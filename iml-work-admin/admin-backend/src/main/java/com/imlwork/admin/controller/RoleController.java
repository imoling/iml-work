package com.imlwork.admin.controller;

import com.imlwork.admin.model.Role;
import com.imlwork.admin.repository.RoleRepository;
import com.imlwork.admin.security.Permissions;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 角色与权限点管理（需 USER_MANAGE，见 SecurityConfig）。 */
@RestController
@RequestMapping("/api/v1/roles")
public class RoleController {

    private final RoleRepository roleRepository;

    public RoleController(RoleRepository roleRepository) {
        this.roleRepository = roleRepository;
    }

    @GetMapping
    public ResponseEntity<List<Role>> list() {
        return ResponseEntity.ok(roleRepository.findAll());
    }

    /** 全部权限点目录（前端渲染角色权限勾选）。 */
    @GetMapping("/permissions")
    public ResponseEntity<List<Map<String, String>>> permissionCatalog() {
        List<Map<String, String>> out = Permissions.ALL_POINTS.stream().map(p -> {
            Map<String, String> m = new LinkedHashMap<>();
            m.put("key", p);
            m.put("label", Permissions.LABELS.getOrDefault(p, p));
            return m;
        }).toList();
        return ResponseEntity.ok(out);
    }

    @PostMapping
    public ResponseEntity<Map<String, Object>> create(@RequestBody Role body) {
        if (body.getName() == null || body.getName().isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("success", false, "error", "角色名不能为空"));
        }
        if (roleRepository.existsById(body.getName())) {
            return ResponseEntity.badRequest().body(Map.of("success", false, "error", "角色已存在"));
        }
        body.setBuiltin(false);
        roleRepository.save(body);
        return ResponseEntity.ok(Map.of("success", true, "role", body));
    }

    @PutMapping("/{name}")
    public ResponseEntity<Map<String, Object>> update(@PathVariable String name, @RequestBody Role body) {
        Role r = roleRepository.findById(name).orElse(null);
        if (r == null) return ResponseEntity.notFound().build();
        if (body.getLabel() != null) r.setLabel(body.getLabel());
        if (body.getPermissions() != null) r.setPermissions(body.getPermissions());
        roleRepository.save(r);
        return ResponseEntity.ok(Map.of("success", true, "role", r));
    }

    @DeleteMapping("/{name}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String name) {
        Role r = roleRepository.findById(name).orElse(null);
        if (r == null) return ResponseEntity.notFound().build();
        if (r.isBuiltin()) {
            return ResponseEntity.badRequest().body(Map.of("success", false, "error", "内置角色不可删除"));
        }
        roleRepository.deleteById(name);
        return ResponseEntity.ok(Map.of("success", true));
    }
}
