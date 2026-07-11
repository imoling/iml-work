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

    /** SOP / 业务说明提示（可选）。kind=sop 时即智能体执行所依据的标准流程描述。 */
    @Column(columnDefinition = "text")
    private String sopHint;

    /** kind=sop 的入口锚点（拼在 baseUrl 后，如 #/travel/apply）。留空则从系统首页起，由智能体自行导航。 */
    private String entryHash;

    /** 编译产物：强类型 Workflow IR（JSON 字符串）。含输入/输出/能力/确认策略/异常分支/参数分类。 */
    @Column(columnDefinition = "text")
    private String irJson;

    // ===== 三形态执行器：replay=录制回放，api=HTTP 接口直调，sop=智能体读页面执行（免录制） =====
    /** 执行形态：replay | api | sop。历史数据为空视为 replay。 */
    private String kind = "replay";

    /** API 形态：HTTP 方法（GET/POST/PUT/DELETE）。 */
    private String apiMethod;

    /** API 形态：相对路径（拼在系统 baseUrl 后），支持 {{字段名}}/{{externalId}} 占位。 */
    private String apiPath;

    /** API 形态：请求体模板。JSON 或 k=v&k2=v2 表单串，支持 {{字段名}} 占位。 */
    @Column(columnDefinition = "text")
    private String apiBodyTemplate;

    /** 输出说明：该动作执行后的返回/影响（人工维护，供查看与模型理解）。 */
    @Column(columnDefinition = "text")
    private String outputDesc;

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

    public String getEntryHash() { return entryHash; }
    public void setEntryHash(String entryHash) { this.entryHash = entryHash; }

    public String getIrJson() { return irJson; }
    public void setIrJson(String irJson) { this.irJson = irJson; }

    public String getKind() { return kind; }
    public void setKind(String kind) { this.kind = kind; }

    public String getApiMethod() { return apiMethod; }
    public void setApiMethod(String apiMethod) { this.apiMethod = apiMethod; }

    public String getApiPath() { return apiPath; }
    public void setApiPath(String apiPath) { this.apiPath = apiPath; }

    public String getApiBodyTemplate() { return apiBodyTemplate; }
    public void setApiBodyTemplate(String apiBodyTemplate) { this.apiBodyTemplate = apiBodyTemplate; }

    public String getOutputDesc() { return outputDesc; }
    public void setOutputDesc(String outputDesc) { this.outputDesc = outputDesc; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
