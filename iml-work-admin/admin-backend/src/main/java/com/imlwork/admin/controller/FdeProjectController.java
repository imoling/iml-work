package com.imlwork.admin.controller;

import com.imlwork.admin.model.FdeProject;
import com.imlwork.admin.service.FdeProjectService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * FDE 工作台 SKILL 生产线 — 交付项目。
 */
@RestController
@RequestMapping("/api/v1/fde/projects")
public class FdeProjectController {

    private final FdeProjectService service;

    public FdeProjectController(FdeProjectService service) {
        this.service = service;
    }

    @GetMapping
    public ResponseEntity<List<FdeProject>> list() {
        return ResponseEntity.ok(service.list());
    }

    @GetMapping("/{id}")
    public ResponseEntity<FdeProject> get(@PathVariable String id) {
        return service.get(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<FdeProject> create(@RequestBody FdeProject body) {
        return ResponseEntity.ok(service.create(body));
    }

    @PutMapping("/{id}")
    public ResponseEntity<FdeProject> update(@PathVariable String id, @RequestBody FdeProject update) {
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
