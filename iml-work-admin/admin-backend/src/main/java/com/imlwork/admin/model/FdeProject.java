package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * FDE 工作台 SKILL 生产线 — 交付项目。一个客户/试点的整体推进单元，
 * 串联其下的业务场景、蓝图、测试与交付。
 */
@Entity
@Table(name = "fde_project")
public class FdeProject {

    @Id
    private String id;

    private String name;

    private String customerName;

    private String industry;

    private String pilotDepartment;

    private String owner;

    /** discovery | modeling | skill_generation | testing | delivery | completed */
    private String stage = "discovery";

    private String plannedLaunchDate;

    private LocalDateTime createdAt = LocalDateTime.now();

    private LocalDateTime updatedAt = LocalDateTime.now();

    public FdeProject() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getCustomerName() { return customerName; }
    public void setCustomerName(String customerName) { this.customerName = customerName; }

    public String getIndustry() { return industry; }
    public void setIndustry(String industry) { this.industry = industry; }

    public String getPilotDepartment() { return pilotDepartment; }
    public void setPilotDepartment(String pilotDepartment) { this.pilotDepartment = pilotDepartment; }

    public String getOwner() { return owner; }
    public void setOwner(String owner) { this.owner = owner; }

    public String getStage() { return stage; }
    public void setStage(String stage) { this.stage = stage; }

    public String getPlannedLaunchDate() { return plannedLaunchDate; }
    public void setPlannedLaunchDate(String plannedLaunchDate) { this.plannedLaunchDate = plannedLaunchDate; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
