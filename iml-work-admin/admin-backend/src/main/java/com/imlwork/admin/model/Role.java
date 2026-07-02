package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.util.ArrayList;
import java.util.List;

/**
 * 角色：一组权限点的集合。name 为稳定标识（如 SUPER_ADMIN），builtin 预设角色不可删除。
 */
@Entity
@Table(name = "auth_role")
public class Role {

    @Id
    private String name;

    private String label;

    /** 权限点集合（点分字符串；超级管理员为 ["*"]）。 */
    @Convert(converter = StringListConverter.class)
    @Column(columnDefinition = "text")
    private List<String> permissions = new ArrayList<>();

    /** 预设内置角色不可删除（可改权限）。 */
    private boolean builtin = false;

    public Role() {}

    public Role(String name, String label, List<String> permissions, boolean builtin) {
        this.name = name;
        this.label = label;
        this.permissions = permissions;
        this.builtin = builtin;
    }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getLabel() { return label; }
    public void setLabel(String label) { this.label = label; }

    public List<String> getPermissions() { return permissions; }
    public void setPermissions(List<String> permissions) { this.permissions = permissions; }

    public boolean isBuiltin() { return builtin; }
    public void setBuiltin(boolean builtin) { this.builtin = builtin; }
}
