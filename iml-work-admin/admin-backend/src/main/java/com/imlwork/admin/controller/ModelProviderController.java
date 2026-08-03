package com.imlwork.admin.controller;

import com.imlwork.admin.dto.ModelProviderRequests;
import com.imlwork.admin.model.ModelProvider;
import com.imlwork.admin.service.ModelProviderService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * Admin CRUD for the enterprise model relay station. 仅做 HTTP 塑形；
 * 业务与探活在 {@link ModelProviderService}；实时流量调度在 ModelRouterService。
 */
@RestController
@RequestMapping("/api/v1/model/providers")
public class ModelProviderController {

    private final ModelProviderService service;

    public ModelProviderController(ModelProviderService service) {
        this.service = service;
    }

    @GetMapping
    public ResponseEntity<List<ModelProvider>> list() {
        return ResponseEntity.ok(service.list());
    }

    @GetMapping("/summary")
    public ResponseEntity<Map<String, Object>> summary() {
        return ResponseEntity.ok(service.summary());
    }

    @PostMapping
    public ModelProvider create(@Valid @RequestBody ModelProviderRequests.Upsert body) {
        return service.create(body);
    }

    /**
     * 档位定义（管理端配置界面用）。与客户端读到的是同一份来源（ModelTiers）——
     * 客户端走 /api/v1/model/models 的 tiers 字段，那条路要 corp-key，管理端够不着，
     * 所以在这里按管理员鉴权再开一个出口，定义本身不重复。
     * 不传可用性：管理端是配置场景，还没有通道时也要能选档位。
     */
    @GetMapping("/tiers")
    public ResponseEntity<List<Map<String, Object>>> tiers() {
        return ResponseEntity.ok(com.imlwork.admin.service.ModelTiers.describeAll());
    }

    /** 批量登记：管理端拉取上游模型后一次勾选多个（每条独立校验，整批同事务）。 */
    @PostMapping("/batch")
    public ResponseEntity<List<ModelProvider>> createBatch(@Valid @RequestBody ModelProviderRequests.BatchUpsert body) {
        return ResponseEntity.ok(service.createBatch(body.items()));
    }

    /** 拉取上游可用模型列表：新建传 baseUrl+apiKey；编辑传 providerId（key 在库里，不经前端）。 */
    @PostMapping("/models")
    public ResponseEntity<Map<String, Object>> listModels(@RequestBody Map<String, String> body) {
        return ResponseEntity.ok(service.listUpstreamModels(
                body.get("providerId"), body.get("baseUrl"), body.get("apiKey")));
    }


    /**
     * 实测模型类型：对每个模型发一个极小探针，按回执里的 reasoning_tokens 判定。
     * 会真实调用上游（每个模型几十 token 的开销），所以由前端显式触发、单次上限 20 个。
     */
    @PostMapping("/probe-types")
    public ResponseEntity<Map<String, Object>> probeTypes(@RequestBody Map<String, Object> body) {
        Object models = body.get("models");
        @SuppressWarnings("unchecked")
        List<String> list = models instanceof List<?> l ? (List<String>) l : List.of();
        return ResponseEntity.ok(service.probeModelTypes(
                (String) body.get("providerId"), (String) body.get("baseUrl"), (String) body.get("apiKey"), list));
    }

    @PutMapping("/{id}")
    public ModelProvider update(@PathVariable String id, @Valid @RequestBody ModelProviderRequests.Upsert body) {
        return service.update(id, body);
    }

    @PostMapping("/{id}/toggle")
    public ModelProvider toggle(@PathVariable String id) {
        return service.toggle(id);
    }

    @PostMapping("/{id}/health")
    public ModelProvider health(@PathVariable String id) {
        return service.health(id);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        service.delete(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }
}
