package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/** 登录审计日志：每次登录尝试（成功/失败）留痕，供管理端安全审计。 */
@Entity
@Table(name = "login_audit")
public class LoginAudit {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String username;
    private String userId;        // 命中用户时记录
    private boolean success;
    private String reason;        // 成功 / 密码错误 / 账号停用 / 用户不存在
    private String clientType;    // admin / client / fde / unknown
    private String ip;
    @Column(length = 512)
    private String userAgent;
    private LocalDateTime createdAt = LocalDateTime.now();

    public LoginAudit() {}

    public LoginAudit(String username, String userId, boolean success, String reason,
                      String clientType, String ip, String userAgent) {
        this.username = username;
        this.userId = userId;
        this.success = success;
        this.reason = reason;
        this.clientType = clientType;
        this.ip = ip;
        this.userAgent = userAgent;
        this.createdAt = LocalDateTime.now();
    }

    public Long getId() { return id; }
    public String getUsername() { return username; }
    public String getUserId() { return userId; }
    public boolean isSuccess() { return success; }
    public String getReason() { return reason; }
    public String getClientType() { return clientType; }
    public String getIp() { return ip; }
    public String getUserAgent() { return userAgent; }
    public LocalDateTime getCreatedAt() { return createdAt; }
}
