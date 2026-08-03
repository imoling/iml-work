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

    /**
     * 批量登记：整批同一个事务——半数入库半数失败会留下一堆说不清来源的残缺通道，
     * 管理员还得逐条比对才知道哪些成了。宁可整批回滚让他重来。
     */
    @Transactional
    public List<ModelProvider> createBatch(List<ModelProviderRequests.Upsert> items) {
        return items.stream().map(this::create).toList();
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
        // 类型必须按**档位表**校验，不能写死二值：曾是 `"reasoning".equals(x) ? "reasoning" : "chat"`，
        // 加了视觉档之后传 vision 会被静默压成 chat——通道登记成功、界面显示正常，
        // 唯独 corp-vision 永远路由不到它（实测踩到）。未知类型仍归兜底档。
        // 合法类型原样保留（含 image/video 这类非对话能力）；未知值才归兜底档。
        p.setModelType(ModelTiers.isValidType(body.modelType())
                ? body.modelType().trim().toLowerCase()
                : ModelTiers.byModelType(body.modelType()).modelType());
        p.setWeight(body.weight() == null ? 1 : Math.max(1, body.weight()));
        p.setEnabled(body.enabled() == null || body.enabled());
        p.setInputPricePer1M(body.inputPricePer1M());      // 元/百万 tokens；可空：清空=不计费
        p.setOutputPricePer1M(body.outputPricePer1M());
        p.setMaxOutputTokens(body.maxOutputTokens());      // 可空：不注入 max_tokens、用厂商默认
        // 仅当传入非空 key 时才覆盖（GET 不下发 key，编辑留空不会误清空）
        if (body.apiKey() != null && !body.apiKey().isBlank()) p.setApiKey(body.apiKey());
    }

    /**
     * 拉取上游可用模型列表：配好通道后自动拉 /v1/models，让人**选**而不是手打。
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
                // items 额外带上类型推断与建议路由名，供管理端「批量登记」面板预填；
                // models 保留原样（datalist 等既有消费端不受影响）。推断是启发式，见 ModelTypeGuess。
                if (!models.isEmpty()) return Map.of(
                        "models", models,
                        "items", models.stream().map(m -> {
                            String t = ModelTypeGuess.of(m);
                            return Map.of("id", m, "guessedType", t,
                                    "chatCapable", ModelTypeGuess.isChatCapable(m),
                                    "suggestedRouteKey", ModelTypeGuess.suggestedRouteKey(t));
                        }).toList(),
                        "endpoint", path);
            } catch (Exception e) { lastErr = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(); }
        }
        return Map.of("models", List.of(), "error", "拉取失败：" + lastErr);
    }

    /**
     * 实测每个模型的通道类型：发一个极小的探针请求，读回执里的
     * {@code usage.completion_tokens_details.reasoning_tokens}——推理模型会把 token 花在思维链上，
     * 该字段 &gt;0 就是**厂商事实**，比按模型名猜可靠得多（deepseek-v4-pro 这种命名里
     * 完全看不出推理属性的，只有实测能认出来）。
     *
     * <p>探不出的（字段缺失、模型不支持 chat、超时、上游报错）一律回退到 ModelTypeGuess 的
     * 命名推断，绝不因为一次探测失败就把类型判反。并发发起、单条 25s 上限。
     */
    public Map<String, Object> probeModelTypes(String providerId, String baseUrl, String apiKey, List<String> models) {
        if (models == null || models.isEmpty()) throw new IllegalArgumentException("models 不能为空");
        if (models.size() > 20) throw new IllegalArgumentException("单次最多探测 20 个模型");
        if (providerId != null && !providerId.isBlank()) {
            ModelProvider p = repository.findById(providerId).orElseThrow(() -> notFound());
            baseUrl = p.getBaseUrl();
            if (apiKey == null || apiKey.isBlank()) apiKey = p.getApiKey();
        }
        if (baseUrl == null || baseUrl.isBlank()) throw new IllegalArgumentException("baseUrl 不能为空");
        String endpoint = chatEndpointOf(baseUrl);
        String key = apiKey;

        java.net.http.HttpClient http = java.net.http.HttpClient.newBuilder()
                .connectTimeout(java.time.Duration.ofSeconds(8)).build();
        Map<String, java.util.concurrent.CompletableFuture<String>> futures = new java.util.LinkedHashMap<>();
        for (String m : models) {
            // 嵌入/重排/语音这类非对话模型不发探针：必然 400，白等一轮超时还污染区分度判断
            futures.put(m, ModelTypeGuess.isChatCapable(m)
                    ? java.util.concurrent.CompletableFuture.supplyAsync(() -> probeOne(http, endpoint, key, m))
                    : java.util.concurrent.CompletableFuture.completedFuture(null));
        }
        Map<String, String> probes = new java.util.LinkedHashMap<>();
        for (Map.Entry<String, java.util.concurrent.CompletableFuture<String>> e : futures.entrySet()) {
            try { probes.put(e.getKey(), e.getValue().get(30, java.util.concurrent.TimeUnit.SECONDS)); }
            catch (Exception ignored) { probes.put(e.getKey(), null); }   // 超时/中断 → 按探不出处理
        }

        // 探测只在**真有区分度**时才采信：混合推理模型时代，同一厂商往往全系都产生思维链
        // （实测 deepseek-v4-flash 与 v4-pro 的 reasoning_tokens 都 >0），这时探测结果全相同，
        // 说明它回答不了"哪个是强档"——强行采信会把整个系列都标成推理档，日常对话全打到贵模型。
        // 全同即视为无信息，整批回退命名推断（ModelTypeGuess 判的是能力档位，不是有无思维链）。
        long distinct = probes.values().stream().filter(java.util.Objects::nonNull).distinct().count();
        boolean useProbe = distinct > 1;

        Map<String, Object> out = new java.util.LinkedHashMap<>();
        for (Map.Entry<String, String> e : probes.entrySet()) {
            String probed = e.getValue();
            String guessed = ModelTypeGuess.of(e.getKey());
            boolean taken = useProbe && probed != null;
            String type = taken ? probed : guessed;
            out.put(e.getKey(), Map.of(
                    "type", type,
                    "probed", taken,                   // 前端据此标注「实测」还是「按名推断」
                    "chatCapable", ModelTypeGuess.isChatCapable(e.getKey()),
                    "suggestedRouteKey", ModelTypeGuess.suggestedRouteKey(type)));
        }
        return Map.of("results", out, "probeUseful", useProbe);
    }

    /** 单个模型的探针：返回 "reasoning"/"chat"，探不出返回 null（由调用方回退命名推断）。 */
    private static String probeOne(java.net.http.HttpClient http, String endpoint, String apiKey, String model) {
        try {
            String payload = new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(Map.of(
                    "model", model,
                    "messages", List.of(Map.of("role", "user", "content", "hi")),
                    "max_tokens", 16));
            java.net.http.HttpRequest.Builder b = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(endpoint))
                    .timeout(java.time.Duration.ofSeconds(25))
                    .header("Content-Type", "application/json")
                    .POST(java.net.http.HttpRequest.BodyPublishers.ofString(payload));
            if (apiKey != null && !apiKey.isBlank()) b.header("Authorization", "Bearer " + apiKey);
            java.net.http.HttpResponse<String> r = http.send(b.build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            if (r.statusCode() < 200 || r.statusCode() >= 300) return null;
            com.fasterxml.jackson.databind.JsonNode usage =
                    new com.fasterxml.jackson.databind.ObjectMapper().readTree(r.body()).path("usage");
            com.fasterxml.jackson.databind.JsonNode details = usage.path("completion_tokens_details");
            if (details.isMissingNode() || !details.has("reasoning_tokens")) return null;   // 字段缺失≠不是推理模型
            return details.get("reasoning_tokens").asInt(0) > 0 ? ModelTypeGuess.REASONING : ModelTypeGuess.CHAT;
        } catch (Exception e) {
            return null;
        }
    }

    /** 由通道 baseUrl 推出 chat 端点（库里既有整条 /chat/completions 的，也有只到根的）。 */
    private static String chatEndpointOf(String baseUrl) {
        String root = baseUrl.trim();
        if (root.endsWith("/")) root = root.substring(0, root.length() - 1);
        if (root.endsWith("/chat/completions")) return root;
        if (root.endsWith("/v1")) return root + "/chat/completions";
        return root + "/v1/chat/completions";
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
