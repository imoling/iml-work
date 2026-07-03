package com.imlwork.admin.dto;

import jakarta.validation.constraints.NotBlank;

import java.util.List;

/** 联网检索代理的请求/响应 DTO（用 DTO 而非实体做 API 契约）。 */
public class SearchDtos {

    /** 检索请求：查询词 + 可选结果数上限（缺省用管理端配置）。 */
    public record SearchRequest(
            @NotBlank(message = "query 不能为空") String query,
            Integer maxResults) {}

    /** 单条检索结果。 */
    public record SearchResultItem(String title, String url, String snippet) {}

    /** 已深读的网页正文（Tavily 直出；Bing 由客户端浏览器深读，此处为空）。 */
    public record SearchPage(String url, String title, String text) {}

    /** 检索响应：命中通道 + 结果列表 + 头部正文。provider=NONE 表示无 API 配置/失败，客户端回退浏览器检索。 */
    public record WebSearchResponse(String provider, List<SearchResultItem> results, List<SearchPage> pages) {}
}
