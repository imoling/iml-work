package com.imlwork.admin.service;

import com.imlwork.admin.dto.UserRequests;
import com.imlwork.admin.model.PasswordResetRequest;
import com.imlwork.admin.model.User;
import com.imlwork.admin.repository.LoginAuditRepository;
import com.imlwork.admin.repository.PasswordResetRequestRepository;
import com.imlwork.admin.repository.UserRepository;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * 用户与密码找回的领域服务：承载校验 + 多步写操作的事务边界，Controller 只做 HTTP 塑形。
 * 校验失败抛 IllegalArgumentException（→ 400），资源不存在抛 ResponseStatusException(404)，
 * 均由 GlobalExceptionHandler 统一映射。
 */
@Service
public class UserService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final PasswordResetRequestRepository resetRequestRepository;
    private final LoginAuditRepository loginAuditRepository;

    public UserService(UserRepository userRepository, PasswordEncoder passwordEncoder,
                       PasswordResetRequestRepository resetRequestRepository,
                       LoginAuditRepository loginAuditRepository) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.resetRequestRepository = resetRequestRepository;
        this.loginAuditRepository = loginAuditRepository;
    }

    @Transactional(readOnly = true)
    public List<User> list() {
        return userRepository.findAll();
    }

    /** 登录审计只读投影：最近 100 条明细 + 成败总数（管理端安全页展示）。 */
    @Transactional(readOnly = true)
    public Map<String, Object> loginAudit() {
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
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("recent", recent);
        out.put("totalSuccess", loginAuditRepository.countBySuccess(true));
        out.put("totalFail", loginAuditRepository.countBySuccess(false));
        return out;
    }

    @Transactional
    public User create(UserRequests.Create req) {
        String uname = str(req.username()).trim();
        if (uname.isBlank()) throw new IllegalArgumentException("用户名不能为空");
        if (str(req.password()).length() < 6) throw new IllegalArgumentException("初始密码至少 6 位");
        if (userRepository.existsByUsername(uname)) throw new IllegalArgumentException("用户名已存在");
        User u = new User();
        u.setId("user-" + UUID.randomUUID().toString().substring(0, 8));
        u.setUsername(uname);
        u.setPasswordHash(passwordEncoder.encode(req.password()));
        u.setMustChangePassword(true);   // 首次登录强制改密
        applyEditable(u, new UserRequests.Update(req.displayName(), req.department(), req.phone(),
                req.enabled(), req.allowAllExperts(), req.roles(), req.assignedExpertIds()));
        return userRepository.save(u);
    }

    @Transactional
    public User update(String id, UserRequests.Update editable) {
        User u = userRepository.findById(id).orElseThrow(() -> notFound("用户不存在"));
        applyEditable(u, editable);
        return userRepository.save(u);
    }

    @Transactional
    public void resetPassword(String id, String password) {
        if (str(password).length() < 6) throw new IllegalArgumentException("新密码至少 6 位");
        User u = userRepository.findById(id).orElseThrow(() -> notFound("用户不存在"));
        u.setPasswordHash(passwordEncoder.encode(password));
        u.setMustChangePassword(true);
        userRepository.save(u);
    }

    @Transactional
    public void delete(String id) {
        if (!userRepository.existsById(id)) throw notFound("用户不存在");
        userRepository.deleteById(id);
    }

    @Transactional(readOnly = true)
    public List<PasswordResetRequest> pendingResetRequests() {
        return resetRequestRepository.findByStatusOrderByCreatedAtDesc("PENDING");
    }

    /** 批准找回申请：重置目标用户密码 + 标记申请已处理（同一事务，原子）。返回临时密码。 */
    @Transactional
    public ResetOutcome approveReset(String requestId, String suppliedPassword) {
        PasswordResetRequest r = resetRequestRepository.findById(requestId).orElseThrow(() -> notFound("申请不存在"));
        User u = r.getUserId() != null ? userRepository.findById(r.getUserId()).orElse(null) : null;
        if (u == null) u = userRepository.findByUsername(r.getUsername()).orElse(null);
        if (u == null) throw new IllegalArgumentException("用户不存在");
        String pwd = str(suppliedPassword);
        if (pwd.isBlank()) pwd = "reset-" + UUID.randomUUID().toString().substring(0, 6);
        if (pwd.length() < 6) throw new IllegalArgumentException("临时密码至少 6 位");
        u.setPasswordHash(passwordEncoder.encode(pwd));
        u.setMustChangePassword(true);
        userRepository.save(u);
        r.setStatus("DONE");
        r.setHandledAt(LocalDateTime.now());
        resetRequestRepository.save(r);
        return new ResetOutcome(u.getUsername(), pwd);
    }

    @Transactional
    public void rejectReset(String requestId) {
        PasswordResetRequest r = resetRequestRepository.findById(requestId).orElseThrow(() -> notFound("申请不存在"));
        r.setStatus("REJECTED");
        r.setHandledAt(LocalDateTime.now());
        resetRequestRepository.save(r);
    }

    public record ResetOutcome(String username, String tempPassword) {}

    // 部分更新语义：null 字段不覆盖（与旧 Map containsKey 语义一致——前端总是全字段提交，
    // 但保留该语义可容忍其它调用方省略字段）。
    private void applyEditable(User u, UserRequests.Update body) {
        if (body == null) return;
        if (body.displayName() != null) u.setDisplayName(body.displayName());
        if (body.department() != null) u.setDepartment(body.department());
        if (body.phone() != null) u.setPhone(body.phone());
        if (body.enabled() != null) u.setEnabled(body.enabled());
        if (body.allowAllExperts() != null) u.setAllowAllExperts(body.allowAllExperts());
        if (body.roles() != null) u.setRoles(new java.util.ArrayList<>(body.roles()));
        if (body.assignedExpertIds() != null) u.setAssignedExpertIds(new java.util.ArrayList<>(body.assignedExpertIds()));
    }

    private static ResponseStatusException notFound(String msg) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, msg);
    }

    private static String str(Object o) { return o == null ? "" : String.valueOf(o); }
}
