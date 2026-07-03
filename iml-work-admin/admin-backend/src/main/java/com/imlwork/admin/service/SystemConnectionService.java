package com.imlwork.admin.service;

import com.imlwork.admin.model.SystemConnection;
import com.imlwork.admin.repository.SystemConnectionRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** 业务系统连接领域服务：状态机治理，绝不接触任何凭证。 */
@Service
public class SystemConnectionService {

    private final SystemConnectionRepository repo;

    public SystemConnectionService(SystemConnectionRepository repo) {
        this.repo = repo;
    }

    @Transactional(readOnly = true)
    public List<SystemConnection> list(String systemId, String ownerUserId) {
        if (systemId != null && !systemId.isBlank()) return repo.findBySystemIdOrderByUpdatedAtDesc(systemId);
        if (ownerUserId != null && !ownerUserId.isBlank()) return repo.findByOwnerUserIdOrderByUpdatedAtDesc(ownerUserId);
        return repo.findAllByOrderByUpdatedAtDesc();
    }

    @Transactional(readOnly = true)
    public SystemConnection get(String id) {
        return repo.findById(id).orElseThrow(() -> notFound());
    }

    @Transactional
    public SystemConnection create(SystemConnection body) {
        if (body.getId() == null || body.getId().isBlank()) body.setId("conn-" + UUID.randomUUID().toString().substring(0, 8));
        if (body.getStatus() == null || body.getStatus().isBlank()) body.setStatus("draft");
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return repo.save(body);
    }

    @Transactional
    public SystemConnection update(String id, SystemConnection body) {
        SystemConnection c = repo.findById(id).orElseThrow(() -> notFound());
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
        return repo.save(c);
    }

    /** 本地登录验证结果上报：ok=true → verified；否则 failed。绝不接收凭证。 */
    @Transactional
    public SystemConnection verifyResult(String id, Map<String, Object> body) {
        SystemConnection c = repo.findById(id).orElseThrow(() -> notFound());
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
        return repo.save(c);
    }

    @Transactional
    public SystemConnection setStatus(String id, String status) {
        SystemConnection c = repo.findById(id).orElseThrow(() -> notFound());
        c.setStatus(status);
        c.setUpdatedAt(LocalDateTime.now());
        return repo.save(c);
    }

    @Transactional
    public void delete(String id) {
        if (!repo.existsById(id)) throw notFound();
        repo.deleteById(id);
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "连接不存在");
    }
}
