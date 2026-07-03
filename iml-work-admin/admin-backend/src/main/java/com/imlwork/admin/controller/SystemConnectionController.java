package com.imlwork.admin.controller;

import com.imlwork.admin.model.SystemConnection;
import com.imlwork.admin.service.SystemConnectionService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 业务系统连接：登录验证 / 能力 / 状态机的治理入口。仅做 HTTP 塑形；业务在 {@link SystemConnectionService}。
 * 登录在员工本地受管浏览器完成，本接口只接收验证结果与状态，不接触任何凭证。
 */
@RestController
@RequestMapping("/api/v1/connections")
public class SystemConnectionController {

    private final SystemConnectionService service;

    public SystemConnectionController(SystemConnectionService service) {
        this.service = service;
    }

    @GetMapping
    public List<SystemConnection> list(@RequestParam(required = false) String systemId,
                                       @RequestParam(required = false) String ownerUserId) {
        return service.list(systemId, ownerUserId);
    }

    @GetMapping("/{id}")
    public SystemConnection get(@PathVariable String id) {
        return service.get(id);
    }

    @PostMapping
    public SystemConnection create(@RequestBody SystemConnection body) {
        return service.create(body);
    }

    @PutMapping("/{id}")
    public SystemConnection update(@PathVariable String id, @RequestBody SystemConnection body) {
        return service.update(id, body);
    }

    @PostMapping("/{id}/verify-result")
    public SystemConnection verifyResult(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return service.verifyResult(id, body);
    }

    @PostMapping("/{id}/suspend")
    public SystemConnection suspend(@PathVariable String id) {
        return service.setStatus(id, "suspended");
    }

    @PostMapping("/{id}/revoke")
    public SystemConnection revoke(@PathVariable String id) {
        return service.setStatus(id, "revoked");
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        service.delete(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }
}
