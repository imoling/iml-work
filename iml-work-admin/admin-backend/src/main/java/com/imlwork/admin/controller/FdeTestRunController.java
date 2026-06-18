package com.imlwork.admin.controller;

import com.imlwork.admin.model.FdeTestRun;
import com.imlwork.admin.repository.FdeTestRunRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * FDE 工作台 SKILL 生产线 — 测试运行。
 */
@RestController
@RequestMapping("/api/v1/fde/test-runs")
public class FdeTestRunController {

    private final FdeTestRunRepository repository;

    public FdeTestRunController(FdeTestRunRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public ResponseEntity<List<FdeTestRun>> list(@RequestParam(value = "scenarioId", required = false) String scenarioId) {
        if (scenarioId == null || scenarioId.isBlank()) {
            return ResponseEntity.ok(repository.findAll());
        }
        return ResponseEntity.ok(repository.findByScenarioIdOrderByStartedAtDesc(scenarioId));
    }

    @GetMapping("/{id}")
    public ResponseEntity<FdeTestRun> get(@PathVariable String id) {
        return repository.findById(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<FdeTestRun> create(@RequestBody FdeTestRun body) {
        if (body.getId() == null || body.getId().isBlank()) {
            body.setId("fderun-" + UUID.randomUUID().toString().substring(0, 8));
        }
        LocalDateTime now = LocalDateTime.now();
        if (body.getStartedAt() == null) body.setStartedAt(now);
        body.setCreatedAt(now);
        return ResponseEntity.ok(repository.save(body));
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
