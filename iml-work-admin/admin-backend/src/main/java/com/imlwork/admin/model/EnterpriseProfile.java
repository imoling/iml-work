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

    /** 公司全称。 */
    private String companyName;

    /** 纳税人识别号 / 统一社会信用代码。 */
    private String taxId;

    /** 公司地址。 */
    private String address;

    /** 企业通用规则/制度摘要（如差旅报销标准），会随系统指令下发给分身。 */
    @Column(columnDefinition = "text")
    private String rules;

    private LocalDateTime updatedAt = LocalDateTime.now();

    public EnterpriseProfile() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getCompanyName() { return companyName; }
    public void setCompanyName(String companyName) { this.companyName = companyName; }

    public String getTaxId() { return taxId; }
    public void setTaxId(String taxId) { this.taxId = taxId; }

    public String getAddress() { return address; }
    public void setAddress(String address) { this.address = address; }

    public String getRules() { return rules; }
    public void setRules(String rules) { this.rules = rules; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
