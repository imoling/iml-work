package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 客户端策略的单例配置（固定 row id = 1）：管理员对员工客户端的集中管控项。
 * 随心跳响应下发，客户端据此收紧本地可选项。
 */
@Entity
@Table(name = "client_policy")
public class ClientPolicy {

    @Id
    private Long id = 1L;

    /**
     * 是否允许员工在客户端自配模型（直连厂商 API / 本地推理端点）。
     *
     * <p>关掉之后客户端只能走企业模型中转站。这条是**安全边界而非偏好**：员工自填一个外部
     * 厂商端点，业务数据就绕过了企业闸直接流向未登记的第三方，平台侧既看不到也审计不到。
     *
     * <p>默认 true（保持现状）：客户端此前本就能自配，默认改成禁止会让已在用的人一升级就断。
     * 需要收紧的企业在管理端显式关闭。
     */
    private boolean allowCustomModel = true;

    private LocalDateTime updatedAt = LocalDateTime.now();

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public boolean isAllowCustomModel() { return allowCustomModel; }
    public void setAllowCustomModel(boolean allowCustomModel) { this.allowCustomModel = allowCustomModel; }

    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
