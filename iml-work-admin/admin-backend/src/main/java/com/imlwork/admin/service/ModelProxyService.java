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
     * 上游超时 —— 由**调用方声明**任务类型，一刀切和网关自己猜都会翻车。
     *
     * 一刀切栽过两次：
     *   · 60s：一个卡住的通道要白等整整一分钟才转移，而路由/意图解析本该 1~3s → 用户「任务理解特别慢」。
     *   · 25s：生成类任务被腰斩 —— 写一份 PPT 的 Python 脚本实测要 33s（输出 4371 tokens），
     *     25s 掐断、两通道各掐一次 → 「所有上游模型通道均不可用」，而模型明明能答。
     *
     * 之后试过让网关按**提示词长度**猜，同样错：生成类的特征恰恰是**输入短、输出长** ——
     * 728 字符的提示词让模型写出 4300+ tokens、耗时 33s，却因输入短被判成「该快速失败」。
     * 输入长度和耗时没有因果关系，猜不出来。调用方自己最清楚在干什么，让它说（见 LONG_FLAG）。
     */
    private static final int TIMEOUT_SHORT_S = 30;    // 意图解析 / 路由 / 判定：本该秒级，卡住就快速转移
    private static final int TIMEOUT_LONG_S  = 180;   // 生成类（写脚本/长文）：实测 30~60s 是常态，给足余量

    /** 调用方声明「这是生成类任务」的内部标记。只在网关内部消费，**绝不透传给厂商**（未知字段会被拒）。 */
    private static final String LONG_FLAG = "iml_long_running";

    /**
     * 超时判据：**由调用方声明**，网关不猜。
     *
     * 曾按「提示词字符数」估长短，错得很彻底：生成类任务的特征恰恰是**输入短、输出长** ——
     * 实测 728 字符的提示词让模型写出 4300+ tokens 的 PPT 脚本、耗时 33s，却因输入短被判成
     * 「该快速失败」，在模型答完前掐断，两个通道各掐一次 → 用户看到「所有上游模型通道均不可用」。
     * 而调用方自己最清楚在干什么：路由/判定传短，写脚本/长文传 iml_long_running。
     */
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
    private final ModelProviderRepository providerRepository;
    private final JwtService jwtService;
    private final TokenEpochCache tokenEpochs;

    public ModelProxyService(GatewayMetrics metrics, ModelRouterService router,
                             ModelProviderRepository providerRepository,
                             JwtService jwtService, TokenEpochCache tokenEpochs,
                             @Value("${model-proxy.corp-key:" + DEV_DEFAULT_CORP_KEY + "}") String corpKey,
                             @Value("${spring.profiles.active:}") String activeProfiles) {
        this.metrics = metrics;
        this.router = router;
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
            return tokenEp == tokenEpochs.current(c.getSubject());
        } catch (Exception e) {
            return false;   // 非法/过期 token 一律拒，静默即可（401 由调用方返回）
        }
    }

    /** 中转入口：优先走注册通道调度，无通道回退单目标代理，最终回退 Mock。 */
    public ResponseEntity<?> chat(Map<String, Object> payload) {
        String model = (String) payload.getOrDefault("model", "deepseek-chat");
        List<?> messages = (List<?>) payload.get("messages");

        int timeoutS = timeoutFor(payload);
        log.info("[Relay Station] Intercepted Request | Model: {} | Messages: {} | 上游超时 {}s",
                model, (messages != null ? messages.size() : 0), timeoutS);

        // 内部标记只在网关消费，转发给厂商前摘掉（DeepSeek/OpenAI 见到未知字段会 400）。
        Map<String, Object> clean = new HashMap<>(payload);
        clean.remove(LONG_FLAG);

        // Preferred path: schedule across the registered relay-station providers.
        List<ModelProvider> candidates = router.candidates(model);
        if (!candidates.isEmpty()) {
            return routeThroughStation(clean, candidates, model, messages, timeoutS);
        }

        // Legacy single-target proxy (used when no providers are registered).
        return legacyProxy(clean, model, messages, timeoutS);
    }

    /**
     * Forward to the scheduled providers in order, failing over to the next on any
     * non-2xx or network error. Records live metrics on each provider row.
     */
    private ResponseEntity<?> routeThroughStation(Map<String, Object> payload,
                                                  List<ModelProvider> candidates,
                                                  String requestedModel, List<?> messages,
                                                  int timeoutS) {
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
                // 调用方没给 max_tokens 时下发**产品默认**（不再依赖管理员逐条配置——留空就走厂商 4k 默认，
                // 混合推理模型会把预算全烧在思考上、正文返回空串，见 ModelOutputBudget 的实测记录）。
                int cap = ModelOutputBudget.resolve(p.getMaxOutputTokens(), p.getModelType());
                if (!body.containsKey("max_tokens") && cap > 0) {
                    body.put("max_tokens", cap);
                }
                String url = ModelRouterService.normalizeChatUrl(p.getBaseUrl());

                log.info("[Relay Station] Routing to provider '{}' ({}) at {}", p.getName(), p.getId(), url);
                HttpResponse<String> response = sendUpstream(url, body, keyed ? p.getApiKey() : null, timeoutS);
                // 厂商不认某个**可选参数**（默认注入的 max_tokens、调用方为确定性带的 temperature 等）
                // → 摘掉该参数对同一通道重发，绝不因可选参数把一条可用通道判死（fail-open）。
                // 实测 2026-08-06：上游对 temperature=0 报 "only 1 is allowed for this model"，
                // 透传 400 让全部候选通道连坐判死，客户端只看到「空响应」。
                // 循环有界：只摘请求体里存在的参数，每轮摘一个（判定见 UpstreamParamReject）。
                for (String rejected; (rejected = UpstreamParamReject.rejectedParam(
                        response.statusCode(), response.body(), body)) != null; ) {
                    log.warn("[Relay Station] Provider '{}' 拒绝参数 {}={}，摘掉该参数重发",
                            p.getName(), rejected, body.get(rejected));
                    body.remove(rejected);
                    response = sendUpstream(url, body, keyed ? p.getApiKey() : null, timeoutS);
                }
                long latency = System.currentTimeMillis() - start;

                if (response.statusCode() >= 200 && response.statusCode() < 300) {
                    long[] toks = parseUsage(response.body());
                    metrics.recordRequest(toks[0], toks[1], true);
                    router.recordResult(p.getId(), true, latency, toks[0], toks[1]);
                    log.info("[Relay Station] Served by '{}' in {}ms", p.getName(), latency);
                    // 回传**真正服务本次请求的上游**：厂商 + 上游模型名。
                    // 不回传的话，客户端只知道"我调了网关"，审计里就只能记 GATEWAY/corp-default，
                    // 而单价是按厂商/模型配的 → 永远匹配不到 → 计费覆盖恒为 0%、费用恒为 ¥0.00。
                    return ResponseEntity.ok()
                            .header("Content-Type", "application/json")
                            .header("X-Relay-Provider", p.getId())
                            .header("X-Relay-Vendor", p.getProvider() == null ? "" : p.getProvider())
                            .header("X-Relay-Model", p.getModel() == null ? "" : p.getModel())
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
        // 仅限非 prod：生产密钥漏配必须如实报错，不能用演示文案掩盖故障、更不能写虚构 token 进计费统计。
        if (!anyKeyed) {
            if (prodProfile) return noUpstreamError();
            return returnMockResponse(payload, requestedModel, messages);
        }
        return ResponseEntity.status(lastStatus)
                .body(Map.of("error", "所有上游模型通道均不可用：" + lastError, "success", false));
    }

    /**
     * 向上游发一次 chat 请求：脱敏 → 建请求 → 发送。抽出来是为了让「摘掉 max_tokens 重发」
     * 复用同一套构造逻辑——两处各写一遍迟早漂移（漏了脱敏或漏了 Authorization 都是事故）。
     */
    private HttpResponse<String> sendUpstream(String url, Map<String, Object> body, String apiKey, int timeoutS)
            throws Exception {
        String sanitized = mask(objectMapper.writeValueAsString(body));
        HttpRequest.Builder b = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(timeoutS))
                .POST(HttpRequest.BodyPublishers.ofString(sanitized));
        if (apiKey != null && !apiKey.isBlank()) {
            b.header("Authorization", "Bearer " + apiKey);
        }
        return httpClient.send(b.build(), HttpResponse.BodyHandlers.ofString());
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
            String sanitizedBody = mask(objectMapper.writeValueAsString(payload));
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

    /** DLP masking of sensitive content (cell phone & national ID card) in the payload. */
    /** data: URL（base64 图片/文件）——DLP 必须绕开它，理由见 {@link #mask}。 */
    private static final java.util.regex.Pattern DATA_URL =
            java.util.regex.Pattern.compile("data:[a-zA-Z0-9.+/-]+;base64,[A-Za-z0-9+/=]+");

    /**
     * 出站前的 DLP 脱敏：手机号、身份证号。
     *
     * <p><b>必须先把 data: URL 摘出来</b>：脱敏是对整个请求 JSON 做正则替换，而 base64 是随机字符流，
     * 必然出现符合手机号/身份证模式的数字段——直接替换等于把图片数据改坏。
     * 症状极隐蔽：请求 200、路由正确、日志一切正常，唯独模型解不出图、返回空回答
     * （实测：同一张图直连厂商能正确描述，经网关就空）。任何 base64 载荷都会中招，不只图片。
     */
    private String mask(String payloadJson) {
        // ① 摘出 data: URL，用不可能出现在 JSON 文本里的哨兵占位
        java.util.List<String> stash = new java.util.ArrayList<>();
        java.util.regex.Matcher m = DATA_URL.matcher(payloadJson);
        StringBuilder buf = new StringBuilder();
        while (m.find()) {
            m.appendReplacement(buf, java.util.regex.Matcher.quoteReplacement("\u0000DLP" + stash.size() + "\u0000"));
            stash.add(m.group());
        }
        m.appendTail(buf);

        // ② 只对其余文本脱敏
        String sanitized = buf.toString()
                .replaceAll("(?<!\\d)1[3-9]\\d{9}(?!\\d)", "1**********")
                .replaceAll("(?<!\\d)\\d{17}[\\dXx](?!\\d)", "3****************X");
        boolean masked = !sanitized.equals(buf.toString());

        // ③ 原样还原 data: URL
        for (int i = 0; i < stash.size(); i++) {
            sanitized = sanitized.replace("\u0000DLP" + i + "\u0000", stash.get(i));
        }
        if (masked) {
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
