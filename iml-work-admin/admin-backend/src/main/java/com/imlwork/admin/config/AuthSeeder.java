package com.imlwork.admin.config;

import com.imlwork.admin.model.Role;
import com.imlwork.admin.model.User;
import com.imlwork.admin.repository.RoleRepository;
import com.imlwork.admin.repository.UserRepository;
import com.imlwork.admin.security.Permissions;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.core.annotation.Order;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * 播种预设角色与初始账户。角色仅在缺失时创建（不覆盖管理员改过的权限）。
 * 初始账户仅在「无任何用户」时创建：超级管理员 admin/admin123 + 演示员工/FDE。
 */
@Component
@Order(1)
public class AuthSeeder implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(AuthSeeder.class);

    private final RoleRepository roleRepository;
    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final boolean prod;
    private final String initialAdminPassword;

    public AuthSeeder(RoleRepository roleRepository, UserRepository userRepository, PasswordEncoder passwordEncoder,
                      @Value("${spring.profiles.active:}") String activeProfiles,
                      @Value("${security.initial-admin-password:}") String initialAdminPassword) {
        this.roleRepository = roleRepository;
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.prod = activeProfiles != null && activeProfiles.contains("prod");
        this.initialAdminPassword = initialAdminPassword;
    }

    @Override
    public void run(String... args) {
        // 预设角色（缺失才建，内置不可删）
        for (Permissions.PresetRole pr : Permissions.PRESET_ROLES) {
            if (!roleRepository.existsById(pr.name())) {
                roleRepository.save(new Role(pr.name(), pr.label(), pr.permissions(), true));
                log.info("[AuthSeeder] 预设角色: {} ({})", pr.name(), pr.label());
            }
        }

        // 内置预设角色的权限「补齐」：老库里已存在的内置角色，若缺了新版预设新增的权限点（如给 EMPLOYEE
        // 加的 client.skill.create），按**并集只增不删**补上——保留管理员对该角色额外加的权限，同时保证
        // 设计基线权限始终到位。不这么做的话，改了 PRESET_ROLES 也只对全新库生效，跑着的库永远缺权限。
        for (Permissions.PresetRole pr : Permissions.PRESET_ROLES) {
            roleRepository.findById(pr.name()).ifPresent(role -> {
                if (!role.isBuiltin()) return;   // 只补内置角色，不动自定义角色
                List<String> cur = role.getPermissions() == null ? new ArrayList<>() : new ArrayList<>(role.getPermissions());
                List<String> missing = pr.permissions().stream().filter(p -> !cur.contains(p)).toList();
                if (!missing.isEmpty()) {
                    cur.addAll(missing);
                    role.setPermissions(cur);
                    roleRepository.save(role);
                    log.info("[AuthSeeder] 内置角色 {} 补齐权限点: {}", pr.name(), missing);
                }
            });
        }

        // 初始账户（仅当没有任何用户时）
        if (userRepository.count() == 0) {
            // 超管口令：优先取配置；生产环境必须显式配置，否则拒绝启动（不允许弱默认）。
            String adminPwd = initialAdminPassword;
            if (adminPwd == null || adminPwd.isBlank()) {
                if (prod) {
                    throw new IllegalStateException(
                            "生产环境必须配置初始超管口令：security.initial-admin-password（不得使用默认 admin123）。");
                }
                adminPwd = "admin123";
            }
            createUser("admin", adminPwd, "超级管理员", "IT", "", List.of("SUPER_ADMIN"), true);

            if (prod) {
                log.info("[AuthSeeder] 已创建初始超管账户 admin（口令来自 security.initial-admin-password）。");
            } else {
                // 演示账户仅在非生产环境播种
                createUser("kang", "kang123", "康Sir", "销售部", "18500006788", List.of("EMPLOYEE"), true);
                createUser("fde", "fde123", "FDE工程师", "交付部", "", List.of("FDE"), true);
                log.info("[AuthSeeder] 初始账户已创建（开发）：admin/admin123（超管）、kang/kang123（员工）、fde/fde123（FDE）");
            }
        }
    }

    private void createUser(String username, String password, String displayName, String dept,
                            String phone, List<String> roles, boolean allowAllExperts) {
        User u = new User();
        u.setId("user-" + UUID.randomUUID().toString().substring(0, 8));
        u.setUsername(username);
        u.setPasswordHash(passwordEncoder.encode(password));
        u.setDisplayName(displayName);
        u.setDepartment(dept);
        u.setPhone(phone);
        u.setRoles(roles);
        u.setAllowAllExperts(allowAllExperts);
        u.setMustChangePassword(false);   // 演示便捷；管理端新建用户则强制改密
        u.setEnabled(true);
        userRepository.save(u);
    }
}
