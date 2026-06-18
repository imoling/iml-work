package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * FDE 工作台 — 测试运行。对场景/蓝图的一次试运行记录，
 * 事件、诊断与产物存于 contentJson。
 */
@Entity
@Table(name = "fde_test_run")
public class FdeTestRun {

    @Id
    private String id;

    private String scenarioId;

    private String blueprintId;

    /** passed | failed | warning | interrupted | needs_confirmation */
    private String status;

    /** mock | local | sandbox */
    private String environment;

    private LocalDateTime startedAt;

    private LocalDateTime endedAt;

    /** events[], diagnostics[], artifacts[] */
    @Column(columnDefinition = "text")
    private String contentJson;

    private LocalDateTime createdAt = LocalDateTime.now();

    public FdeTestRun() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getScenarioId() { return scenarioId; }
    public void setScenarioId(String scenarioId) { this.scenarioId = scenarioId; }

    public String getBlueprintId() { return blueprintId; }
    public void setBlueprintId(String blueprintId) { this.blueprintId = blueprintId; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getEnvironment() { return environment; }
    public void setEnvironment(String environment) { this.environment = environment; }

    public LocalDateTime getStartedAt() { return startedAt; }
    public void setStartedAt(LocalDateTime startedAt) { this.startedAt = startedAt; }

    public LocalDateTime getEndedAt() { return endedAt; }
    public void setEndedAt(LocalDateTime endedAt) { this.endedAt = endedAt; }

    public String getContentJson() { return contentJson; }
    public void setContentJson(String contentJson) { this.contentJson = contentJson; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
