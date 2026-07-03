package com.imlwork.admin.service;

import com.imlwork.admin.model.FdeTemplate;
import com.imlwork.admin.repository.FdeTemplateRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;

/** FDE 复用模板领域服务。 */
@Service
public class FdeTemplateService {

    private final FdeTemplateRepository repository;

    public FdeTemplateService(FdeTemplateRepository repository) {
        this.repository = repository;
    }

    @Transactional(readOnly = true)
    public List<FdeTemplate> list(String type) {
        if (type == null || type.isBlank()) return repository.findAllByOrderByUpdatedAtDesc();
        return repository.findByType(type);
    }

    @Transactional(readOnly = true)
    public FdeTemplate get(String id) {
        return repository.findById(id).orElseThrow(() -> notFound());
    }

    @Transactional
    public FdeTemplate create(FdeTemplate body) {
        if (body.getId() == null || body.getId().isBlank()) body.setId("fdetpl-" + UUID.randomUUID().toString().substring(0, 8));
        if (body.getVersion() == null || body.getVersion().isBlank()) body.setVersion("1.0.0");
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return repository.save(body);
    }

    @Transactional
    public FdeTemplate update(String id, FdeTemplate update) {
        FdeTemplate existing = repository.findById(id).orElseThrow(() -> notFound());
        existing.setName(update.getName());
        existing.setType(update.getType());
        if (update.getVersion() != null) existing.setVersion(update.getVersion());
        existing.setSourceProjectId(update.getSourceProjectId());
        if (update.getLastUsedAt() != null) existing.setLastUsedAt(update.getLastUsedAt());
        if (update.getContentJson() != null) existing.setContentJson(update.getContentJson());
        existing.setUpdatedAt(LocalDateTime.now());
        return repository.save(existing);
    }

    @Transactional
    public void delete(String id) {
        if (!repository.existsById(id)) throw notFound();
        repository.deleteById(id);
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "模板不存在");
    }
}
