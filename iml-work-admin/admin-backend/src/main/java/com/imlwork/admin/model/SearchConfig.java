package com.imlwork.admin.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 企业联网检索服务配置（单例，id 固定为 "default"）。由管理端统一维护，
 * 客户端拉取后据此选择检索通道：配了 API（Tavily/Bing）就走 API，否则回退到
 * 客户端内置的浏览器检索（离屏 / Playwright）。
 */
@Entity
@Table(name = "search_config")
public class SearchConfig {

    @Id
    private String id = "default";

    /** 检索服务商：NONE（内置浏览器检索）| TAVILY | BING | SEARXNG（自托管聚合检索，免密钥）。 */
    private String provider = "NONE";

    /** 自托管检索服务地址（SEARXNG 用，如 http://127.0.0.1:8890）；API 型服务商留空。 */
    @Column(length = 500)
    private String endpoint;

    // 密钥只收不吐：PUT 可写入，GET 绝不序列化返回（改由 hasKey 告知管理端是否已设置）。
    @Column(length = 1000)
    @JsonProperty(access = JsonProperty.Access.WRITE_ONLY)
    private String apiKey;

    /** 返回结果条数上限。 */
    private int maxResults = 5;

    /** 深读头部网页篇数（提取正文用于综合）。默认 4：搜到多篇时并行深读多篇，避免"搜到 5 只读 1"。 */
    private int deepReadCount = 4;

    /** 内置浏览器检索的抓取引擎：ELECTRON（离屏）| PLAYWRIGHT。 */
    private String browserEngine = "ELECTRON";

    private LocalDateTime updatedAt = LocalDateTime.now();

    public SearchConfig() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }

    public String getEndpoint() { return endpoint; }
    public void setEndpoint(String endpoint) { this.endpoint = endpoint; }

    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) { this.apiKey = apiKey; }

    // 只序列化「是否已配置密钥」给管理端，不吐露密钥本身（@Transient：不入库）。
    @Transient
    public boolean isHasKey() { return apiKey != null && !apiKey.isBlank(); }

    public int getMaxResults() { return maxResults; }
    public void setMaxResults(int maxResults) { this.maxResults = maxResults; }

    public int getDeepReadCount() { return deepReadCount; }
    public void setDeepReadCount(int deepReadCount) { this.deepReadCount = deepReadCount; }

    public String getBrowserEngine() { return browserEngine; }
    public void setBrowserEngine(String browserEngine) { this.browserEngine = browserEngine; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
