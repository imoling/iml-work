package com.imlwork.admin.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * 用户管理写请求 DTO（替代此前的 Map&lt;String,Object&gt;）：带类型与校验注解，
 * 校验失败由 GlobalExceptionHandler 统一转 400。字段名与管理前端 JSON key 一致。
 * 画像字段全部可空：null 表示「不改该字段」（与旧 Map containsKey 的部分更新语义一致）。
 */
public final class UserRequests {
    private UserRequests() {}

    public record Create(
            @NotBlank(message = "用户名不能为空") String username,
            @NotBlank @Size(min = 6, message = "初始密码至少 6 位") String password,
            String displayName, String department, String phone,
            Boolean enabled, Boolean allowAllExperts,
            List<String> roles, List<String> assignedExpertIds) {}

    public record Update(
            String displayName, String department, String phone,
            Boolean enabled, Boolean allowAllExperts,
            List<String> roles, List<String> assignedExpertIds) {}

    public record ResetPassword(
            @NotBlank @Size(min = 6, message = "新密码至少 6 位") String password) {}
}
