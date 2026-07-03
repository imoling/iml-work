package com.imlwork.admin.controller;

import com.imlwork.admin.model.ModelProvider;
import com.imlwork.admin.service.ModelProviderService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * Admin CRUD for the enterprise model relay station. 仅做 HTTP 塑形；
 * 业务与探活在 {@link ModelProviderService}；实时流量调度在 ModelRouterService。
 */
@RestController
@RequestMapping("/api/v1/model/providers")
public class ModelProviderController {

    private final ModelProviderService service;

    public ModelProviderController(ModelProviderService service) {
        this.service = service;
    }

    @GetMapping
    public ResponseEntity<List<ModelProvider>> list() {
        return ResponseEntity.ok(service.list());
    }

    @GetMapping("/summary")
    public ResponseEntity<Map<String, Object>> summary() {
        return ResponseEntity.ok(service.summary());
    }

    @PostMapping
    public ModelProvider create(@RequestBody ModelProvider p) {
        return service.create(p);
    }

    @PutMapping("/{id}")
    public ModelProvider update(@PathVariable String id, @RequestBody ModelProvider update) {
        return service.update(id, update);
    }

    @PostMapping("/{id}/toggle")
    public ModelProvider toggle(@PathVariable String id) {
        return service.toggle(id);
    }

    @PostMapping("/{id}/health")
    public ModelProvider health(@PathVariable String id) {
        return service.health(id);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        service.delete(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }
}
