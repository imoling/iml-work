package com.imlwork.admin.service;

import com.imlwork.admin.model.ModelProvider;
import com.imlwork.admin.repository.ModelProviderRepository;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Scheduler for the enterprise model relay station. Given a requested route key
 * (logical model name), it returns the enabled providers in priority order using
 * nginx-style smooth weighted round-robin, so the gateway can forward to the
 * primary pick and fail over to the rest. Also probes upstream health and folds
 * live latency / error metrics back into each provider row.
 */
@Service
public class ModelRouterService {

    private final ModelProviderRepository repository;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(8))
            .build();

    /** Mutable per-provider current-weight state for smooth weighted round-robin. */
    private final Map<String, Integer> currentWeights = new ConcurrentHashMap<>();

    public ModelRouterService(ModelProviderRepository repository) {
        this.repository = repository;
    }

    public boolean hasProviders() {
        return repository.findByEnabledTrue().stream().anyMatch(p -> !"DOWN".equals(p.getStatus()));
    }

    /**
     * Ordered candidate list for a request. The first element is the SWRR pick;
     * the remainder are weight-desc fallbacks for failover. Providers marked DOWN
     * are excluded. A blank routeKey on a provider matches any request.
     */
    public List<ModelProvider> candidates(String requestedModel) {
        List<ModelProvider> enabled = new ArrayList<>(repository.findByEnabledTrue());
        enabled.removeIf(p -> "DOWN".equals(p.getStatus()));
        if (enabled.isEmpty()) return List.of();

        // Prefer providers whose routeKey (or upstream model) matches the request;
        // fall back to the wildcard pool when nothing matches explicitly.
        String want = requestedModel == null ? "" : requestedModel.trim();
        List<ModelProvider> matched = new ArrayList<>();
        for (ModelProvider p : enabled) {
            String rk = p.getRouteKey() == null ? "" : p.getRouteKey().trim();
            if (!want.isEmpty() && (want.equalsIgnoreCase(rk) || want.equalsIgnoreCase(p.getModel()))) {
                matched.add(p);
            }
        }
        List<ModelProvider> pool = matched.isEmpty() ? enabled : matched;

        ModelProvider primary = pickSmoothWeighted(pool);
        List<ModelProvider> ordered = new ArrayList<>();
        if (primary != null) ordered.add(primary);
        pool.stream()
                .filter(p -> primary == null || !p.getId().equals(primary.getId()))
                .sorted(Comparator.comparingInt(ModelProvider::getWeight).reversed())
                .forEach(ordered::add);
        return ordered;
    }

    /** nginx smooth weighted round-robin selection over the given pool. */
    private synchronized ModelProvider pickSmoothWeighted(List<ModelProvider> pool) {
        int totalWeight = 0;
        ModelProvider best = null;
        for (ModelProvider p : pool) {
            int w = Math.max(1, p.getWeight());
            totalWeight += w;
            int cur = currentWeights.getOrDefault(p.getId(), 0) + w;
            currentWeights.put(p.getId(), cur);
            if (best == null || cur > currentWeights.get(best.getId())) {
                best = p;
            }
        }
        if (best != null) {
            currentWeights.put(best.getId(), currentWeights.get(best.getId()) - totalWeight);
        }
        return best;
    }

    /** Fold a request outcome back into the provider's persisted counters. */
    public void recordResult(String providerId, boolean ok, long latencyMs) {
        recordResult(providerId, ok, latencyMs, 0, 0);
    }

    public void recordResult(String providerId, boolean ok, long latencyMs,
                             long promptTokens, long completionTokens) {
        repository.findById(providerId).ifPresent(p -> {
            long total = p.getTotalRequests() + 1;
            p.setTotalRequests(total);
            p.setTotalPromptTokens(p.getTotalPromptTokens() + promptTokens);
            p.setTotalCompletionTokens(p.getTotalCompletionTokens() + completionTokens);
            if (!ok) p.setFailedRequests(p.getFailedRequests() + 1);
            // Exponential moving average keeps latency responsive without history.
            long prev = p.getAvgLatencyMs();
            p.setAvgLatencyMs(prev == 0 ? latencyMs : Math.round(prev * 0.7 + latencyMs * 0.3));
            if (ok) {
                p.setStatus("HEALTHY");
            } else if (p.getTotalRequests() > 0
                    && p.getFailedRequests() * 2 > p.getTotalRequests()) {
                p.setStatus("DOWN");
            }
            repository.save(p);
        });
    }

    /** Active health probe: a tiny chat round-trip (or reachability) against the upstream. */
    public ModelProvider probe(ModelProvider p) {
        long start = System.currentTimeMillis();
        try {
            String url = normalizeChatUrl(p.getBaseUrl());
            String body = "{\"model\":\"" + (p.getModel() == null ? "" : p.getModel())
                    + "\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1}";
            HttpRequest.Builder b = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("Content-Type", "application/json")
                    // 探活超时对齐慢上游：经代理的 AGNES 生成 1 个 token 也要 8~18s，10s 会在阈值边缘
                    // 反复横跳(HEALTHY↔DOWN)。探活是手动/低频操作等得起；真死的上游 30s 同样判死。
                    // 真实转发超时另有 60s(ModelProxyController)，不受此影响。
                    .timeout(Duration.ofSeconds(30))
                    .POST(HttpRequest.BodyPublishers.ofString(body));
            if (p.getApiKey() != null && !p.getApiKey().isBlank()) {
                b.header("Authorization", "Bearer " + p.getApiKey());
            }
            HttpResponse<Void> res = httpClient.send(b.build(), HttpResponse.BodyHandlers.discarding());
            long latency = System.currentTimeMillis() - start;
            p.setAvgLatencyMs(latency);
            // 2xx = healthy; 401/403 = reachable but bad key; others = degraded.
            int sc = res.statusCode();
            if (sc >= 200 && sc < 300) {
                p.setStatus("HEALTHY");
                p.setMessage("探活成功 · " + latency + "ms");
            } else if (sc == 401 || sc == 403) {
                p.setStatus("DOWN");
                p.setMessage("可达但鉴权失败 (HTTP " + sc + ")，请检查密钥");
            } else {
                p.setStatus("DOWN");
                p.setMessage("上游异常 HTTP " + sc);
            }
        } catch (Exception e) {
            if (p.getApiKey() == null || p.getApiKey().isBlank()) {
                p.setStatus("UNKNOWN");
                p.setMessage("未配置密钥，未实际探活（离线/内网模式）");
            } else {
                p.setStatus("DOWN");
                p.setMessage("探活失败：" + e.getMessage());
            }
        }
        p.setLastChecked(LocalDateTime.now());
        return repository.save(p);
    }

    /** Normalize a base URL to a chat-completions endpoint. */
    public static String normalizeChatUrl(String baseUrl) {
        if (baseUrl == null) return "";
        String u = baseUrl.trim();
        if (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        if (u.endsWith("/chat/completions") || u.endsWith("/v1/messages") || u.endsWith("/chat")) {
            return u;
        }
        return u + "/chat/completions";
    }
}
