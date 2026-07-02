package com.imlwork.admin.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 认证相关请求 DTO（替代此前的 Map&lt;String,String&gt;）：带类型与校验注解，
 * 校验失败由 GlobalExceptionHandler 统一转 400。字段名与前端 JSON key 一致。
 */
public final class AuthRequests {
    private AuthRequests() {}

    public record Login(
            @NotBlank(message = "请填写用户名") String username,
            @NotBlank(message = "请填写密码") String password) {}

    public record ChangePassword(
            @NotBlank(message = "请填写原密码") String oldPassword,
            @NotBlank @Size(min = 6, message = "新密码至少 6 位") String newPassword) {}

    public record Forgot(
            @NotBlank(message = "请填写用户名") String username,
            String phone) {}
}
