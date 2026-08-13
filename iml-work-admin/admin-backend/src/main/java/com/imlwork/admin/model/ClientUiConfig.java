package com.imlwork.admin.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.LocalDateTime;

/**
 * 客户端 UI 配置 KV（首页卡片等由管理端下发的界面语料）。
 * value 为 JSON 文本，形状由客户端与管理端共同约定；后端只存取不解析。
 * 全字段非原始类型——规避 ddl-auto update 对非空表加原始列静默失败的坑。
 */
@Entity
@Table(name = "client_ui_config")
public class ClientUiConfig {
    /** 配置键，如 hero-cards。 */
    @Id
    @Column(length = 64)
    private String id;

    @Column(columnDefinition = "TEXT")
    private String value;

    private LocalDateTime updatedAt;

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getValue() { return value; }
    public void setValue(String value) { this.value = value; }
    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
