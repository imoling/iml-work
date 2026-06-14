package com.imlwork.admin.controller;

import com.imlwork.admin.model.SandboxConfig;
import com.imlwork.admin.repository.SandboxConfigRepository;
import com.imlwork.admin.service.DockerMonitorService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * Sandbox configuration + live container monitoring. Persists the runtime mode
 * and resource quotas, tests Docker Remote API connectivity, lists running
 * sandbox containers and force-kills them via {@link DockerMonitorService}.
 */
@RestController
@RequestMapping("/api/v1/sandbox")
public class SandboxController {

    private final SandboxConfigRepository configRepository;
    private final DockerMonitorService dockerService;

    public SandboxController(SandboxConfigRepository configRepository, DockerMonitorService dockerService) {
        this.configRepository = configRepository;
        this.dockerService = dockerService;
    }

    @GetMapping("/config")
    public ResponseEntity<SandboxConfig> getConfig() {
        return ResponseEntity.ok(configRepository.findById(1L).orElseGet(() -> {
            SandboxConfig cfg = new SandboxConfig();
            return configRepository.save(cfg);
        }));
    }

    @PutMapping("/config")
    public ResponseEntity<SandboxConfig> updateConfig(@RequestBody SandboxConfig update) {
        SandboxConfig cfg = configRepository.findById(1L).orElseGet(SandboxConfig::new);
        cfg.setId(1L);
        cfg.setMode(update.getMode());
        cfg.setDockerEndpoint(update.getDockerEndpoint());
        cfg.setCpuQuota(update.getCpuQuota());
        cfg.setMemoryQuotaMb(update.getMemoryQuotaMb());
        cfg.setTimeoutSeconds(update.getTimeoutSeconds());
        cfg.setNetworkIsolation(update.isNetworkIsolation());
        return ResponseEntity.ok(configRepository.save(cfg));
    }

    /** Probe Docker Remote API connectivity for the given (or configured) endpoint. */
    @PostMapping("/docker/ping")
    public ResponseEntity<Map<String, Object>> ping(@RequestBody(required = false) Map<String, String> body) {
        String host = body != null ? body.get("endpoint") : null;
        return ResponseEntity.ok(dockerService.ping(host));
    }

    @GetMapping("/containers")
    public ResponseEntity<Map<String, Object>> containers(@RequestParam(value = "endpoint", required = false) String endpoint) {
        return ResponseEntity.ok(dockerService.listContainers(endpoint));
    }

    @DeleteMapping("/containers/{id}")
    public ResponseEntity<Map<String, Object>> kill(
            @PathVariable String id,
            @RequestParam(value = "endpoint", required = false) String endpoint) {
        return ResponseEntity.ok(dockerService.killContainer(endpoint, id));
    }
}
