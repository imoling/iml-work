package com.imlwork.admin.service;

import com.imlwork.admin.model.FdeTestRun;
import com.imlwork.admin.repository.FdeTestRunRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * FDE 工作台 SKILL 生产线 — 测试运行记录。
 * 业务与事务在此，控制器只做 HTTP 塑形。
 */
@Service
public class FdeTestRunService {

    private final FdeTestRunRepository repository;

    public FdeTestRunService(FdeTestRunRepository repository) {
        this.repository = repository;
    }

    /** 按场景过滤（时间倒序）；未给场景则全量列出。 */
    @Transactional(readOnly = true)
    public List<FdeTestRun> list(String scenarioId) {
        if (scenarioId == null || scenarioId.isBlank()) {
            return repository.findAll();
        }
        return repository.findByScenarioIdOrderByStartedAtDesc(scenarioId);
    }

    @Transactional(readOnly = true)
    public Optional<FdeTestRun> get(String id) {
        return repository.findById(id);
    }

    /** 创建一次测试运行：缺省补 ID / startedAt，createdAt 统一由服务端落。 */
    @Transactional
    public FdeTestRun create(FdeTestRun body) {
        if (body.getId() == null || body.getId().isBlank()) {
            body.setId("fderun-" + UUID.randomUUID().toString().substring(0, 8));
        }
        LocalDateTime now = LocalDateTime.now();
        if (body.getStartedAt() == null) body.setStartedAt(now);
        body.setCreatedAt(now);
        return repository.save(body);
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
