package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 本体对象类型：企业业务里的一个「名词」及其属性、关系、状态机的正式定义。
 *
 * 本体层的核心：平台只登记 Schema（此表）+ 对象引用 + 业务事件，绝不存实例数据。
 * 对象的真实数据在运行时由客户端从 boundSystemId 指向的系统按需读取，留在本地。
 */
@Entity
@Table(name = "ontology_type")
public class OntologyType {

    @Id
    private String id;

    /** 所属对象域：OA | CRM。 */
    private String domain;

    /** 类型机器键：Contract / ApprovalTask / Customer / Opportunity / Contact / VisitEvent。 */
    private String typeKey;

    /** 中文标签（如 合同）。 */
    private String label;

    /** 数据来源系统（SystemIntegration id，如 sys-oa / sys-crm）。 */
    private String boundSystemId;

    /** 属性定义（JSON 数组）：[{key,label,type}]。 */
    @Column(columnDefinition = "text")
    private String propertiesJson;

    /** 关系定义（JSON 数组）：[{name,targetType,cardinality}]。 */
    @Column(columnDefinition = "text")
    private String relationsJson;

    /** 状态机定义（JSON）：{initial, states:[], transitions:[{from,to,action}]}。 */
    @Column(columnDefinition = "text")
    private String stateMachineJson;

    /** 对象列表页相对路径（读驱动消解用）：客户端打开 baseUrl+此路径抓取候选对象 {名称, href}。 */
    private String resolveListPath;

    @Column(columnDefinition = "text")
    private String description;

    private LocalDateTime createdAt = LocalDateTime.now();
    private LocalDateTime updatedAt = LocalDateTime.now();

    public OntologyType() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getDomain() { return domain; }
    public void setDomain(String domain) { this.domain = domain; }

    public String getTypeKey() { return typeKey; }
    public void setTypeKey(String typeKey) { this.typeKey = typeKey; }

    public String getLabel() { return label; }
    public void setLabel(String label) { this.label = label; }

    public String getBoundSystemId() { return boundSystemId; }
    public void setBoundSystemId(String boundSystemId) { this.boundSystemId = boundSystemId; }

    public String getPropertiesJson() { return propertiesJson; }
    public void setPropertiesJson(String propertiesJson) { this.propertiesJson = propertiesJson; }

    public String getRelationsJson() { return relationsJson; }
    public void setRelationsJson(String relationsJson) { this.relationsJson = relationsJson; }

    public String getStateMachineJson() { return stateMachineJson; }
    public void setStateMachineJson(String stateMachineJson) { this.stateMachineJson = stateMachineJson; }

    public String getResolveListPath() { return resolveListPath; }
    public void setResolveListPath(String resolveListPath) { this.resolveListPath = resolveListPath; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
