package com.imlwork.admin.dto;

import jakarta.validation.constraints.NotBlank;

import java.util.List;

/** 联网检索代理的请求/响应 DTO（用 DTO 而非实体做 API 契约）。 */
public class SearchDtos {

    /** 检索请求：查询词 + 可选结果数上限（缺省用管理端配置）。 */
    public record SearchRequest(
            @NotBlank(message = "query 不能为空") String query,
            Integer maxResults) {}

    /** 单条检索结果。tier=信源级别标签（权威/专业/一般/自媒体），由后端按分级名单标注——
     *  客户端素材标签直接用它（单一来源），本地 sourceTier 仅作旧后端/浏览器兜底。 */
    public record SearchResultItem(String title, String url, String snippet, String tier) {}

    /** 已深读的网页正文（tier 含义同上）。 */
    public record SearchPage(String url, String title, String text, String tier) {}

    /** 行情快照单条（腾讯行情接口服务端直采）：当日点位/涨跌的确定性数据源，
     *  新闻检索只做背景叙事——治"指数数字从旧文/自媒体转抄致错"的根。 */
    public record QuoteItem(String symbol, String name, double price, double prevClose,
                            double change, double changePct, String time) {}

    /** 检索响应：命中通道 + 结果列表 + 头部正文。provider=NONE 表示无 API 配置/失败，客户端回退浏览器检索。 */
    public record WebSearchResponse(String provider, List<SearchResultItem> results, List<SearchPage> pages) {}
}
