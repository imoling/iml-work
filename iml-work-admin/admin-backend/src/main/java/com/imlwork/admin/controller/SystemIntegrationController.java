package com.imlwork.admin.controller;

import com.imlwork.admin.model.SystemIntegration;
import com.imlwork.admin.service.SystemIntegrationService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 业务系统登记（OA/CRM/…）。仅做 HTTP 塑形；地址探测与状态机在 {@link SystemIntegrationService}。
 * 只登记地址、不保存任何凭证；登录由员工在 FDE/客户端本地完成。
 */
@RestController
@RequestMapping("/api/v1/integrations")
public class SystemIntegrationController {

    private final SystemIntegrationService service;

    public SystemIntegrationController(SystemIntegrationService service) {
        this.service = service;
    }

    @GetMapping
    public ResponseEntity<List<SystemIntegration>> list() {
        return ResponseEntity.ok(service.list());
    }

    @PostMapping
    public SystemIntegration create(@RequestBody SystemIntegration integration) {
        return service.create(integration);
    }

    @PutMapping("/{id}")
    public SystemIntegration update(@PathVariable String id, @RequestBody SystemIntegration update) {
        return service.update(id, update);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        service.delete(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }

    @PostMapping("/{id}/verify")
    public SystemIntegration verify(@PathVariable String id) {
        return service.verify(id);
    }

    @PostMapping("/{id}/disconnect")
    public SystemIntegration disconnect(@PathVariable String id) {
        return service.disconnect(id);
    }
}
