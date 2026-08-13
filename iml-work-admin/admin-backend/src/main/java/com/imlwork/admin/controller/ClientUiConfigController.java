package com.imlwork.admin.controller;

import com.imlwork.admin.model.ClientUiConfig;
import com.imlwork.admin.repository.ClientUiConfigRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.Map;

/**
 * 客户端 UI 配置（首页卡片语料等）。GET 任一登录用户（客户端拉取）；
 * PUT 管理端专用（ENTERPRISE_MANAGE，见 SecurityConfig）。value 为 JSON 文本，
 * 形状由两端约定（hero-cards = HeroSkill[]），后端只存取不解析。
 */
@RestController
@RequestMapping("/api/v1/client-config")
public class ClientUiConfigController {

    private final ClientUiConfigRepository repository;

    public ClientUiConfigController(ClientUiConfigRepository repository) {
        this.repository = repository;
    }

    // 8MB：卡片配置可含内嵌插图（data URI，管理端已压到 400×240，单张几十 KB）
    public record SaveReq(@NotBlank @Size(max = 8_000_000) String value) {}

    @GetMapping("/{key}")
    public ResponseEntity<?> get(@PathVariable String key) {
        return repository.findById(key)
                .<ResponseEntity<?>>map(c -> ResponseEntity.ok(Map.of(
                        "key", c.getId(),
                        "value", c.getValue() == null ? "" : c.getValue(),
                        "updatedAt", String.valueOf(c.getUpdatedAt()))))
                .orElseGet(() -> ResponseEntity.ok(Map.of("key", key, "value", "")));
    }

    @PutMapping("/{key}")
    @Transactional
    public ResponseEntity<?> save(@PathVariable String key, @Valid @RequestBody SaveReq req) {
        if (key.length() > 64) throw new IllegalArgumentException("配置键过长");
        ClientUiConfig c = repository.findById(key).orElseGet(() -> {
            ClientUiConfig n = new ClientUiConfig();
            n.setId(key);
            return n;
        });
        c.setValue(req.value());
        c.setUpdatedAt(LocalDateTime.now());
        repository.save(c);
        return ResponseEntity.ok(Map.of("ok", true));
    }
}
