package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * FDE 工作台 — 业务场景。项目下采集到的一个可被技能化的业务动作，
 * 承载评分、素材、事实与流程模型（存于 contentJson）。
 */
@Entity
@Table(name = "fde_scenario")
public class FdeScenario {

    @Id
    private String id;

    private String projectId;

    private String name;

    private String department;

    private String businessRole;

    @Column(columnDefinition = "text")
    private String description;

    /** daily | weekly | monthly | occasional */
    private String frequency;

    /**
     * draft | collected | scored | modeled | blueprint_ready | orchestrated |
     * package_generated | testing | test_failed | test_passed | submitted |
     * published | templated
     */
    private String status = "draft";

    /** low | medium | high */
    private String riskLevel;

    /** low | medium | high */
    private String reusePotential;

    private String owner;

    @Convert(converter = StringListConverter.class)
    @Column(columnDefinition = "text")
    private List<String> systems = new ArrayList<>();

    /** holds {score, materials, facts, flow:{nodes,edges}} */
    @Column(columnDefinition = "text")
    private String contentJson;

    private LocalDateTime createdAt = LocalDateTime.now();

    private LocalDateTime updatedAt = LocalDateTime.now();

    public FdeScenario() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getProjectId() { return projectId; }
    public void setProjectId(String projectId) { this.projectId = projectId; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getDepartment() { return department; }
    public void setDepartment(String department) { this.department = department; }

    public String getBusinessRole() { return businessRole; }
    public void setBusinessRole(String businessRole) { this.businessRole = businessRole; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public String getFrequency() { return frequency; }
    public void setFrequency(String frequency) { this.frequency = frequency; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getRiskLevel() { return riskLevel; }
    public void setRiskLevel(String riskLevel) { this.riskLevel = riskLevel; }

    public String getReusePotential() { return reusePotential; }
    public void setReusePotential(String reusePotential) { this.reusePotential = reusePotential; }

    public String getOwner() { return owner; }
    public void setOwner(String owner) { this.owner = owner; }

    public List<String> getSystems() { return systems; }
    public void setSystems(List<String> systems) { this.systems = systems; }

    public String getContentJson() { return contentJson; }
    public void setContentJson(String contentJson) { this.contentJson = contentJson; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
