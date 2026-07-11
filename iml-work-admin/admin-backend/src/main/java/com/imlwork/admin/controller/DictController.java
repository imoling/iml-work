package com.imlwork.admin.controller;

import com.imlwork.admin.model.DictItem;
import com.imlwork.admin.service.DictService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 数据字典：GET 全员可读（客户端归档分类下拉也用）；增删改仅企业信息管理权限
 * （鉴权在 SecurityConfig 按方法区分）。
 */
@RestController
@RequestMapping("/api/v1/dicts")
public class DictController {

    /** 新建项请求体。 */
    public record CreateReq(
            @NotBlank(message = "类型不能为空") @Size(max = 64) String type,
            @NotBlank(message = "名称不能为空") @Size(max = 128) String label,
            Integer sortOrder) {}

    /** 更新项请求体（字段均可选：只改传入的）。 */
    public record UpdateReq(@Size(max = 128) String label, Integer sortOrder, Boolean enabled) {}

    private final DictService dictService;

    public DictController(DictService dictService) {
        this.dictService = dictService;
    }

    /** 管理视图：全部类型 → 全部项（含停用）。 */
    @GetMapping
    public ResponseEntity<Map<String, Object>> manageView() {
        return ResponseEntity.ok(dictService.manageView());
    }

    /** 某类型的启用项（下拉取值；type 如 knowledge_category）。 */
    @GetMapping("/{type}")
    public ResponseEntity<List<DictItem>> items(@PathVariable String type) {
        return ResponseEntity.ok(dictService.items(type));
    }

    @PostMapping
    public ResponseEntity<DictItem> create(@Valid @RequestBody CreateReq req) {
        return ResponseEntity.ok(dictService.create(req.type(), req.label(), req.sortOrder() != null ? req.sortOrder() : 0));
    }

    @PutMapping("/{id}")
    public ResponseEntity<DictItem> update(@PathVariable Long id, @Valid @RequestBody UpdateReq req) {
        return ResponseEntity.ok(dictService.update(id, req.label(), req.sortOrder(), req.enabled()));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable Long id) {
        dictService.delete(id);
        return ResponseEntity.ok(Map.of("success", true));
    }
}
