package com.imlwork.admin.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.imlwork.admin.model.ModelProvider;
import com.imlwork.admin.repository.ModelProviderRepository;
import com.imlwork.admin.security.JwtService;
import com.imlwork.admin.security.TokenEpochCache;
import io.jsonwebtoken.Claims;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 企业模型中转站核心：注册通道加权调度 + 容灾（{@link ModelRouterService}）、DLP 脱敏、
 * 无通道时回退单目标代理、最终回退演示 Mock。中转的 HTTP 状态码/头/原始 JSON 体
 * 本身就是业务结果，故方法直接返回 ResponseEntity；控制器只做鉴权塑形与委托。
 */
@Service
public class ModelProxyService {

    private static final Logger log = LoggerFactory.getLogger(ModelProxyService.class);

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${model-proxy.target-url:https://api.deepseek.com/v1/chat/completions}")
    private String targetUrl;

    @Value("${model-proxy.api-key:}")
    private String defaultApiKey;

    /**
     * 注册通道的正路已改走 {@link ModelStreamRelay}（流式 + TTFB/静默判死，不再按总时长掐）。
     * 这两档总超时只剩一个用户：无注册通道时的 legacy 单目标兜底代理（非流式，dev 场景）。
     *
     * 历史教训留档（为什么由调用方声明、不能网关猜）：曾按提示词长度估超时——生成类任务的
     * 特征恰恰是输入短、输出长（728 字符提示词写出 4300+ tokens、33s），必然误判；一刀切
     * 60s/25s 也都各翻过一次车。调用方自己最清楚在干什么，让它说（见 LONG_FLAG）。
     */
    private static final int TIMEOUT_SHORT_S = 60;
    private static final int TIMEOUT_LONG_S  = 180;

    /** 调用方声明「这是生成类任务」的内部标记。只在网关内部消费，**绝不透传给厂商**（未知字段会被拒）。 */
    private static final String LONG_FLAG = "iml_long_running";

    /**
     * 调用方声明「意图/判定类短调用，关思考换速度」的内部标记（与 LONG_FLAG 同纪律：网关消费后摘除）。
     *
     * 背景：主力通道是混合推理模型（deepseek-v4-flash），对「路由/判定/提炼」这类分类型小任务也先
     * 吐 reasoning_content——通道 1.4 万次请求实测平均时延 19.5s，是「任务理解慢」的主因。
     * 实测 2026-08-13：带 thinking={"type":"disabled"} 后同题 <1s 返回且无 reasoning_content
     * （enable_thinking=false 无效；reasoning_effort="none" 亦有效，取前者）。
     * 不认 thinking 参数的通道由摘参重发兜底（UpstreamParamReject 已列入 thinking）。
     */
    private static final String FAST_FLAG = "iml_fast";

    /** legacy 兜底代理的总超时档位（注册通道路径的超时判据在 ModelStreamRelay，与此无关）。 */
    private static int timeoutFor(Map<String, Object> payload) {
        boolean lng = payload != null && Boolean.TRUE.equals(payload.get(LONG_FLAG));
        return lng ? TIMEOUT_LONG_S : TIMEOUT_SHORT_S;
    }

    /** 开发兜底 corp-key；生产 profile 下沿用/为空则拒绝启动（与 JWT/HMAC/admin 口令同一纪律）。 */
    static final String DEV_DEFAULT_CORP_KEY = "sk-corp-default-key";

    /** 服务间共享密钥：客户端/FDE 调用 /model/chat 必须携带，防止未授权盗用企业模型额度。 */
    private final String corpKey;
    private final boolean prodProfile;

    private final GatewayMetrics metrics;
    private final ModelRouterService router;
    private final ModelStreamRelay streamRelay;
    private final ModelProviderRepository providerRepository;
    private final JwtService jwtService;
    private final TokenEpochCache tokenEpochs;

    public ModelProxyService(GatewayMetrics metrics, ModelRouterService router,
                             ModelStreamRelay streamRelay,
                             ModelProviderRepository providerRepository,
                             JwtService jwtService, TokenEpochCache tokenEpochs,
                             @Value("${model-proxy.corp-key:" + DEV_DEFAULT_CORP_KEY + "}") String corpKey,
                             @Value("${spring.profiles.active:}") String activeProfiles) {
        this.metrics = metrics;
        this.router = router;
        this.streamRelay = streamRelay;
        this.providerRepository = providerRepository;
        this.jwtService = jwtService;
        this.tokenEpochs = tokenEpochs;
        this.prodProfile = activeProfiles != null && activeProfiles.contains("prod");
        boolean weak = corpKey == null || corpKey.isBlank() || DEV_DEFAULT_CORP_KEY.equals(corpKey);
        if (weak) {
            if (prodProfile) {
                // corp-key 是 /model/chat（permitAll）的唯一闸；默认值写在源码里等于公开，生产必须显式配置。
                throw new IllegalStateException(
                        "生产环境必须显式配置企业模型网关密钥：model-proxy.corp-key（环境变量 MODEL_PROXY_CORP_KEY，不得使用开发默认值）。");
            }
            log.warn("⚠️ 模型网关使用了开发默认 corp-key，仅限本地开发。上生产前务必设置 model-proxy.corp-key。");
        }
        this.corpKey = corpKey;
    }

    /** 网关可用模型清单：别名 + 各启用通道（去重）。客户端 proxy 模式的模型选择器数据源。 */
    public Map<String, Object> gatewayModels() {
        java.util.LinkedHashSet<String> names = new java.util.LinkedHashSet<>();
        names.add(ModelTiers.ALL.get(0).alias());        // 兜底档恒下发
        java.util.List<Map<String, Object>> channels = new java.util.ArrayList<>();
        java.util.Set<String> types = new java.util.LinkedHashSet<>();
        for (ModelProvider p : router.enabledProviders()) {
            if (p.getRouteKey() != null && !p.getRouteKey().isBlank()) names.add(p.getRouteKey().trim());
            if (p.getModel() != null && !p.getModel().isBlank()) names.add(p.getModel().trim());
            if (p.getModelType() != null) types.add(p.getModelType());
            channels.add(Map.of(
                    "name", p.getName() == null ? "" : p.getName(),
                    "model", p.getModel() == null ? "" : p.getModel(),
                    "routeKey", p.getRouteKey() == null ? "" : p.getRouteKey(),
                    "modelType", p.getModelType()));
        }
        // 非兜底档只在真有该类型通道时给别名，免得客户端选了个空路由（网关会 fail-open
        // 回默认池，但用户以为自己换了模型）。档位定义与文案的唯一来源是 ModelTiers。
        java.util.List<Map<String, Object>> tiers = ModelTiers.describe(types);
        for (Map<String, Object> t : tiers) {
            if (Boolean.TRUE.equals(t.get("available"))) names.add(String.valueOf(t.get("alias")));
        }
        return Map.of("models", new java.util.ArrayList<>(names), "channels", channels, "tiers", tiers);
    }

    /**
     * 多媒体生成转发（图片 / 视频）：与 /chat 同样按通道路由、同样只在网关持厂商密钥。
     *
     * 为什么必须经网关而不是让客户端直连：厂商密钥只存服务端是红线。客户端拿 corp-key 调这里，
     * 网关用通道自己的 key 打上游——与 /chat 完全同一套信任模型。
     *
     * 与 /chat 的不同：不做 DLP（提示词是用户要画的东西，没有手机号/身份证语义，
     * 而 base64 图生图载荷经脱敏反而会被改坏），也不覆盖 model（调用方指定要哪个生成模型）。
     *
     * @param path     上游相对路径，如 /images/generations、/videos
     * @param wantType 该能力对应的通道类型（走 modelType 过滤，与档位路由同构）
     */
    public ResponseEntity<?> mediaGenerate(Map<String, Object> payload, String path, String wantType, int timeoutS) {
        // 同类通道优先，且**不看健康状态**：探活对生成类通道只是间接判据，
        // 而回落去打对话通道是必然失败的（DeepSeek 不认 /images/generations）。
        List<ModelProvider> candidates = router.providersOfType(wantType);
        if (candidates.isEmpty()) {
            // 压根没登记该类型的通道 → 才回落到全部启用通道（同厂商的对话通道往往同源可用）
            candidates = router.enabledProviders();
        }
        if (candidates.isEmpty()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("error", Map.of("message", "没有可用的模型通道", "type", "no_provider")));
        }
        String lastError = "no upstream reached";
        int lastStatus = 502;
        for (ModelProvider p : candidates) {
            // 每条通道允许一次连接级重试，见 isStaleConnection 的注释。
            for (int attempt = 0; attempt < 2; attempt++) {
                long start = System.currentTimeMillis();
                try {
                    String url = ModelRouterService.siblingEndpoint(p.getBaseUrl(), path);
                    HttpRequest.Builder b = HttpRequest.newBuilder()
                            .uri(URI.create(url))
                            .header("Content-Type", "application/json")
                            .timeout(Duration.ofSeconds(timeoutS))
                            .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(payload)));
                    if (p.getApiKey() != null && !p.getApiKey().isBlank()) {
                        b.header("Authorization", "Bearer " + p.getApiKey());
                    }
                    log.info("[Relay Station] Media '{}' via provider '{}' at {}{}", path, p.getName(), url,
                            attempt > 0 ? " (retry)" : "");
                    HttpResponse<String> res = httpClient.send(b.build(), HttpResponse.BodyHandlers.ofString());
                    long latency = System.currentTimeMillis() - start;
                    if (res.statusCode() >= 200 && res.statusCode() < 300) {
                        log.info("[Relay Station] Media served by '{}' in {}ms", p.getName(), latency);
                        return ResponseEntity.ok().header("Content-Type", "application/json").body(res.body());
                    }
                    lastStatus = res.statusCode();
                    lastError = res.body();
                    log.warn("[Relay Station] Media provider '{}' returned {}", p.getName(), res.statusCode());
                    break;   // 上游给了明确 HTTP 错误码 → 重试没有意义，换下一条通道
                } catch (Exception e) {
                    lastError = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                    log.warn("[Relay Station] Media provider '{}' failed: {}", p.getName(), lastError);
                    if (attempt == 0 && isStaleConnection(e)) continue;
                    break;
                }
            }
        }
        return ResponseEntity.status(lastStatus)
                .body(Map.of("error", Map.of("message", "多媒体生成失败：" + lastError, "type", "upstream_error")));
    }

    /**
     * 这个异常是不是"连接池里那条连接已经被上游关掉了"。
     *
     * 实测过：同一条通道第一次 23s 正常出图，5 分钟后再打就挂 97s 然后 EOF——
     * Java HttpClient 复用了 keep-alive 连接，而上游早已单方面关闭。
     * 这类失败请求**根本没到达上游**，重试一次就好；换成 HTTP 错误码那种"上游明确拒绝"，
     * 重试只是白等，所以只对连接级异常重试。
     *
     * 提交视频任务时重试理论上可能造成重复任务，但前提是请求真的到过上游——
     * 而这几种签名恰恰意味着没到。相比"用户直接看到生成失败"，这个残余风险更值得承担。
     */
    private static boolean isStaleConnection(Exception e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (!(t instanceof java.io.IOException)) continue;
            String m = t.getMessage() == null ? "" : t.getMessage().toLowerCase();
            if (m.contains("eof reached") || m.contains("connection reset")
                    || m.contains("goaway") || m.contains("connection was closed")
                    || m.contains("broken pipe")) return true;
        }
        return false;
    }

    /** 多媒体任务状态查询（视频是异步任务：先提交拿 task_id，再轮询）。 */
    public ResponseEntity<?> mediaStatus(String path, String wantType, int timeoutS) {
        List<ModelProvider> candidates = router.providersOfType(wantType);
        if (candidates.isEmpty()) candidates = router.enabledProviders();
        for (ModelProvider p : candidates) {
            try {
                String url = ModelRouterService.siblingEndpoint(p.getBaseUrl(), path);
                HttpRequest.Builder b = HttpRequest.newBuilder()
                        .uri(URI.create(url)).timeout(Duration.ofSeconds(timeoutS)).GET();
                if (p.getApiKey() != null && !p.getApiKey().isBlank()) {
                    b.header("Authorization", "Bearer " + p.getApiKey());
                }
                HttpResponse<String> res = httpClient.send(b.build(), HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() >= 200 && res.statusCode() < 300) {
                    return ResponseEntity.ok().header("Content-Type", "application/json").body(res.body());
                }
            } catch (Exception e) {
                log.warn("[Relay Station] Media status via '{}' failed: {}", p.getName(), e.getMessage());
            }
        }
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                .body(Map.of("error", Map.of("message", "任务状态查询失败", "type", "upstream_error")));
    }

    /**
     * 网关鉴权，两种凭证任一即通行：
     * ① 员工登录 JWT（客户端登录后零配置——登录态即模型权限，吊销跟随账号纪元：改密/强制下线立即失效）；
     * ② 服务间共享密钥 corp-key（FDE 工作台、脚本等无登录态场景的备用通道）。
     * 厂商密钥仍只存服务端，两种凭证都拿不到上游 key。
     */
    public boolean authorized(String authHeader) {
        if (authHeader == null || !authHeader.startsWith("Bearer ")) return false;
        String token = authHeader.substring(7).trim();
        if (token.equals(corpKey)) return true;
        try {
            Claims c = jwtService.parse(token);
            long tokenEp = c.get("ep") instanceof Number n ? n.longValue() : 0L;
            long currentEp = tokenEpochs.current(c.getSubject());
            if (tokenEp != currentEp) {
                // 被拒必须留痕（不含令牌本体）：静默 401 曾让「刚登录就被拒」的现场排查只能靠猜
                log.warn("[Gateway] JWT 纪元不符被拒：sub={} tokenEp={} currentEp={}（改密/强制下线后的旧令牌，或用户不存在）",
                        c.getSubject(), tokenEp, currentEp);
                return false;
            }
            return true;
        } catch (Exception e) {
            log.warn("[Gateway] 凭证被拒：既非本环境 corp-key，也非本环境可解析的 JWT（{}: {}）",
                    e.getClass().getSimpleName(), e.getMessage());
            return false;
        }
    }

    /** 服务端内部调用（SkillLlmHelper / SkillCreator / Expert 面试官等）的入口：恒聚合返回。 */
    public ResponseEntity<?> chat(Map<String, Object> payload) {
        return chat(payload, null);
    }

    /**
     * 中转入口：优先走注册通道的流式中继（{@link ModelStreamRelay}——上游恒流式，
     * 思考/生成再久只要增量在流动就不超时），无通道回退单目标代理，最终回退 Mock。
     *
     * 调用方带 stream=true 且给了 streamTarget → SSE 原样透传直写 servlet 响应，
     * 此时返回 null（= 请求已处理，控制器原样返回 null 即可）；否则网关内聚合成
     * 非流式 JSON（FDE 工作台等老消费端零改动）。
     */
    public ResponseEntity<?> chat(Map<String, Object> payload,
                                  jakarta.servlet.http.HttpServletResponse streamTarget) {
        String model = (String) payload.getOrDefault("model", "deepseek-chat");
        List<?> messages = (List<?>) payload.get("messages");
        boolean longTask = Boolean.TRUE.equals(payload.get(LONG_FLAG));
        boolean wantStream = Boolean.TRUE.equals(payload.get("stream")) && streamTarget != null;

        log.info("[Relay Station] Intercepted Request | Model: {} | Messages: {} | {}任务 | {}",
                model, (messages != null ? messages.size() : 0), longTask ? "长" : "短",
                wantStream ? "SSE 透传" : "聚合返回");

        // 内部标记只在网关消费，转发给厂商前摘掉（DeepSeek/OpenAI 见到未知字段会 400）。
        Map<String, Object> clean = new HashMap<>(payload);
        clean.remove(LONG_FLAG);
        boolean fast = Boolean.TRUE.equals(payload.get(FAST_FLAG));
        clean.remove(FAST_FLAG);
        if (fast && !clean.containsKey("thinking")) {
            // 短判定关思考（见 FAST_FLAG 注释）。调用方显式传了 thinking 时以调用方为准。
            clean.put("thinking", Map.of("type", "disabled"));
        }

        // Preferred path: stream across the registered relay-station providers.
        List<ModelProvider> candidates = router.candidates(model);
        if (!candidates.isEmpty()) {
            ResponseEntity<?> res = streamRelay.relay(clean, candidates, wantStream ? streamTarget : null, longTask);
            if (res == ModelStreamRelay.STREAM_WRITTEN) return null;   // SSE 已直写响应
            if (res != null) return res;
            // 所有候选通道都没配密钥：非 prod 回退演示 Mock 保住离线演示，prod 如实报错。
            metrics.recordRequest(0, 0, false);
            if (prodProfile) return noUpstreamError();
            return returnMockResponse(clean, model, messages);
        }

        // Legacy single-target proxy (used when no providers are registered).
        // 该兜底不支持流式：摘掉 stream 诚实退化成整体 JSON（客户端按 Content-Type 兼容两种响应）。
        clean.remove("stream");
        clean.remove("stream_options");
        return legacyProxy(clean, model, messages, timeoutFor(payload));
    }

    /** Legacy behavior: resolve a single key (config / env) and forward to one target. */
    private ResponseEntity<?> legacyProxy(Map<String, Object> payload,
                                          String model, List<?> messages, int timeoutS) {
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
            if (prodProfile) {
                log.error("[Relay Station] 生产环境无任何可用上游密钥 — 如实报 503。");
                return noUpstreamError();
            }
            log.warn("[Relay Station] No provider registered and no API key resolved — returning mock.");
            return returnMockResponse(payload, model, messages);
        }

        try {
            String sanitizedBody = DlpMasker.mask(objectMapper.writeValueAsString(payload));
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(targetUrl))
                    .header("Content-Type", "application/json")
                    .header("Authorization", resolvedKey)
                    .POST(HttpRequest.BodyPublishers.ofString(sanitizedBody))
                    .timeout(Duration.ofSeconds(timeoutS))
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

    /** prod 无可用上游：如实 503 + 明确错误码（演示 Mock 只在非 prod 生效）。 */
    private ResponseEntity<?> noUpstreamError() {
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .body(Map.of("error", "模型网关无可用上游通道：请在管理端「模型中转站」为通道配置密钥",
                        "code", "NO_UPSTREAM_KEY", "success", false));
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

    /** 网关运行统计：请求量/Token 总量 + 加权平均时延 + 活跃通道数。 */
    @Transactional(readOnly = true)
    public Map<String, Object> stats() {
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
        return stats;
    }
}
