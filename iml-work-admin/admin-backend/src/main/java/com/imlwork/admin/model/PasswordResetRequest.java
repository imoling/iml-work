package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/** 找回密码申请：用户提交（用户名+手机号），管理员核验身份后重置密码。 */
@Entity
@Table(name = "password_reset_request")
public class PasswordResetRequest {

    @Id
    private String id;

    private String username;
    private String userId;      // 命中用户时记录
    private String phone;       // 用户填写，供管理员核验身份
    private String status = "PENDING";  // PENDING / DONE / REJECTED
    private LocalDateTime createdAt = LocalDateTime.now();
    private LocalDateTime handledAt;

    public PasswordResetRequest() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getPhone() { return phone; }
    public void setPhone(String phone) { this.phone = phone; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getHandledAt() { return handledAt; }
    public void setHandledAt(LocalDateTime handledAt) { this.handledAt = handledAt; }
}
