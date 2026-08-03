package com.imlwork.admin.service;

import com.imlwork.admin.model.ClientPolicy;
import com.imlwork.admin.repository.ClientPolicyRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.Map;

/** 客户端策略：单例读写 + 随心跳下发的精简视图。 */
@Service
public class ClientPolicyService {

    private final ClientPolicyRepository repository;

    public ClientPolicyService(ClientPolicyRepository repository) {
        this.repository = repository;
    }

    /** 单例读取；表为空（迁移前的老库）时返回默认值而不是抛错——策略缺失不该让心跳挂掉。 */
    @Transactional(readOnly = true)
    public ClientPolicy current() {
        return repository.findById(1L).orElseGet(ClientPolicy::new);
    }

    /** 下发给客户端的精简视图（只给它需要判断的字段，不暴露整行实体）。 */
    @Transactional(readOnly = true)
    public Map<String, Object> forClient() {
        return Map.of("allowCustomModel", current().isAllowCustomModel());
    }

    @Transactional
    public ClientPolicy update(boolean allowCustomModel) {
        ClientPolicy p = repository.findById(1L).orElseGet(() -> {
            ClientPolicy fresh = new ClientPolicy();
            fresh.setId(1L);
            return fresh;
        });
        p.setAllowCustomModel(allowCustomModel);
        p.setUpdatedAt(LocalDateTime.now());
        return repository.save(p);
    }
}
