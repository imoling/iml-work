package com.imlwork.admin.controller;

import com.imlwork.admin.model.SystemConnection;
import com.imlwork.admin.repository.SystemConnectionRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 业务系统连接：登录验证 / 能力 / 状态机的治理入口。
 * 登录在员工本地受管浏览器完成，本接口只接收验证结果与状态，不接触任何凭证。
 */
@RestController
@RequestMapping("/api/v1/connections")
public class SystemConnectionController {

    private final SystemConnectionRepository repo;

    public SystemConnectionController(SystemConnectionRepository repo) {
        this.repo = repo;
    }

    @GetMapping
    public List<SystemConnection> list(@RequestParam(required = false) String systemId,
                                       @RequestParam(required = false) String ownerUserId) {
        if (systemId != null && !systemId.isBlank()) return repo.findBySystemIdOrderByUpdatedAtDesc(systemId);
        if (ownerUserId != null && !ownerUserId.isBlank()) return repo.findByOwnerUserIdOrderByUpdatedAtDesc(ownerUserId);
        return repo.findAllByOrderByUpdatedAtDesc();
    }

    @GetMapping("/{id}")
    public ResponseEntity<SystemConnection> get(@PathVariable String id) {
        return repo.findById(id).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping
    public SystemConnection create(@RequestBody SystemConnection body) {
        if (body.getId() == null || body.getId().isBlank()) {
            body.setId("conn-" + UUID.randomUUID().toString().substring(0, 8));
        }
        if (body.getStatus() == null || body.getStatus().isBlank()) body.setStatus("draft");
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return repo.save(body);
    }

    @PutMapping("/{id}")
    public ResponseEntity<SystemConnection> update(@PathVariable String id, @RequestBody SystemConnection body) {
        return repo.findById(id).map(c -> {
            c.setSystemId(body.getSystemId());
            c.setOwnerUserId(body.getOwnerUserId());
            c.setDeviceId(body.getDeviceId());
            c.setBrowserProfileRef(body.getBrowserProfileRef());
            if (body.getCapabilities() != null) c.setCapabilities(body.getCapabilities());
            if (body.getStatus() != null && !body.getStatus().isBlank()) c.setStatus(body.getStatus());
            if (body.getEnvironment() != null) c.setEnvironment(body.getEnvironment());
            c.setMessage(body.getMessage());
            c.setExpiresAt(body.getExpiresAt());
            c.setConnectorVersionRange(body.getConnectorVersionRange());
            c.setUpdatedAt(LocalDateTime.now());
            return ResponseEntity.ok(repo.save(c));
        }).orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** 本地登录验证结果上报：ok=true → verified；否则 failed。绝不接收凭证。 */
    @PostMapping("/{id}/verify-result")
    public ResponseEntity<SystemConnection> verifyResult(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return repo.findById(id).map(c -> {
            boolean ok = Boolean.TRUE.equals(body.get("ok"));
            Object msg = body.get("message");
            c.setMessage(msg == null ? null : String.valueOf(msg));
            if (ok) {
                c.setStatus("verified");
                c.setLastVerifiedAt(LocalDateTime.now());
                Object exp = body.get("expiresAt");
                if (exp != null && !String.valueOf(exp).isBlank()) {
                    try { c.setExpiresAt(LocalDateTime.parse(String.valueOf(exp))); } catch (Exception ignored) {}
                }
            } else {
                c.setStatus("failed");
            }
            c.setUpdatedAt(LocalDateTime.now());
            return ResponseEntity.ok(repo.save(c));
        }).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/{id}/suspend")
    public ResponseEntity<SystemConnection> suspend(@PathVariable String id) {
        return setStatus(id, "suspended");
    }

    @PostMapping("/{id}/revoke")
    public ResponseEntity<SystemConnection> revoke(@PathVariable String id) {
        return setStatus(id, "revoked");
    }

    private ResponseEntity<SystemConnection> setStatus(String id, String status) {
        return repo.findById(id).map(c -> {
            c.setStatus(status);
            c.setUpdatedAt(LocalDateTime.now());
            return ResponseEntity.ok(repo.save(c));
        }).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        if (!repo.existsById(id)) return ResponseEntity.notFound().build();
        repo.deleteById(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }
}
