package com.imlwork.admin.controller;

import com.imlwork.admin.model.ConnectorAction;
import com.imlwork.admin.service.ConnectorActionService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 连接器动作：可复用业务动作的注册与管理。录制产出动作，SKILL 引用动作 ID。
 * 仅做 HTTP 塑形；业务与事务在 {@link ConnectorActionService}。
 */
@RestController
@RequestMapping("/api/v1/connector-actions")
public class ConnectorActionController {

    private final ConnectorActionService service;

    public ConnectorActionController(ConnectorActionService service) {
        this.service = service;
    }

    @GetMapping
    public List<ConnectorAction> list(@RequestParam(required = false) String systemId,
                                      @RequestParam(required = false) String connectionId) {
        return service.list(systemId, connectionId);
    }

    @GetMapping("/{id}")
    public ConnectorAction get(@PathVariable String id) {
        return service.get(id);
    }

    @PostMapping
    public ConnectorAction create(@RequestBody ConnectorAction body) {
        return service.create(body);
    }

    @PutMapping("/{id}")
    public ConnectorAction update(@PathVariable String id, @RequestBody ConnectorAction body) {
        return service.update(id, body);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        service.delete(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }
}
