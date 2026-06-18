package com.imlwork.admin.controller;

import com.imlwork.admin.model.FdeBlueprint;
import com.imlwork.admin.repository.FdeBlueprintRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * FDE 工作台 SKILL 生产线 — 技能蓝图。
 */
@RestController
@RequestMapping("/api/v1/fde/blueprints")
public class FdeBlueprintController {

    private final FdeBlueprintRepository repository;

    public FdeBlueprintController(FdeBlueprintRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public ResponseEntity<List<FdeBlueprint>> list(@RequestParam(value = "scenarioId", required = false) String scenarioId) {
        if (scenarioId == null || scenarioId.isBlank()) {
            return ResponseEntity.ok(repository.findAll());
        }
        return ResponseEntity.ok(repository.findByScenarioIdOrderByUpdatedAtDesc(scenarioId));
    }

    @GetMapping("/{id}")
    public ResponseEntity<FdeBlueprint> get(@PathVariable String id) {
        return repository.findById(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<FdeBlueprint> create(@RequestBody FdeBlueprint body) {
        if (body.getId() == null || body.getId().isBlank()) {
            body.setId("fdebp-" + UUID.randomUUID().toString().substring(0, 8));
        }
        if (body.getVersion() == null || body.getVersion().isBlank()) body.setVersion("1.0.0");
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return ResponseEntity.ok(repository.save(body));
    }

    @PutMapping("/{id}")
    public ResponseEntity<FdeBlueprint> update(@PathVariable String id, @RequestBody FdeBlueprint update) {
        return repository.findById(id).map(existing -> {
            existing.setScenarioId(update.getScenarioId());
            existing.setName(update.getName());
            if (update.getVersion() != null) existing.setVersion(update.getVersion());
            if (update.getMarkdownDraft() != null) existing.setMarkdownDraft(update.getMarkdownDraft());
            if (update.getContentJson() != null) existing.setContentJson(update.getContentJson());
            existing.setUpdatedAt(LocalDateTime.now());
            return ResponseEntity.ok(repository.save(existing));
        }).orElse(ResponseEntity.notFound().build());
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
