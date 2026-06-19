package com.imlwork.admin.controller;

import com.imlwork.admin.model.ConnectorAction;
import com.imlwork.admin.repository.ConnectorActionRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 连接器动作：可复用业务动作的注册与管理。录制产出动作，SKILL 引用动作 ID。
 */
@RestController
@RequestMapping("/api/v1/connector-actions")
public class ConnectorActionController {

    private final ConnectorActionRepository repo;

    public ConnectorActionController(ConnectorActionRepository repo) {
        this.repo = repo;
    }

    @GetMapping
    public List<ConnectorAction> list(@RequestParam(required = false) String systemId,
                                      @RequestParam(required = false) String connectionId) {
        if (systemId != null && !systemId.isBlank()) return repo.findBySystemIdOrderByUpdatedAtDesc(systemId);
        if (connectionId != null && !connectionId.isBlank()) return repo.findByConnectionIdOrderByUpdatedAtDesc(connectionId);
        return repo.findAllByOrderByUpdatedAtDesc();
    }

    @GetMapping("/{id}")
    public ResponseEntity<ConnectorAction> get(@PathVariable String id) {
        return repo.findById(id).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping
    public ConnectorAction create(@RequestBody ConnectorAction body) {
        if (body.getId() == null || body.getId().isBlank()) {
            body.setId("cact-" + UUID.randomUUID().toString().substring(0, 8));
        }
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return repo.save(body);
    }

    @PutMapping("/{id}")
    public ResponseEntity<ConnectorAction> update(@PathVariable String id, @RequestBody ConnectorAction body) {
        return repo.findById(id).map(a -> {
            a.setSystemId(body.getSystemId());
            a.setConnectionId(body.getConnectionId());
            a.setName(body.getName());
            a.setActionKey(body.getActionKey());
            if (body.getCapability() != null && !body.getCapability().isBlank()) a.setCapability(body.getCapability());
            if (body.getVersion() != null && !body.getVersion().isBlank()) a.setVersion(body.getVersion());
            a.setStepsJson(body.getStepsJson());
            a.setFieldsJson(body.getFieldsJson());
            a.setSopHint(body.getSopHint());
            a.setIrJson(body.getIrJson());
            a.setUpdatedAt(LocalDateTime.now());
            return ResponseEntity.ok(repo.save(a));
        }).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        if (!repo.existsById(id)) return ResponseEntity.notFound().build();
        repo.deleteById(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }
}
