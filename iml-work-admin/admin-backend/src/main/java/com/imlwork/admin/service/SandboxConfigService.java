package com.imlwork.admin.service;

import com.imlwork.admin.model.SandboxConfig;
import com.imlwork.admin.repository.SandboxConfigRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 代码执行沙箱配置（单例 row id=1）：读取时懒建默认行，更新为白名单字段合并。
 * 业务与事务在此，控制器只做 HTTP 塑形。
 */
@Service
public class SandboxConfigService {

    private final SandboxConfigRepository repository;

    public SandboxConfigService(SandboxConfigRepository repository) {
        this.repository = repository;
    }

    /** 取单例配置；不存在则落一行默认值（保证前端表单永远有数据）。 */
    @Transactional
    public SandboxConfig getOrCreate() {
        return repository.findById(1L).orElseGet(() -> repository.save(new SandboxConfig()));
    }

    /** 白名单字段合并更新到单例行（id 恒为 1）。 */
    @Transactional
    public SandboxConfig update(SandboxConfig update) {
        SandboxConfig cfg = repository.findById(1L).orElseGet(SandboxConfig::new);
        cfg.setId(1L);
        cfg.setMode(update.getMode());
        cfg.setDockerEndpoint(update.getDockerEndpoint());
        cfg.setBaseImage(update.getBaseImage());
        cfg.setCpuQuota(update.getCpuQuota());
        cfg.setMemoryQuotaMb(update.getMemoryQuotaMb());
        cfg.setTimeoutSeconds(update.getTimeoutSeconds());
        cfg.setNetworkIsolation(update.isNetworkIsolation());
        return repository.save(cfg);
    }
}
