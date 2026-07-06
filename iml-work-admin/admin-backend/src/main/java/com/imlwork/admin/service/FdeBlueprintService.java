package com.imlwork.admin.service;

import com.imlwork.admin.model.FdeBlueprint;
import com.imlwork.admin.repository.FdeBlueprintRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * FDE 工作台 SKILL 生产线 — 技能蓝图。
 * 业务与事务在此，控制器只做 HTTP 塑形。
 */
@Service
public class FdeBlueprintService {

    private final FdeBlueprintRepository repository;

    public FdeBlueprintService(FdeBlueprintRepository repository) {
        this.repository = repository;
    }

    /** 按场景过滤（更新时间倒序）；未给场景则全量列出。 */
    @Transactional(readOnly = true)
    public List<FdeBlueprint> list(String scenarioId) {
        if (scenarioId == null || scenarioId.isBlank()) {
            return repository.findAll();
        }
        return repository.findByScenarioIdOrderByUpdatedAtDesc(scenarioId);
    }

    @Transactional(readOnly = true)
    public Optional<FdeBlueprint> get(String id) {
        return repository.findById(id);
    }

    /** 创建蓝图：缺省补 ID / 版本 1.0.0，创建与更新时间统一由服务端落。 */
    @Transactional
    public FdeBlueprint create(FdeBlueprint body) {
        if (body.getId() == null || body.getId().isBlank()) {
            body.setId("fdebp-" + UUID.randomUUID().toString().substring(0, 8));
        }
        if (body.getVersion() == null || body.getVersion().isBlank()) body.setVersion("1.0.0");
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return repository.save(body);
    }

    /** 合并式更新：scenarioId/name 全量覆盖，version/草稿/内容仅在给值时覆盖；不存在返回 empty。 */
    @Transactional
    public Optional<FdeBlueprint> update(String id, FdeBlueprint update) {
        return repository.findById(id).map(existing -> {
            existing.setScenarioId(update.getScenarioId());
            existing.setName(update.getName());
            if (update.getVersion() != null) existing.setVersion(update.getVersion());
            if (update.getMarkdownDraft() != null) existing.setMarkdownDraft(update.getMarkdownDraft());
            if (update.getContentJson() != null) existing.setContentJson(update.getContentJson());
            existing.setUpdatedAt(LocalDateTime.now());
            return repository.save(existing);
        });
    }

    /** 删除；不存在返回 false。 */
    @Transactional
    public boolean delete(String id) {
        if (!repository.existsById(id)) {
            return false;
        }
        repository.deleteById(id);
        return true;
    }
}
