package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 对象引用：一个业务对象实例的「身份」，而非其数据。
 *
 * 只登记「类型 + 系统 + 外部主键 + 展示名 + 当前状态」，用于把业务事件锚定到具体对象，
 * 并在管理端审计。绝不存合同金额、联系人电话等业务明细——那些留在客户端本地。
 */
@Entity
@Table(name = "ontology_object_ref")
public class ObjectRef {

    @Id
    private String id;

    private String tenantId = "default";

    /** 对象类型键（OntologyType.typeKey）。 */
    private String objectType;

    /** 来源系统（SystemIntegration id）。 */
    private String systemId;

    /** 该对象在真实系统里的主键。 */
    private String externalId;

    /** 展示名（仅标识用，如「宝钢钢铁数字化项目合同」）——非业务明细。 */
    private String displayName;

    /** 当前状态（对象状态机里的状态键）。 */
    private String currentState;

    /** 关联的操作者（可空）。 */
    private String ownerUserId;

    private LocalDateTime lastSeenAt = LocalDateTime.now();
    private LocalDateTime createdAt = LocalDateTime.now();

    public ObjectRef() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }

    public String getObjectType() { return objectType; }
    public void setObjectType(String objectType) { this.objectType = objectType; }

    public String getSystemId() { return systemId; }
    public void setSystemId(String systemId) { this.systemId = systemId; }

    public String getExternalId() { return externalId; }
    public void setExternalId(String externalId) { this.externalId = externalId; }

    public String getDisplayName() { return displayName; }
    public void setDisplayName(String displayName) { this.displayName = displayName; }

    public String getCurrentState() { return currentState; }
    public void setCurrentState(String currentState) { this.currentState = currentState; }

    public String getOwnerUserId() { return ownerUserId; }
    public void setOwnerUserId(String ownerUserId) { this.ownerUserId = ownerUserId; }

    public LocalDateTime getLastSeenAt() { return lastSeenAt; }
    public void setLastSeenAt(LocalDateTime lastSeenAt) { this.lastSeenAt = lastSeenAt; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
