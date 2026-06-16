package com.imlwork.admin.model;

import jakarta.persistence.*;
import java.time.LocalDateTime;

/** 脱敏操作留痕：每次对某条 Trace 做脱敏/导出都记录，不保存敏感原文。 */
@Entity
@Table(name = "desensitize_audit")
public class DesensitizeAudit {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;
    private String traceId;
    private String mode;          // LIGHT | STANDARD | STRONG
    private String role;          // 操作角色
    private String operator;      // 操作人
    private String hitRules;      // 命中规则编号，如 D4,D10
    private int hitCount;
    private boolean exported;
    private String exportNo;      // 导出文件编号
    private LocalDateTime createdAt = LocalDateTime.now();

    public DesensitizeAudit() {}

    public Long getId() { return id; } public void setId(Long v) { this.id = v; }
    public String getTraceId() { return traceId; } public void setTraceId(String v) { this.traceId = v; }
    public String getMode() { return mode; } public void setMode(String v) { this.mode = v; }
    public String getRole() { return role; } public void setRole(String v) { this.role = v; }
    public String getOperator() { return operator; } public void setOperator(String v) { this.operator = v; }
    public String getHitRules() { return hitRules; } public void setHitRules(String v) { this.hitRules = v; }
    public int getHitCount() { return hitCount; } public void setHitCount(int v) { this.hitCount = v; }
    public boolean isExported() { return exported; } public void setExported(boolean v) { this.exported = v; }
    public String getExportNo() { return exportNo; } public void setExportNo(String v) { this.exportNo = v; }
    public LocalDateTime getCreatedAt() { return createdAt; } public void setCreatedAt(LocalDateTime v) { this.createdAt = v; }
}
