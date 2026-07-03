package com.imlwork.admin.service;

import com.imlwork.admin.model.PasswordResetRequest;
import com.imlwork.admin.model.User;
import com.imlwork.admin.repository.PasswordResetRequestRepository;
import com.imlwork.admin.repository.UserRepository;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
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

    public UserService(UserRepository userRepository, PasswordEncoder passwordEncoder,
                       PasswordResetRequestRepository resetRequestRepository) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.resetRequestRepository = resetRequestRepository;
    }

    @Transactional(readOnly = true)
    public List<User> list() {
        return userRepository.findAll();
    }

    @Transactional
    public User create(String username, String password, Map<String, Object> editable) {
        String uname = str(username).trim();
        if (uname.isBlank()) throw new IllegalArgumentException("用户名不能为空");
        if (str(password).length() < 6) throw new IllegalArgumentException("初始密码至少 6 位");
        if (userRepository.existsByUsername(uname)) throw new IllegalArgumentException("用户名已存在");
        User u = new User();
        u.setId("user-" + UUID.randomUUID().toString().substring(0, 8));
        u.setUsername(uname);
        u.setPasswordHash(passwordEncoder.encode(password));
        u.setMustChangePassword(true);   // 首次登录强制改密
        applyEditable(u, editable);
        return userRepository.save(u);
    }

    @Transactional
    public User update(String id, Map<String, Object> editable) {
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

    private void applyEditable(User u, Map<String, Object> body) {
        if (body == null) return;
        if (body.containsKey("displayName")) u.setDisplayName(str(body.get("displayName")));
        if (body.containsKey("department")) u.setDepartment(str(body.get("department")));
        if (body.containsKey("phone")) u.setPhone(str(body.get("phone")));
        if (body.containsKey("enabled")) u.setEnabled(Boolean.TRUE.equals(body.get("enabled")));
        if (body.containsKey("allowAllExperts")) u.setAllowAllExperts(Boolean.TRUE.equals(body.get("allowAllExperts")));
        if (body.get("roles") instanceof List<?> l) u.setRoles(l.stream().map(String::valueOf).collect(Collectors.toList()));
        if (body.get("assignedExpertIds") instanceof List<?> l) u.setAssignedExpertIds(l.stream().map(String::valueOf).collect(Collectors.toList()));
    }

    private static ResponseStatusException notFound(String msg) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, msg);
    }

    private static String str(Object o) { return o == null ? "" : String.valueOf(o); }
}
