package com.imlwork.admin.controller;

import com.imlwork.admin.model.ModelProvider;
import com.imlwork.admin.repository.ModelProviderRepository;
import com.imlwork.admin.service.ModelRouterService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Admin CRUD for the enterprise model relay station: register multiple upstream
 * models, set their load-balancing weight, toggle them on/off and probe health.
 * Live traffic is scheduled across these rows by {@link ModelRouterService}.
 */
@RestController
@RequestMapping("/api/v1/model/providers")
public class ModelProviderController {

    private final ModelProviderRepository repository;
    private final ModelRouterService router;

    public ModelProviderController(ModelProviderRepository repository, ModelRouterService router) {
        this.repository = repository;
        this.router = router;
    }

    @GetMapping
    public ResponseEntity<List<ModelProvider>> list() {
        return ResponseEntity.ok(repository.findAll());
    }

    @GetMapping("/summary")
    public ResponseEntity<Map<String, Object>> summary() {
        List<ModelProvider> all = repository.findAll();
        long enabled = all.stream().filter(ModelProvider::isEnabled).count();
        long healthy = all.stream().filter(p -> "HEALTHY".equals(p.getStatus())).count();
        long down = all.stream().filter(p -> "DOWN".equals(p.getStatus())).count();
        long totalReq = all.stream().mapToLong(ModelProvider::getTotalRequests).sum();
        long totalFail = all.stream().mapToLong(ModelProvider::getFailedRequests).sum();

        Map<String, Object> s = new HashMap<>();
        s.put("total", all.size());
        s.put("enabled", enabled);
        s.put("healthy", healthy);
        s.put("down", down);
        s.put("totalRequests", totalReq);
        s.put("failedRequests", totalFail);
        s.put("successRate", totalReq == 0 ? 1.0 : (totalReq - totalFail) / (double) totalReq);
        return ResponseEntity.ok(s);
    }

    @PostMapping
    public ResponseEntity<ModelProvider> create(@RequestBody ModelProvider p) {
        if (p.getId() == null || p.getId().isBlank()) {
            p.setId("mp-" + UUID.randomUUID().toString().substring(0, 8));
        }
        if (p.getWeight() < 1) p.setWeight(1);
        p.setStatus("UNKNOWN");
        p.setTotalRequests(0);
        p.setFailedRequests(0);
        p.setAvgLatencyMs(0);
        return ResponseEntity.ok(repository.save(p));
    }

    @PutMapping("/{id}")
    public ResponseEntity<ModelProvider> update(@PathVariable String id, @RequestBody ModelProvider update) {
        return repository.findById(id).map(existing -> {
            existing.setName(update.getName());
            existing.setProvider(update.getProvider());
            existing.setBaseUrl(update.getBaseUrl());
            existing.setModel(update.getModel());
            existing.setRouteKey(update.getRouteKey());
            existing.setWeight(Math.max(1, update.getWeight()));
            existing.setEnabled(update.isEnabled());
            // Only overwrite the key when a new non-blank one is supplied.
            if (update.getApiKey() != null && !update.getApiKey().isBlank()) {
                existing.setApiKey(update.getApiKey());
            }
            return ResponseEntity.ok(repository.save(existing));
        }).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping("/{id}/toggle")
    public ResponseEntity<ModelProvider> toggle(@PathVariable String id) {
        return repository.findById(id).map(p -> {
            p.setEnabled(!p.isEnabled());
            return ResponseEntity.ok(repository.save(p));
        }).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping("/{id}/health")
    public ResponseEntity<ModelProvider> health(@PathVariable String id) {
        return repository.findById(id)
                .map(p -> ResponseEntity.ok(router.probe(p)))
                .orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        if (!repository.existsById(id)) {
            return ResponseEntity.notFound().build();
        }
        repository.deleteById(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }
}
