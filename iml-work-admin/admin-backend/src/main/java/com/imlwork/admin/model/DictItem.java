package com.imlwork.admin.model;

import jakarta.persistence.*;
import java.time.LocalDateTime;

/**
 * 数据字典项：系统内各类"分类/枚举"的单一事实来源（type 维度区分，如
 * knowledge_category 企业知识分类 / ontology_domain 本体业务域 / biz_system_type 业务系统类型）。
 * 建表与种子见 Flyway V4__dict_items.sql；管理端「字典管理」页运行时维护。
 */
@Entity
@Table(name = "dict_item", uniqueConstraints = @UniqueConstraint(name = "uq_dict_type_label", columnNames = {"type", "label"}))
public class DictItem {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 64)
    private String type;

    @Column(nullable = false, length = 128)
    private String label;

    @Column(name = "sort_order", nullable = false)
    private int sortOrder = 0;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt = LocalDateTime.now();

    public Long getId() { return id; }
    public String getType() { return type; }
    public void setType(String type) { this.type = type; }
    public String getLabel() { return label; }
    public void setLabel(String label) { this.label = label; }
    public int getSortOrder() { return sortOrder; }
    public void setSortOrder(int sortOrder) { this.sortOrder = sortOrder; }
    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public LocalDateTime getCreatedAt() { return createdAt; }
}
