package com.imlwork.admin.controller;

import com.imlwork.admin.model.ModelProvider;
import com.imlwork.admin.repository.ExpertRepository;
import com.imlwork.admin.repository.KnowledgeDocumentRepository;
import com.imlwork.admin.repository.ModelProviderRepository;
import com.imlwork.admin.repository.RetrievalAuditRepository;
import com.imlwork.admin.repository.SkillRepository;
import com.imlwork.admin.repository.SystemIntegrationRepository;
import com.imlwork.admin.service.GatewayMetrics;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Aggregated operations dashboard: active agents, gateway call frequency, task
 * success rate, RAG hit-rate, relay-station channel health and per-provider
 * traffic distribution, plus the real per-day time series for the admin charts.
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
    private final ModelProviderRepository providerRepository;

    public DashboardController(GatewayMetrics metrics,
                               ExpertRepository expertRepository,
                               SkillRepository skillRepository,
                               KnowledgeDocumentRepository knowledgeRepository,
                               SystemIntegrationRepository integrationRepository,
                               RetrievalAuditRepository auditRepository,
                               ModelProviderRepository providerRepository) {
        this.metrics = metrics;
        this.expertRepository = expertRepository;
        this.skillRepository = skillRepository;
        this.knowledgeRepository = knowledgeRepository;
        this.integrationRepository = integrationRepository;
        this.auditRepository = auditRepository;
        this.providerRepository = providerRepository;
    }

    @GetMapping("/overview")
    public ResponseEntity<Map<String, Object>> overview() {
        long connectedIntegrations = integrationRepository.findAll().stream()
                .filter(i -> "CONNECTED".equals(i.getStatus()))
                .count();

        long totalRetrievals = auditRepository.count();
        long hits = auditRepository.countByHit(true);
        double hitRate = totalRetrievals == 0 ? 0.0 : hits / (double) totalRetrievals;

        // Relay-station channel health + weighted average latency across providers.
        List<ModelProvider> providers = providerRepository.findAll();
        long totalChannels = providers.size();
        long healthyChannels = providers.stream().filter(p -> "HEALTHY".equals(p.getStatus())).count();
        long enabledChannels = providers.stream().filter(ModelProvider::isEnabled).count();
        long latencyReqWeight = providers.stream().mapToLong(ModelProvider::getTotalRequests).sum();
        long weightedLatency = providers.stream()
                .mapToLong(p -> p.getAvgLatencyMs() * Math.max(0, p.getTotalRequests())).sum();
        long avgChannelLatency = latencyReqWeight == 0 ? 0 : weightedLatency / latencyReqWeight;

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
        // Relay station
        overview.put("gatewayChannels", totalChannels);
        overview.put("gatewayHealthyChannels", healthyChannels);
        overview.put("gatewayEnabledChannels", enabledChannels);
        overview.put("gatewayAvgLatencyMs", avgChannelLatency);
        return ResponseEntity.ok(overview);
    }

    /** Real 7-day time series + relay-station provider traffic distribution. */
    @GetMapping("/timeseries")
    public ResponseEntity<Map<String, Object>> timeseries() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("points", metrics.getDailySeries(7));
        result.put("providers", providerDistribution());
        return ResponseEntity.ok(result);
    }

    /** Per-provider share of total served requests, busiest first. */
    private List<Map<String, Object>> providerDistribution() {
        List<ModelProvider> providers = providerRepository.findAll();
        long grand = providers.stream().mapToLong(ModelProvider::getTotalRequests).sum();
        List<Map<String, Object>> rows = new ArrayList<>();
        providers.stream()
                .sorted(Comparator.comparingLong(ModelProvider::getTotalRequests).reversed())
                .forEach(p -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("id", p.getId());
                    row.put("name", p.getName());
                    row.put("provider", p.getProvider());
                    row.put("requests", p.getTotalRequests());
                    row.put("failed", p.getFailedRequests());
                    row.put("avgLatencyMs", p.getAvgLatencyMs());
                    row.put("status", p.getStatus());
                    row.put("share", grand == 0 ? 0.0 : round(p.getTotalRequests() / (double) grand));
                    rows.add(row);
                });
        return rows;
    }

    private double round(double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }
}
