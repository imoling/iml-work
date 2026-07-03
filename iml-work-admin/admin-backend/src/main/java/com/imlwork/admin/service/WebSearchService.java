package com.imlwork.admin.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.imlwork.admin.dto.SearchDtos.SearchPage;
import com.imlwork.admin.dto.SearchDtos.SearchResultItem;
import com.imlwork.admin.dto.SearchDtos.WebSearchResponse;
import com.imlwork.admin.model.SearchConfig;
import com.imlwork.admin.repository.SearchConfigRepository;
import org.springframework.stereotype.Service;

import java.net.ProxySelector;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 企业联网检索代理：用后端保管的 Tavily/Bing 密钥执行检索，密钥绝不下发客户端
 * （对齐「模型统一经中转站、平台不下发密钥」的安全红线）。无 API 配置/失败时返回
 * provider=NONE，客户端据此回退到内置浏览器检索。
 */
@Service
public class WebSearchService {

    private final SearchConfigRepository configRepo;
    // 走企业代理访问外网检索 API：honor -Dhttp(s).proxyHost（dev.sh 已透传）。
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .proxy(ProxySelector.getDefault())
            .build();
    private final ObjectMapper om = new ObjectMapper();

    public WebSearchService(SearchConfigRepository configRepo) {
        this.configRepo = configRepo;
    }

    private static final WebSearchResponse EMPTY = new WebSearchResponse("NONE", List.of(), List.of());

    public WebSearchResponse search(String query, Integer maxOverride) {
        SearchConfig cfg = configRepo.findById("default").orElse(null);
        if (cfg == null) return EMPTY;
        String provider = cfg.getProvider() == null ? "NONE" : cfg.getProvider();
        String key = cfg.getApiKey();
        int max = maxOverride != null && maxOverride > 0 ? maxOverride
                : (cfg.getMaxResults() > 0 ? cfg.getMaxResults() : 5);
        int deep = Math.max(0, cfg.getDeepReadCount());
        if (key == null || key.isBlank()) return EMPTY;
        try {
            if ("TAVILY".equals(provider)) return tavily(query, key, max, deep);
            if ("BING".equals(provider)) return bing(query, key, max);
        } catch (Exception e) {
            // 检索 API 失败 → 返回空，客户端回退浏览器检索（不抛错、不泄漏 key）。
            return EMPTY;
        }
        return EMPTY;
    }

    /** Tavily：面向 AI 的检索 API，直接返回结果与正文。 */
    private WebSearchResponse tavily(String query, String key, int max, int deep) throws Exception {
        String body = om.writeValueAsString(Map.of(
                "api_key", key, "query", query, "max_results", max, "include_raw_content", true));
        HttpRequest req = HttpRequest.newBuilder(URI.create("https://api.tavily.com/search"))
                .timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() / 100 != 2) throw new RuntimeException("Tavily HTTP " + res.statusCode());
        JsonNode d = om.readTree(res.body());
        List<SearchResultItem> results = new ArrayList<>();
        List<SearchPage> pages = new ArrayList<>();
        int i = 0;
        for (JsonNode x : d.path("results")) {
            String url = x.path("url").asText("");
            String title = x.path("title").asText("");
            String content = x.path("content").asText("");
            results.add(new SearchResultItem(title, url, content.length() > 200 ? content.substring(0, 200) : content));
            if (i < deep) {
                String raw = x.path("raw_content").asText(content);
                String text = raw.replaceAll("\\s+", " ").trim();
                if (text.length() > 2600) text = text.substring(0, 2600);
                if (!text.isBlank()) pages.add(new SearchPage(url, title, text));
            }
            i++;
        }
        return new WebSearchResponse("TAVILY", results, pages);
    }

    /** Bing Web Search API：只返结果，正文由客户端浏览器深读（无需密钥）。 */
    private WebSearchResponse bing(String query, String key, int max) throws Exception {
        String url = "https://api.bing.microsoft.com/v7.0/search?q="
                + URLEncoder.encode(query, StandardCharsets.UTF_8) + "&count=" + max + "&mkt=zh-CN";
        HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(20))
                .header("Ocp-Apim-Subscription-Key", key)
                .GET()
                .build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() / 100 != 2) throw new RuntimeException("Bing HTTP " + res.statusCode());
        JsonNode d = om.readTree(res.body());
        List<SearchResultItem> results = new ArrayList<>();
        for (JsonNode x : d.path("webPages").path("value")) {
            results.add(new SearchResultItem(x.path("name").asText(""), x.path("url").asText(""), x.path("snippet").asText("")));
        }
        return new WebSearchResponse("BING", results, List.of());
    }
}
