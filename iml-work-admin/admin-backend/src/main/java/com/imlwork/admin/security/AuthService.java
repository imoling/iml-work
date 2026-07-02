package com.imlwork.admin.security;

import com.imlwork.admin.model.Role;
import com.imlwork.admin.model.User;
import com.imlwork.admin.repository.RoleRepository;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** 角色→权限点解析 + 用户对外 DTO（不含密码哈希）。 */
@Service
public class AuthService {

    private final RoleRepository roleRepository;

    public AuthService(RoleRepository roleRepository) {
        this.roleRepository = roleRepository;
    }

    /** 汇总用户所有角色的权限点；含 "*" 则视为超级管理员，返回 ["*"]。 */
    public List<String> resolvePermissions(User user) {
        Set<String> perms = new LinkedHashSet<>();
        for (String roleName : user.getRoles()) {
            Role r = roleRepository.findById(roleName).orElse(null);
            if (r == null) continue;
            if (r.getPermissions().contains(Permissions.ALL)) {
                return List.of(Permissions.ALL);
            }
            perms.addAll(r.getPermissions());
        }
        return new ArrayList<>(perms);
    }

    /** 对外用户信息（含解析后的权限点，供前端做菜单/按钮级控制）。 */
    public Map<String, Object> toDto(User u) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", u.getId());
        m.put("username", u.getUsername());
        m.put("displayName", u.getDisplayName());
        m.put("department", u.getDepartment());
        m.put("phone", u.getPhone());
        m.put("enabled", u.isEnabled());
        m.put("mustChangePassword", u.isMustChangePassword());
        m.put("roles", u.getRoles());
        m.put("assignedExpertIds", u.getAssignedExpertIds());
        m.put("allowAllExperts", u.isAllowAllExperts());
        m.put("permissions", resolvePermissions(u));
        m.put("lastLoginAt", u.getLastLoginAt());
        m.put("createdAt", u.getCreatedAt());
        return m;
    }
}
