package com.imlwork.admin.service;

import com.imlwork.admin.model.FdeProject;
import com.imlwork.admin.repository.FdeProjectRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * FDE 工作台 SKILL 生产线 — 交付项目。
 * 业务与事务在此，控制器只做 HTTP 塑形。
 */
@Service
public class FdeProjectService {

    private final FdeProjectRepository repository;

    public FdeProjectService(FdeProjectRepository repository) {
        this.repository = repository;
    }

    @Transactional(readOnly = true)
    public List<FdeProject> list() {
        return repository.findAllByOrderByUpdatedAtDesc();
    }

    @Transactional(readOnly = true)
    public Optional<FdeProject> get(String id) {
        return repository.findById(id);
    }

    /** 创建项目：缺省补 ID / 阶段 discovery，创建与更新时间统一由服务端落。 */
    @Transactional
    public FdeProject create(FdeProject body) {
        if (body.getId() == null || body.getId().isBlank()) {
            body.setId("fdeproj-" + UUID.randomUUID().toString().substring(0, 8));
        }
        if (body.getStage() == null || body.getStage().isBlank()) body.setStage("discovery");
        LocalDateTime now = LocalDateTime.now();
        body.setCreatedAt(now);
        body.setUpdatedAt(now);
        return repository.save(body);
    }

    /** 合并式更新：基础字段全量覆盖，stage 仅在给值时覆盖；不存在返回 empty。 */
    @Transactional
    public Optional<FdeProject> update(String id, FdeProject update) {
        return repository.findById(id).map(existing -> {
            existing.setName(update.getName());
            existing.setCustomerName(update.getCustomerName());
            existing.setIndustry(update.getIndustry());
            existing.setPilotDepartment(update.getPilotDepartment());
            existing.setOwner(update.getOwner());
            if (update.getStage() != null) existing.setStage(update.getStage());
            existing.setPlannedLaunchDate(update.getPlannedLaunchDate());
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
