package com.imlwork.admin.service;

import com.imlwork.admin.model.FdeDeliveryPackage;
import com.imlwork.admin.repository.FdeDeliveryPackageRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;

/** FDE 交付包领域服务。 */
@Service
public class FdeDeliveryPackageService {

    private final FdeDeliveryPackageRepository repository;

    public FdeDeliveryPackageService(FdeDeliveryPackageRepository repository) {
        this.repository = repository;
    }

    /** 按场景过滤（更新时间倒序）；未给场景则倒序封顶一页，不全量直出。 */
    @Transactional(readOnly = true)
    public List<FdeDeliveryPackage> list(String scenarioId) {
        if (scenarioId == null || scenarioId.isBlank()) {
            return repository.findAll(PageRequest.of(0, 500, Sort.by(Sort.Direction.DESC, "updatedAt"))).getContent();
        }
        return repository.findByScenarioIdOrderByUpdatedAtDesc(scenarioId);
    }

    @Transactional(readOnly = true)
    public FdeDeliveryPackage get(String id) {
        return repository.findById(id).orElseThrow(() -> notFound());
    }

    @Transactional
    public FdeDeliveryPackage create(FdeDeliveryPackage body) {
        if (body.getId() == null || body.getId().isBlank()) body.setId("fdedlv-" + UUID.randomUUID().toString().substring(0, 8));
        if (body.getStatus() == null || body.getStatus().isBlank()) body.setStatus("draft");
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return repository.save(body);
    }

    @Transactional
    public FdeDeliveryPackage update(String id, FdeDeliveryPackage update) {
        FdeDeliveryPackage existing = repository.findById(id).orElseThrow(() -> notFound());
        existing.setScenarioId(update.getScenarioId());
        existing.setBlueprintId(update.getBlueprintId());
        if (update.getStatus() != null) existing.setStatus(update.getStatus());
        existing.setSubmitTarget(update.getSubmitTarget());
        existing.setPublishedSkillId(update.getPublishedSkillId());
        if (update.getSkillMarkdown() != null) existing.setSkillMarkdown(update.getSkillMarkdown());
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
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "交付包不存在");
    }
}
