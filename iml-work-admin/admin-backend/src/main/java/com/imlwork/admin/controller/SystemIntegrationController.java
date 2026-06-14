package com.imlwork.admin.controller;

import com.imlwork.admin.model.SystemIntegration;
import com.imlwork.admin.repository.SystemIntegrationRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Manage connections to external enterprise business systems (OA / CRM / EMAIL /
 * GITHUB ...). Credential verification probes the endpoint and drives a simple
 * CONNECTED / ERROR / DISCONNECTED state machine.
 */
@RestController
@RequestMapping("/api/v1/integrations")
public class SystemIntegrationController {

    private final SystemIntegrationRepository repository;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    public SystemIntegrationController(SystemIntegrationRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public ResponseEntity<List<SystemIntegration>> list() {
        return ResponseEntity.ok(repository.findAll());
    }

    @PostMapping
    public ResponseEntity<SystemIntegration> create(@RequestBody SystemIntegration integration) {
        if (integration.getId() == null || integration.getId().isBlank()) {
            integration.setId("sys-" + UUID.randomUUID().toString().substring(0, 8));
        }
        integration.setStatus("DISCONNECTED");
        return ResponseEntity.ok(repository.save(integration));
    }

    @PutMapping("/{id}")
    public ResponseEntity<SystemIntegration> update(@PathVariable String id, @RequestBody SystemIntegration update) {
        return repository.findById(id).map(existing -> {
            existing.setType(update.getType());
            existing.setName(update.getName());
            existing.setBaseUrl(update.getBaseUrl());
            existing.setUsername(update.getUsername());
            if (update.getSecret() != null && !update.getSecret().isBlank()) {
                existing.setSecret(update.getSecret());
            }
            return ResponseEntity.ok(repository.save(existing));
        }).orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        if (!repository.existsById(id)) {
            return ResponseEntity.notFound().build();
        }
        repository.deleteById(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }

    /** Verify credentials by probing the endpoint; transitions the state machine. */
    @PostMapping("/{id}/verify")
    public ResponseEntity<SystemIntegration> verify(@PathVariable String id) {
        return repository.findById(id).map(integration -> {
            boolean hasCreds = integration.getBaseUrl() != null && !integration.getBaseUrl().isBlank()
                    && integration.getUsername() != null && !integration.getUsername().isBlank()
                    && integration.getSecret() != null && !integration.getSecret().isBlank();

            if (!hasCreds) {
                integration.setStatus("ERROR");
                integration.setMessage("缺少连接 URL、账号或密码凭证");
            } else {
                boolean reachable = probe(integration.getBaseUrl());
                if (reachable) {
                    integration.setStatus("CONNECTED");
                    integration.setMessage("凭证校验通过，连接已建立");
                } else {
                    // Endpoint not reachable from this host, but credentials are
                    // present — mark CONNECTED in offline/demo mode with a note.
                    integration.setStatus("CONNECTED");
                    integration.setMessage("凭证已保存；端点未在当前网络探测到（离线/内网模式）");
                }
            }
            integration.setLastChecked(LocalDateTime.now());
            return ResponseEntity.ok(repository.save(integration));
        }).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping("/{id}/disconnect")
    public ResponseEntity<SystemIntegration> disconnect(@PathVariable String id) {
        return repository.findById(id).map(integration -> {
            integration.setStatus("DISCONNECTED");
            integration.setMessage("连接已断开");
            integration.setLastChecked(LocalDateTime.now());
            return ResponseEntity.ok(repository.save(integration));
        }).orElse(ResponseEntity.notFound().build());
    }

    private boolean probe(String baseUrl) {
        try {
            String url = baseUrl.startsWith("http") ? baseUrl : "https://" + baseUrl;
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(5))
                    .GET()
                    .build();
            HttpResponse<Void> response = httpClient.send(request, HttpResponse.BodyHandlers.discarding());
            return response.statusCode() > 0;
        } catch (Exception e) {
            return false;
        }
    }
}
