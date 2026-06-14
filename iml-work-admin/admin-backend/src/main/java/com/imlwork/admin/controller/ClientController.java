package com.imlwork.admin.controller;

import com.imlwork.admin.model.ClientNode;
import com.imlwork.admin.repository.ClientNodeRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Receives heartbeats from Electron client nodes and exposes their live sandbox
 * runtime status to the admin SandboxManager. A node counts as online when its
 * last heartbeat is within {@link #ONLINE_WINDOW_SECONDS}.
 */
@RestController
@RequestMapping("/api/v1/clients")
public class ClientController {

    private static final long ONLINE_WINDOW_SECONDS = 90;

    private final ClientNodeRepository repository;

    public ClientController(ClientNodeRepository repository) {
        this.repository = repository;
    }

    @PostMapping("/heartbeat")
    public ResponseEntity<Map<String, Object>> heartbeat(@RequestBody ClientNode incoming) {
        if (incoming.getClientId() == null || incoming.getClientId().isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("success", false, "error", "clientId required"));
        }
        ClientNode node = repository.findById(incoming.getClientId()).orElseGet(ClientNode::new);
        node.setClientId(incoming.getClientId());
        node.setHostname(incoming.getHostname());
        node.setExpertId(incoming.getExpertId());
        node.setExpertName(incoming.getExpertName());
        node.setSandboxMode(incoming.getSandboxMode());
        node.setPyodideHealthy(incoming.isPyodideHealthy());
        node.setImCommandCount(incoming.getImCommandCount());
        node.setAppVersion(incoming.getAppVersion());
        node.setLastSeen(LocalDateTime.now());
        repository.save(node);
        return ResponseEntity.ok(Map.of("success", true, "clientId", node.getClientId()));
    }

    @GetMapping
    public ResponseEntity<List<Map<String, Object>>> list() {
        LocalDateTime now = LocalDateTime.now();
        List<Map<String, Object>> rows = repository.findAll().stream().map(n -> {
            boolean online = n.getLastSeen() != null
                    && Duration.between(n.getLastSeen(), now).getSeconds() <= ONLINE_WINDOW_SECONDS;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("clientId", n.getClientId());
            m.put("hostname", n.getHostname());
            m.put("expertId", n.getExpertId());
            m.put("expertName", n.getExpertName());
            m.put("sandboxMode", n.getSandboxMode());
            m.put("pyodideHealthy", n.isPyodideHealthy());
            m.put("imCommandCount", n.getImCommandCount());
            m.put("appVersion", n.getAppVersion());
            m.put("lastSeen", n.getLastSeen());
            m.put("online", online);
            return m;
        }).toList();
        return ResponseEntity.ok(rows);
    }
}
