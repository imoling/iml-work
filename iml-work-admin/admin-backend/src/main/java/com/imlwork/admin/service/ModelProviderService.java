package com.imlwork.admin.service;

import com.imlwork.admin.dto.ModelProviderRequests;
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
    public ModelProvider create(ModelProviderRequests.Upsert body) {
        ModelProvider p = new ModelProvider();
        p.setId("mp-" + UUID.randomUUID().toString().substring(0, 8));
        applyEditable(p, body);
        p.setStatus("UNKNOWN");        // 计数器/状态服务端管理，默认零值即可
        return repository.save(p);
    }

    @Transactional
    public ModelProvider update(String id, ModelProviderRequests.Upsert body) {
        ModelProvider existing = repository.findById(id).orElseThrow(() -> notFound());
        applyEditable(existing, body);
        return repository.save(existing);
    }

    /** 把 DTO 里客户端可编辑的字段写入实体（id/status/计数器/lastChecked 不在其列）。 */
    private void applyEditable(ModelProvider p, ModelProviderRequests.Upsert body) {
        p.setName(body.name());
        p.setProvider(body.provider());
        p.setBaseUrl(body.baseUrl());
        p.setModel(body.model());
        p.setRouteKey(body.routeKey());
        p.setWeight(body.weight() == null ? 1 : Math.max(1, body.weight()));
        p.setEnabled(body.enabled() == null || body.enabled());
        p.setInputPricePer1k(body.inputPricePer1k());      // 可空：清空=不计费
        p.setOutputPricePer1k(body.outputPricePer1k());
        // 仅当传入非空 key 时才覆盖（GET 不下发 key，编辑留空不会误清空）
        if (body.apiKey() != null && !body.apiKey().isBlank()) p.setApiKey(body.apiKey());
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
