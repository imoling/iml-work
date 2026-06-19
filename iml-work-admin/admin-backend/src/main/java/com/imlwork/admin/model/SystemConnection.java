package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * 业务系统连接：一个用户/设备对某业务系统的"已验证"使用授权。
 *
 * 安全约束（务必遵守）：本实体只保存连接的「状态与引用」——绝不保存密码 / 密钥 /
 * 验证码 / Cookie。真实登录凭证只存在于员工本地受管浏览器的独立 Profile 中
 * （browserProfileRef 指向本地目录名），平台仅记录验证状态与会话有效期。
 * 录制与运行时只允许引用 status=verified 的连接，且不记录登录过程。
 */
@Entity
@Table(name = "system_connection")
public class SystemConnection {

    @Id
    private String id;

    /** 关联的业务系统（SystemIntegration 的 id）。 */
    private String systemId;

    /** 连接归属用户。 */
    private String ownerUserId;

    private String deviceId;

    /** 本地受管浏览器 Profile 目录名（如 pwprofile-<systemId>），不含任何凭证。 */
    private String browserProfileRef;

    /** 授予的 CRUD 能力：read|create|update|delete|batch。 */
    @Convert(converter = StringListConverter.class)
    @Column(columnDefinition = "text")
    private List<String> capabilities = new ArrayList<>();

    /** 状态机：draft|verifying|verified|expired|failed|suspended|revoked。 */
    private String status = "draft";

    /** 运行环境：test|production。 */
    private String environment = "production";

    /** 最近一次验证 / 异常信息。 */
    @Column(length = 1000)
    private String message;

    private LocalDateTime lastVerifiedAt;

    private LocalDateTime expiresAt;

    /** 兼容的连接器版本范围，如 ^1.2。 */
    private String connectorVersionRange;

    private LocalDateTime createdAt = LocalDateTime.now();

    private LocalDateTime updatedAt = LocalDateTime.now();

    public SystemConnection() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getSystemId() { return systemId; }
    public void setSystemId(String systemId) { this.systemId = systemId; }

    public String getOwnerUserId() { return ownerUserId; }
    public void setOwnerUserId(String ownerUserId) { this.ownerUserId = ownerUserId; }

    public String getDeviceId() { return deviceId; }
    public void setDeviceId(String deviceId) { this.deviceId = deviceId; }

    public String getBrowserProfileRef() { return browserProfileRef; }
    public void setBrowserProfileRef(String browserProfileRef) { this.browserProfileRef = browserProfileRef; }

    public List<String> getCapabilities() { return capabilities; }
    public void setCapabilities(List<String> capabilities) { this.capabilities = capabilities; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getEnvironment() { return environment; }
    public void setEnvironment(String environment) { this.environment = environment; }

    public String getMessage() { return message; }
    public void setMessage(String message) { this.message = message; }

    public LocalDateTime getLastVerifiedAt() { return lastVerifiedAt; }
    public void setLastVerifiedAt(LocalDateTime lastVerifiedAt) { this.lastVerifiedAt = lastVerifiedAt; }

    public LocalDateTime getExpiresAt() { return expiresAt; }
    public void setExpiresAt(LocalDateTime expiresAt) { this.expiresAt = expiresAt; }

    public String getConnectorVersionRange() { return connectorVersionRange; }
    public void setConnectorVersionRange(String connectorVersionRange) { this.connectorVersionRange = connectorVersionRange; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
