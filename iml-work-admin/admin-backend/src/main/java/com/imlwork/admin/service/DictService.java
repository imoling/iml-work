package com.imlwork.admin.service;

import com.imlwork.admin.model.DictItem;
import com.imlwork.admin.repository.DictItemRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 数据字典维护与查询：type 维度的分类/枚举集中管理，替代散落三端的硬编码常量。 */
@Service
public class DictService {

    /** 已知字典类型的中文名（管理端展示；新类型可自由创建，未登记的按 code 显示）。 */
    public static final Map<String, String> TYPE_LABELS = Map.of(
            "knowledge_category", "企业知识分类",
            "ontology_domain", "本体业务域",
            "biz_system_type", "业务系统类型");

    public static final String KNOWLEDGE_CATEGORY = "knowledge_category";

    private final DictItemRepository repository;

    public DictService(DictItemRepository repository) {
        this.repository = repository;
    }

    /** 某类型的启用项标签（按 sort 排序）——各消费点取值入口。空类型返回空列表，不抛错。 */
    @Transactional(readOnly = true)
    public List<String> labels(String type) {
        return repository.findByTypeAndEnabledTrueOrderBySortOrderAscIdAsc(type).stream().map(DictItem::getLabel).toList();
    }

    /** 某类型的启用项实体（客户端/管理端下拉用）。 */
    @Transactional(readOnly = true)
    public List<DictItem> items(String type) {
        return repository.findByTypeAndEnabledTrueOrderBySortOrderAscIdAsc(type);
    }

    /** 管理视图：全部类型 → 全部项（含停用），带类型中文名。 */
    @Transactional(readOnly = true)
    public Map<String, Object> manageView() {
        Map<String, List<DictItem>> grouped = new LinkedHashMap<>();
        for (DictItem it : repository.findAllByOrderByTypeAscSortOrderAscIdAsc()) {
            grouped.computeIfAbsent(it.getType(), k -> new java.util.ArrayList<>()).add(it);
        }
        return Map.of("types", grouped, "typeLabels", TYPE_LABELS);
    }

    @Transactional
    public DictItem create(String type, String label, int sortOrder) {
        String t = normalize(type, "类型"), l = normalize(label, "名称");
        if (!t.matches("[a-z0-9_]{2,64}")) throw new IllegalArgumentException("类型编码只能用小写字母/数字/下划线（2-64 位）");
        if (repository.findByTypeAndLabel(t, l).isPresent()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "该类型下已存在同名项：" + l);
        }
        DictItem it = new DictItem();
        it.setType(t);
        it.setLabel(l);
        it.setSortOrder(sortOrder);
        return repository.save(it);
    }

    @Transactional
    public DictItem update(Long id, String label, Integer sortOrder, Boolean enabled) {
        DictItem it = repository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "字典项不存在"));
        if (label != null && !label.isBlank()) {
            String l = label.trim();
            repository.findByTypeAndLabel(it.getType(), l)
                    .filter(other -> !other.getId().equals(id))
                    .ifPresent(other -> { throw new ResponseStatusException(HttpStatus.CONFLICT, "该类型下已存在同名项：" + l); });
            it.setLabel(l);
        }
        if (sortOrder != null) it.setSortOrder(sortOrder);
        if (enabled != null) it.setEnabled(enabled);
        return repository.save(it);
    }

    /** 删除字典项。历史数据里已写入的分类字符串不受影响（作为历史值保留展示）。 */
    @Transactional
    public void delete(Long id) {
        if (!repository.existsById(id)) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "字典项不存在");
        repository.deleteById(id);
    }

    private static String normalize(String v, String field) {
        if (v == null || v.isBlank()) throw new IllegalArgumentException(field + "不能为空");
        return v.trim();
    }
}
