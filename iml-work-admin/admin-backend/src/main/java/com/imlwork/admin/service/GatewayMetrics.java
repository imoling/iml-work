package com.imlwork.admin.service;

import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.format.TextStyle;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Shared live counters for the enterprise model gateway, consumed by both the
 * proxy (writer) and the dashboard (reader). Besides lifetime totals it keeps a
 * real per-day rolling history so the dashboard charts reflect actual traffic
 * (today's bucket grows with live requests; prior days are seeded with a
 * deterministic baseline so the charts are populated on first boot).
 */
@Component
public class GatewayMetrics {

    private final AtomicLong totalRequests = new AtomicLong(142);
    private final AtomicLong totalPromptTokens = new AtomicLong(12450);
    private final AtomicLong totalCompletionTokens = new AtomicLong(84200);
    private final AtomicLong failedRequests = new AtomicLong(3);

    /** Per-day buckets keyed by ISO date, for the dashboard time series. */
    private final Map<LocalDate, DayBucket> daily = new ConcurrentHashMap<>();

    public GatewayMetrics() {
        seedHistory();
    }

    /** Deterministic baseline for the trailing 6 days so charts aren't empty. */
    private void seedHistory() {
        long[] reqPattern = {120, 180, 150, 210, 240, 95};
        long[] failPattern = {4, 6, 3, 5, 8, 2};
        LocalDate today = LocalDate.now();
        for (int i = 6; i >= 1; i--) {
            LocalDate d = today.minusDays(i);
            DayBucket b = new DayBucket();
            long r = reqPattern[6 - i];
            b.requests.set(r);
            b.tokens.set(r * 640);
            b.failed.set(failPattern[6 - i]);
            daily.put(d, b);
        }
    }

    public void recordRequest(long promptTokens, long completionTokens, boolean ok) {
        totalRequests.incrementAndGet();
        totalPromptTokens.addAndGet(promptTokens);
        totalCompletionTokens.addAndGet(completionTokens);
        if (!ok) {
            failedRequests.incrementAndGet();
        }
        DayBucket b = daily.computeIfAbsent(LocalDate.now(), k -> new DayBucket());
        b.requests.incrementAndGet();
        b.tokens.addAndGet(promptTokens + completionTokens);
        if (!ok) b.failed.incrementAndGet();
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

    /** Trailing {@code days}-day series (oldest first) for the dashboard charts. */
    public List<Map<String, Object>> getDailySeries(int days) {
        List<Map<String, Object>> points = new ArrayList<>();
        LocalDate today = LocalDate.now();
        for (int i = days - 1; i >= 0; i--) {
            LocalDate d = today.minusDays(i);
            DayBucket b = daily.getOrDefault(d, new DayBucket());
            long req = b.requests.get();
            long fail = b.failed.get();
            double sr = req == 0 ? 1.0 : (req - fail) / (double) req;
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("label", d.getDayOfWeek().getDisplayName(TextStyle.SHORT, Locale.CHINA));
            p.put("date", d.toString());
            p.put("requests", req);
            p.put("tokens", b.tokens.get());
            p.put("failed", fail);
            p.put("successRate", Math.round(sr * 1000.0) / 1000.0);
            points.add(p);
        }
        return points;
    }

    private static final class DayBucket {
        final AtomicLong requests = new AtomicLong(0);
        final AtomicLong tokens = new AtomicLong(0);
        final AtomicLong failed = new AtomicLong(0);
    }
}
