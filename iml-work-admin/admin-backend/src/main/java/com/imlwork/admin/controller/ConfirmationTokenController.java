package com.imlwork.admin.controller;

import com.imlwork.admin.model.ConfirmationToken;
import com.imlwork.admin.service.ConfirmationTokenService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 策略与确认服务（文档 §12.6）：签发 / 校验 / 消费一次性签名确认令牌。
 * 仅做 HTTP 塑形；签名与业务在 {@link ConfirmationTokenService}。只接收表单摘要，不接收明文业务字段。
 */
@RestController
@RequestMapping("/api/v1/confirmations")
public class ConfirmationTokenController {

    private final ConfirmationTokenService service;

    public ConfirmationTokenController(ConfirmationTokenService service) {
        this.service = service;
    }

    @PostMapping
    public ConfirmationToken issue(@RequestBody Map<String, Object> body) {
        return service.issue(body);
    }

    @PostMapping("/{id}/consume")
    public ResponseEntity<Map<String, Object>> consume(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return ResponseEntity.ok(service.consume(id, body));
    }

    @GetMapping("/{id}")
    public ResponseEntity<ConfirmationToken> get(@PathVariable String id) {
        ConfirmationToken t = service.get(id);
        return t == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(t);
    }
}
