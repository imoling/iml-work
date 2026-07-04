package com.imlwork.admin.model;

import jakarta.persistence.*;
import java.time.LocalDateTime;

/**
 * 一次用户任务的全链路执行轨迹（Agent Trace）。终端/用户/问题/模型/推理摘要/技能/
 * 联网/证据/安全/结果/异常等全流程信息落在这里，供安全审计追溯。spans/sources/events
 * 以 JSON 文本存储，读取时按脱敏模式整体扫描脱敏。
 */
@Entity
@Table(name = "agent_trace")
public class AgentTrace {

    @Id
    private String id;

    private LocalDateTime createdAt = LocalDateTime.now();

    // 终端信息
    private String clientId;
    private String deviceHost;
    private String appVersion;
    private String clientIp;
    private String workspace;

    // 用户信息
    private String userId;
    private String userNickname;
    private String expertId;
    private String expertName;
    private String department;
    private String role;

    // 任务信息
    private String sessionId;
    @Column(columnDefinition = "text") private String userQuestion;

    // 模型信息
    private String modelName;
    private String modelProvider;
    private String connectionMode;
    private long promptTokens;
    private long completionTokens;
    private long durationMs;

    // 能力 / 数据访问
    private boolean webSearchUsed;
    /** 本次任务是否经公司级 Docker 沙箱执行过代码（直接代码技能或 agentic bundle 技能）。 */
    private boolean sandboxUsed;
    private String skillUsed;
    private String knowledgeUsed;

    // 安全 / 结果
    private String riskLevel = "LOW";   // LOW | MEDIUM | HIGH
    private String status = "SUCCESS";  // SUCCESS | FAILED | BLOCKED
    private boolean approvalTriggered;
    private boolean sensitiveHit;
    private String feedback;   // 用户质量反馈：UP | DOWN | null

    @Column(columnDefinition = "text") private String reasoningSummary; // 可审计推理摘要（非完整思维链）
    @Column(columnDefinition = "text") private String finalAnswer;
    @Column(columnDefinition = "text") private String spans;   // JSON: 执行时间线
    @Column(columnDefinition = "text") private String sources; // JSON: 证据与来源
    @Column(columnDefinition = "text") private String events;  // JSON: 安全事件

    public AgentTrace() {}

    public String getId() { return id; } public void setId(String v) { this.id = v; }
    public LocalDateTime getCreatedAt() { return createdAt; } public void setCreatedAt(LocalDateTime v) { this.createdAt = v; }
    public String getClientId() { return clientId; } public void setClientId(String v) { this.clientId = v; }
    public String getDeviceHost() { return deviceHost; } public void setDeviceHost(String v) { this.deviceHost = v; }
    public String getAppVersion() { return appVersion; } public void setAppVersion(String v) { this.appVersion = v; }
    public String getClientIp() { return clientIp; } public void setClientIp(String v) { this.clientIp = v; }
    public String getWorkspace() { return workspace; } public void setWorkspace(String v) { this.workspace = v; }
    public String getUserId() { return userId; } public void setUserId(String v) { this.userId = v; }
    public String getUserNickname() { return userNickname; } public void setUserNickname(String v) { this.userNickname = v; }
    public String getExpertId() { return expertId; } public void setExpertId(String v) { this.expertId = v; }
    public String getExpertName() { return expertName; } public void setExpertName(String v) { this.expertName = v; }
    public String getDepartment() { return department; } public void setDepartment(String v) { this.department = v; }
    public String getRole() { return role; } public void setRole(String v) { this.role = v; }
    public String getSessionId() { return sessionId; } public void setSessionId(String v) { this.sessionId = v; }
    public String getUserQuestion() { return userQuestion; } public void setUserQuestion(String v) { this.userQuestion = v; }
    public String getModelName() { return modelName; } public void setModelName(String v) { this.modelName = v; }
    public String getModelProvider() { return modelProvider; } public void setModelProvider(String v) { this.modelProvider = v; }
    public String getConnectionMode() { return connectionMode; } public void setConnectionMode(String v) { this.connectionMode = v; }
    public long getPromptTokens() { return promptTokens; } public void setPromptTokens(long v) { this.promptTokens = v; }
    public long getCompletionTokens() { return completionTokens; } public void setCompletionTokens(long v) { this.completionTokens = v; }
    public long getDurationMs() { return durationMs; } public void setDurationMs(long v) { this.durationMs = v; }
    public boolean isWebSearchUsed() { return webSearchUsed; } public void setWebSearchUsed(boolean v) { this.webSearchUsed = v; }
    public boolean isSandboxUsed() { return sandboxUsed; } public void setSandboxUsed(boolean v) { this.sandboxUsed = v; }
    public String getSkillUsed() { return skillUsed; } public void setSkillUsed(String v) { this.skillUsed = v; }
    public String getKnowledgeUsed() { return knowledgeUsed; } public void setKnowledgeUsed(String v) { this.knowledgeUsed = v; }
    public String getRiskLevel() { return riskLevel; } public void setRiskLevel(String v) { this.riskLevel = v; }
    public String getStatus() { return status; } public void setStatus(String v) { this.status = v; }
    public boolean isApprovalTriggered() { return approvalTriggered; } public void setApprovalTriggered(boolean v) { this.approvalTriggered = v; }
    public boolean isSensitiveHit() { return sensitiveHit; } public void setSensitiveHit(boolean v) { this.sensitiveHit = v; }
    public String getFeedback() { return feedback; } public void setFeedback(String v) { this.feedback = v; }
    public String getReasoningSummary() { return reasoningSummary; } public void setReasoningSummary(String v) { this.reasoningSummary = v; }
    public String getFinalAnswer() { return finalAnswer; } public void setFinalAnswer(String v) { this.finalAnswer = v; }
    public String getSpans() { return spans; } public void setSpans(String v) { this.spans = v; }
    public String getSources() { return sources; } public void setSources(String v) { this.sources = v; }
    public String getEvents() { return events; } public void setEvents(String v) { this.events = v; }
}
