package com.imlwork.admin.controller;

import com.imlwork.admin.model.Role;
import com.imlwork.admin.security.Permissions;
import com.imlwork.admin.service.RoleService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 角色与权限点管理（需 USER_MANAGE）。仅做 HTTP 塑形；业务与事务在 {@link RoleService}。 */
@RestController
@RequestMapping("/api/v1/roles")
public class RoleController {

    private final RoleService roleService;

    public RoleController(RoleService roleService) {
        this.roleService = roleService;
    }

    @GetMapping
    public ResponseEntity<List<Role>> list() {
        return ResponseEntity.ok(roleService.list());
    }

    /** 全部权限点目录（前端渲染角色权限勾选）。静态目录，无需入 Service。 */
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
        return ResponseEntity.ok(Map.of("success", true, "role", roleService.create(body)));
    }

    @PutMapping("/{name}")
    public ResponseEntity<Map<String, Object>> update(@PathVariable String name, @RequestBody Role body) {
        return ResponseEntity.ok(Map.of("success", true, "role", roleService.update(name, body)));
    }

    @DeleteMapping("/{name}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String name) {
        roleService.delete(name);
        return ResponseEntity.ok(Map.of("success", true));
    }
}
