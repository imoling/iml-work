package com.imlwork.admin.controller;

import com.imlwork.admin.model.AgentTrace;
import com.imlwork.admin.model.DesensitizeAudit;
import com.imlwork.admin.repository.AgentTraceRepository;
import com.imlwork.admin.repository.DesensitizeAuditRepository;
import com.imlwork.admin.service.DesensitizeService;
import com.imlwork.admin.service.DesensitizeService.Hit;
import com.imlwork.admin.service.DesensitizeService.Mode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.*;

/**
 * Agent Trace 审计追溯。提交/检索/查看全链路执行轨迹，按角色 + 模式一键脱敏，
 * 并对每次脱敏/导出留痕。无权限系统时以"角色筛选"模拟分权查看。
 */
@RestController
@RequestMapping("/api/v1/traces")
public class AgentTraceController {

    private final AgentTraceRepository traceRepo;
    private final DesensitizeAuditRepository auditRepo;
    private final DesensitizeService desensitize;

    public AgentTraceController(AgentTraceRepository traceRepo, DesensitizeAuditRepository auditRepo, DesensitizeService desensitize) {
        this.traceRepo = traceRepo;
        this.auditRepo = auditRepo;
        this.desensitize = desensitize;
    }

    // 角色 → 实际脱敏模式（无权限系统时的条件筛选）。super 看原文；external 强脱敏。
    private Mode modeForRole(String role, Mode requested) {
        if (role == null) return requested;
        return switch (role) {
            case "super" -> null;                 // 超级管理员：原文（经审批）
            case "external" -> Mode.STRONG;        // 外部审计/导出：强脱敏
            default -> requested;                  // 普通管理员 / 安全审计员 / 系统管理员
        };
    }

    @PostMapping
    public ResponseEntity<AgentTrace> submit(@RequestBody AgentTrace t) {
        if (t.getId() == null || t.getId().isBlank()) t.setId("trace-" + UUID.randomUUID().toString().substring(0, 10));
        if (t.getCreatedAt() == null) t.setCreatedAt(LocalDateTime.now());
        return ResponseEntity.ok(traceRepo.save(t));
    }

    /** 列表（带筛选）。问题字段按标准脱敏后用于列表展示。 */
    @GetMapping
    public ResponseEntity<List<Map<String, Object>>> list(
            @RequestParam(required = false) String q,
            @RequestParam(required = false) String userId,
            @RequestParam(required = false) String model,
            @RequestParam(required = false) String risk,
            @RequestParam(required = false) Boolean web) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (AgentTrace t : traceRepo.findTop200ByOrderByCreatedAtDesc()) {
            if (userId != null && !userId.isBlank() && !userId.equalsIgnoreCase(t.getUserId())) continue;
            if (model != null && !model.isBlank() && (t.getModelName() == null || !t.getModelName().contains(model))) continue;
            if (risk != null && !risk.isBlank() && !risk.equalsIgnoreCase(t.getRiskLevel())) continue;
            if (web != null && web != t.isWebSearchUsed()) continue;
            if (q != null && !q.isBlank()) {
                String hay = (t.getUserQuestion() + " " + t.getUserNickname() + " " + t.getExpertName()).toLowerCase();
                if (!hay.contains(q.toLowerCase())) continue;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", t.getId());
            m.put("createdAt", t.getCreatedAt());
            m.put("userNickname", t.getUserNickname());
            m.put("deviceHost", t.getDeviceHost());
            m.put("expertName", t.getExpertName());
            m.put("modelName", t.getModelName());
            m.put("modelProvider", t.getModelProvider());
            m.put("question", desensitize.desensitize(t.getUserQuestion(), Mode.STANDARD).text());
            m.put("durationMs", t.getDurationMs());
            m.put("totalTokens", t.getPromptTokens() + t.getCompletionTokens());
            m.put("webSearchUsed", t.isWebSearchUsed());
            m.put("skillUsed", t.getSkillUsed());
            m.put("riskLevel", t.getRiskLevel());
            m.put("status", t.getStatus());
            m.put("sensitiveHit", t.isSensitiveHit());
            out.add(m);
        }
        return ResponseEntity.ok(out);
    }

    /** 详情：按角色 + 模式脱敏，返回全字段 + 命中规则报告。 */
    @GetMapping("/{id}")
    public ResponseEntity<Map<String, Object>> detail(
            @PathVariable String id,
            @RequestParam(defaultValue = "STANDARD") String mode,
            @RequestParam(defaultValue = "admin") String role) {
        return traceRepo.findById(id).map(t -> {
            Mode effective = modeForRole(role, desensitize.parseMode(mode));
            Map<String, Hit> hitAgg = new LinkedHashMap<>();
            Map<String, Object> m = new LinkedHashMap<>();
            // 不脱敏的元数据
            m.put("id", t.getId());
            m.put("createdAt", t.getCreatedAt());
            m.put("clientId", t.getClientId());
            m.put("deviceHost", t.getDeviceHost());
            m.put("appVersion", t.getAppVersion());
            m.put("clientIp", t.getClientIp());
            m.put("workspace", t.getWorkspace());
            m.put("userId", t.getUserId());
            m.put("userNickname", t.getUserNickname());
            m.put("expertId", t.getExpertId());
            m.put("expertName", t.getExpertName());
            m.put("department", t.getDepartment());
            m.put("role", t.getRole());
            m.put("sessionId", t.getSessionId());
            m.put("modelName", t.getModelName());
            m.put("modelProvider", t.getModelProvider());
            m.put("connectionMode", t.getConnectionMode());
            m.put("promptTokens", t.getPromptTokens());
            m.put("completionTokens", t.getCompletionTokens());
            m.put("durationMs", t.getDurationMs());
            m.put("webSearchUsed", t.isWebSearchUsed());
            m.put("skillUsed", t.getSkillUsed());
            m.put("knowledgeUsed", t.getKnowledgeUsed());
            m.put("riskLevel", t.getRiskLevel());
            m.put("status", t.getStatus());
            m.put("approvalTriggered", t.isApprovalTriggered());
            m.put("sensitiveHit", t.isSensitiveHit());
            // 脱敏的内容字段
            m.put("userQuestion", scrub(t.getUserQuestion(), effective, hitAgg));
            m.put("reasoningSummary", scrub(t.getReasoningSummary(), effective, hitAgg));
            m.put("finalAnswer", scrub(t.getFinalAnswer(), effective, hitAgg));
            m.put("spans", scrub(t.getSpans(), effective, hitAgg));
            m.put("sources", scrub(t.getSources(), effective, hitAgg));
            m.put("events", scrub(t.getEvents(), effective, hitAgg));
            m.put("mode", effective == null ? "RAW" : effective.name());
            m.put("role", role);
            // 安全审计员及以上可见命中原因
            boolean showReasons = !"admin".equals(role);
            m.put("hits", showReasons ? new ArrayList<>(hitAgg.values()) : List.of());
            m.put("hitTotal", hitAgg.values().stream().mapToInt(Hit::count).sum());
            return ResponseEntity.ok(m);
        }).orElse(ResponseEntity.notFound().build());
    }

    private String scrub(String text, Mode mode, Map<String, Hit> agg) {
        if (mode == null) return text; // RAW
        var r = desensitize.desensitize(text, mode);
        for (Hit h : r.hits()) {
            Hit prev = agg.get(h.rule());
            agg.put(h.rule(), new Hit(h.rule(), h.name(), h.level(), (prev == null ? 0 : prev.count()) + h.count()));
        }
        return r.text();
    }

    /** 记录一次脱敏/导出留痕。 */
    @PostMapping("/{id}/desensitize-audit")
    public ResponseEntity<DesensitizeAudit> recordAudit(@PathVariable String id, @RequestBody Map<String, Object> body) {
        DesensitizeAudit a = new DesensitizeAudit();
        a.setTraceId(id);
        a.setMode(String.valueOf(body.getOrDefault("mode", "STANDARD")));
        a.setRole(String.valueOf(body.getOrDefault("role", "admin")));
        a.setOperator(String.valueOf(body.getOrDefault("operator", "管理员")));
        a.setHitRules(String.valueOf(body.getOrDefault("hitRules", "")));
        a.setHitCount(body.get("hitCount") instanceof Number n ? n.intValue() : 0);
        boolean exported = Boolean.TRUE.equals(body.get("exported"));
        a.setExported(exported);
        if (exported) a.setExportNo("EXP-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase());
        return ResponseEntity.ok(auditRepo.save(a));
    }

    @GetMapping("/audits/recent")
    public ResponseEntity<List<DesensitizeAudit>> audits() {
        return ResponseEntity.ok(auditRepo.findTop100ByOrderByCreatedAtDesc());
    }
}
