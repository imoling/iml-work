package com.imlwork.admin.controller;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/model")
public class ModelProxyController {

    private static final Logger log = LoggerFactory.getLogger(ModelProxyController.class);

    // Track total token consumption at corporate level
    private static long totalPromptTokens = 12450L;
    private static long totalCompletionTokens = 84200L;
    private static int totalRequests = 142;

    @PostMapping("/chat")
    public ResponseEntity<Map<String, Object>> chatCompletion(@RequestBody Map<String, Object> payload) {
        totalRequests++;
        
        String model = (String) payload.getOrDefault("model", "deepseek-chat");
        List<?> messages = (List<?>) payload.get("messages");
        
        log.info("[Model Proxy Hub] Intercepted Request #{} | Model: {} | Messages Count: {}", 
                totalRequests, model, (messages != null ? messages.size() : 0));

        // Mock token calculation
        int promptTokens = 45 + (messages != null ? messages.size() * 12 : 0);
        int completionTokens = 95;
        
        totalPromptTokens += promptTokens;
        totalCompletionTokens += completionTokens;

        log.debug("[Model Proxy Hub] Usage generated: prompt_tokens={}, completion_tokens={}", 
                promptTokens, completionTokens);

        // Mock response structure compatible with standard OpenAI chat payloads
        Map<String, Object> choice = new HashMap<>();
        choice.put("index", 0);
        
        Map<String, String> message = new HashMap<>();
        message.put("role", "assistant");
        message.put("content", "这是经由企业内网中转网关代理返回的回答。中转系统已对密钥及内网上下文做脱敏与安全隔离审计。");
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
        stats.put("totalRequests", totalRequests);
        stats.put("totalPromptTokens", totalPromptTokens);
        stats.put("totalCompletionTokens", totalCompletionTokens);
        stats.put("totalTokens", totalPromptTokens + totalCompletionTokens);
        stats.put("averageLatencyMs", 420);
        stats.put("activeConnections", 3);
        return ResponseEntity.ok(stats);
    }
}
