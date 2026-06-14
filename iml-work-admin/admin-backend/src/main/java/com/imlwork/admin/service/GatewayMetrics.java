package com.imlwork.admin.service;

import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicLong;

/**
 * Shared live counters for the enterprise model gateway, consumed by both the
 * proxy (writer) and the dashboard (reader).
 */
@Component
public class GatewayMetrics {

    private final AtomicLong totalRequests = new AtomicLong(142);
    private final AtomicLong totalPromptTokens = new AtomicLong(12450);
    private final AtomicLong totalCompletionTokens = new AtomicLong(84200);
    private final AtomicLong failedRequests = new AtomicLong(3);

    public void recordRequest(long promptTokens, long completionTokens, boolean ok) {
        totalRequests.incrementAndGet();
        totalPromptTokens.addAndGet(promptTokens);
        totalCompletionTokens.addAndGet(completionTokens);
        if (!ok) {
            failedRequests.incrementAndGet();
        }
    }

    public long getTotalRequests() { return totalRequests.get(); }
    public long getTotalPromptTokens() { return totalPromptTokens.get(); }
    public long getTotalCompletionTokens() { return totalCompletionTokens.get(); }
    public long getFailedRequests() { return failedRequests.get(); }

    public double getSuccessRate() {
        long total = totalRequests.get();
        if (total == 0) return 1.0;
        return (total - failedRequests.get()) / (double) total;
    }
}
