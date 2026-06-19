package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 一次性确认令牌（文档 §12.6）：写操作（增删改批量）人工确认后，由策略服务签发的
 * 短效、一次性、绑定表单摘要的签名对象。
 *
 * 安全约束：只保存 formDataHash / targetObjectHash（摘要），绝不保存明文业务字段；
 * 连接器执行前校验签名 + 有效期 + 使用状态 + 用户/连接/动作/表单摘要，成功执行或失败
 * 一次后立即失效。
 */
@Entity
@Table(name = "confirmation_token")
public class ConfirmationToken {

    @Id
    private String id;            // tokenId

    private String tenantId = "default";
    private String userId;
    private String connectionId;
    private String skillId;
    private String actionId;
    private String capability;    // create|update|delete|batch

    private String targetObjectHash;  // 目标对象摘要（可选）
    private String formDataHash;      // 表单数据摘要

    private String nonce;
    @Column(length = 128)
    private String signature;     // HMAC-SHA256(canonical claims)

    /** issued|consumed|expired|revoked。 */
    private String status = "issued";

    private LocalDateTime issuedAt = LocalDateTime.now();
    private LocalDateTime expiresAt;
    private LocalDateTime consumedAt;

    public ConfirmationToken() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }
    public String getConnectionId() { return connectionId; }
    public void setConnectionId(String connectionId) { this.connectionId = connectionId; }
    public String getSkillId() { return skillId; }
    public void setSkillId(String skillId) { this.skillId = skillId; }
    public String getActionId() { return actionId; }
    public void setActionId(String actionId) { this.actionId = actionId; }
    public String getCapability() { return capability; }
    public void setCapability(String capability) { this.capability = capability; }
    public String getTargetObjectHash() { return targetObjectHash; }
    public void setTargetObjectHash(String targetObjectHash) { this.targetObjectHash = targetObjectHash; }
    public String getFormDataHash() { return formDataHash; }
    public void setFormDataHash(String formDataHash) { this.formDataHash = formDataHash; }
    public String getNonce() { return nonce; }
    public void setNonce(String nonce) { this.nonce = nonce; }
    public String getSignature() { return signature; }
    public void setSignature(String signature) { this.signature = signature; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
    public LocalDateTime getIssuedAt() { return issuedAt; }
    public void setIssuedAt(LocalDateTime issuedAt) { this.issuedAt = issuedAt; }
    public LocalDateTime getExpiresAt() { return expiresAt; }
    public void setExpiresAt(LocalDateTime expiresAt) { this.expiresAt = expiresAt; }
    public LocalDateTime getConsumedAt() { return consumedAt; }
    public void setConsumedAt(LocalDateTime consumedAt) { this.consumedAt = consumedAt; }
}
