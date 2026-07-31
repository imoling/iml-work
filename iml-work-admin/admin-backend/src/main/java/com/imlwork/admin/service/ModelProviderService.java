package com.imlwork.admin.service;

import com.imlwork.admin.dto.ModelProviderRequests;
import com.imlwork.admin.model.ModelProvider;
import com.imlwork.admin.repository.ModelProviderRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.HashMap;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 模型网关提供商领域服务：注册/权重/开关/健康探活。
 * 探活委托 {@link ModelRouterService#probe}；实时流量调度仍由 ModelRouterService 承担。
 */
@Service
public class ModelProviderService {

    private final ModelProviderRepository repository;
    private final ModelRouterService router;

    public ModelProviderService(ModelProviderRepository repository, ModelRouterService router) {
        this.repository = repository;
        this.router = router;
    }

    @Transactional(readOnly = true)
    public List<ModelProvider> list() {
        return repository.findAll();
    }

    @Transactional(readOnly = true)
    public Map<String, Object> summary() {
        List<ModelProvider> all = repository.findAll();
        long enabled = all.stream().filter(ModelProvider::isEnabled).count();
        long healthy = all.stream().filter(p -> "HEALTHY".equals(p.getStatus())).count();
        long down = all.stream().filter(p -> "DOWN".equals(p.getStatus())).count();
        long totalReq = all.stream().mapToLong(ModelProvider::getTotalRequests).sum();
        long totalFail = all.stream().mapToLong(ModelProvider::getFailedRequests).sum();
        Map<String, Object> s = new HashMap<>();
        s.put("total", all.size());
        s.put("enabled", enabled);
        s.put("healthy", healthy);
        s.put("down", down);
        s.put("totalRequests", totalReq);
        s.put("failedRequests", totalFail);
        s.put("successRate", totalReq == 0 ? 1.0 : (totalReq - totalFail) / (double) totalReq);
        return s;
    }

    @Transactional
    public ModelProvider create(ModelProviderRequests.Upsert body) {
        ModelProvider p = new ModelProvider();
        p.setId("mp-" + UUID.randomUUID().toString().substring(0, 8));
        applyEditable(p, body);
        p.setStatus("UNKNOWN");        // 计数器/状态服务端管理，默认零值即可
        return repository.save(p);
    }

    @Transactional
    public ModelProvider update(String id, ModelProviderRequests.Upsert body) {
        ModelProvider existing = repository.findById(id).orElseThrow(() -> notFound());
        applyEditable(existing, body);
        return repository.save(existing);
    }

    /** 把 DTO 里客户端可编辑的字段写入实体（id/status/计数器/lastChecked 不在其列）。 */
    private void applyEditable(ModelProvider p, ModelProviderRequests.Upsert body) {
        p.setName(body.name());
        p.setProvider(body.provider());
        p.setBaseUrl(body.baseUrl());
        p.setModel(body.model());
        p.setRouteKey(body.routeKey());
        // 类型白名单：非法值归 chat（将来扩 vision 等再加）
        p.setModelType("reasoning".equalsIgnoreCase(body.modelType()) ? "reasoning" : "chat");
        p.setWeight(body.weight() == null ? 1 : Math.max(1, body.weight()));
        p.setEnabled(body.enabled() == null || body.enabled());
        p.setInputPricePer1M(body.inputPricePer1M());      // 元/百万 tokens；可空：清空=不计费
        p.setOutputPricePer1M(body.outputPricePer1M());
        p.setMaxOutputTokens(body.maxOutputTokens());      // 可空：不注入 max_tokens、用厂商默认
        // 仅当传入非空 key 时才覆盖（GET 不下发 key，编辑留空不会误清空）
        if (body.apiKey() != null && !body.apiKey().isBlank()) p.setApiKey(body.apiKey());
    }

    /**
     * 拉取上游可用模型列表（参考主流实现：配好通道后自动拉 /v1/models 让人**选**而不是手打）。
     * 依次探测 OpenAI 兼容的 {base}/models、{base}/v1/models 与 Ollama 的 {base}/api/tags，
     * 首个能解析出列表的生效——DeepSeek/OpenAI/智谱走前两档，本地 Ollama 走第三档。
     * providerId 传了就用库里的 baseUrl+key（编辑场景：key 不下发前端，只能服务端代取）。
     */
    public Map<String, Object> listUpstreamModels(String providerId, String baseUrl, String apiKey) {
        if (providerId != null && !providerId.isBlank()) {
            ModelProvider p = repository.findById(providerId).orElseThrow(() -> notFound());
            baseUrl = p.getBaseUrl();
            if (apiKey == null || apiKey.isBlank()) apiKey = p.getApiKey();
        }
        if (baseUrl == null || baseUrl.isBlank()) throw new IllegalArgumentException("baseUrl 不能为空");
        String root = baseUrl.trim();
        if (root.endsWith("/")) root = root.substring(0, root.length() - 1);
        for (String suffix : new String[]{"/chat/completions", "/v1/messages", "/chat"}) {
            if (root.endsWith(suffix)) { root = root.substring(0, root.length() - suffix.length()); break; }
        }
        java.net.http.HttpClient http = java.net.http.HttpClient.newBuilder()
                .connectTimeout(java.time.Duration.ofSeconds(8)).build();
        String lastErr = "上游未返回可解析的模型列表";
        for (String path : new String[]{"/models", "/v1/models", "/api/tags"}) {
            if (root.endsWith("/v1") && path.equals("/v1/models")) continue;   // base 已含 /v1 时避免 /v1/v1
            try {
                java.net.http.HttpRequest.Builder b = java.net.http.HttpRequest.newBuilder()
                        .uri(java.net.URI.create(root + path))
                        .timeout(java.time.Duration.ofSeconds(15)).GET();
                if (apiKey != null && !apiKey.isBlank()) b.header("Authorization", "Bearer " + apiKey);
                java.net.http.HttpResponse<String> r = http.send(b.build(),
                        java.net.http.HttpResponse.BodyHandlers.ofString());
                if (r.statusCode() < 200 || r.statusCode() >= 300) { lastErr = "HTTP " + r.statusCode(); continue; }
                List<String> models = parseModelIds(r.body());
                if (!models.isEmpty()) return Map.of("models", models, "endpoint", path);
            } catch (Exception e) { lastErr = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(); }
        }
        return Map.of("models", List.of(), "error", "拉取失败：" + lastErr);
    }

    /** 解析两种形状：OpenAI 兼容 {data:[{id}]} 与 Ollama {models:[{name|model}]}。 */
    private static List<String> parseModelIds(String body) {
        List<String> out = new ArrayList<>();
        try {
            com.fasterxml.jackson.databind.JsonNode root = new com.fasterxml.jackson.databind.ObjectMapper().readTree(body);
            com.fasterxml.jackson.databind.JsonNode arr = root.has("data") ? root.get("data") : root.get("models");
            if (arr != null && arr.isArray()) {
                for (com.fasterxml.jackson.databind.JsonNode n : arr) {
                    String id = n.hasNonNull("id") ? n.get("id").asText()
                            : n.hasNonNull("name") ? n.get("name").asText()
                            : n.hasNonNull("model") ? n.get("model").asText() : "";
                    if (!id.isBlank()) out.add(id);
                }
            }
        } catch (Exception ignored) { /* 非 JSON/形状不符 → 空列表，调用方换下一个端点 */ }
        return out.stream().distinct().sorted().toList();
    }

    @Transactional
    public ModelProvider toggle(String id) {
        ModelProvider p = repository.findById(id).orElseThrow(() -> notFound());
        p.setEnabled(!p.isEnabled());
        return repository.save(p);
    }

    /** 探活：委托 router.probe（其内部会更新并保存 provider 状态）。 */
    @Transactional
    public ModelProvider health(String id) {
        ModelProvider p = repository.findById(id).orElseThrow(() -> notFound());
        return router.probe(p);
    }

    @Transactional
    public void delete(String id) {
        if (!repository.existsById(id)) throw notFound();
        repository.deleteById(id);
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "提供商不存在");
    }
}
