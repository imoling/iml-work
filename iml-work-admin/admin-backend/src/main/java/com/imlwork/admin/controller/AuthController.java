package com.imlwork.admin.controller;

import com.imlwork.admin.dto.AuthRequests;
import com.imlwork.admin.model.LoginAudit;
import com.imlwork.admin.model.PasswordResetRequest;
import com.imlwork.admin.model.User;
import com.imlwork.admin.repository.LoginAuditRepository;
import com.imlwork.admin.repository.PasswordResetRequestRepository;
import com.imlwork.admin.repository.UserRepository;
import com.imlwork.admin.security.AuthService;
import com.imlwork.admin.security.JwtAuthFilter.AuthPrincipal;
import com.imlwork.admin.security.JwtService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** 登录、当前用户、改密。JWT 无状态，登出由前端丢弃 token 完成。 */
@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final AuthService authService;
    private final LoginAuditRepository loginAuditRepository;
    private final PasswordResetRequestRepository resetRequestRepository;

    public AuthController(UserRepository userRepository, PasswordEncoder passwordEncoder,
                          JwtService jwtService, AuthService authService,
                          LoginAuditRepository loginAuditRepository,
                          PasswordResetRequestRepository resetRequestRepository) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.authService = authService;
        this.loginAuditRepository = loginAuditRepository;
        this.resetRequestRepository = resetRequestRepository;
    }

    private void audit(String username, String userId, boolean ok, String reason, HttpServletRequest req) {
        try {
            String client = req.getHeader("X-Client");
            String ip = req.getHeader("X-Forwarded-For");
            if (ip == null || ip.isBlank()) ip = req.getRemoteAddr();
            String ua = req.getHeader("User-Agent");
            loginAuditRepository.save(new LoginAudit(username, userId, ok, reason,
                    client == null || client.isBlank() ? "unknown" : client, ip, ua));
        } catch (Exception ignore) { /* 审计失败不影响登录 */ }
    }

    @PostMapping("/login")
    public ResponseEntity<Map<String, Object>> login(@Valid @RequestBody AuthRequests.Login body, HttpServletRequest req) {
        String username = body.username().trim();
        String password = body.password();
        User user = userRepository.findByUsername(username).orElse(null);
        if (user == null) {
            audit(username, null, false, "用户不存在", req);
            return ResponseEntity.status(401).body(Map.of("success", false, "error", "用户名或密码错误"));
        }
        if (!passwordEncoder.matches(password, user.getPasswordHash())) {
            audit(username, user.getId(), false, "密码错误", req);
            return ResponseEntity.status(401).body(Map.of("success", false, "error", "用户名或密码错误"));
        }
        if (!user.isEnabled()) {
            audit(username, user.getId(), false, "账号停用", req);
            return ResponseEntity.status(403).body(Map.of("success", false, "error", "账号已停用，请联系管理员"));
        }
        audit(username, user.getId(), true, "成功", req);
        user.setLastLoginAt(LocalDateTime.now());
        userRepository.save(user);

        List<String> perms = authService.resolvePermissions(user);
        String token = jwtService.generate(user.getId(), user.getUsername(), user.getDisplayName(),
                user.getRoles(), perms);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("success", true);
        resp.put("token", token);
        resp.put("user", authService.toDto(user));
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
        String oldPwd = body.oldPassword();
        String newPwd = body.newPassword();
        if (!passwordEncoder.matches(oldPwd, user.getPasswordHash())) {
            return ResponseEntity.status(400).body(Map.of("success", false, "error", "原密码不正确"));
        }
        user.setPasswordHash(passwordEncoder.encode(newPwd));
        user.setMustChangePassword(false);
        userRepository.save(user);
        return ResponseEntity.ok(Map.of("success", true));
    }

    /**
     * 找回密码申请（公开）。用户提交用户名（+手机号供核验）→ 生成待处理申请，
     * 管理员在「用户权限 · 找回申请」核验身份后重置。为不泄露账号是否存在，统一返回成功文案。
     */
    @PostMapping("/forgot")
    public ResponseEntity<Map<String, Object>> forgot(@Valid @RequestBody AuthRequests.Forgot body) {
        String username = body.username().trim();
        String phone = body.phone() == null ? "" : body.phone().trim();
        String msg = "已提交找回申请。若该账号存在，管理员核验身份后将为你重置密码，请留意联系。";
        User user = userRepository.findByUsername(username).orElse(null);
        if (user != null) {
            // 去重：同一用户已有 PENDING 申请则复用，不重复堆积
            boolean hasPending = !resetRequestRepository.findByUserIdAndStatus(user.getId(), "PENDING").isEmpty();
            if (!hasPending) {
                PasswordResetRequest r = new PasswordResetRequest();
                r.setId("rst-" + UUID.randomUUID().toString().substring(0, 8));
                r.setUsername(username);
                r.setUserId(user.getId());
                r.setPhone(phone);
                resetRequestRepository.save(r);
            }
        }
        return ResponseEntity.ok(Map.of("success", true, "message", msg));
    }

    private User currentUser() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        if (a == null || !(a.getPrincipal() instanceof AuthPrincipal p)) return null;
        return userRepository.findById(p.userId()).orElse(null);
    }
}
