package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * FDE 工作台 — 交付包。可提交至技能中心的最终成品，
 * 含 SKILL.md 与结构化元数据（流程模型、执行器配置、依赖、验收用例等存于 contentJson）。
 */
@Entity
@Table(name = "fde_delivery_package")
public class FdeDeliveryPackage {

    @Id
    private String id;

    private String scenarioId;

    private String blueprintId;

    /** draft | ready | submitted | accepted | rejected */
    private String status = "draft";

    /** mock | admin_skill_center */
    private String submitTarget;

    /** set when submitted to skill center */
    private String publishedSkillId;

    @Column(columnDefinition = "text")
    private String skillMarkdown;

    /**
     * metadata, flowModel, executorConfig, dependencies, acceptanceCases,
     * testRunIds, permissionSuggestions, confirmationRules
     */
    @Column(columnDefinition = "text")
    private String contentJson;

    private LocalDateTime createdAt = LocalDateTime.now();

    private LocalDateTime updatedAt = LocalDateTime.now();

    public FdeDeliveryPackage() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getScenarioId() { return scenarioId; }
    public void setScenarioId(String scenarioId) { this.scenarioId = scenarioId; }

    public String getBlueprintId() { return blueprintId; }
    public void setBlueprintId(String blueprintId) { this.blueprintId = blueprintId; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getSubmitTarget() { return submitTarget; }
    public void setSubmitTarget(String submitTarget) { this.submitTarget = submitTarget; }

    public String getPublishedSkillId() { return publishedSkillId; }
    public void setPublishedSkillId(String publishedSkillId) { this.publishedSkillId = publishedSkillId; }

    public String getSkillMarkdown() { return skillMarkdown; }
    public void setSkillMarkdown(String skillMarkdown) { this.skillMarkdown = skillMarkdown; }

    public String getContentJson() { return contentJson; }
    public void setContentJson(String contentJson) { this.contentJson = contentJson; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
