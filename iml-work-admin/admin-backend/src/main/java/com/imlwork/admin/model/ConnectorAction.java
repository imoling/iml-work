package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 连接器动作：某业务系统上一个稳定、可复用、可验证的业务动作（如 crm.新建拜访）。
 *
 * 这是"连接器 / SKILL 分离"的核心单元——录制产出的是命名动作，而不是整条场景脚本。
 * SKILL 只引用动作 ID + 版本，不内联页面定位细节。动作绑定到一个已验证连接录制而成。
 */
@Entity
@Table(name = "connector_action")
public class ConnectorAction {

    @Id
    private String id;

    /** 所属业务系统（SystemIntegration id）。 */
    private String systemId;

    /** 录制时所用的已验证连接（SystemConnection id）。 */
    private String connectionId;

    /** 业务动作名（中文标签，如 新建拜访记录）。 */
    private String name;

    /** 机器键，如 crm.new_follow_up（可选）。 */
    private String actionKey;

    /** 该动作的 CRUD 能力：read|create|update|delete|batch。 */
    private String capability = "read";

    private String version = "1.0.0";

    /** 录制的富步骤（JSON 字符串）。 */
    @Column(columnDefinition = "text")
    private String stepsJson;

    /** 参数/字段（JSON 字符串）。 */
    @Column(columnDefinition = "text")
    private String fieldsJson;

    /** SOP / 业务说明提示（可选）。 */
    @Column(columnDefinition = "text")
    private String sopHint;

    private LocalDateTime createdAt = LocalDateTime.now();

    private LocalDateTime updatedAt = LocalDateTime.now();

    public ConnectorAction() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getSystemId() { return systemId; }
    public void setSystemId(String systemId) { this.systemId = systemId; }

    public String getConnectionId() { return connectionId; }
    public void setConnectionId(String connectionId) { this.connectionId = connectionId; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getActionKey() { return actionKey; }
    public void setActionKey(String actionKey) { this.actionKey = actionKey; }

    public String getCapability() { return capability; }
    public void setCapability(String capability) { this.capability = capability; }

    public String getVersion() { return version; }
    public void setVersion(String version) { this.version = version; }

    public String getStepsJson() { return stepsJson; }
    public void setStepsJson(String stepsJson) { this.stepsJson = stepsJson; }

    public String getFieldsJson() { return fieldsJson; }
    public void setFieldsJson(String fieldsJson) { this.fieldsJson = fieldsJson; }

    public String getSopHint() { return sopHint; }
    public void setSopHint(String sopHint) { this.sopHint = sopHint; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
