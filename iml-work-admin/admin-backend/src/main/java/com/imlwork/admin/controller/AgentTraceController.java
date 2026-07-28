package com.imlwork.admin.controller;

import com.imlwork.admin.model.AgentTrace;
import com.imlwork.admin.model.DesensitizeAudit;
import com.imlwork.admin.security.JwtAuthFilter.AuthPrincipal;
import com.imlwork.admin.service.TraceService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * Agent Trace 审计追溯。仅做 HTTP 塑形；提交/反馈/脱敏投影/留痕在 {@link TraceService}。
 *
 * 脱敏档位（role）**由服务端按 JWT 定**：query 参数只能自愿降档（预览 external 视图），
 * 绝不能自提为 super 看原文——曾是任何登录员工可读全库原文的越权口（体检 P1-3）。
 */
@RestController
@RequestMapping("/api/v1/traces")
public class AgentTraceController {

    private final TraceService service;

    public AgentTraceController(TraceService service) {
        this.service = service;
    }

    /** 当前登录主体；未认证（理论上被 SecurityConfig 挡住）返回 null。 */
    private AuthPrincipal caller() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        return a != null && a.getPrincipal() instanceof AuthPrincipal p ? p : null;
    }

    /** 查看档位服务端定档：super 仅超管可用；非超管请求 super 一律封顶 admin；external 任何人可自愿降档。 */
    private String effectiveRole(String requested) {
        AuthPrincipal p = caller();
        boolean superAdmin = p != null && p.superAdmin();
        String r = requested == null || requested.isBlank() ? "admin" : requested;
        if ("super".equals(r) && !superAdmin) return "admin";
        return r;
    }

    @PostMapping
    public ResponseEntity<AgentTrace> submit(@RequestBody AgentTrace t) {
        AuthPrincipal p = caller();
        return ResponseEntity.ok(service.submit(t, p == null ? null : p.userId()));
    }

    @PostMapping("/feedback")
    public ResponseEntity<Map<String, Object>> feedback(@RequestBody Map<String, Object> body) {
        String traceId = body.get("traceId") == null ? "" : String.valueOf(body.get("traceId"));
        String userQuestion = body.get("userQuestion") == null ? "" : String.valueOf(body.get("userQuestion"));
        String fb = body.get("feedback") == null ? null : String.valueOf(body.get("feedback"));
        return ResponseEntity.ok(service.feedback(traceId, userQuestion, fb));
    }

    @GetMapping
    public ResponseEntity<List<Map<String, Object>>> list(
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String userId,
            @RequestParam(required = false) String model,
            @RequestParam(required = false) String risk,
            @RequestParam(required = false) Boolean web) {
        return ResponseEntity.ok(service.list(q, userId, model, risk, web));
    }

    @GetMapping("/{id}")
    public ResponseEntity<Map<String, Object>> detail(
            @PathVariable String id,
            @RequestParam(defaultValue = "STANDARD") String mode,
            @RequestParam(defaultValue = "admin") String role) {
        return ResponseEntity.ok(service.detail(id, mode, effectiveRole(role)));
    }

    /** 节点完整输入/输出批量上报（客户端 trace 提交成功后补报，独立表存储；仅限本人 trace）。 */
    @PostMapping("/{id}/payloads")
    public ResponseEntity<Map<String, Object>> savePayloads(@PathVariable String id, @RequestBody List<Map<String, Object>> items) {
        AuthPrincipal p = caller();
        return ResponseEntity.ok(Map.of("saved",
                service.savePayloads(id, items, p == null ? null : p.userId(), p != null && p.superAdmin())));
    }

    /** 按需单查某节点完整输入/输出（时间线点开查看；过与详情同款角色脱敏）。 */
    @GetMapping("/{id}/payload/{spanId}")
    public ResponseEntity<Map<String, Object>> payload(
            @PathVariable String id, @PathVariable String spanId,
            @RequestParam(defaultValue = "STANDARD") String mode,
            @RequestParam(defaultValue = "admin") String role) {
        return ResponseEntity.ok(service.payload(id, spanId, mode, effectiveRole(role)));
    }

    @PostMapping("/{id}/desensitize-audit")
    public ResponseEntity<DesensitizeAudit> recordAudit(@PathVariable String id, @RequestBody Map<String, Object> body) {
        AuthPrincipal p = caller();
        return ResponseEntity.ok(service.recordAudit(id, body,
                effectiveRole(String.valueOf(body.getOrDefault("role", "admin"))),
                p == null ? null : p.displayName()));
    }

    @GetMapping("/audits/recent")
    public ResponseEntity<List<DesensitizeAudit>> audits() {
        return ResponseEntity.ok(service.recentAudits());
    }
}
