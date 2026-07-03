package com.imlwork.admin.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 安全红线回归测试：检索密钥绝不下发。
 * SearchConfig.apiKey 为 @JsonProperty(WRITE_ONLY)——序列化(GET 响应)绝不能含 apiKey，
 * 只暴露 hasKey 布尔；反序列化(PUT 请求)仍能收到 apiKey。
 */
class SearchConfigJsonTest {

    private final ObjectMapper om = new ObjectMapper().registerModule(new JavaTimeModule());

    @Test
    void serialize_neverLeaksApiKey_andExposesHasKey() throws Exception {
        SearchConfig c = new SearchConfig();
        c.setProvider("TAVILY");
        c.setApiKey("tvly-super-secret");

        String json = om.writeValueAsString(c);

        assertFalse(json.contains("tvly-super-secret"), "响应体绝不能出现密钥明文");
        assertFalse(json.contains("\"apiKey\""), "响应体不应含 apiKey 字段");
        assertTrue(json.contains("\"hasKey\":true"), "应以 hasKey 告知已配置");
    }

    @Test
    void serialize_hasKeyFalse_whenBlank() throws Exception {
        SearchConfig c = new SearchConfig();
        String json = om.writeValueAsString(c);
        assertTrue(json.contains("\"hasKey\":false"));
    }

    @Test
    void deserialize_stillAcceptsApiKey() throws Exception {
        SearchConfig c = om.readValue(
                "{\"provider\":\"BING\",\"apiKey\":\"new-key\",\"maxResults\":3}", SearchConfig.class);
        assertEquals("new-key", c.getApiKey(), "PUT 请求里的 apiKey 必须仍可写入");
        assertEquals("BING", c.getProvider());
        assertEquals(3, c.getMaxResults());
    }
}
