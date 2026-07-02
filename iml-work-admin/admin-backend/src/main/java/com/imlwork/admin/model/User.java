package com.imlwork.admin.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.persistence.*;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * 统一账户。用户名+密码登录（BCrypt）；持有角色（→权限点）；可分配「可领用岗位」。
 * 密码哈希用 {@link JsonIgnore} 永不出现在 API 响应中。
 */
@Entity
@Table(name = "auth_user", uniqueConstraints = @UniqueConstraint(columnNames = "username"))
public class User {

    @Id
    private String id;

    private String username;

    @JsonIgnore
    private String passwordHash;

    private String displayName;
    private String department;
    private String phone;
    private boolean enabled = true;

    /** 首次登录（或被重置后）强制改密。 */
    private boolean mustChangePassword = false;

    /** 角色名集合。 */
    @Convert(converter = StringListConverter.class)
    @Column(columnDefinition = "text")
    private List<String> roles = new ArrayList<>();

    /** 允许领用的岗位（Expert）ID 集合；allowAllExperts=true 时忽略此限制。 */
    @Convert(converter = StringListConverter.class)
    @Column(columnDefinition = "text")
    private List<String> assignedExpertIds = new ArrayList<>();

    /** 是否允许领用全部岗位（true = 不受 assignedExpertIds 限制）。 */
    private boolean allowAllExperts = false;

    private LocalDateTime createdAt = LocalDateTime.now();
    private LocalDateTime lastLoginAt;

    public User() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username; }

    public String getPasswordHash() { return passwordHash; }
    public void setPasswordHash(String passwordHash) { this.passwordHash = passwordHash; }

    public String getDisplayName() { return displayName; }
    public void setDisplayName(String displayName) { this.displayName = displayName; }

    public String getDepartment() { return department; }
    public void setDepartment(String department) { this.department = department; }

    public String getPhone() { return phone; }
    public void setPhone(String phone) { this.phone = phone; }

    public boolean isEnabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }

    public boolean isMustChangePassword() { return mustChangePassword; }
    public void setMustChangePassword(boolean mustChangePassword) { this.mustChangePassword = mustChangePassword; }

    public List<String> getRoles() { return roles; }
    public void setRoles(List<String> roles) { this.roles = roles; }

    public List<String> getAssignedExpertIds() { return assignedExpertIds; }
    public void setAssignedExpertIds(List<String> assignedExpertIds) { this.assignedExpertIds = assignedExpertIds; }

    public boolean isAllowAllExperts() { return allowAllExperts; }
    public void setAllowAllExperts(boolean allowAllExperts) { this.allowAllExperts = allowAllExperts; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }

    public LocalDateTime getLastLoginAt() { return lastLoginAt; }
    public void setLastLoginAt(LocalDateTime lastLoginAt) { this.lastLoginAt = lastLoginAt; }
}
