package com.imlwork.admin.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.imlwork.admin.model.ModelProvider;
import com.imlwork.admin.repository.ModelProviderRepository;
import com.imlwork.admin.service.GatewayMetrics;
import com.imlwork.admin.service.ModelRouterService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Unified entry point of the enterprise model relay station. Incoming chat
 * requests are scheduled across the registered upstream providers (weighted
 * round-robin + failover) by {@link ModelRouterService}, with DLP masking applied
 * to every payload. When no providers are configured it falls back to the legacy
 * single-target proxy, and finally to a mock response for offline/demo use.
 */
@RestController
@RequestMapping("/api/v1/model")
public class ModelProxyController {

    private static final Logger log = LoggerFactory.getLogger(ModelProxyController.class);

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${model-proxy.target-url:https://api.deepseek.com/v1/chat/completions}")
    private String targetUrl;

    @Value("${model-proxy.api-key:}")
    private String defaultApiKey;

    /** 服务间共享密钥：客户端/FDE 调用 /model/chat 必须携带，防止未授权盗用企业模型额度。 */
    @Value("${model-proxy.corp-key:sk-corp-default-key}")
    private String corpKey;

    private final GatewayMetrics metrics;
    private final ModelRouterService router;
    private final ModelProviderRepository providerRepository;

    public ModelProxyController(GatewayMetrics metrics, ModelRouterService router,
                                ModelProviderRepository providerRepository) {
        this.metrics = metrics;
        this.router = router;
        this.providerRepository = providerRepository;
    }

    @PostMapping("/chat")
    public ResponseEntity<?> chatCompletion(
            @RequestBody Map<String, Object> payload,
            @RequestHeader(value = "Authorization", required = false) String authHeader) {

        // 网关鉴权：必须携带服务间共享密钥（corp key），否则拒绝——防止未登录者盗用企业模型额度。
        if (authHeader == null || !authHeader.equals("Bearer " + corpKey)) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("error", Map.of("message", "未授权：模型网关需要有效的服务密钥", "type", "unauthorized")));
        }

        String model = (String) payload.getOrDefault("model", "deepseek-chat");
        List<?> messages = (List<?>) payload.get("messages");

        log.info("[Relay Station] Intercepted Request | Model: {} | Messages Count: {}",
                model, (messages != null ? messages.size() : 0));

        // Preferred path: schedule across the registered relay-station providers.
        List<ModelProvider> candidates = router.candidates(model);
        if (!candidates.isEmpty()) {
            return routeThroughStation(payload, candidates, model, messages);
        }

        // Legacy single-target proxy (used when no providers are registered).
        return legacyProxy(payload, authHeader, model, messages);
    }

    /**
     * Forward to the scheduled providers in order, failing over to the next on any
     * non-2xx or network error. Records live metrics on each provider row.
     */
    private ResponseEntity<?> routeThroughStation(Map<String, Object> payload,
                                                  List<ModelProvider> candidates,
                                                  String requestedModel, List<?> messages) {
        String lastError = "no upstream reached";
        int lastStatus = 502;
        boolean anyKeyed = false;

        for (ModelProvider p : candidates) {
            boolean keyed = p.getApiKey() != null && !p.getApiKey().isBlank();
            anyKeyed = anyKeyed || keyed;
            long start = System.currentTimeMillis();
            try {
                // Per-provider body: override the model with the provider's upstream name.
                Map<String, Object> body = new HashMap<>(payload);
                if (p.getModel() != null && !p.getModel().isBlank()) {
                    body.put("model", p.getModel());
                }
                String sanitized = mask(objectMapper.writeValueAsString(body));
                String url = ModelRouterService.normalizeChatUrl(p.getBaseUrl());

                HttpRequest.Builder b = HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .header("Content-Type", "application/json")
                        .timeout(Duration.ofSeconds(60))
                        .POST(HttpRequest.BodyPublishers.ofString(sanitized));
                if (keyed) {
                    b.header("Authorization", "Bearer " + p.getApiKey());
                }

                log.info("[Relay Station] Routing to provider '{}' ({}) at {}", p.getName(), p.getId(), url);
                HttpResponse<String> response = httpClient.send(b.build(), HttpResponse.BodyHandlers.ofString());
                long latency = System.currentTimeMillis() - start;

                if (response.statusCode() >= 200 && response.statusCode() < 300) {
                    long[] toks = parseUsage(response.body());
                    metrics.recordRequest(toks[0], toks[1], true);
                    router.recordResult(p.getId(), true, latency, toks[0], toks[1]);
                    log.info("[Relay Station] Served by '{}' in {}ms", p.getName(), latency);
                    return ResponseEntity.ok()
                            .header("Content-Type", "application/json")
                            .header("X-Relay-Provider", p.getId())
                            .body(response.body());
                }
                router.recordResult(p.getId(), false, latency);
                lastStatus = response.statusCode();
                lastError = response.body();
                log.warn("[Relay Station] Provider '{}' returned {} — failing over", p.getName(), lastStatus);
            } catch (Exception e) {
                router.recordResult(p.getId(), false, System.currentTimeMillis() - start);
                lastError = e.getMessage();
                log.warn("[Relay Station] Provider '{}' error: {} — failing over", p.getName(), lastError);
            }
        }

        metrics.recordRequest(0, 0, false);
        // If none of the candidates had a key, degrade gracefully to a mock so the
        // console / client stays usable in offline demo mode.
        if (!anyKeyed) {
            return returnMockResponse(payload, requestedModel, messages);
        }
        return ResponseEntity.status(lastStatus)
                .body(Map.of("error", "所有上游模型通道均不可用：" + lastError, "success", false));
    }

    /** Legacy behavior: resolve a single key (client / config / env) and forward to one target. */
    private ResponseEntity<?> legacyProxy(Map<String, Object> payload, String authHeader,
                                          String model, List<?> messages) {
        // 绝不把调用方的 Authorization（corp key / JWT）转发给外部上游，只用服务端配置的上游密钥。
        String resolvedKey = "";
        if (defaultApiKey != null && !defaultApiKey.trim().isEmpty()) {
            resolvedKey = "Bearer " + defaultApiKey;
        } else {
            String envKey = System.getenv("DEEPSEEK_API_KEY");
            if (envKey == null || envKey.trim().isEmpty()) {
                envKey = System.getenv("OPENAI_API_KEY");
            }
            if (envKey != null && !envKey.trim().isEmpty()) {
                resolvedKey = "Bearer " + envKey;
            }
        }

        if (resolvedKey.isEmpty()) {
            log.warn("[Relay Station] No provider registered and no API key resolved — returning mock.");
            return returnMockResponse(payload, model, messages);
        }

        try {
            String sanitizedBody = mask(objectMapper.writeValueAsString(payload));
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(targetUrl))
                    .header("Content-Type", "application/json")
                    .header("Authorization", resolvedKey)
                    .POST(HttpRequest.BodyPublishers.ofString(sanitizedBody))
                    .timeout(Duration.ofSeconds(60))
                    .build();

            log.info("[Relay Station] (legacy) Forwarding request to: {}", targetUrl);
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() >= 200 && response.statusCode() < 300) {
                long[] toks = parseUsage(response.body());
                metrics.recordRequest(toks[0], toks[1], true);
                return ResponseEntity.ok().header("Content-Type", "application/json").body(response.body());
            }
            metrics.recordRequest(0, 0, false);
            log.error("[Relay Station] (legacy) Upstream error: {} - {}", response.statusCode(), response.body());
            return ResponseEntity.status(response.statusCode())
                    .header("Content-Type", "application/json").body(response.body());
        } catch (Exception e) {
            log.error("[Relay Station] (legacy) Forwarding exception: ", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("error", e.getMessage(), "success", false));
        }
    }

    /** DLP masking of sensitive content (cell phone & national ID card) in the payload. */
    private String mask(String payloadJson) {
        String cellPhonePattern = "(?<!\\d)1[3-9]\\d{9}(?!\\d)";
        String idCardPattern = "(?<!\\d)\\d{17}[\\dXx](?!\\d)";
        String sanitized = payloadJson
                .replaceAll(cellPhonePattern, "1**********")
                .replaceAll(idCardPattern, "3****************X");
        if (!sanitized.equals(payloadJson)) {
            log.info("[Relay Station] DLP masking applied to request payload.");
        }
        return sanitized;
    }

    /** Parse [prompt_tokens, completion_tokens] from an upstream success body. */
    private long[] parseUsage(String body) {
        try {
            Map<?, ?> resMap = objectMapper.readValue(body, Map.class);
            Map<?, ?> usage = (Map<?, ?>) resMap.get("usage");
            long pTok = 0, cTok = 0;
            if (usage != null) {
                Number promptTok = (Number) usage.get("prompt_tokens");
                Number compTok = (Number) usage.get("completion_tokens");
                if (promptTok != null) pTok = promptTok.longValue();
                if (compTok != null) cTok = compTok.longValue();
            }
            return new long[]{pTok, cTok};
        } catch (Exception parseErr) {
            log.warn("[Relay Station] Failed to parse usage metrics: {}", parseErr.getMessage());
            return new long[]{0, 0};
        }
    }

    private ResponseEntity<?> returnMockResponse(Map<String, Object> payload, String model, List<?> messages) {
        // Mock token calculation
        int promptTokens = 45 + (messages != null ? messages.size() * 12 : 0);
        int completionTokens = 95;

        metrics.recordRequest(promptTokens, completionTokens, true);

        Map<String, Object> choice = new HashMap<>();
        choice.put("index", 0);

        Map<String, String> message = new HashMap<>();
        message.put("role", "assistant");
        message.put("content", "这是经由企业内网中转网关代理返回的演示回答（检测到未配置任何真实的大模型密钥）。中转系统已对密钥及内网上下文做脱敏与安全隔离审计。");
        choice.put("message", message);
        choice.put("finish_reason", "stop");

        Map<String, Object> usage = new HashMap<>();
        usage.put("prompt_tokens", promptTokens);
        usage.put("completion_tokens", completionTokens);
        usage.put("total_tokens", promptTokens + completionTokens);

        Map<String, Object> responseBody = new HashMap<>();
        responseBody.put("id", "chatcmpl-" + java.util.UUID.randomUUID().toString().substring(0, 8));
        responseBody.put("object", "chat.completion");
        responseBody.put("created", System.currentTimeMillis() / 1000);
        responseBody.put("model", model);
        responseBody.put("choices", List.of(choice));
        responseBody.put("usage", usage);
        responseBody.put("success", true);

        return ResponseEntity.ok(responseBody);
    }

    @GetMapping("/stats")
    public ResponseEntity<Map<String, Object>> getProxyStats() {
        List<ModelProvider> providers = providerRepository.findAll();
        // Request-weighted average latency across providers that actually served traffic.
        long reqWeight = providers.stream().mapToLong(ModelProvider::getTotalRequests).sum();
        long weightedLatency = providers.stream()
                .mapToLong(p -> p.getAvgLatencyMs() * Math.max(0, p.getTotalRequests())).sum();
        long avgLatency = reqWeight == 0 ? 0 : weightedLatency / reqWeight;
        // "Active connections" = enabled channels currently healthy enough to serve.
        long activeChannels = providers.stream()
                .filter(p -> p.isEnabled() && !"DOWN".equals(p.getStatus()))
                .count();

        Map<String, Object> stats = new HashMap<>();
        stats.put("totalRequests", metrics.getTotalRequests());
        stats.put("totalPromptTokens", metrics.getTotalPromptTokens());
        stats.put("totalCompletionTokens", metrics.getTotalCompletionTokens());
        stats.put("totalTokens", metrics.getTotalPromptTokens() + metrics.getTotalCompletionTokens());
        stats.put("averageLatencyMs", avgLatency);
        stats.put("activeConnections", activeChannels);
        return ResponseEntity.ok(stats);
    }
}
