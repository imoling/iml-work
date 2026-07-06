package com.imlwork.admin.dto;

import jakarta.validation.constraints.NotBlank;

import java.util.List;

/**
 * 角色管理写请求 DTO（替代直接拿 Role 实体当请求契约）。
 * Update 字段可空：null 表示「不改该字段」（与服务层既有部分更新语义一致）。
 */
public final class RoleRequests {
    private RoleRequests() {}

    public record Create(
            @NotBlank(message = "角色名不能为空") String name,
            String label,
            List<String> permissions) {}

    public record Update(String label, List<String> permissions) {}
}
