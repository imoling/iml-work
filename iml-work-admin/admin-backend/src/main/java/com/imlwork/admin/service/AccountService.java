package com.imlwork.admin.service;

import com.imlwork.admin.model.LoginAudit;
import com.imlwork.admin.model.PasswordResetRequest;
import com.imlwork.admin.model.User;
import com.imlwork.admin.repository.LoginAuditRepository;
import com.imlwork.admin.repository.PasswordResetRequestRepository;
import com.imlwork.admin.repository.UserRepository;
import com.imlwork.admin.security.AuthService;
import com.imlwork.admin.security.JwtService;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 账户领域服务：登录、改密、找回申请。
 * 注意：登录审计（含失败）必须落库，故 login 不整体 @Transactional（否则失败抛异常会回滚失败审计）；
 * 改密 / 找回为单事务写。
 */
@Service
public class AccountService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final AuthService authService;
    private final LoginAuditRepository loginAuditRepository;
    private final PasswordResetRequestRepository resetRequestRepository;

    public AccountService(UserRepository userRepository, PasswordEncoder passwordEncoder, JwtService jwtService,
                          AuthService authService, LoginAuditRepository loginAuditRepository,
                          PasswordResetRequestRepository resetRequestRepository) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.authService = authService;
        this.loginAuditRepository = loginAuditRepository;
        this.resetRequestRepository = resetRequestRepository;
    }

    public record AuditInfo(String clientType, String ip, String ua) {}
    public record LoginResult(String token, Map<String, Object> user) {}

    /** 登录：校验凭证 → 记审计（含失败）→ 更新 lastLogin → 签发 token。失败抛 401/403。 */
    public LoginResult login(String username, String password, AuditInfo audit) {
        String uname = username == null ? "" : username.trim();
        User user = userRepository.findByUsername(uname).orElse(null);
        if (user == null) {
            recordAudit(uname, null, false, "用户不存在", audit);
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "用户名或密码错误");
        }
        if (!passwordEncoder.matches(password, user.getPasswordHash())) {
            recordAudit(uname, user.getId(), false, "密码错误", audit);
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "用户名或密码错误");
        }
        if (!user.isEnabled()) {
            recordAudit(uname, user.getId(), false, "账号停用", audit);
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "账号已停用，请联系管理员");
        }
        recordAudit(uname, user.getId(), true, "成功", audit);
        user.setLastLoginAt(LocalDateTime.now());
        userRepository.save(user);

        List<String> perms = authService.resolvePermissions(user);
        String token = jwtService.generate(user.getId(), user.getUsername(), user.getDisplayName(),
                user.getRoles(), perms);
        return new LoginResult(token, authService.toDto(user));
    }

    @Transactional
    public void changePassword(String userId, String oldPassword, String newPassword) {
        User user = userRepository.findById(userId).orElseThrow(
                () -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "未登录"));
        if (newPassword == null || newPassword.length() < 6) throw new IllegalArgumentException("新密码至少 6 位");
        if (!passwordEncoder.matches(oldPassword, user.getPasswordHash())) throw new IllegalArgumentException("原密码不正确");
        user.setPasswordHash(passwordEncoder.encode(newPassword));
        user.setMustChangePassword(false);
        userRepository.save(user);
    }

    /** 找回申请：为不泄露账号是否存在，统一成功；存在则去重后建 PENDING 申请。 */
    @Transactional
    public void forgot(String username, String phone) {
        String uname = username == null ? "" : username.trim();
        User user = userRepository.findByUsername(uname).orElse(null);
        if (user == null) return;
        boolean hasPending = !resetRequestRepository.findByUserIdAndStatus(user.getId(), "PENDING").isEmpty();
        if (hasPending) return;
        PasswordResetRequest r = new PasswordResetRequest();
        r.setId("rst-" + UUID.randomUUID().toString().substring(0, 8));
        r.setUsername(uname);
        r.setUserId(user.getId());
        r.setPhone(phone == null ? "" : phone.trim());
        resetRequestRepository.save(r);
    }

    private void recordAudit(String username, String userId, boolean ok, String reason, AuditInfo a) {
        try {
            String client = a == null || a.clientType() == null || a.clientType().isBlank() ? "unknown" : a.clientType();
            loginAuditRepository.save(new LoginAudit(username, userId, ok, reason, client,
                    a == null ? null : a.ip(), a == null ? null : a.ua()));
        } catch (Exception ignore) { /* 审计失败不影响登录 */ }
    }
}
