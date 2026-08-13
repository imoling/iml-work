package com.imlwork.admin.service;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * OpenAI 兼容 SSE 流的增量聚合器：把一行行 `data: {...}` 增量块折叠成一份标准的
 * 非流式 chat.completion JSON。
 *
 * <p>网关用它实现「上游走流式、对老消费端保持原契约」：思考模型只要还在吐增量
 * （reasoning_content 也算）就说明链路是活的，不该被总时长闸掐死——等完整响应的
 * 旧模式分不清「在思考」和「卡死了」，180s 一刀切把长推理全部误杀（2026-08-13 实锤）。
 *
 * <p>聚合覆盖：content / reasoning_content / tool_calls（按 index 拼接参数分片）/
 * finish_reason / usage（含 stream_options.include_usage 的末块）。纯状态机、无 IO，
 * 单元测试直接喂行即可。
 */
public final class SseChunkAggregator {

    private final ObjectMapper mapper = new ObjectMapper();

    private String id = "";
    private String model = "";
    private long created;
    private final StringBuilder content = new StringBuilder();
    private final StringBuilder reasoning = new StringBuilder();
    private String finishReason = "";
    private Map<String, Object> usage;
    private String streamError = "";
    private boolean sawDelta;
    private boolean done;

    private static final class ToolCallDraft {
        String id = "";
        String type = "function";
        String name = "";
        final StringBuilder args = new StringBuilder();
    }

    private final TreeMap<Integer, ToolCallDraft> toolCalls = new TreeMap<>();

    /**
     * 喂一行 SSE 原文。返回 true 表示流已终结（收到 [DONE]）。
     * 空行 / 注释行 / 非 data 行忽略；解析失败的单块跳过、不终结整个流
     * （可能是厂商私有心跳或被截断的块，下一块往往正常）。
     */
    public boolean feed(String rawLine) {
        if (done || rawLine == null) return done;
        String line = rawLine.strip();
        if (line.isEmpty() || line.startsWith(":") || !line.startsWith("data:")) return done;
        String data = line.substring(5).strip();
        if ("[DONE]".equals(data)) {
            done = true;
            return true;
        }
        try {
            merge(mapper.readValue(data, Map.class));
        } catch (Exception ignored) {
            // 单个坏块不致命，跳过等下一块
        }
        return done;
    }

    private void merge(Map<?, ?> chunk) {
        Object err = chunk.get("error");
        if (err != null) {
            streamError = (err instanceof Map<?, ?> m && m.get("message") != null)
                    ? String.valueOf(m.get("message")) : String.valueOf(err);
            return;
        }
        if (id.isEmpty() && chunk.get("id") != null) id = String.valueOf(chunk.get("id"));
        if (model.isEmpty() && chunk.get("model") != null) model = String.valueOf(chunk.get("model"));
        if (created == 0 && chunk.get("created") instanceof Number n) created = n.longValue();
        if (chunk.get("usage") instanceof Map<?, ?> u) usage = castMap(u);
        if (!(chunk.get("choices") instanceof List<?> choices) || choices.isEmpty()) return;
        if (!(choices.get(0) instanceof Map<?, ?> choice)) return;
        Object fr = choice.get("finish_reason");
        if (fr != null) finishReason = String.valueOf(fr);
        if (!(choice.get("delta") instanceof Map<?, ?> delta)) return;
        if (delta.get("content") instanceof String s && !s.isEmpty()) {
            content.append(s);
            sawDelta = true;
        }
        if (delta.get("reasoning_content") instanceof String s && !s.isEmpty()) {
            reasoning.append(s);
            sawDelta = true;
        }
        if (delta.get("tool_calls") instanceof List<?> tcs) {
            for (Object o : tcs) {
                if (!(o instanceof Map<?, ?> tc)) continue;
                int idx = tc.get("index") instanceof Number n ? n.intValue() : 0;
                ToolCallDraft draft = toolCalls.computeIfAbsent(idx, k -> new ToolCallDraft());
                if (tc.get("id") instanceof String s && !s.isEmpty()) draft.id = s;
                if (tc.get("type") instanceof String s && !s.isEmpty()) draft.type = s;
                if (tc.get("function") instanceof Map<?, ?> fn) {
                    // name 首块完整下发（OpenAI 语义），后续块若重复下发不能拼接成 "getXgetX"
                    if (fn.get("name") instanceof String s && !s.isEmpty() && draft.name.isEmpty()) draft.name = s;
                    if (fn.get("arguments") instanceof String s) draft.args.append(s);
                }
                sawDelta = true;
            }
        }
    }

    /** 是否收到过任何正文/思维链/工具调用增量——容灾判据：一个增量都没有才允许换通道重试。 */
    public boolean sawAnyDelta() {
        return sawDelta;
    }

    /** 上游在流中夹带的 error 块（如限流/内容审查中途报错）；无则空串。 */
    public String streamError() {
        return streamError;
    }

    /** [prompt_tokens, completion_tokens]；上游没给 usage 时为 0（计量口径与非流式一致）。 */
    public long[] usageTokens() {
        if (usage == null) return new long[]{0, 0};
        long p = usage.get("prompt_tokens") instanceof Number n ? n.longValue() : 0;
        long c = usage.get("completion_tokens") instanceof Number n ? n.longValue() : 0;
        return new long[]{p, c};
    }

    /** 折叠成标准非流式 chat.completion 响应体。 */
    public Map<String, Object> toResponse() {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("role", "assistant");
        message.put("content", content.toString());
        if (!reasoning.isEmpty()) message.put("reasoning_content", reasoning.toString());
        if (!toolCalls.isEmpty()) {
            List<Object> tcs = new ArrayList<>();
            for (Map.Entry<Integer, ToolCallDraft> e : toolCalls.entrySet()) {
                ToolCallDraft d = e.getValue();
                tcs.add(Map.of(
                        "index", e.getKey(),
                        "id", d.id,
                        "type", d.type,
                        "function", Map.of("name", d.name, "arguments", d.args.toString())));
            }
            message.put("tool_calls", tcs);
        }
        Map<String, Object> choice = new LinkedHashMap<>();
        choice.put("index", 0);
        choice.put("message", message);
        choice.put("finish_reason", finishReason.isEmpty() ? "stop" : finishReason);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id);
        out.put("object", "chat.completion");
        out.put("created", created);
        out.put("model", model);
        out.put("choices", List.of(choice));
        if (usage != null) out.put("usage", usage);
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Map<?, ?> m) {
        return (Map<String, Object>) m;
    }
}
