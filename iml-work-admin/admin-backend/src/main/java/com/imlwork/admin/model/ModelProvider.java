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
    private Double inputPricePer1k;
    private Double outputPricePer1k;

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

    public Double getInputPricePer1k() { return inputPricePer1k; }
    public void setInputPricePer1k(Double inputPricePer1k) { this.inputPricePer1k = inputPricePer1k; }

    public Double getOutputPricePer1k() { return outputPricePer1k; }
    public void setOutputPricePer1k(Double outputPricePer1k) { this.outputPricePer1k = outputPricePer1k; }
}
