package com.imlwork.admin.service;

import com.imlwork.admin.dto.SearchDtos.WebSearchResponse;
import com.imlwork.admin.model.SearchConfig;
import com.imlwork.admin.repository.SearchConfigRepository;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * 检索代理守卫路径测试（不发真实外网请求）：
 * 无配置 / 无密钥 / provider=NONE 时必须返回 provider=NONE 空结果，
 * 客户端据此回退浏览器检索——绝不能抛错或泄漏密钥状态以外的信息。
 */
class WebSearchServiceTest {

    private WebSearchService serviceWith(SearchConfig cfg) {
        SearchConfigRepository repo = mock(SearchConfigRepository.class);
        when(repo.findById("default")).thenReturn(Optional.ofNullable(cfg));
        return new WebSearchService(repo);
    }

    @Test
    void noConfig_returnsNone() {
        WebSearchResponse r = serviceWith(null).search("招标 公告", null);
        assertEquals("NONE", r.provider());
        assertTrue(r.results().isEmpty());
        assertTrue(r.pages().isEmpty());
    }

    @Test
    void noApiKey_returnsNone() {
        SearchConfig cfg = new SearchConfig();
        cfg.setProvider("TAVILY");          // 配了通道但没配密钥
        WebSearchResponse r = serviceWith(cfg).search("q", null);
        assertEquals("NONE", r.provider());
    }

    @Test
    void providerNone_returnsNone_evenWithKey() {
        SearchConfig cfg = new SearchConfig();
        cfg.setProvider("NONE");
        cfg.setApiKey("some-key");
        WebSearchResponse r = serviceWith(cfg).search("q", 3);
        assertEquals("NONE", r.provider());
    }
}
