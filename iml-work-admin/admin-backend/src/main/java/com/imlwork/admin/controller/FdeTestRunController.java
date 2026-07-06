package com.imlwork.admin.controller;

import com.imlwork.admin.model.FdeTestRun;
import com.imlwork.admin.service.FdeTestRunService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * FDE 工作台 SKILL 生产线 — 测试运行。
 */
@RestController
@RequestMapping("/api/v1/fde/test-runs")
public class FdeTestRunController {

    private final FdeTestRunService service;

    public FdeTestRunController(FdeTestRunService service) {
        this.service = service;
    }

    @GetMapping
    public ResponseEntity<List<FdeTestRun>> list(@RequestParam(value = "scenarioId", required = false) String scenarioId) {
        return ResponseEntity.ok(service.list(scenarioId));
    }

    @GetMapping("/{id}")
    public ResponseEntity<FdeTestRun> get(@PathVariable String id) {
        return service.get(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<FdeTestRun> create(@RequestBody FdeTestRun body) {
        return ResponseEntity.ok(service.create(body));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        if (!service.delete(id)) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }
}
