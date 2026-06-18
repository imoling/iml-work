package com.imlwork.admin.controller;

import com.imlwork.admin.model.FdeScenario;
import com.imlwork.admin.repository.FdeScenarioRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * FDE 工作台 SKILL 生产线 — 业务场景。
 */
@RestController
@RequestMapping("/api/v1/fde/scenarios")
public class FdeScenarioController {

    private final FdeScenarioRepository repository;

    public FdeScenarioController(FdeScenarioRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public ResponseEntity<List<FdeScenario>> list(@RequestParam(value = "projectId", required = false) String projectId) {
        if (projectId == null || projectId.isBlank()) {
            return ResponseEntity.ok(repository.findAllByOrderByUpdatedAtDesc());
        }
        return ResponseEntity.ok(repository.findByProjectIdOrderByUpdatedAtDesc(projectId));
    }

    @GetMapping("/{id}")
    public ResponseEntity<FdeScenario> get(@PathVariable String id) {
        return repository.findById(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<FdeScenario> create(@RequestBody FdeScenario body) {
        if (body.getId() == null || body.getId().isBlank()) {
            body.setId("fdescen-" + UUID.randomUUID().toString().substring(0, 8));
        }
        if (body.getStatus() == null || body.getStatus().isBlank()) body.setStatus("draft");
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return ResponseEntity.ok(repository.save(body));
    }

    @PutMapping("/{id}")
    public ResponseEntity<FdeScenario> update(@PathVariable String id, @RequestBody FdeScenario update) {
        return repository.findById(id).map(existing -> {
            existing.setProjectId(update.getProjectId());
            existing.setName(update.getName());
            existing.setDepartment(update.getDepartment());
            existing.setBusinessRole(update.getBusinessRole());
            existing.setDescription(update.getDescription());
            existing.setFrequency(update.getFrequency());
            if (update.getStatus() != null) existing.setStatus(update.getStatus());
            existing.setRiskLevel(update.getRiskLevel());
            existing.setReusePotential(update.getReusePotential());
            existing.setOwner(update.getOwner());
            if (update.getSystems() != null) existing.setSystems(update.getSystems());
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
