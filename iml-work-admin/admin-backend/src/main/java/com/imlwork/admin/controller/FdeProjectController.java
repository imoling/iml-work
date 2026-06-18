package com.imlwork.admin.controller;

import com.imlwork.admin.model.FdeProject;
import com.imlwork.admin.repository.FdeProjectRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * FDE 工作台 SKILL 生产线 — 交付项目。
 */
@RestController
@RequestMapping("/api/v1/fde/projects")
public class FdeProjectController {

    private final FdeProjectRepository repository;

    public FdeProjectController(FdeProjectRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public ResponseEntity<List<FdeProject>> list() {
        return ResponseEntity.ok(repository.findAllByOrderByUpdatedAtDesc());
    }

    @GetMapping("/{id}")
    public ResponseEntity<FdeProject> get(@PathVariable String id) {
        return repository.findById(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<FdeProject> create(@RequestBody FdeProject body) {
        if (body.getId() == null || body.getId().isBlank()) {
            body.setId("fdeproj-" + UUID.randomUUID().toString().substring(0, 8));
        }
        if (body.getStage() == null || body.getStage().isBlank()) body.setStage("discovery");
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return ResponseEntity.ok(repository.save(body));
    }

    @PutMapping("/{id}")
    public ResponseEntity<FdeProject> update(@PathVariable String id, @RequestBody FdeProject update) {
        return repository.findById(id).map(existing -> {
            existing.setName(update.getName());
            existing.setCustomerName(update.getCustomerName());
            existing.setIndustry(update.getIndustry());
            existing.setPilotDepartment(update.getPilotDepartment());
            existing.setOwner(update.getOwner());
            if (update.getStage() != null) existing.setStage(update.getStage());
            existing.setPlannedLaunchDate(update.getPlannedLaunchDate());
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
