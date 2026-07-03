package com.imlwork.admin.service;

import com.imlwork.admin.model.FdeScenario;
import com.imlwork.admin.repository.FdeScenarioRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;

/** FDE 业务场景领域服务。 */
@Service
public class FdeScenarioService {

    private final FdeScenarioRepository repository;

    public FdeScenarioService(FdeScenarioRepository repository) {
        this.repository = repository;
    }

    @Transactional(readOnly = true)
    public List<FdeScenario> list(String projectId) {
        if (projectId == null || projectId.isBlank()) return repository.findAllByOrderByUpdatedAtDesc();
        return repository.findByProjectIdOrderByUpdatedAtDesc(projectId);
    }

    @Transactional(readOnly = true)
    public FdeScenario get(String id) {
        return repository.findById(id).orElseThrow(() -> notFound());
    }

    @Transactional
    public FdeScenario create(FdeScenario body) {
        if (body.getId() == null || body.getId().isBlank()) body.setId("fdescen-" + UUID.randomUUID().toString().substring(0, 8));
        if (body.getStatus() == null || body.getStatus().isBlank()) body.setStatus("draft");
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return repository.save(body);
    }

    @Transactional
    public FdeScenario update(String id, FdeScenario update) {
        FdeScenario existing = repository.findById(id).orElseThrow(() -> notFound());
        existing.setProjectId(update.getProjectId());
        existing.setName(update.getName());
        existing.setDepartment(update.getDepartment());
        existing.setBusinessRole(update.getBusinessRole());
        existing.setDescription(update.getDescription());
        existing.setFrequency(update.getFrequency());
        if (update.getStatus() != null) existing.setStatus(update.getStatus());
        existing.setRiskLevel(update.getRiskLevel());
        existing.setReusePotential(update.getReusePotential());
        existing.setOwner(update.getOwner());
        if (update.getSystems() != null) existing.setSystems(update.getSystems());
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
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "场景不存在");
    }
}
