package com.imlwork.admin.service;

import com.imlwork.admin.model.ModelProvider;
import com.imlwork.admin.repository.ModelProviderRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 模型网关提供商领域服务：注册/权重/开关/健康探活。
 * 探活委托 {@link ModelRouterService#probe}；实时流量调度仍由 ModelRouterService 承担。
 */
@Service
public class ModelProviderService {

    private final ModelProviderRepository repository;
    private final ModelRouterService router;

    public ModelProviderService(ModelProviderRepository repository, ModelRouterService router) {
        this.repository = repository;
        this.router = router;
    }

    @Transactional(readOnly = true)
    public List<ModelProvider> list() {
        return repository.findAll();
    }

    @Transactional(readOnly = true)
    public Map<String, Object> summary() {
        List<ModelProvider> all = repository.findAll();
        long enabled = all.stream().filter(ModelProvider::isEnabled).count();
        long healthy = all.stream().filter(p -> "HEALTHY".equals(p.getStatus())).count();
        long down = all.stream().filter(p -> "DOWN".equals(p.getStatus())).count();
        long totalReq = all.stream().mapToLong(ModelProvider::getTotalRequests).sum();
        long totalFail = all.stream().mapToLong(ModelProvider::getFailedRequests).sum();
        Map<String, Object> s = new HashMap<>();
        s.put("total", all.size());
        s.put("enabled", enabled);
        s.put("healthy", healthy);
        s.put("down", down);
        s.put("totalRequests", totalReq);
        s.put("failedRequests", totalFail);
        s.put("successRate", totalReq == 0 ? 1.0 : (totalReq - totalFail) / (double) totalReq);
        return s;
    }

    @Transactional
    public ModelProvider create(ModelProvider p) {
        if (p.getId() == null || p.getId().isBlank()) p.setId("mp-" + UUID.randomUUID().toString().substring(0, 8));
        if (p.getWeight() < 1) p.setWeight(1);
        p.setStatus("UNKNOWN");
        p.setTotalRequests(0);
        p.setFailedRequests(0);
        p.setAvgLatencyMs(0);
        return repository.save(p);
    }

    @Transactional
    public ModelProvider update(String id, ModelProvider update) {
        ModelProvider existing = repository.findById(id).orElseThrow(() -> notFound());
        existing.setName(update.getName());
        existing.setProvider(update.getProvider());
        existing.setBaseUrl(update.getBaseUrl());
        existing.setModel(update.getModel());
        existing.setRouteKey(update.getRouteKey());
        existing.setWeight(Math.max(1, update.getWeight()));
        existing.setEnabled(update.isEnabled());
        existing.setInputPricePer1k(update.getInputPricePer1k());     // 可空：清空=不计费
        existing.setOutputPricePer1k(update.getOutputPricePer1k());
        // 仅当传入非空 key 时才覆盖（GET 不下发 key，编辑不会误清空）
        if (update.getApiKey() != null && !update.getApiKey().isBlank()) existing.setApiKey(update.getApiKey());
        return repository.save(existing);
    }

    @Transactional
    public ModelProvider toggle(String id) {
        ModelProvider p = repository.findById(id).orElseThrow(() -> notFound());
        p.setEnabled(!p.isEnabled());
        return repository.save(p);
    }

    /** 探活：委托 router.probe（其内部会更新并保存 provider 状态）。 */
    @Transactional
    public ModelProvider health(String id) {
        ModelProvider p = repository.findById(id).orElseThrow(() -> notFound());
        return router.probe(p);
    }

    @Transactional
    public void delete(String id) {
        if (!repository.existsById(id)) throw notFound();
        repository.deleteById(id);
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "提供商不存在");
    }
}
