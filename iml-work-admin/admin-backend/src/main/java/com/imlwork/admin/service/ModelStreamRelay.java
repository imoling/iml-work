package com.imlwork.admin.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.imlwork.admin.model.ModelProvider;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 模型中转的<b>流式内核</b>：上游一律以 stream=true 调用，超时判据从「总时长」换成
 * 「链路是否还在动」。这是 2026-08-13 排障的治本改造——
 *
 * <p>旧模式（等完整响应 + 180s 总闸）的死因：思考模型（DeepSeek v4 系等）非流式时
 * 要等<b>思考+正文全部生成完</b>才回包，长推理任务 3~10 分钟是正常水平，180s 一刀切
 * 必然误杀；而同一模型在官方 App 里"感觉很快"，是因为官方走流式、首个思考增量 1~2s
 * 就到了。开源网关（one-api / new-api / OpenRouter 同类）也是同一套做法：
 * 上游恒流式，超时只卡「首包」与「增量间静默」，容灾只在首个增量之前做。
 *
 * <p>三道闸，取代一刀切总时长：
 * <ul>
 *   <li><b>TTFB {@value #TTFB_S}s</b>：响应头必须按时到（流式下头部先行，思考中也会先吐
 *       reasoning 增量）。这是判「通道死没死」的闸——到点即容灾换通道，比旧 60s 快。</li>
 *   <li><b>静默 {@value #IDLE_GAP_S}s</b>：相邻增量之间的最大间隔。只要模型还在思考/输出，
 *       增量就不会断，静默这么久才是真卡死。</li>
 *   <li><b>总兜底</b>（短 {@value #TOTAL_CAP_SHORT_S}s / 长 {@value #TOTAL_CAP_LONG_S}s）：
 *       防跑飞的安全网，正常流动的响应不应撞到。</li>
 * </ul>
 *
 * <p>两种出口：调用方带 stream=true → <b>SSE 原样透传</b>（客户端自己消费增量，
 * 首字到达即证明链路活着）；不带 → 网关内<b>聚合</b>成标准非流式 JSON（FDE 工作台等
 * 老消费端零改动受益）。容灾纪律：只在<b>一个增量都没收到</b>时换下一条通道；
 * 已经开始输出后中断，如实报错（换通道重生成会话就不连贯了，且 token 已计费）。
 */
@Service
public class ModelStreamRelay {

    private static final Logger log = LoggerFactory.getLogger(ModelStreamRelay.class);

    /** 响应头到达时限。流式下头部先行——到不了说明通道真死了，立刻容灾换通道。 */
    private static final int TTFB_S = 60;
    /** 相邻两个增量间允许的最大静默。流一直在动就永不判死，停这么久才算卡死。 */
    private static final int IDLE_GAP_S = 90;
    /** 短任务（路由/判定，已带 iml_fast 关思考）的总兜底。 */
    private static final int TOTAL_CAP_SHORT_S = 240;
    /** 长任务（写脚本/长文/深思考）的总兜底：64k 预算的整站生成流式输出 15 分钟+是正常水平。 */
    private static final int TOTAL_CAP_LONG_S = 1800;

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    private final ObjectMapper objectMapper = new ObjectMapper();

    /** 静默看门狗：到点直接 close 上游流，阻塞中的 readLine 立刻以 IOException 醒来。 */
    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "model-stream-watchdog");
        t.setDaemon(true);
        return t;
    });

    private final GatewayMetrics metrics;
    private final ModelRouterService router;

    public ModelStreamRelay(GatewayMetrics metrics, ModelRouterService router) {
        this.metrics = metrics;
        this.router = router;
    }

    /**
     * 透传模式已把 SSE 直接写进 servlet 响应时的标记返回值——控制器据此返回 null
     * （HttpEntityMethodProcessor 对 null 视为「请求已处理」）。不能走 StreamingResponseBody：
     * 控制器声明类型是 ResponseEntity&lt;?&gt;，返回值处理器按声明匹配、认不出运行时的
     * 流式 body，直接 500 "No converter"（2026-08-13 真跑实锤）。虚拟线程下同步直写零成本。
     */
    public static final ResponseEntity<Object> STREAM_WRITTEN = ResponseEntity.ok().build();

    /**
     * 经注册通道的流式中转。passthroughTo 非空 → 原样转发 SSE 直写该 servlet 响应
     * （成功时返回 {@link #STREAM_WRITTEN}）；为空 → 网关内聚合成完整 chat.completion JSON。
     * 返回 null 表示所有候选通道都没配密钥——由调用方决定回退演示 Mock（非 prod）还是如实 503（prod）。
     */
    public ResponseEntity<?> relay(Map<String, Object> payload, List<ModelProvider> candidates,
                                   HttpServletResponse passthroughTo, boolean longTask) {
        boolean passthrough = passthroughTo != null;
        String lastError = "no upstream reached";
        int lastStatus = 502;
        boolean anyKeyed = false;
        // 每条通道的失败明细：单通道超时曾被「所有上游模型通道均不可用」伪装成全网故障
        List<String> attempts = new ArrayList<>();
        int totalCapS = longTask ? TOTAL_CAP_LONG_S : TOTAL_CAP_SHORT_S;

        for (ModelProvider p : candidates) {
            boolean keyed = p.getApiKey() != null && !p.getApiKey().isBlank();
            anyKeyed = anyKeyed || keyed;
            long start = System.currentTimeMillis();

            Map<String, Object> body = new HashMap<>(payload);
            if (p.getModel() != null && !p.getModel().isBlank()) {
                body.put("model", p.getModel());
            }
            // 调用方没给 max_tokens 时下发产品默认（混合推理模型会把厂商 4k 默认预算全烧在
            // 思考上、正文返回空串，见 ModelOutputBudget 的实测记录）。
            int cap = ModelOutputBudget.resolve(p.getMaxOutputTokens(), p.getModelType());
            if (!body.containsKey("max_tokens") && cap > 0) {
                body.put("max_tokens", cap);
            }
            body.put("stream", Boolean.TRUE);
            // usage 在最后一个增量块里带回（OpenAI 兼容语义）；不认这个参数的通道由摘参重发兜底
            if (!body.containsKey("stream_options")) {
                body.put("stream_options", Map.of("include_usage", Boolean.TRUE));
            }
            String url = ModelRouterService.normalizeChatUrl(p.getBaseUrl());
            String key = keyed ? p.getApiKey() : null;

            try {
                log.info("[Relay Station] Streaming via '{}' ({}) at {} | TTFB {}s / 静默 {}s / 兜底 {}s / {}",
                        p.getName(), p.getId(), url, TTFB_S, IDLE_GAP_S, totalCapS,
                        passthrough ? "SSE 透传" : "网关聚合");
                HttpResponse<InputStream> res = openStream(url, body, key);

                // 非 2xx：走「摘被拒可选参数重发」（与非流式时代同一 fail-open 纪律，
                // 绝不因 temperature/max_tokens/stream_options 这类可选参数把可用通道判死）
                String errBody = null;
                boolean budgetFallbackTried = false;
                while (res.statusCode() < 200 || res.statusCode() >= 300) {
                    errBody = readAll(res);
                    String rejected = UpstreamParamReject.rejectedParam(res.statusCode(), errBody, body);
                    if (rejected == null) break;
                    if ("max_tokens".equals(rejected) && !budgetFallbackTried && cap > 0
                            && !Integer.valueOf(cap).equals(body.get("max_tokens"))) {
                        // 调用方显式给的大预算被拒：先回退到通道默认预算，而不是直接摘掉——
                        // 摘掉＝厂商默认 4k，混合推理模型会把它全烧在思考上返回空正文
                        // （见 ModelOutputBudget 实测记录）。回退值仍被拒时下一轮才真摘。
                        budgetFallbackTried = true;
                        log.warn("[Relay Station] Provider '{}' 拒绝 max_tokens={}，回退通道默认 {} 重发",
                                p.getName(), body.get("max_tokens"), cap);
                        body.put("max_tokens", cap);
                    } else {
                        log.warn("[Relay Station] Provider '{}' 拒绝参数 {}={}，摘掉该参数重发",
                                p.getName(), rejected, body.get(rejected));
                        body.remove(rejected);
                    }
                    res = openStream(url, body, key);
                    errBody = null;
                }
                if (res.statusCode() < 200 || res.statusCode() >= 300) {
                    router.recordResult(p.getId(), false, System.currentTimeMillis() - start);
                    lastStatus = res.statusCode();
                    lastError = errBody == null ? "" : errBody;
                    attempts.add("「" + p.getName() + "」HTTP " + lastStatus + "：" + truncate(lastError, 160));
                    log.warn("[Relay Station] Provider '{}' returned {} — failing over", p.getName(), lastStatus);
                    continue;
                }

                if (passthrough) {
                    return passthroughServlet(p, res, passthroughTo, start, totalCapS);
                }
                ResponseEntity<?> aggregated = aggregateResponse(p, res, start, totalCapS);
                if (aggregated != null) return aggregated;
                // 一个增量都没收到就断了 → 当作该通道失败，换下一条
                lastStatus = 502;
                lastError = "上游流建立后未吐出任何增量即中断";
                attempts.add("「" + p.getName() + "」" + lastError);
            } catch (Exception e) {
                router.recordResult(p.getId(), false, System.currentTimeMillis() - start);
                lastError = (e instanceof java.net.http.HttpTimeoutException)
                        ? TTFB_S + "s 内未给出响应头（通道不通或上游过载；流式下头部先行，这不是任务太长）"
                        : String.valueOf(e.getMessage());
                attempts.add("「" + p.getName() + "」" + truncate(lastError, 160));
                log.warn("[Relay Station] Provider '{}' stream error: {} — failing over", p.getName(), lastError);
            }
        }

        if (!anyKeyed) return null;

        metrics.recordRequest(0, 0, false);
        String hint = candidates.size() == 1
                ? "当前仅启用了这 1 条对话通道、无备用可切换，请稍后重试或在管理端再启用一条备用通道"
                : "已依次尝试 " + candidates.size() + " 条通道均失败，请稍后重试";
        return ResponseEntity.status(lastStatus)
                .body(Map.of("error", "模型通道调用失败——" + String.join("；", attempts) + "。" + hint,
                        "success", false));
    }

    /**
     * 建立一次流式上游连接，TTFB 闸用 sendAsync + get(超时) 实现：ofInputStream 的
     * future 在**响应头到达**时即完成，正好是纯首包语义。
     *
     * ⚠️ 绝不能改回 HttpRequest.timeout：它不是「管到响应头」而是管到**正文读完**——
     * 真跑实锤（2026-08-13）：聚合读流在 60.08s 处被整体取消（"closed"），增量明明在流动。
     */
    private HttpResponse<InputStream> openStream(String url, Map<String, Object> body, String apiKey)
            throws Exception {
        String sanitized = DlpMasker.mask(objectMapper.writeValueAsString(body));
        HttpRequest.Builder b = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(sanitized));
        if (apiKey != null && !apiKey.isBlank()) {
            b.header("Authorization", "Bearer " + apiKey);
        }
        var future = httpClient.sendAsync(b.build(), HttpResponse.BodyHandlers.ofInputStream());
        try {
            return future.get(TTFB_S, TimeUnit.SECONDS);
        } catch (java.util.concurrent.TimeoutException te) {
            future.cancel(true);
            throw new java.net.http.HttpTimeoutException(TTFB_S + "s 内未给出响应头");
        } catch (java.util.concurrent.ExecutionException ee) {
            throw ee.getCause() instanceof Exception ex ? ex : ee;
        }
    }

    /**
     * 聚合模式：读完整条流折叠成非流式 JSON。返回 null = 一个增量都没收到（可容灾换通道）；
     * 已有增量后中断则如实 502（不换通道重生成——token 已计费且重跑结果不连贯）。
     */
    private ResponseEntity<?> aggregateResponse(ModelProvider p, HttpResponse<InputStream> res,
                                                long start, int totalCapS) {
        SseChunkAggregator agg = new SseChunkAggregator();
        InputStream in = res.body();
        AtomicLong lastRead = new AtomicLong(System.currentTimeMillis());
        AtomicReference<String> killReason = new AtomicReference<>("");
        ScheduledFuture<?> guard = armGuard(in, lastRead, start + totalCapS * 1000L, totalCapS, killReason);
        String abnormal = null;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                lastRead.set(System.currentTimeMillis());
                if (agg.feed(line)) break;   // [DONE]
            }
        } catch (IOException e) {
            abnormal = "读流中断：" + e.getMessage();
        } finally {
            guard.cancel(false);
            closeQuietly(in);
        }
        // 看门狗 close 触发的 IOException/EOF，报看门狗的判定而不是裸的 "stream closed"
        if (!killReason.get().isEmpty()) abnormal = killReason.get();
        long latency = System.currentTimeMillis() - start;

        if (!agg.sawAnyDelta()) {
            router.recordResult(p.getId(), false, latency);
            log.warn("[Relay Station] Provider '{}' 流无任何增量即终止（{}）",
                    p.getName(), abnormal != null ? abnormal : orEmpty(agg.streamError(), "上游关闭"));
            return null;
        }
        if (abnormal != null || !agg.streamError().isEmpty()) {
            router.recordResult(p.getId(), false, latency);
            metrics.recordRequest(0, 0, false);
            String why = abnormal != null ? abnormal : agg.streamError();
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body(Map.of("error", "模型生成中断（已输出部分内容后断流）：" + truncate(why, 200) + "。请重试",
                            "success", false));
        }

        long[] toks = agg.usageTokens();
        metrics.recordRequest(toks[0], toks[1], true);
        router.recordResult(p.getId(), true, latency, toks[0], toks[1]);
        log.info("[Relay Station] Aggregated stream from '{}' in {}ms | completion {} tok", p.getName(), latency, toks[1]);
        try {
            return ResponseEntity.ok()
                    .header("Content-Type", "application/json")
                    .header("X-Relay-Provider", p.getId())
                    .header("X-Relay-Vendor", p.getProvider() == null ? "" : p.getProvider())
                    .header("X-Relay-Model", p.getModel() == null ? "" : p.getModel())
                    .body(objectMapper.writeValueAsString(agg.toResponse()));
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("error", "聚合响应序列化失败：" + e.getMessage(), "success", false));
        }
    }

    /** 透传模式：容灾已在 2xx 建立前完成，这里把上游 SSE 原样泵进 servlet 响应并顺带计量。 */
    private ResponseEntity<?> passthroughServlet(ModelProvider p, HttpResponse<InputStream> res,
                                                 HttpServletResponse client, long start, int totalCapS)
            throws java.io.IOException {
        client.setStatus(200);
        client.setContentType("text/event-stream;charset=UTF-8");
        client.setHeader("Cache-Control", "no-cache");
        // nginx 反代下禁响应缓冲，SSE 增量才能逐块到达客户端
        client.setHeader("X-Accel-Buffering", "no");
        client.setHeader("X-Relay-Provider", p.getId());
        client.setHeader("X-Relay-Vendor", p.getProvider() == null ? "" : p.getProvider());
        client.setHeader("X-Relay-Model", p.getModel() == null ? "" : p.getModel());
        pump(p, res.body(), client.getOutputStream(), start, totalCapS);
        return STREAM_WRITTEN;
    }

    private void pump(ModelProvider p, InputStream in, OutputStream out, long start, int totalCapS) {
        // 顺带喂聚合器：不为拼正文，只为从流里拿 usage/是否有增量，供计量与通道健康度
        SseChunkAggregator agg = new SseChunkAggregator();
        AtomicLong lastRead = new AtomicLong(System.currentTimeMillis());
        AtomicReference<String> killReason = new AtomicReference<>("");
        ScheduledFuture<?> guard = armGuard(in, lastRead, start + totalCapS * 1000L, totalCapS, killReason);
        boolean clean = false;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                lastRead.set(System.currentTimeMillis());
                boolean finished = agg.feed(line);
                out.write(line.getBytes(StandardCharsets.UTF_8));
                out.write('\n');
                out.flush();
                if (finished) {
                    clean = true;
                    break;
                }
            }
            // 个别厂商不发 [DONE] 直接关流：有增量的正常 EOF 也算完整
            if (!clean && agg.sawAnyDelta() && killReason.get().isEmpty()) clean = true;
        } catch (IOException e) {
            String why = orEmpty(killReason.get(), "上游断流或客户端断开：" + e.getMessage());
            // 尽力把中断原因作为标准 error 事件递给客户端；写失败说明客户端已断，忽略即可
            try {
                out.write(("data: " + objectMapper.writeValueAsString(
                        Map.of("error", Map.of("message", why))) + "\n\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
            } catch (Exception ignored) {
                // 客户端侧已断开，无处可送
            }
            log.warn("[Relay Station] Passthrough via '{}' 中断：{}", p.getName(), why);
        } finally {
            guard.cancel(false);
            closeQuietly(in);
            long latency = System.currentTimeMillis() - start;
            long[] toks = agg.usageTokens();
            metrics.recordRequest(toks[0], toks[1], clean);
            if (clean) {
                router.recordResult(p.getId(), true, latency, toks[0], toks[1]);
            } else {
                router.recordResult(p.getId(), false, latency);
            }
            log.info("[Relay Station] Passthrough via '{}' {} | {}ms | completion {} tok",
                    p.getName(), clean ? "完成" : "中断", latency, toks[1]);
        }
    }

    /**
     * 看门狗：静默超限或撞总兜底时 close 上游流——阻塞中的 readLine 立刻醒来，
     * 这是 java.net.http 流式读唯一可靠的异步打断方式（读本身不接受超时参数）。
     */
    private ScheduledFuture<?> armGuard(InputStream in, AtomicLong lastRead, long deadlineMs,
                                        int totalCapS, AtomicReference<String> killReason) {
        return watchdog.scheduleAtFixedRate(() -> {
            long now = System.currentTimeMillis();
            String reason = null;
            if (now - lastRead.get() > IDLE_GAP_S * 1000L) {
                reason = "上游流静默超过 " + IDLE_GAP_S + "s（增量停止，判定卡死）";
            } else if (now > deadlineMs) {
                reason = "总时长超过兜底上限 " + totalCapS + "s";
            }
            if (reason != null) {
                killReason.compareAndSet("", reason);
                try {
                    in.close();
                } catch (IOException ignored) {
                    // close 本身失败无补救，读线程会以其他方式退出
                }
            }
        }, 5, 5, TimeUnit.SECONDS);
    }

    private static String readAll(HttpResponse<InputStream> res) {
        try (InputStream in = res.body()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "读取上游错误响应失败：" + e.getMessage();
        }
    }

    private static void closeQuietly(InputStream in) {
        try {
            in.close();
        } catch (IOException ignored) {
            // 收尾清理，失败无补救
        }
    }

    private static String orEmpty(String s, String fallback) {
        return s == null || s.isEmpty() ? fallback : s;
    }

    /** 错误明细截断：上游 body 可能是整页 HTML/长 JSON，进错误文案前掐到可读长度。 */
    private static String truncate(String s, int max) {
        if (s == null) return "";
        String t = s.strip();
        return t.length() <= max ? t : t.substring(0, max) + "…";
    }
}
