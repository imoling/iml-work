package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 企业基础信息与通用规则（单例，id 固定为 "default"）。由管理端统一维护，
 * 客户端拉取后注入到工作分身的系统指令中，避免在客户端写死企业信息。
 */
@Entity
@Table(name = "enterprise_profile")
public class EnterpriseProfile {

    @Id
    private String id = "default";

    /** 企业名称。 */
    private String companyName;

    /** 企业其他基本信息（自由文本：可写税号、地址、制度规则等，随系统指令下发给分身）。 */
    @Column(columnDefinition = "text")
    private String info;

    private LocalDateTime updatedAt = LocalDateTime.now();

    public EnterpriseProfile() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getCompanyName() { return companyName; }
    public void setCompanyName(String companyName) { this.companyName = companyName; }

    public String getInfo() { return info; }
    public void setInfo(String info) { this.info = info; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
