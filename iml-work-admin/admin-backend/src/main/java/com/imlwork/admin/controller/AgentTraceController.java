package com.imlwork.admin.controller;

import com.imlwork.admin.model.AgentTrace;
import com.imlwork.admin.model.DesensitizeAudit;
import com.imlwork.admin.service.TraceService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * Agent Trace 审计追溯。仅做 HTTP 塑形；提交/反馈/脱敏投影/留痕在 {@link TraceService}。
 */
@RestController
@RequestMapping("/api/v1/traces")
public class AgentTraceController {

    private final TraceService service;

    public AgentTraceController(TraceService service) {
        this.service = service;
    }

    @PostMapping
    public ResponseEntity<AgentTrace> submit(@RequestBody AgentTrace t) {
        return ResponseEntity.ok(service.submit(t));
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
        return ResponseEntity.ok(service.detail(id, mode, role));
    }

    @PostMapping("/{id}/desensitize-audit")
    public ResponseEntity<DesensitizeAudit> recordAudit(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return ResponseEntity.ok(service.recordAudit(id, body));
    }

    @GetMapping("/audits/recent")
    public ResponseEntity<List<DesensitizeAudit>> audits() {
        return ResponseEntity.ok(service.recentAudits());
    }
}
