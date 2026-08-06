package com.imlwork.admin.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 摘参重发判定的回归钉子。
 *
 * <p>为什么值得钉：误判的两个方向代价都大——漏判则一个参数怪癖让全部候选通道连坐 400、
 * 客户端只看到「空响应」（2026-08-06 实测：temperature=0 被上游拒，排查绕了一整圈）；
 * 误判则把鉴权失败/真参数错误当参数怪癖无限兜底，掩盖真故障。下面每条断言对应一类真实报文。
 */
class UpstreamParamRejectTest {

    private static Map<String, Object> body(String... keys) {
        Map<String, Object> m = new HashMap<>();
        for (String k : keys) m.put(k, 0);
        return m;
    }

    @Test
    @DisplayName("实测报文：temperature 被拒（only 1 is allowed）→ 摘 temperature")
    void realWorldTemperatureReject() {
        String resp = "{\"error\":{\"message\":\"invalid temperature: only 1 is allowed for this model\",\"type\":\"invalid_request_error\"}}";
        assertEquals("temperature", UpstreamParamReject.rejectedParam(400, resp, body("model", "messages", "temperature")));
    }

    @Test
    @DisplayName("报文点名 temperature 但请求体根本没带 → 不摘（那是别的问题）")
    void paramNotSentIsNotStripped() {
        String resp = "{\"error\":{\"message\":\"invalid temperature: only 1 is allowed for this model\"}}";
        assertNull(UpstreamParamReject.rejectedParam(400, resp, body("model", "messages")));
    }

    @Test
    @DisplayName("max_tokens 拒绝走既有判定（含 max_output_tokens 变体）→ 摘 max_tokens")
    void maxTokensDelegates() {
        assertEquals("max_tokens", UpstreamParamReject.rejectedParam(400,
                "{\"error\":{\"message\":\"max_tokens is too large\"}}", body("max_tokens", "temperature")));
        assertEquals("max_tokens", UpstreamParamReject.rejectedParam(422,
                "{\"detail\":\"max_output_tokens exceeds model limit\"}", body("max_tokens")));
    }

    @Test
    @DisplayName("一次只报一个：max_tokens 与 temperature 同被点名时先摘 max_tokens，重发后再判")
    void oneAtATime() {
        String resp = "{\"error\":{\"message\":\"max_tokens and temperature are invalid\"}}";
        Map<String, Object> sent = body("max_tokens", "temperature");
        assertEquals("max_tokens", UpstreamParamReject.rejectedParam(400, resp, sent));
        sent.remove("max_tokens");
        assertEquals("temperature", UpstreamParamReject.rejectedParam(400, resp, sent));
        sent.remove("temperature");
        assertNull(UpstreamParamReject.rejectedParam(400, resp, sent));
    }

    @Test
    @DisplayName("鉴权/限流绝不摘参重试：401/403/429 即使报文出现参数名也返回 null")
    void authAndRateLimitNeverRetried() {
        String resp = "{\"error\":{\"message\":\"invalid api key; check temperature of your account\"}}";
        assertNull(UpstreamParamReject.rejectedParam(401, resp, body("temperature")));
        assertNull(UpstreamParamReject.rejectedParam(403, resp, body("temperature")));
        assertNull(UpstreamParamReject.rejectedParam(429, resp, body("temperature")));
    }

    @Test
    @DisplayName("400 但报文没点名任何已发参数（如消息格式错误）→ 不摘、如实失败转移")
    void unrelated400IsNotStripped() {
        String resp = "{\"error\":{\"message\":\"messages: content must not be empty\"}}";
        assertNull(UpstreamParamReject.rejectedParam(400, resp, body("temperature", "top_p")));
    }

    @Test
    @DisplayName("top_p 等其余调优参数同样可摘")
    void otherTuningParams() {
        assertEquals("top_p", UpstreamParamReject.rejectedParam(400,
                "{\"error\":{\"message\":\"top_p must be 1 for this model\"}}", body("top_p")));
    }

    @Test
    @DisplayName("报文为 null 不炸")
    void nullBodySafe() {
        assertNull(UpstreamParamReject.rejectedParam(400, null, body("temperature")));
    }
}
