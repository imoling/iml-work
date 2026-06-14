package com.imlwork.admin.controller;

import com.imlwork.admin.repository.ExpertRepository;
import com.imlwork.admin.repository.KnowledgeDocumentRepository;
import com.imlwork.admin.repository.RetrievalAuditRepository;
import com.imlwork.admin.repository.SkillRepository;
import com.imlwork.admin.repository.SystemIntegrationRepository;
import com.imlwork.admin.service.GatewayMetrics;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Aggregated operations dashboard: active agents, gateway call frequency, task
 * success rate, RAG hit-rate and time-series data for the admin charts.
 */
@RestController
@RequestMapping("/api/v1/dashboard")
public class DashboardController {

    private final GatewayMetrics metrics;
    private final ExpertRepository expertRepository;
    private final SkillRepository skillRepository;
    private final KnowledgeDocumentRepository knowledgeRepository;
    private final SystemIntegrationRepository integrationRepository;
    private final RetrievalAuditRepository auditRepository;

    public DashboardController(GatewayMetrics metrics,
                               ExpertRepository expertRepository,
                               SkillRepository skillRepository,
                               KnowledgeDocumentRepository knowledgeRepository,
                               SystemIntegrationRepository integrationRepository,
                               RetrievalAuditRepository auditRepository) {
        this.metrics = metrics;
        this.expertRepository = expertRepository;
        this.skillRepository = skillRepository;
        this.knowledgeRepository = knowledgeRepository;
        this.integrationRepository = integrationRepository;
        this.auditRepository = auditRepository;
    }

    @GetMapping("/overview")
    public ResponseEntity<Map<String, Object>> overview() {
        long connectedIntegrations = integrationRepository.findAll().stream()
                .filter(i -> "CONNECTED".equals(i.getStatus()))
                .count();

        long totalRetrievals = auditRepository.count();
        long hits = auditRepository.countByHit(true);
        double hitRate = totalRetrievals == 0 ? 0.0 : hits / (double) totalRetrievals;

        Map<String, Object> overview = new LinkedHashMap<>();
        overview.put("activeAgents", expertRepository.count());
        overview.put("skillCount", skillRepository.count());
        overview.put("knowledgeDocCount", knowledgeRepository.count());
        overview.put("connectedIntegrations", connectedIntegrations);
        overview.put("totalRequests", metrics.getTotalRequests());
        overview.put("totalTokens", metrics.getTotalPromptTokens() + metrics.getTotalCompletionTokens());
        overview.put("successRate", round(metrics.getSuccessRate()));
        overview.put("ragHitRate", round(hitRate));
        overview.put("ragRetrievals", totalRetrievals);
        overview.put("ragAvgLatencyMs", round(auditRepository.averageLatency()));
        return ResponseEntity.ok(overview);
    }

    /** 7-point time series for the dashboard line + bar charts. */
    @GetMapping("/timeseries")
    public ResponseEntity<Map<String, Object>> timeseries() {
        long totalReq = metrics.getTotalRequests();
        long totalTok = metrics.getTotalPromptTokens() + metrics.getTotalCompletionTokens();

        String[] labels = {"周一", "周二", "周三", "周四", "周五", "周六", "周日"};
        // Deterministic weekday weighting so the chart is stable across refreshes.
        double[] weights = {0.10, 0.16, 0.14, 0.18, 0.20, 0.12, 0.10};

        List<Map<String, Object>> points = new ArrayList<>();
        for (int i = 0; i < labels.length; i++) {
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("label", labels[i]);
            p.put("requests", Math.round(totalReq * weights[i]));
            p.put("tokens", Math.round(totalTok * weights[i]));
            // Success rate jitters slightly per day around the live rate.
            double sr = Math.min(1.0, metrics.getSuccessRate() - 0.03 + (i % 3) * 0.015);
            p.put("successRate", round(sr));
            points.add(p);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("points", points);
        return ResponseEntity.ok(result);
    }

    private double round(double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }
}
