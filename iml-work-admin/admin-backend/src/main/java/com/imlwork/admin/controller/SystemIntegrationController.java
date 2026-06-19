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
        integration.setStatus("REGISTERED");
        integration.setMessage("地址已登记；登录在 FDE/客户端本地验证");
        return ResponseEntity.ok(repository.save(integration));
    }

    @PutMapping("/{id}")
    public ResponseEntity<SystemIntegration> update(@PathVariable String id, @RequestBody SystemIntegration update) {
        return repository.findById(id).map(existing -> {
            // 管理平台只登记地址，不收集/保存任何登录凭证（登录在 FDE/客户端本地完成）
            existing.setType(update.getType());
            existing.setName(update.getName());
            existing.setBaseUrl(update.getBaseUrl());
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

    /**
     * 探测业务系统地址可达性（不涉及任何凭证）。
     * 登录验证由员工在 FDE / 客户端本地受管浏览器完成（见 /api/v1/connections），
     * 管理平台只登记地址、不保存账号密码。
     */
    @PostMapping("/{id}/verify")
    public ResponseEntity<SystemIntegration> verify(@PathVariable String id) {
        return repository.findById(id).map(integration -> {
            if (integration.getBaseUrl() == null || integration.getBaseUrl().isBlank()) {
                integration.setStatus("ERROR");
                integration.setMessage("缺少连接 URL");
            } else if (probe(integration.getBaseUrl())) {
                integration.setStatus("REACHABLE");
                integration.setMessage("地址可达；登录由员工在 FDE/客户端本地验证");
            } else {
                integration.setStatus("REGISTERED");
                integration.setMessage("地址已登记；当前网络未探测到（内网/离线）。登录在本地完成");
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
