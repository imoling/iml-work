package com.imlwork.admin.model;

import jakarta.persistence.*;

/**
 * Persistent per-day aggregate of gateway traffic, so the dashboard time series
 * is real and survives restarts. One row per calendar day (id = ISO date), each
 * chat request increments exactly one row.
 */
@Entity
@Table(name = "gateway_daily_stat")
public class GatewayDailyStat {

    /** ISO date, e.g. "2026-06-15". */
    @Id
    private String id;

    private long requests = 0;
    private long promptTokens = 0;
    private long completionTokens = 0;
    private long failed = 0;

    public GatewayDailyStat() {}

    public GatewayDailyStat(String id) {
        this.id = id;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public long getRequests() { return requests; }
    public void setRequests(long requests) { this.requests = requests; }

    public long getPromptTokens() { return promptTokens; }
    public void setPromptTokens(long promptTokens) { this.promptTokens = promptTokens; }

    public long getCompletionTokens() { return completionTokens; }
    public void setCompletionTokens(long completionTokens) { this.completionTokens = completionTokens; }

    public long getFailed() { return failed; }
    public void setFailed(long failed) { this.failed = failed; }
}
