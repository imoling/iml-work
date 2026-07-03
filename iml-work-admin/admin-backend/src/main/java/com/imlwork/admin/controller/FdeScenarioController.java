package com.imlwork.admin.controller;

import com.imlwork.admin.model.FdeScenario;
import com.imlwork.admin.service.FdeScenarioService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/** FDE 工作台 SKILL 生产线 — 业务场景。仅做 HTTP 塑形；业务在 {@link FdeScenarioService}。 */
@RestController
@RequestMapping("/api/v1/fde/scenarios")
public class FdeScenarioController {

    private final FdeScenarioService service;

    public FdeScenarioController(FdeScenarioService service) {
        this.service = service;
    }

    @GetMapping
    public ResponseEntity<List<FdeScenario>> list(@RequestParam(value = "projectId", required = false) String projectId) {
        return ResponseEntity.ok(service.list(projectId));
    }

    @GetMapping("/{id}")
    public FdeScenario get(@PathVariable String id) {
        return service.get(id);
    }

    @PostMapping
    public FdeScenario create(@RequestBody FdeScenario body) {
        return service.create(body);
    }

    @PutMapping("/{id}")
    public FdeScenario update(@PathVariable String id, @RequestBody FdeScenario update) {
        return service.update(id, update);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        service.delete(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }
}
