package com.imlwork.admin.controller;

import com.imlwork.admin.model.LoginAudit;
import com.imlwork.admin.model.PasswordResetRequest;
import com.imlwork.admin.model.User;
import com.imlwork.admin.repository.LoginAuditRepository;
import com.imlwork.admin.repository.PasswordResetRequestRepository;
import com.imlwork.admin.repository.UserRepository;
import com.imlwork.admin.security.AuthService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

/** 用户管理（需 USER_MANAGE，见 SecurityConfig）。 */
@RestController
@RequestMapping("/api/v1/users")
public class UserController {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final AuthService authService;
    private final LoginAuditRepository loginAuditRepository;
    private final PasswordResetRequestRepository resetRequestRepository;

    public UserController(UserRepository userRepository, PasswordEncoder passwordEncoder, AuthService authService,
                          LoginAuditRepository loginAuditRepository,
                          PasswordResetRequestRepository resetRequestRepository) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.authService = authService;
        this.loginAuditRepository = loginAuditRepository;
        this.resetRequestRepository = resetRequestRepository;
    }

    // ── 登录审计 ──────────────────────────────────────────────────────────
    @GetMapping("/login-audit")
    public ResponseEntity<Map<String, Object>> loginAudit() {
        List<Map<String, Object>> recent = loginAuditRepository.findTop100ByOrderByCreatedAtDesc().stream().map(a -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("username", a.getUsername());
            m.put("success", a.isSuccess());
            m.put("reason", a.getReason());
            m.put("clientType", a.getClientType());
            m.put("ip", a.getIp());
            m.put("createdAt", a.getCreatedAt());
            return m;
        }).collect(Collectors.toList());
        long ok = loginAuditRepository.countBySuccess(true);
        long fail = loginAuditRepository.countBySuccess(false);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("recent", recent);
        out.put("totalSuccess", ok);
        out.put("totalFail", fail);
        return ResponseEntity.ok(out);
    }

    // ── 找回密码申请 ──────────────────────────────────────────────────────
    @GetMapping("/reset-requests")
    public ResponseEntity<List<PasswordResetRequest>> resetRequests() {
        return ResponseEntity.ok(resetRequestRepository.findByStatusOrderByCreatedAtDesc("PENDING"));
    }

    /** 核验身份后批准：重置该用户密码（强制改密），返回临时密码供管理员转达。 */
    @PostMapping("/reset-requests/{id}/approve")
    public ResponseEntity<Map<String, Object>> approveReset(@PathVariable String id, @RequestBody(required = false) Map<String, Object> body) {
        PasswordResetRequest r = resetRequestRepository.findById(id).orElse(null);
        if (r == null) return ResponseEntity.notFound().build();
        User u = r.getUserId() != null ? userRepository.findById(r.getUserId()).orElse(null) : null;
        if (u == null) u = userRepository.findByUsername(r.getUsername()).orElse(null);
        if (u == null) return ResponseEntity.badRequest().body(Map.of("success", false, "error", "用户不存在"));
        String pwd = body != null && body.get("password") != null ? String.valueOf(body.get("password")) : "";
        if (pwd.isBlank()) pwd = "reset-" + UUID.randomUUID().toString().substring(0, 6);
        if (pwd.length() < 6) return ResponseEntity.badRequest().body(Map.of("success", false, "error", "临时密码至少 6 位"));
        u.setPasswordHash(passwordEncoder.encode(pwd));
        u.setMustChangePassword(true);
        userRepository.save(u);
        r.setStatus("DONE");
        r.setHandledAt(LocalDateTime.now());
        resetRequestRepository.save(r);
        return ResponseEntity.ok(Map.of("success", true, "username", u.getUsername(), "tempPassword", pwd));
    }

    @PostMapping("/reset-requests/{id}/reject")
    public ResponseEntity<Map<String, Object>> rejectReset(@PathVariable String id) {
        PasswordResetRequest r = resetRequestRepository.findById(id).orElse(null);
        if (r == null) return ResponseEntity.notFound().build();
        r.setStatus("REJECTED");
        r.setHandledAt(LocalDateTime.now());
        resetRequestRepository.save(r);
        return ResponseEntity.ok(Map.of("success", true));
    }

    @GetMapping
    public ResponseEntity<List<Map<String, Object>>> list() {
        return ResponseEntity.ok(userRepository.findAll().stream().map(authService::toDto).collect(Collectors.toList()));
    }

    @PostMapping
    public ResponseEntity<Map<String, Object>> create(@RequestBody Map<String, Object> body) {
        String username = str(body.get("username")).trim();
        String password = str(body.get("password"));
        if (username.isBlank()) return ResponseEntity.badRequest().body(Map.of("success", false, "error", "用户名不能为空"));
        if (password.length() < 6) return ResponseEntity.badRequest().body(Map.of("success", false, "error", "初始密码至少 6 位"));
        if (userRepository.existsByUsername(username)) {
            return ResponseEntity.badRequest().body(Map.of("success", false, "error", "用户名已存在"));
        }
        User u = new User();
        u.setId("user-" + UUID.randomUUID().toString().substring(0, 8));
        u.setUsername(username);
        u.setPasswordHash(passwordEncoder.encode(password));
        u.setMustChangePassword(true);   // 首次登录强制改密
        applyEditable(u, body);
        userRepository.save(u);
        return ResponseEntity.ok(Map.of("success", true, "user", authService.toDto(u)));
    }

    @PutMapping("/{id}")
    public ResponseEntity<Map<String, Object>> update(@PathVariable String id, @RequestBody Map<String, Object> body) {
        User u = userRepository.findById(id).orElse(null);
        if (u == null) return ResponseEntity.notFound().build();
        applyEditable(u, body);
        userRepository.save(u);
        return ResponseEntity.ok(Map.of("success", true, "user", authService.toDto(u)));
    }

    /** 重置密码（管理员）→ 强制下次登录改密。 */
    @PostMapping("/{id}/reset-password")
    public ResponseEntity<Map<String, Object>> resetPassword(@PathVariable String id, @RequestBody Map<String, Object> body) {
        User u = userRepository.findById(id).orElse(null);
        if (u == null) return ResponseEntity.notFound().build();
        String pwd = str(body.get("password"));
        if (pwd.length() < 6) return ResponseEntity.badRequest().body(Map.of("success", false, "error", "新密码至少 6 位"));
        u.setPasswordHash(passwordEncoder.encode(pwd));
        u.setMustChangePassword(true);
        userRepository.save(u);
        return ResponseEntity.ok(Map.of("success", true));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        if (!userRepository.existsById(id)) return ResponseEntity.notFound().build();
        userRepository.deleteById(id);
        return ResponseEntity.ok(Map.of("success", true));
    }

    @SuppressWarnings("unchecked")
    private void applyEditable(User u, Map<String, Object> body) {
        if (body.containsKey("displayName")) u.setDisplayName(str(body.get("displayName")));
        if (body.containsKey("department")) u.setDepartment(str(body.get("department")));
        if (body.containsKey("phone")) u.setPhone(str(body.get("phone")));
        if (body.containsKey("enabled")) u.setEnabled(Boolean.TRUE.equals(body.get("enabled")));
        if (body.containsKey("allowAllExperts")) u.setAllowAllExperts(Boolean.TRUE.equals(body.get("allowAllExperts")));
        if (body.get("roles") instanceof List<?> l) u.setRoles(l.stream().map(String::valueOf).collect(Collectors.toList()));
        if (body.get("assignedExpertIds") instanceof List<?> l) u.setAssignedExpertIds(l.stream().map(String::valueOf).collect(Collectors.toList()));
    }

    private static String str(Object o) { return o == null ? "" : String.valueOf(o); }
}
