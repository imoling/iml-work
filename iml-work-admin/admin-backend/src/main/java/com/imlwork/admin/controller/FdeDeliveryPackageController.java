package com.imlwork.admin.controller;

import com.imlwork.admin.model.FdeDeliveryPackage;
import com.imlwork.admin.repository.FdeDeliveryPackageRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * FDE 工作台 SKILL 生产线 — 交付包。
 */
@RestController
@RequestMapping("/api/v1/fde/deliveries")
public class FdeDeliveryPackageController {

    private final FdeDeliveryPackageRepository repository;

    public FdeDeliveryPackageController(FdeDeliveryPackageRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public ResponseEntity<List<FdeDeliveryPackage>> list(@RequestParam(value = "scenarioId", required = false) String scenarioId) {
        if (scenarioId == null || scenarioId.isBlank()) {
            return ResponseEntity.ok(repository.findAll());
        }
        return ResponseEntity.ok(repository.findByScenarioIdOrderByUpdatedAtDesc(scenarioId));
    }

    @GetMapping("/{id}")
    public ResponseEntity<FdeDeliveryPackage> get(@PathVariable String id) {
        return repository.findById(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<FdeDeliveryPackage> create(@RequestBody FdeDeliveryPackage body) {
        if (body.getId() == null || body.getId().isBlank()) {
            body.setId("fdedlv-" + UUID.randomUUID().toString().substring(0, 8));
        }
        if (body.getStatus() == null || body.getStatus().isBlank()) body.setStatus("draft");
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return ResponseEntity.ok(repository.save(body));
    }

    @PutMapping("/{id}")
    public ResponseEntity<FdeDeliveryPackage> update(@PathVariable String id, @RequestBody FdeDeliveryPackage update) {
        return repository.findById(id).map(existing -> {
            existing.setScenarioId(update.getScenarioId());
            existing.setBlueprintId(update.getBlueprintId());
            if (update.getStatus() != null) existing.setStatus(update.getStatus());
            existing.setSubmitTarget(update.getSubmitTarget());
            existing.setPublishedSkillId(update.getPublishedSkillId());
            if (update.getSkillMarkdown() != null) existing.setSkillMarkdown(update.getSkillMarkdown());
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
