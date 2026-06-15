package com.imlwork.admin.controller;

import com.imlwork.admin.model.EnterpriseProfile;
import com.imlwork.admin.repository.EnterpriseProfileRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;

/**
 * 企业基础信息维护。客户端在构建分身系统指令时拉取这里的企业信息与规则，
 * 不再在客户端写死公司名称、税号、报销规定等。
 */
@RestController
@RequestMapping("/api/v1/enterprise")
public class EnterpriseController {

    private static final String ID = "default";
    private final EnterpriseProfileRepository repository;

    public EnterpriseController(EnterpriseProfileRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public ResponseEntity<EnterpriseProfile> get() {
        return ResponseEntity.ok(repository.findById(ID).orElseGet(() -> {
            EnterpriseProfile p = new EnterpriseProfile();
            p.setId(ID);
            return repository.save(p);
        }));
    }

    @PutMapping
    public ResponseEntity<EnterpriseProfile> update(@RequestBody EnterpriseProfile update) {
        EnterpriseProfile p = repository.findById(ID).orElseGet(() -> {
            EnterpriseProfile np = new EnterpriseProfile();
            np.setId(ID);
            return np;
        });
        p.setCompanyName(update.getCompanyName());
        p.setTaxId(update.getTaxId());
        p.setAddress(update.getAddress());
        p.setRules(update.getRules());
        p.setUpdatedAt(LocalDateTime.now());
        return ResponseEntity.ok(repository.save(p));
    }
}
