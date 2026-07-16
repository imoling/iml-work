package com.imlwork.admin.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * One upstream model endpoint registered in the enterprise relay station. The
 * unified gateway load-balances across all enabled, healthy providers that match
 * a requested route key (logical model name), so the enterprise can pool several
 * vendors / keys behind a single internal endpoint and schedule traffic by weight.
 */
@Entity
@Table(name = "model_provider")
public class ModelProvider {

    @Id
    private String id;

    /** Display name, e.g. "DeepSeek 主用通道". */
    private String name;

    /** Vendor family: DEEPSEEK | OPENAI | ANTHROPIC | AGNES | OLLAMA | CUSTOM. */
    private String provider;

    /** Upstream chat-completions endpoint (full URL or base; normalized at call time). */
    private String baseUrl;

    /** 上游密钥：可写入(创建/更新)，但绝不随任何响应序列化下发到前端。 */
    @Column(length = 1000)
    @JsonProperty(access = JsonProperty.Access.WRITE_ONLY)
    private String apiKey;

    /** Upstream model name actually sent to the vendor, e.g. "deepseek-chat". */
    private String model;

    /**
     * Logical model name clients request through the gateway. Providers sharing a
     * routeKey form one load-balancing pool. Blank = matches any request.
     */
    private String routeKey;

    /** Relative weight for weighted round-robin scheduling (>=1). */
    private int weight = 1;

    private boolean enabled = true;

    /** HEALTHY | DOWN | UNKNOWN — driven by health probes and live traffic. */
    private String status = "UNKNOWN";

    @Column(length = 1000)
    private String message;

    private LocalDateTime lastChecked;

    // Live counters, persisted so the console survives restarts.
    private long totalRequests = 0;
    private long failedRequests = 0;
    private long avgLatencyMs = 0;
    private long totalPromptTokens = 0;
    private long totalCompletionTokens = 0;

    /**
     * 可选计费单价（人民币元 / 每 1000 token）。用 nullable Double：未配置即为 null，
     * 驾驶舱费用「不臆造」——只有配了单价的通道才计入成本，未配则前端提示「配置后可见」。
     * （nullable 装箱类型，ddl-auto 增列不会命中 NOT NULL 静默失败那个坑。）
     */
    // 计价单位：**每百万 tokens**（与厂商官网标价一致，如 DeepSeek 输入 1 元/百万、输出 2 元/百万）。
    // 曾按「每 1K」存，运维要手动除以 1000，结果 DeepSeek 填成 0.0002 —— 比官方标价小了 5 倍。
    // 列名显式标注：字段名里带数字时（Per1M），Hibernate 的隐式命名策略会推成 input_price_per1m，
    // 与迁移建的 input_price_per_1m 对不上 → 启动后一查就 SQLGrammarException。别赌命名策略。
    @Column(name = "input_price_per_1m")
    private Double inputPricePer1M;

    @Column(name = "output_price_per_1m")
    private Double outputPricePer1M;

    /** 单次请求最大输出 tokens（网关在调用方未指定 max_tokens 时注入）。
     *  可空=不注入、用厂商默认。长输出场景（技能创造器产脚本、长文生成）靠它防截断——
     *  厂商默认普遍 4k，而现代模型上限已到 1M 级，该多大由通道配置说了算，不在代码写死。 */
    @Column(name = "max_output_tokens")
    private Integer maxOutputTokens;

    public ModelProvider() {}

    public ModelProvider(String id, String name, String provider, String baseUrl,
                         String apiKey, String model, String routeKey, int weight) {
        this.id = id;
        this.name = name;
        this.provider = provider;
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.model = model;
        this.routeKey = routeKey;
        this.weight = weight;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }

    public String getBaseUrl() { return baseUrl; }
    public void setBaseUrl(String baseUrl) { this.baseUrl = baseUrl; }

    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) { this.apiKey = apiKey; }

    public String getModel() { return model; }
    public void setModel(String model) { this.model = model; }

    public String getRouteKey() { return routeKey; }
    public void setRouteKey(String routeKey) { this.routeKey = routeKey; }

    public int getWeight() { return weight; }
    public void setWeight(int weight) { this.weight = weight; }

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getMessage() { return message; }
    public void setMessage(String message) { this.message = message; }

    public LocalDateTime getLastChecked() { return lastChecked; }
    public void setLastChecked(LocalDateTime lastChecked) { this.lastChecked = lastChecked; }

    public long getTotalRequests() { return totalRequests; }
    public void setTotalRequests(long totalRequests) { this.totalRequests = totalRequests; }

    public long getFailedRequests() { return failedRequests; }
    public void setFailedRequests(long failedRequests) { this.failedRequests = failedRequests; }

    public long getAvgLatencyMs() { return avgLatencyMs; }
    public void setAvgLatencyMs(long avgLatencyMs) { this.avgLatencyMs = avgLatencyMs; }

    public long getTotalPromptTokens() { return totalPromptTokens; }
    public void setTotalPromptTokens(long totalPromptTokens) { this.totalPromptTokens = totalPromptTokens; }

    public long getTotalCompletionTokens() { return totalCompletionTokens; }
    public void setTotalCompletionTokens(long totalCompletionTokens) { this.totalCompletionTokens = totalCompletionTokens; }

    public Double getInputPricePer1M() { return inputPricePer1M; }
    public void setInputPricePer1M(Double inputPricePer1M) { this.inputPricePer1M = inputPricePer1M; }

    public Integer getMaxOutputTokens() { return maxOutputTokens; }
    public void setMaxOutputTokens(Integer maxOutputTokens) { this.maxOutputTokens = maxOutputTokens; }

    public Double getOutputPricePer1M() { return outputPricePer1M; }
    public void setOutputPricePer1M(Double outputPricePer1M) { this.outputPricePer1M = outputPricePer1M; }
}
