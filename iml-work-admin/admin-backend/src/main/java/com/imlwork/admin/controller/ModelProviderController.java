package com.imlwork.admin.controller;

import com.imlwork.admin.dto.ModelProviderRequests;
import com.imlwork.admin.model.ModelProvider;
import com.imlwork.admin.service.ModelProviderService;
import jakarta.validation.Valid;
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
    public ModelProvider create(@Valid @RequestBody ModelProviderRequests.Upsert body) {
        return service.create(body);
    }

    /** 拉取上游可用模型列表：新建传 baseUrl+apiKey；编辑传 providerId（key 在库里，不经前端）。 */
    @PostMapping("/models")
    public ResponseEntity<Map<String, Object>> listModels(@RequestBody Map<String, String> body) {
        return ResponseEntity.ok(service.listUpstreamModels(
                body.get("providerId"), body.get("baseUrl"), body.get("apiKey")));
    }

    @PutMapping("/{id}")
    public ModelProvider update(@PathVariable String id, @Valid @RequestBody ModelProviderRequests.Upsert body) {
        return service.update(id, body);
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
