package com.imlwork.admin.service;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SSE 增量聚合器的行为钉子：流式中继的正确性根基——聚合错了，客户端拿到的
 * 就是残缺/串味的回答，而且症状会被归咎到「模型抽风」上，极难排查。
 */
class SseChunkAggregatorTest {

    @SuppressWarnings("unchecked")
    private static Map<String, Object> firstMessage(Map<String, Object> resp) {
        List<Map<String, Object>> choices = (List<Map<String, Object>>) resp.get("choices");
        return (Map<String, Object>) choices.get(0).get("message");
    }

    @Test
    void 正文增量按序拼接且DONE终结流() {
        SseChunkAggregator agg = new SseChunkAggregator();
        assertFalse(agg.feed("data: {\"id\":\"c1\",\"model\":\"m\",\"created\":123,\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"你好\"}}]}"));
        assertFalse(agg.feed("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"，世界\"}}]}"));
        assertFalse(agg.feed("data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}"));
        assertTrue(agg.feed("data: [DONE]"));

        Map<String, Object> resp = agg.toResponse();
        assertEquals("c1", resp.get("id"));
        assertEquals("chat.completion", resp.get("object"));
        Map<String, Object> msg = firstMessage(resp);
        assertEquals("你好，世界", msg.get("content"));
        assertTrue(agg.sawAnyDelta());
    }

    @Test
    void 思维链与正文分开聚合() {
        SseChunkAggregator agg = new SseChunkAggregator();
        agg.feed("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"想一\"}}]}");
        agg.feed("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"想二\"}}]}");
        agg.feed("data: {\"choices\":[{\"delta\":{\"content\":\"答案\"}}]}");
        agg.feed("data: [DONE]");

        Map<String, Object> msg = firstMessage(agg.toResponse());
        assertEquals("答案", msg.get("content"));
        assertEquals("想一想二", msg.get("reasoning_content"));
    }

    @Test
    void 工具调用参数分片按index归并且name不重复拼接() {
        SseChunkAggregator agg = new SseChunkAggregator();
        agg.feed("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"getWeather\",\"arguments\":\"{\\\"ci\"}}]}}]}");
        // 个别厂商每块都重发完整 name——不能拼成 getWeathergetWeather
        agg.feed("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"getWeather\",\"arguments\":\"ty\\\":\\\"北京\\\"}\"}}]}}]}");
        agg.feed("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}");
        agg.feed("data: [DONE]");

        Map<String, Object> msg = firstMessage(agg.toResponse());
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> tcs = (List<Map<String, Object>>) msg.get("tool_calls");
        assertEquals(1, tcs.size());
        @SuppressWarnings("unchecked")
        Map<String, Object> fn = (Map<String, Object>) tcs.get(0).get("function");
        assertEquals("getWeather", fn.get("name"));
        assertEquals("{\"city\":\"北京\"}", fn.get("arguments"));
        assertEquals("call_1", tcs.get(0).get("id"));
    }

    @Test
    void usage取末块且计量口径与非流式一致() {
        SseChunkAggregator agg = new SseChunkAggregator();
        agg.feed("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}");
        agg.feed("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":22}}");
        agg.feed("data: [DONE]");

        assertEquals(11, agg.usageTokens()[0]);
        assertEquals(22, agg.usageTokens()[1]);
        assertTrue(agg.toResponse().containsKey("usage"));
    }

    @Test
    void 错误块被捕获且无增量时不算有产出() {
        SseChunkAggregator agg = new SseChunkAggregator();
        agg.feed("data: {\"error\":{\"message\":\"rate limited\"}}");
        assertEquals("rate limited", agg.streamError());
        assertFalse(agg.sawAnyDelta());
    }

    @Test
    void 注释行空行与坏JSON块都被安全跳过() {
        SseChunkAggregator agg = new SseChunkAggregator();
        assertFalse(agg.feed(": keepalive"));
        assertFalse(agg.feed(""));
        assertFalse(agg.feed("event: ping"));
        assertFalse(agg.feed("data: {截断的坏块"));
        agg.feed("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}");
        agg.feed("data: [DONE]");
        assertEquals("ok", firstMessage(agg.toResponse()).get("content"));
    }

    @Test
    void 没有usage时token为零而不是空指针() {
        SseChunkAggregator agg = new SseChunkAggregator();
        agg.feed("data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}");
        assertEquals(0, agg.usageTokens()[0]);
        assertNull(agg.toResponse().get("usage"));
    }
}
