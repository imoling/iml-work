package com.imlwork.admin.controller;

import com.imlwork.admin.model.FdeBlueprint;
import com.imlwork.admin.service.FdeBlueprintService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * FDE 工作台 SKILL 生产线 — 技能蓝图。
 */
@RestController
@RequestMapping("/api/v1/fde/blueprints")
public class FdeBlueprintController {

    private final FdeBlueprintService service;

    public FdeBlueprintController(FdeBlueprintService service) {
        this.service = service;
    }

    @GetMapping
    public ResponseEntity<List<FdeBlueprint>> list(@RequestParam(value = "scenarioId", required = false) String scenarioId) {
        return ResponseEntity.ok(service.list(scenarioId));
    }

    @GetMapping("/{id}")
    public ResponseEntity<FdeBlueprint> get(@PathVariable String id) {
        return service.get(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<FdeBlueprint> create(@RequestBody FdeBlueprint body) {
        return ResponseEntity.ok(service.create(body));
    }

    @PutMapping("/{id}")
    public ResponseEntity<FdeBlueprint> update(@PathVariable String id, @RequestBody FdeBlueprint update) {
        return service.update(id, update).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        if (!service.delete(id)) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }
}
