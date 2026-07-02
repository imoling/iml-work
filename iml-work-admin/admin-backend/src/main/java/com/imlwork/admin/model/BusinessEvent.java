package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 业务事件：一次对象状态变化的审计记录（ApprovalPassed / RiskFlagged / StageAdvanced / VisitLogged）。
 *
 * 这是本体层「Event Writer」的落点：区别于 AgentTrace 的技术事件，这里记录的是
 * 业务语义事件——谁、对哪个对象、做了什么动作、状态从何到何。可关联 AgentTrace(traceId)。
 */
@Entity
@Table(name = "ontology_business_event")
public class BusinessEvent {

    @Id
    private String id;

    private String tenantId = "default";

    private String objectType;
    private String objectRefId;
    private String systemId;

    /** 触发事件的动作键（OntologyAction.actionKey）。 */
    private String actionKey;

    /** 事件类型：ApprovalPassed / RiskFlagged / StageAdvanced / VisitLogged。 */
    private String eventType;

    private String fromState;
    private String toState;

    private String actorUserId;
    private String actorName;

    /** 关联的 AgentTrace id（可空）。 */
    private String traceId;

    private String riskLevel = "LOW";

    @Column(columnDefinition = "text")
    private String note;

    private LocalDateTime createdAt = LocalDateTime.now();

    public BusinessEvent() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }

    public String getObjectType() { return objectType; }
    public void setObjectType(String objectType) { this.objectType = objectType; }

    public String getObjectRefId() { return objectRefId; }
    public void setObjectRefId(String objectRefId) { this.objectRefId = objectRefId; }

    public String getSystemId() { return systemId; }
    public void setSystemId(String systemId) { this.systemId = systemId; }

    public String getActionKey() { return actionKey; }
    public void setActionKey(String actionKey) { this.actionKey = actionKey; }

    public String getEventType() { return eventType; }
    public void setEventType(String eventType) { this.eventType = eventType; }

    public String getFromState() { return fromState; }
    public void setFromState(String fromState) { this.fromState = fromState; }

    public String getToState() { return toState; }
    public void setToState(String toState) { this.toState = toState; }

    public String getActorUserId() { return actorUserId; }
    public void setActorUserId(String actorUserId) { this.actorUserId = actorUserId; }

    public String getActorName() { return actorName; }
    public void setActorName(String actorName) { this.actorName = actorName; }

    public String getTraceId() { return traceId; }
    public void setTraceId(String traceId) { this.traceId = traceId; }

    public String getRiskLevel() { return riskLevel; }
    public void setRiskLevel(String riskLevel) { this.riskLevel = riskLevel; }

    public String getNote() { return note; }
    public void setNote(String note) { this.note = note; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
