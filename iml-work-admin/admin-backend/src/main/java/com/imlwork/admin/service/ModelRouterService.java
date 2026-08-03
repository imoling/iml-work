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
    /** 全部启用且未判死的通道（网关模型清单用）。 */
    public List<ModelProvider> enabledProviders() {
        List<ModelProvider> enabled = new ArrayList<>(repository.findByEnabledTrue());
        enabled.removeIf(p -> "DOWN".equals(p.getStatus()));
        return enabled;
    }

    public List<ModelProvider> candidates(String requestedModel) {
        List<ModelProvider> enabled = new ArrayList<>(repository.findByEnabledTrue());
        enabled.removeIf(p -> "DOWN".equals(p.getStatus()));
        // 非对话通道（文生图/文生视频）绝不能进对话候选池。
        // 下面匹配不到 routeKey 时会 fail-open 到**全池**，图片通道混在里面就会收到 /chat 请求
        // ——它根本不是 chat-completions 兼容的，直接硬失败。视觉档没这个问题（仍是 chat 接口），
        // 所以此前不需要这道过滤，登记 image/video 通道后就必须有。
        enabled.removeIf(p -> ModelTiers.MEDIA_TYPES.contains(
                p.getModelType() == null ? "" : p.getModelType().trim().toLowerCase()));
        if (enabled.isEmpty()) return List.of();

        String want = requestedModel == null ? "" : requestedModel.trim();

        // 类型别名（2026-07-29）：客户端按**用途**请求（corp-reasoning），网关按通道类型路由。
        // 无该类型的通道时回退全池（fail-open）——客户端可以无脑发别名，没配推理档就用默认档，
        // 绝不因为管理员没标注类型而把请求打挂。
        // 泛化成"按档位别名路由"：加新档位（vision…）只改 ModelTiers，不再动这里的分支。
        ModelTiers.Tier tier = ModelTiers.byAlias(want);
        if (tier != null && !tier.fallback()) {
            final String wantType = tier.modelType();
            List<ModelProvider> typed = enabled.stream()
                    .filter(p -> wantType.equalsIgnoreCase(p.getModelType())).toList();
            List<ModelProvider> pool0 = typed.isEmpty() ? enabled : new ArrayList<>(typed);
            ModelProvider primary0 = pickSmoothWeighted(pool0);
            List<ModelProvider> ordered0 = new ArrayList<>();
            if (primary0 != null) ordered0.add(primary0);
            pool0.stream()
                    .filter(p -> primary0 == null || !p.getId().equals(primary0.getId()))
                    .sorted(Comparator.comparingInt(ModelProvider::getWeight).reversed())
                    .forEach(ordered0::add);
            return ordered0;
        }

        // Prefer providers whose routeKey (or upstream model) matches the request;
        // fall back to the wildcard pool when nothing matches explicitly.
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

    /**
     * 多媒体通道探活：GET 同源的 /models，只验**连通性与密钥**，不真发生成请求。
     *
     * 为什么不打真实生成端点：生成一张图/一段视频是有成本的操作，探活是可以被频繁点的动作，
     * 拿它烧额度不合理。/models 是 OpenAI 兼容家族的标准清单接口（"从上游拉取"用的就是它）。
     *
     * 判据比对话通道宽松：只有 401/403 才算 DOWN。上游答了 404（没实现 /models）说明
     * 网络与 TLS 都通，把这种情况判死会让一条好通道被无声剔除——那正是这次要修的病。
     */
    private ModelProvider probeMedia(ModelProvider p) {
        long start = System.currentTimeMillis();
        try {
            String url = siblingEndpoint(p.getBaseUrl(), "/models");
            HttpRequest.Builder b = HttpRequest.newBuilder()
                    .uri(URI.create(url)).timeout(Duration.ofSeconds(20)).GET();
            if (p.getApiKey() != null && !p.getApiKey().isBlank()) {
                b.header("Authorization", "Bearer " + p.getApiKey());
            }
            HttpResponse<Void> res = httpClient.send(b.build(), HttpResponse.BodyHandlers.discarding());
            long latency = System.currentTimeMillis() - start;
            p.setAvgLatencyMs(latency);
            int sc = res.statusCode();
            if (sc == 401 || sc == 403) {
                p.setStatus("DOWN");
                p.setMessage("可达但鉴权失败 (HTTP " + sc + ")，请检查密钥");
            } else {
                p.setStatus("HEALTHY");
                p.setMessage("可达 · " + latency + "ms（生成类通道只验连通与密钥，不试跑生成）");
            }
        } catch (Exception e) {
            p.setStatus("DOWN");
            p.setMessage("不可达：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
        }
        p.setLastChecked(java.time.LocalDateTime.now());
        return repository.save(p);
    }

    /** 某类型的通道（不看健康状态）——多媒体转发用：宁可试一条被标 DOWN 的同类通道，
     *  也好过回落去打根本不支持该能力的对话通道。 */
    public List<ModelProvider> providersOfType(String modelType) {
        return repository.findByEnabledTrue().stream()
                .filter(p -> modelType != null && modelType.equalsIgnoreCase(p.getModelType()))
                .sorted(Comparator.comparingInt(ModelProvider::getWeight).reversed())
                .toList();
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
        // 非对话通道（文生图/文生视频）不能用 chat 载荷探活——上游必然 400，
        // 于是通道被标 DOWN、从可用池剔除，生成请求回落到全池去打对话模型，全线失败。
        // （2026-08-02 实测踩到：客户端生成图片失败，根因就在这。）
        if (ModelTiers.MEDIA_TYPES.contains(
                p.getModelType() == null ? "" : p.getModelType().trim().toLowerCase())) {
            return probeMedia(p);
        }
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
                    // 真实转发超时另有 60s(ModelProxyService)，不受此影响。
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

    /**
     * 把通道 baseUrl 规范成同源的**另一个端点**（多媒体生成用：/images/generations、/videos）。
     * 通道配的是 chat 端点（…/v1/chat/completions），生成类要打到同一 API 根下的别的路径。
     */
    public static String siblingEndpoint(String baseUrl, String path) {
        String u = normalizeChatUrl(baseUrl);
        for (String tail : new String[]{"/chat/completions", "/v1/messages", "/chat"}) {
            if (u.endsWith(tail)) { u = u.substring(0, u.length() - tail.length()); break; }
        }
        if (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u + (path.startsWith("/") ? path : "/" + path);
    }
}
