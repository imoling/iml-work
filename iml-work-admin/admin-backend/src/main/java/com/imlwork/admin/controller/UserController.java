package com.imlwork.admin.controller;

import com.imlwork.admin.dto.UserRequests;
import com.imlwork.admin.model.PasswordResetRequest;
import com.imlwork.admin.security.AuthService;
import com.imlwork.admin.service.UserService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 用户管理（需 USER_MANAGE，见 SecurityConfig）。仅做 HTTP 塑形，业务逻辑与事务在 {@link UserService}。
 */
@RestController
@RequestMapping("/api/v1/users")
public class UserController {

    private final UserService userService;
    private final AuthService authService;

    public UserController(UserService userService, AuthService authService) {
        this.userService = userService;
        this.authService = authService;
    }

    // ── 登录审计（只读投影） ────────────────────────────────────────────────
    @GetMapping("/login-audit")
    public ResponseEntity<Map<String, Object>> loginAudit() {
        return ResponseEntity.ok(userService.loginAudit());
    }

    // ── 找回密码申请 ──────────────────────────────────────────────────────
    @GetMapping("/reset-requests")
    public ResponseEntity<List<PasswordResetRequest>> resetRequests() {
        return ResponseEntity.ok(userService.pendingResetRequests());
    }

    @PostMapping("/reset-requests/{id}/approve")
    public ResponseEntity<Map<String, Object>> approveReset(@PathVariable String id, @RequestBody(required = false) Map<String, Object> body) {
        String pwd = body != null && body.get("password") != null ? String.valueOf(body.get("password")) : "";
        UserService.ResetOutcome out = userService.approveReset(id, pwd);
        return ResponseEntity.ok(Map.of("success", true, "username", out.username(), "tempPassword", out.tempPassword()));
    }

    @PostMapping("/reset-requests/{id}/reject")
    public ResponseEntity<Map<String, Object>> rejectReset(@PathVariable String id) {
        userService.rejectReset(id);
        return ResponseEntity.ok(Map.of("success", true));
    }

    // ── 用户 CRUD ─────────────────────────────────────────────────────────
    @GetMapping
    public ResponseEntity<List<Map<String, Object>>> list() {
        return ResponseEntity.ok(userService.list().stream().map(authService::toDto).collect(Collectors.toList()));
    }

    @PostMapping
    public ResponseEntity<Map<String, Object>> create(@Valid @RequestBody UserRequests.Create body) {
        var u = userService.create(body);
        return ResponseEntity.ok(Map.of("success", true, "user", authService.toDto(u)));
    }

    @PutMapping("/{id}")
    public ResponseEntity<Map<String, Object>> update(@PathVariable String id, @RequestBody UserRequests.Update body) {
        var u = userService.update(id, body);
        return ResponseEntity.ok(Map.of("success", true, "user", authService.toDto(u)));
    }

    @PostMapping("/{id}/reset-password")
    public ResponseEntity<Map<String, Object>> resetPassword(@PathVariable String id, @Valid @RequestBody UserRequests.ResetPassword body) {
        userService.resetPassword(id, body.password());
        return ResponseEntity.ok(Map.of("success", true));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        userService.delete(id);
        return ResponseEntity.ok(Map.of("success", true));
    }
}
