package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * 本体对象动作：某对象类型上的一次「状态迁移」，绑定到一个可执行的连接器动作。
 *
 * 与 ConnectorAction 的分工：ConnectorAction 负责「在某系统里具体怎么点」；
 * OntologyAction 负责「这个动作是哪个对象、从什么状态到什么状态、要不要人工确认」。
 */
@Entity
@Table(name = "ontology_action")
public class OntologyAction {

    @Id
    private String id;

    /** 对象域：OA | CRM。 */
    private String domain;

    /** 作用的对象类型键（OntologyType.typeKey）。 */
    private String objectType;

    /** 动作机器键：approve / reject / markRisk / evaluateRisk / advanceStage / logVisit。 */
    private String actionKey;

    /** 中文标签（如 审批通过）。 */
    private String label;

    /** 能力：read|create|update|delete|batch（决定是否走确认令牌）。 */
    private String capability = "read";

    /** 状态迁移起点（可空=任意状态）。 */
    private String fromState;

    /** 状态迁移终点（可空=不改状态，如纯读）。 */
    private String toState;

    /** 绑定的连接器动作 id（ConnectorAction.id，可空——P0 允许先不绑）。 */
    private String connectorActionId;

    /** 策略（JSON）：{auto:bool, confirmIf:"amount>5000000", risk:"HIGH"} —— 何时自动、何时人工确认。 */
    @Column(columnDefinition = "text")
    private String policyJson;

    @Column(columnDefinition = "text")
    private String description;

    /**
     * 岗位授权：哪些岗位分身有权执行这个动作。
     * 空 = 不限岗位（向后兼容）；非空 = 只有列出的岗位可执行，其它岗位明确拒绝。
     *
     * 授权单位是**岗位**而非平台角色：员工以某个岗位分身的身份干活，「批准生产指令」天然属于
     * 「生产运行部领导」的职权。此前本体动作完全没有权限概念——只要业务域命中，一线操作工的分身
     * 就能批准生产指令。在危化行业这是事故级漏洞。
     */
    @Convert(converter = StringListConverter.class)
    @Column(columnDefinition = "text")
    private List<String> allowedExperts = new ArrayList<>();

    private LocalDateTime createdAt = LocalDateTime.now();
    private LocalDateTime updatedAt = LocalDateTime.now();

    public OntologyAction() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getDomain() { return domain; }
    public void setDomain(String domain) { this.domain = domain; }

    public String getObjectType() { return objectType; }
    public void setObjectType(String objectType) { this.objectType = objectType; }

    public String getActionKey() { return actionKey; }
    public void setActionKey(String actionKey) { this.actionKey = actionKey; }

    public String getLabel() { return label; }
    public void setLabel(String label) { this.label = label; }

    public String getCapability() { return capability; }
    public void setCapability(String capability) { this.capability = capability; }

    public String getFromState() { return fromState; }
    public void setFromState(String fromState) { this.fromState = fromState; }

    public String getToState() { return toState; }
    public void setToState(String toState) { this.toState = toState; }

    public String getConnectorActionId() { return connectorActionId; }
    public void setConnectorActionId(String connectorActionId) { this.connectorActionId = connectorActionId; }

    public String getPolicyJson() { return policyJson; }
    public void setPolicyJson(String policyJson) { this.policyJson = policyJson; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }

    public List<String> getAllowedExperts() { return allowedExperts; }
    public void setAllowedExperts(List<String> allowedExperts) { this.allowedExperts = allowedExperts == null ? new ArrayList<>() : allowedExperts; }
}
