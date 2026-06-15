package com.imlwork.admin.service;

import com.imlwork.admin.model.GatewayDailyStat;
import com.imlwork.admin.repository.GatewayDailyStatRepository;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.format.TextStyle;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Real, persistent counters for the enterprise model gateway. Every chat request
 * increments exactly one per-day row in {@code gateway_daily_stat}; lifetime
 * totals and the dashboard time series are derived from those rows, so all
 * numbers reflect actual traffic and survive restarts (no synthetic seeds).
 */
@Component
public class GatewayMetrics {

    private final GatewayDailyStatRepository dailyRepo;

    public GatewayMetrics(GatewayDailyStatRepository dailyRepo) {
        this.dailyRepo = dailyRepo;
    }

    public synchronized void recordRequest(long promptTokens, long completionTokens, boolean ok) {
        String today = LocalDate.now().toString();
        GatewayDailyStat s = dailyRepo.findById(today).orElseGet(() -> new GatewayDailyStat(today));
        s.setRequests(s.getRequests() + 1);
        s.setPromptTokens(s.getPromptTokens() + promptTokens);
        s.setCompletionTokens(s.getCompletionTokens() + completionTokens);
        if (!ok) s.setFailed(s.getFailed() + 1);
        dailyRepo.save(s);
    }

    public long getTotalRequests() { return dailyRepo.sumRequests(); }
    public long getTotalPromptTokens() { return dailyRepo.sumPromptTokens(); }
    public long getTotalCompletionTokens() { return dailyRepo.sumCompletionTokens(); }
    public long getFailedRequests() { return dailyRepo.sumFailed(); }

    public double getSuccessRate() {
        long total = getTotalRequests();
        if (total == 0) return 1.0;
        return (total - getFailedRequests()) / (double) total;
    }

    /** Trailing {@code days}-day series (oldest first) for the dashboard charts. */
    public List<Map<String, Object>> getDailySeries(int days) {
        List<Map<String, Object>> points = new ArrayList<>();
        LocalDate today = LocalDate.now();
        for (int i = days - 1; i >= 0; i--) {
            LocalDate d = today.minusDays(i);
            GatewayDailyStat s = dailyRepo.findById(d.toString()).orElse(null);
            long req = s == null ? 0 : s.getRequests();
            long fail = s == null ? 0 : s.getFailed();
            long tokens = s == null ? 0 : s.getPromptTokens() + s.getCompletionTokens();
            double sr = req == 0 ? 1.0 : (req - fail) / (double) req;
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("label", d.getDayOfWeek().getDisplayName(TextStyle.SHORT, Locale.CHINA));
            p.put("date", d.toString());
            p.put("requests", req);
            p.put("tokens", tokens);
            p.put("failed", fail);
            p.put("successRate", Math.round(sr * 1000.0) / 1000.0);
            points.add(p);
        }
        return points;
    }
}
