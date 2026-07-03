package com.imlwork.admin.controller;

import com.imlwork.admin.model.FdeDeliveryPackage;
import com.imlwork.admin.service.FdeDeliveryPackageService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/** FDE 工作台 SKILL 生产线 — 交付包。仅做 HTTP 塑形；业务在 {@link FdeDeliveryPackageService}。 */
@RestController
@RequestMapping("/api/v1/fde/deliveries")
public class FdeDeliveryPackageController {

    private final FdeDeliveryPackageService service;

    public FdeDeliveryPackageController(FdeDeliveryPackageService service) {
        this.service = service;
    }

    @GetMapping
    public ResponseEntity<List<FdeDeliveryPackage>> list(@RequestParam(value = "scenarioId", required = false) String scenarioId) {
        return ResponseEntity.ok(service.list(scenarioId));
    }

    @GetMapping("/{id}")
    public FdeDeliveryPackage get(@PathVariable String id) {
        return service.get(id);
    }

    @PostMapping
    public FdeDeliveryPackage create(@RequestBody FdeDeliveryPackage body) {
        return service.create(body);
    }

    @PutMapping("/{id}")
    public FdeDeliveryPackage update(@PathVariable String id, @RequestBody FdeDeliveryPackage update) {
        return service.update(id, update);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        service.delete(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }
}
