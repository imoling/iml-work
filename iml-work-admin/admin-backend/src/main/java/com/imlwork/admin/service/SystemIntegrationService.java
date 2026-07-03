package com.imlwork.admin.service;

import com.imlwork.admin.model.SystemIntegration;
import com.imlwork.admin.repository.SystemIntegrationRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;

/**
 * 业务系统登记领域服务（OA/CRM/…）。只登记地址与可达状态，绝不收集/保存任何登录凭证。
 * 地址可达性探测不涉及凭证；登录由员工在 FDE/客户端本地受管浏览器完成。
 */
@Service
public class SystemIntegrationService {

    private final SystemIntegrationRepository repository;
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    public SystemIntegrationService(SystemIntegrationRepository repository) {
        this.repository = repository;
    }

    @Transactional(readOnly = true)
    public List<SystemIntegration> list() {
        return repository.findAll();
    }

    @Transactional
    public SystemIntegration create(SystemIntegration integration) {
        if (integration.getId() == null || integration.getId().isBlank()) {
            integration.setId("sys-" + UUID.randomUUID().toString().substring(0, 8));
        }
        if (integration.getBaseUrl() != null) integration.setBaseUrl(integration.getBaseUrl().trim());
        integration.setStatus("REGISTERED");
        integration.setMessage("地址已登记；登录在 FDE/客户端本地验证");
        return repository.save(integration);
    }

    @Transactional
    public SystemIntegration update(String id, SystemIntegration update) {
        SystemIntegration existing = repository.findById(id).orElseThrow(() -> notFound());
        // 管理平台只登记地址，不收集/保存任何登录凭证（登录在 FDE/客户端本地完成）
        existing.setType(update.getType());
        existing.setName(update.getName());
        existing.setBaseUrl(update.getBaseUrl() == null ? null : update.getBaseUrl().trim());
        return repository.save(existing);
    }

    @Transactional
    public void delete(String id) {
        if (!repository.existsById(id)) throw notFound();
        repository.deleteById(id);
    }

    /** 探测地址可达性（不涉及凭证），更新状态机。 */
    @Transactional
    public SystemIntegration verify(String id) {
        SystemIntegration integration = repository.findById(id).orElseThrow(() -> notFound());
        if (integration.getBaseUrl() == null || integration.getBaseUrl().isBlank()) {
            integration.setStatus("ERROR");
            integration.setMessage("缺少连接 URL");
        } else if (probe(integration.getBaseUrl())) {
            integration.setStatus("REACHABLE");
            integration.setMessage("地址可达；登录由员工在 FDE/客户端本地验证");
        } else {
            integration.setStatus("UNREACHABLE");
            integration.setMessage("地址不可达：当前网络未探测到响应（可能内网/离线/防火墙）。登录仍在本地完成");
        }
        integration.setLastChecked(LocalDateTime.now());
        return repository.save(integration);
    }

    @Transactional
    public SystemIntegration disconnect(String id) {
        SystemIntegration integration = repository.findById(id).orElseThrow(() -> notFound());
        integration.setStatus("DISCONNECTED");
        integration.setMessage("连接已断开");
        integration.setLastChecked(LocalDateTime.now());
        return repository.save(integration);
    }

    /** 清洗登记地址：去首尾空白、去掉 #hash 片段（SPA 路由）、补全协议。 */
    public static String sanitizeUrl(String raw) {
        if (raw == null) return "";
        String u = raw.trim();
        int h = u.indexOf('#');
        if (h >= 0) u = u.substring(0, h).trim();
        if (u.isEmpty()) return "";
        return u.startsWith("http") ? u : "https://" + u;
    }

    private boolean probe(String baseUrl) {
        String url = sanitizeUrl(baseUrl);
        if (url.isEmpty()) return false;
        for (String method : new String[]{"HEAD", "GET"}) {
            try {
                HttpRequest request = HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .timeout(Duration.ofSeconds(5))
                        .method(method, HttpRequest.BodyPublishers.noBody())
                        .build();
                HttpResponse<Void> response = httpClient.send(request, HttpResponse.BodyHandlers.discarding());
                if (response.statusCode() > 0) return true;
            } catch (Exception ignored) { /* 换方法重试 */ }
        }
        return false;
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "系统登记不存在");
    }
}
