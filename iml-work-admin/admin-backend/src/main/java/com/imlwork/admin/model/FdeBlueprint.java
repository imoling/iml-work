package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * FDE 工作台 — 技能蓝图。由场景细化而成的结构化技能设计稿，
 * Markdown 草稿 + 结构化字段（依赖、执行器、验收用例等存于 contentJson）。
 */
@Entity
@Table(name = "fde_blueprint")
public class FdeBlueprint {

    @Id
    private String id;

    private String scenarioId;

    private String name;

    private String version = "1.0.0";

    @Column(columnDefinition = "text")
    private String markdownDraft;

    /**
     * summary, applicableRoles, departments, triggerKeywords, prerequisites,
     * inputParams, outputResults, knowledgeDependencies, systemDependencies,
     * fileDependencies, permissionBoundaries, sensitiveActions,
     * confirmationRules, executors, acceptanceCases
     */
    @Column(columnDefinition = "text")
    private String contentJson;

    private LocalDateTime createdAt = LocalDateTime.now();

    private LocalDateTime updatedAt = LocalDateTime.now();

    public FdeBlueprint() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getScenarioId() { return scenarioId; }
    public void setScenarioId(String scenarioId) { this.scenarioId = scenarioId; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getVersion() { return version; }
    public void setVersion(String version) { this.version = version; }

    public String getMarkdownDraft() { return markdownDraft; }
    public void setMarkdownDraft(String markdownDraft) { this.markdownDraft = markdownDraft; }

    public String getContentJson() { return contentJson; }
    public void setContentJson(String contentJson) { this.contentJson = contentJson; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
