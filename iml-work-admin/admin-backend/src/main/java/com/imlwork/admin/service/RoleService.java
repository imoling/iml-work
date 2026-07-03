package com.imlwork.admin.service;

import com.imlwork.admin.model.Role;
import com.imlwork.admin.repository.RoleRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

/** 角色领域服务：校验 + 事务写；Controller 只做 HTTP 塑形。 */
@Service
public class RoleService {

    private final RoleRepository roleRepository;

    public RoleService(RoleRepository roleRepository) {
        this.roleRepository = roleRepository;
    }

    @Transactional(readOnly = true)
    public List<Role> list() {
        return roleRepository.findAll();
    }

    @Transactional
    public Role create(Role body) {
        if (body.getName() == null || body.getName().isBlank()) throw new IllegalArgumentException("角色名不能为空");
        if (roleRepository.existsById(body.getName())) throw new IllegalArgumentException("角色已存在");
        body.setBuiltin(false);
        return roleRepository.save(body);
    }

    @Transactional
    public Role update(String name, Role body) {
        Role r = roleRepository.findById(name).orElseThrow(() -> notFound("角色不存在"));
        if (body.getLabel() != null) r.setLabel(body.getLabel());
        if (body.getPermissions() != null) r.setPermissions(body.getPermissions());
        return roleRepository.save(r);
    }

    @Transactional
    public void delete(String name) {
        Role r = roleRepository.findById(name).orElseThrow(() -> notFound("角色不存在"));
        if (r.isBuiltin()) throw new IllegalArgumentException("内置角色不可删除");
        roleRepository.deleteById(name);
    }

    private static ResponseStatusException notFound(String msg) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, msg);
    }
}
