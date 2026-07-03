package com.imlwork.admin.controller;

import com.imlwork.admin.model.FdeTemplate;
import com.imlwork.admin.service.FdeTemplateService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/** FDE 工作台 SKILL 生产线 — 复用模板。仅做 HTTP 塑形；业务在 {@link FdeTemplateService}。 */
@RestController
@RequestMapping("/api/v1/fde/templates")
public class FdeTemplateController {

    private final FdeTemplateService service;

    public FdeTemplateController(FdeTemplateService service) {
        this.service = service;
    }

    @GetMapping
    public ResponseEntity<List<FdeTemplate>> list(@RequestParam(value = "type", required = false) String type) {
        return ResponseEntity.ok(service.list(type));
    }

    @GetMapping("/{id}")
    public FdeTemplate get(@PathVariable String id) {
        return service.get(id);
    }

    @PostMapping
    public FdeTemplate create(@RequestBody FdeTemplate body) {
        return service.create(body);
    }

    @PutMapping("/{id}")
    public FdeTemplate update(@PathVariable String id, @RequestBody FdeTemplate update) {
        return service.update(id, update);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        service.delete(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }
}
