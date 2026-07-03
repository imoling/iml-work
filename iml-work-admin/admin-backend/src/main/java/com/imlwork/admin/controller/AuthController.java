package com.imlwork.admin.controller;

import com.imlwork.admin.dto.AuthRequests;
import com.imlwork.admin.model.User;
import com.imlwork.admin.repository.UserRepository;
import com.imlwork.admin.security.AuthService;
import com.imlwork.admin.security.JwtAuthFilter.AuthPrincipal;
import com.imlwork.admin.service.AccountService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;

/** 登录、当前用户、改密、找回。仅做 HTTP 塑形；业务与事务在 {@link AccountService}。 */
@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AccountService accountService;
    private final AuthService authService;
    private final UserRepository userRepository;

    public AuthController(AccountService accountService, AuthService authService, UserRepository userRepository) {
        this.accountService = accountService;
        this.authService = authService;
        this.userRepository = userRepository;
    }

    @PostMapping("/login")
    public ResponseEntity<Map<String, Object>> login(@Valid @RequestBody AuthRequests.Login body, HttpServletRequest req) {
        String ip = req.getHeader("X-Forwarded-For");
        if (ip == null || ip.isBlank()) ip = req.getRemoteAddr();
        var audit = new AccountService.AuditInfo(req.getHeader("X-Client"), ip, req.getHeader("User-Agent"));
        var result = accountService.login(body.username(), body.password(), audit);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("success", true);
        resp.put("token", result.token());
        resp.put("user", result.user());
        return ResponseEntity.ok(resp);
    }

    @GetMapping("/me")
    public ResponseEntity<Map<String, Object>> me() {
        User user = currentUser();
        if (user == null) return ResponseEntity.status(401).body(Map.of("error", "未登录"));
        return ResponseEntity.ok(authService.toDto(user));
    }

    @PostMapping("/change-password")
    public ResponseEntity<Map<String, Object>> changePassword(@Valid @RequestBody AuthRequests.ChangePassword body) {
        User user = currentUser();
        if (user == null) return ResponseEntity.status(401).body(Map.of("success", false, "error", "未登录"));
        accountService.changePassword(user.getId(), body.oldPassword(), body.newPassword());
        return ResponseEntity.ok(Map.of("success", true));
    }

    @PostMapping("/forgot")
    public ResponseEntity<Map<String, Object>> forgot(@Valid @RequestBody AuthRequests.Forgot body) {
        accountService.forgot(body.username(), body.phone());
        return ResponseEntity.ok(Map.of("success", true,
                "message", "已提交找回申请。若该账号存在，管理员核验身份后将为你重置密码，请留意联系。"));
    }

    private User currentUser() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        if (a == null || !(a.getPrincipal() instanceof AuthPrincipal p)) return null;
        return userRepository.findById(p.userId()).orElse(null);
    }
}
