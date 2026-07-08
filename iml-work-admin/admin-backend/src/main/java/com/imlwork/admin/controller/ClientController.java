package com.imlwork.admin.controller;

import com.imlwork.admin.model.ClientNode;
import com.imlwork.admin.service.ClientNodeService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 接收 Electron 客户端节点心跳，并向管理端 SandboxManager 暴露其在线运行状态。
 * 仅做 HTTP 塑形；业务与事务在 {@link ClientNodeService}。
 */
@RestController
@RequestMapping("/api/v1/clients")
public class ClientController {

    private final ClientNodeService service;

    public ClientController(ClientNodeService service) {
        this.service = service;
    }

    @PostMapping("/heartbeat")
    public ResponseEntity<Map<String, Object>> heartbeat(@RequestBody ClientNode incoming) {
        if (incoming.getClientId() == null || incoming.getClientId().isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("success", false, "error", "clientId required"));
        }
        return ResponseEntity.ok(Map.of("success", true, "clientId", service.upsertHeartbeat(incoming)));
    }

    @GetMapping
    public ResponseEntity<List<Map<String, Object>>> list() {
        return ResponseEntity.ok(service.listWithStatus());
    }

    /** 清理离线节点：删除已离线（超出在线窗口未心跳）的陈旧节点，返回删除数。在线节点不动。 */
    @DeleteMapping("/offline")
    public ResponseEntity<Map<String, Object>> pruneOffline() {
        int removed = service.pruneOffline();
        return ResponseEntity.ok(Map.of("success", true, "removed", removed));
    }
}
