package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * FDE 工作台 — 复用模板。从交付沉淀出的可复用资产（行业/角色/流程/技能/执行器/验收用例），
 * 结构化内容存于 contentJson。
 */
@Entity
@Table(name = "fde_template")
public class FdeTemplate {

    @Id
    private String id;

    private String name;

    /** industry | role | process | skill | executor | acceptance_case */
    private String type;

    private String version = "1.0.0";

    private String sourceProjectId;

    private LocalDateTime lastUsedAt;

    /** industries, roles, systems, reuseConditions, flowNodes, executors, acceptanceCases */
    @Column(columnDefinition = "text")
    private String contentJson;

    private LocalDateTime createdAt = LocalDateTime.now();

    private LocalDateTime updatedAt = LocalDateTime.now();

    public FdeTemplate() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getType() { return type; }
    public void setType(String type) { this.type = type; }

    public String getVersion() { return version; }
    public void setVersion(String version) { this.version = version; }

    public String getSourceProjectId() { return sourceProjectId; }
    public void setSourceProjectId(String sourceProjectId) { this.sourceProjectId = sourceProjectId; }

    public LocalDateTime getLastUsedAt() { return lastUsedAt; }
    public void setLastUsedAt(LocalDateTime lastUsedAt) { this.lastUsedAt = lastUsedAt; }

    public String getContentJson() { return contentJson; }
    public void setContentJson(String contentJson) { this.contentJson = contentJson; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
