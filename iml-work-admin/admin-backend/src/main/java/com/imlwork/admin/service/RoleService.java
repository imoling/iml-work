package com.imlwork.admin.service;

import com.imlwork.admin.dto.RoleRequests;
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
    public Role create(RoleRequests.Create body) {
        if (body.name() == null || body.name().isBlank()) throw new IllegalArgumentException("角色名不能为空");
        if (roleRepository.existsById(body.name())) throw new IllegalArgumentException("角色已存在");
        Role r = new Role();
        r.setName(body.name());
        r.setLabel(body.label());
        if (body.permissions() != null) r.setPermissions(new java.util.ArrayList<>(body.permissions()));
        r.setBuiltin(false);
        return roleRepository.save(r);
    }

    @Transactional
    public Role update(String name, RoleRequests.Update body) {
        Role r = roleRepository.findById(name).orElseThrow(() -> notFound("角色不存在"));
        if (body.label() != null) r.setLabel(body.label());
        if (body.permissions() != null) r.setPermissions(new java.util.ArrayList<>(body.permissions()));
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
