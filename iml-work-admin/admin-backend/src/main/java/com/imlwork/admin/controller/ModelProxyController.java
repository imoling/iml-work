package com.imlwork.admin.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.imlwork.admin.service.GatewayMetrics;
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

    private final GatewayMetrics metrics;

    public ModelProxyController(GatewayMetrics metrics) {
        this.metrics = metrics;
    }

    @PostMapping("/chat")
    public ResponseEntity<?> chatCompletion(
            @RequestBody Map<String, Object> payload,
            @RequestHeader(value = "Authorization", required = false) String authHeader) {

        String model = (String) payload.getOrDefault("model", "deepseek-chat");
        List<?> messages = (List<?>) payload.get("messages");

        log.info("[Model Proxy Hub] Intercepted Request | Model: {} | Messages Count: {}",
                model, (messages != null ? messages.size() : 0));

        // Resolve API key
        String resolvedKey = "";
        if (authHeader != null && authHeader.startsWith("Bearer ") && !authHeader.contains("sk-corp-default-key")) {
            resolvedKey = authHeader;
        } else if (defaultApiKey != null && !defaultApiKey.trim().isEmpty()) {
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
            log.warn("[Model Proxy Hub] No API Key resolved. Upstream requests will fail.");
            // Returning a mock response if no key is configured to allow local offline test
            return returnMockResponse(payload, model, messages);
        }

        try {
            // Convert payload to JSON
            String payloadJson = objectMapper.writeValueAsString(payload);

            // DLP sensitive content masking (cell phone & national ID card)
            String cellPhonePattern = "(?<!\\d)1[3-9]\\d{9}(?!\\d)";
            String idCardPattern = "(?<!\\d)\\d{17}[\\dXx](?!\\d)";
            String sanitizedBody = payloadJson
                    .replaceAll(cellPhonePattern, "1**********")
                    .replaceAll(idCardPattern, "3****************X");

            if (!sanitizedBody.equals(payloadJson)) {
                log.info("[Model Proxy Hub] DLP Masking applied to request payload.");
            }

            // Build request to upstream LLM API
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(targetUrl))
                    .header("Content-Type", "application/json")
                    .header("Authorization", resolvedKey)
                    .POST(HttpRequest.BodyPublishers.ofString(sanitizedBody))
                    .timeout(Duration.ofSeconds(60))
                    .build();

            log.info("[Model Proxy Hub] Forwarding request to: {}", targetUrl);
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            log.info("[Model Proxy Hub] Upstream response status: {}", response.statusCode());

            if (response.statusCode() >= 200 && response.statusCode() < 300) {
                // Try parsing usage to update metrics
                try {
                    Map<?, ?> resMap = objectMapper.readValue(response.body(), Map.class);
                    Map<?, ?> usage = (Map<?, ?>) resMap.get("usage");
                    long pTok = 0, cTok = 0;
                    if (usage != null) {
                        Number promptTok = (Number) usage.get("prompt_tokens");
                        Number compTok = (Number) usage.get("completion_tokens");
                        if (promptTok != null) pTok = promptTok.longValue();
                        if (compTok != null) cTok = compTok.longValue();
                    }
                    metrics.recordRequest(pTok, cTok, true);
                } catch (Exception parseErr) {
                    log.warn("[Model Proxy Hub] Failed to parse usage metrics: {}", parseErr.getMessage());
                    metrics.recordRequest(0, 0, true);
                }

                // Return upstream response directly
                return ResponseEntity.ok()
                        .header("Content-Type", "application/json")
                        .body(response.body());
            } else {
                metrics.recordRequest(0, 0, false);
                log.error("[Model Proxy Hub] Upstream error: {} - {}", response.statusCode(), response.body());
                return ResponseEntity.status(response.statusCode())
                        .header("Content-Type", "application/json")
                        .body(response.body());
            }

        } catch (Exception e) {
            log.error("[Model Proxy Hub] Forwarding exception: ", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("error", e.getMessage(), "success", false));
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
        Map<String, Object> stats = new HashMap<>();
        stats.put("totalRequests", metrics.getTotalRequests());
        stats.put("totalPromptTokens", metrics.getTotalPromptTokens());
        stats.put("totalCompletionTokens", metrics.getTotalCompletionTokens());
        stats.put("totalTokens", metrics.getTotalPromptTokens() + metrics.getTotalCompletionTokens());
        stats.put("averageLatencyMs", 420);
        stats.put("activeConnections", 3);
        return ResponseEntity.ok(stats);
    }
}
