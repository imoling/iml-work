package com.imlwork.admin.controller;

import com.imlwork.admin.model.FdeTemplate;
import com.imlwork.admin.repository.FdeTemplateRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * FDE 工作台 SKILL 生产线 — 复用模板。
 */
@RestController
@RequestMapping("/api/v1/fde/templates")
public class FdeTemplateController {

    private final FdeTemplateRepository repository;

    public FdeTemplateController(FdeTemplateRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public ResponseEntity<List<FdeTemplate>> list(@RequestParam(value = "type", required = false) String type) {
        if (type == null || type.isBlank()) {
            return ResponseEntity.ok(repository.findAllByOrderByUpdatedAtDesc());
        }
        return ResponseEntity.ok(repository.findByType(type));
    }

    @GetMapping("/{id}")
    public ResponseEntity<FdeTemplate> get(@PathVariable String id) {
        return repository.findById(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<FdeTemplate> create(@RequestBody FdeTemplate body) {
        if (body.getId() == null || body.getId().isBlank()) {
            body.setId("fdetpl-" + UUID.randomUUID().toString().substring(0, 8));
        }
        if (body.getVersion() == null || body.getVersion().isBlank()) body.setVersion("1.0.0");
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return ResponseEntity.ok(repository.save(body));
    }

    @PutMapping("/{id}")
    public ResponseEntity<FdeTemplate> update(@PathVariable String id, @RequestBody FdeTemplate update) {
        return repository.findById(id).map(existing -> {
            existing.setName(update.getName());
            existing.setType(update.getType());
            if (update.getVersion() != null) existing.setVersion(update.getVersion());
            existing.setSourceProjectId(update.getSourceProjectId());
            if (update.getLastUsedAt() != null) existing.setLastUsedAt(update.getLastUsedAt());
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
