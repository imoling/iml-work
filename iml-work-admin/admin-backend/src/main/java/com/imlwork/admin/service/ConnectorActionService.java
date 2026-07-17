package com.imlwork.admin.service;

import com.imlwork.admin.model.ConnectorAction;
import com.imlwork.admin.repository.ConnectorActionRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;

/** 连接器动作领域服务：注册/查询/更新/删除，Controller 只做 HTTP 塑形。 */
@Service
public class ConnectorActionService {

    private final ConnectorActionRepository repo;

    public ConnectorActionService(ConnectorActionRepository repo) {
        this.repo = repo;
    }

    @Transactional(readOnly = true)
    public List<ConnectorAction> list(String systemId, String connectionId) {
        if (systemId != null && !systemId.isBlank()) return repo.findBySystemIdOrderByUpdatedAtDesc(systemId);
        if (connectionId != null && !connectionId.isBlank()) return repo.findByConnectionIdOrderByUpdatedAtDesc(connectionId);
        return repo.findTop500ByOrderByUpdatedAtDesc();
    }

    @Transactional(readOnly = true)
    public ConnectorAction get(String id) {
        return repo.findById(id).orElseThrow(() -> notFound());
    }

    @Transactional
    public ConnectorAction create(ConnectorAction body) {
        if (body.getId() == null || body.getId().isBlank()) {
            body.setId("cact-" + UUID.randomUUID().toString().substring(0, 8));
        }
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return repo.save(body);
    }

    @Transactional
    public ConnectorAction update(String id, ConnectorAction body) {
        ConnectorAction a = repo.findById(id).orElseThrow(() -> notFound());
        a.setSystemId(body.getSystemId());
        a.setConnectionId(body.getConnectionId());
        a.setName(body.getName());
        a.setActionKey(body.getActionKey());
        if (body.getCapability() != null && !body.getCapability().isBlank()) a.setCapability(body.getCapability());
        if (body.getVersion() != null && !body.getVersion().isBlank()) a.setVersion(body.getVersion());
        a.setStepsJson(body.getStepsJson());
        a.setFieldsJson(body.getFieldsJson());
        a.setSopHint(body.getSopHint());
        a.setEntryHash(body.getEntryHash());
        a.setIrJson(body.getIrJson());
        // 三形态执行器字段（replay/api/sop）
        if (body.getKind() != null && !body.getKind().isBlank()) a.setKind(body.getKind());
        a.setApiMethod(body.getApiMethod());
        a.setApiPath(body.getApiPath());
        a.setApiBodyTemplate(body.getApiBodyTemplate());
        a.setOutputDesc(body.getOutputDesc());
        a.setUpdatedAt(LocalDateTime.now());
        return repo.save(a);
    }

    @Transactional
    public void delete(String id) {
        if (!repo.existsById(id)) throw notFound();
        repo.deleteById(id);
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "连接器动作不存在");
    }
}
