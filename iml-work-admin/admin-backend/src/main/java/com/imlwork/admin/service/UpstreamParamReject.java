package com.imlwork.admin.service;

import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 上游「拒绝可选参数」的识别策略——网关摘掉被拒参数对同一通道重发的判定依据。
 *
 * <p>网关对请求体全字段透传（架构约定：tools/tool_choice 等必须原样到厂商），但各厂商对
 * <b>可选调优参数</b>的容忍度不一：有的模型只认 temperature=1（实测 2026-08-06：
 * "invalid temperature: only 1 is allowed for this model"，来自客户端为确定性场景传的
 * temperature=0），有的不认我们默认注入的 max_tokens 上限。这些参数摘掉只降体验、不改语义，
 * 而透传报错的代价是<b>全通道连坐</b>：调度器把每个候选通道试一遍，同一参数在每个通道
 * 都 400，整条路由判死，客户端只看到「空响应」。
 *
 * <p>识别靠状态码 + 报文点名参数名：OpenAI 兼容的错误报文没有可依赖的结构化 param 字段，
 * 各厂商只有 message 文本是稳定线索。宁缺勿滥：只认 400/422——鉴权失败（401/403）、
 * 限流（429）报文里就算出现参数名也绝不摘参重试，那是在掩盖真故障。
 */
public final class UpstreamParamReject {
    private UpstreamParamReject() {}

    /**
     * 除 max_tokens（有专门的变体关键词，见 {@link ModelOutputBudget#rejectedForMaxTokens}）
     * 之外可摘除的调优参数。参数名本身就是报文识别关键词——OpenAI 兼容报错普遍会点名字段。
     */
    // stream_options 是流式中继默认注入的（要末块 usage 计量）；个别厂商只认 stream 不认它，摘掉只丢计量不丢功能。
    private static final List<String> TUNING_PARAMS =
            List.of("temperature", "top_p", "frequency_penalty", "presence_penalty", "thinking", "stream_options");

    /**
     * 本次请求体里被上游拒绝的可摘除参数；无则 null。
     * 一次只报一个（报文通常只点名第一个非法字段），调用方摘掉重发后再判——循环天然有界：
     * 只报请求体里存在的参数，且每轮摘掉一个。
     */
    public static String rejectedParam(int status, String respBody, Map<String, Object> sentBody) {
        if (status != 400 && status != 422) return null;
        if (sentBody.containsKey("max_tokens") && ModelOutputBudget.rejectedForMaxTokens(status, respBody)) {
            return "max_tokens";
        }
        String b = respBody == null ? "" : respBody.toLowerCase(Locale.ROOT);
        for (String p : TUNING_PARAMS) {
            if (sentBody.containsKey(p) && b.contains(p)) return p;
        }
        return null;
    }
}
