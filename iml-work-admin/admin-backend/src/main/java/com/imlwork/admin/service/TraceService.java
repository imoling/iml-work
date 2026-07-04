package com.imlwork.admin.service;

import com.imlwork.admin.model.AgentTrace;
import com.imlwork.admin.model.DesensitizeAudit;
import com.imlwork.admin.repository.AgentTraceRepository;
import com.imlwork.admin.repository.DesensitizeAuditRepository;
import com.imlwork.admin.service.DesensitizeService.Hit;
import com.imlwork.admin.service.DesensitizeService.Mode;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.*;

/**
 * Agent Trace 审计追溯领域服务：提交/反馈（写）+ 列表/详情按角色脱敏投影（读）+ 脱敏留痕。
 * 脱敏委托 {@link DesensitizeService}。
 */
@Service
public class TraceService {

    private final AgentTraceRepository traceRepo;
    private final DesensitizeAuditRepository auditRepo;
    private final DesensitizeService desensitize;

    public TraceService(AgentTraceRepository traceRepo, DesensitizeAuditRepository auditRepo, DesensitizeService desensitize) {
        this.traceRepo = traceRepo;
        this.auditRepo = auditRepo;
        this.desensitize = desensitize;
    }

    @Transactional
    public AgentTrace submit(AgentTrace t) {
        if (t.getId() == null || t.getId().isBlank()) t.setId("trace-" + UUID.randomUUID().toString().substring(0, 10));
        if (t.getCreatedAt() == null) t.setCreatedAt(LocalDateTime.now());
        return traceRepo.save(t);
    }

    /** 质量反馈：优先按 traceId 精确回填，否则按问题文本回填最近一条（UP/DOWN/null）。 */
    @Transactional
    public Map<String, Object> feedback(String traceId, String userQuestion, String fb) {
        AgentTrace t = null;
        if (traceId != null && !traceId.isBlank() && !"null".equals(traceId)) t = traceRepo.findById(traceId).orElse(null);
        if (t == null && userQuestion != null && !userQuestion.isBlank())
            t = traceRepo.findFirstByUserQuestionOrderByCreatedAtDesc(userQuestion);
        if (t == null) return Map.of("success", false, "error", "未找到对应 Trace");
        t.setFeedback(fb != null && (fb.equals("UP") || fb.equals("DOWN")) ? fb : null);
        traceRepo.save(t);
        return Map.of("success", true, "id", t.getId(), "feedback", String.valueOf(t.getFeedback()));
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> list(String q, String userId, String model, String risk, Boolean web) {
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
        m.put("sandboxUsed", t.isSandboxUsed());
            m.put("sandboxUsed", t.isSandboxUsed());
            m.put("skillUsed", t.getSkillUsed());
            m.put("riskLevel", t.getRiskLevel());
            m.put("status", t.getStatus());
            m.put("sensitiveHit", t.isSensitiveHit());
            m.put("feedback", t.getFeedback());
            out.add(m);
        }
        return out;
    }

    @Transactional(readOnly = true)
    public Map<String, Object> detail(String id, String mode, String role) {
        AgentTrace t = traceRepo.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Trace 不存在"));
        Mode effective = modeForRole(role, desensitize.parseMode(mode));
        Map<String, Hit> hitAgg = new LinkedHashMap<>();
        Map<String, Object> m = new LinkedHashMap<>();
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
        m.put("userQuestion", scrub(t.getUserQuestion(), effective, hitAgg));
        m.put("reasoningSummary", scrub(t.getReasoningSummary(), effective, hitAgg));
        m.put("finalAnswer", scrub(t.getFinalAnswer(), effective, hitAgg));
        m.put("spans", scrub(t.getSpans(), effective, hitAgg));
        m.put("sources", scrub(t.getSources(), effective, hitAgg));
        m.put("events", scrub(t.getEvents(), effective, hitAgg));
        m.put("mode", effective == null ? "RAW" : effective.name());
        m.put("role", role);
        boolean showReasons = !"admin".equals(role);
        m.put("hits", showReasons ? new ArrayList<>(hitAgg.values()) : List.of());
        m.put("hitTotal", hitAgg.values().stream().mapToInt(Hit::count).sum());
        return m;
    }

    @Transactional
    public DesensitizeAudit recordAudit(String id, Map<String, Object> body) {
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
        return auditRepo.save(a);
    }

    @Transactional(readOnly = true)
    public List<DesensitizeAudit> recentAudits() {
        return auditRepo.findTop100ByOrderByCreatedAtDesc();
    }

    // 角色 → 实际脱敏模式。super 看原文；external 强脱敏。
    private Mode modeForRole(String role, Mode requested) {
        if (role == null) return requested;
        return switch (role) {
            case "super" -> null;
            case "external" -> Mode.STRONG;
            default -> requested;
        };
    }

    private String scrub(String text, Mode mode, Map<String, Hit> agg) {
        if (mode == null) return text;
        var r = desensitize.desensitize(text, mode);
        for (Hit h : r.hits()) {
            Hit prev = agg.get(h.rule());
            agg.put(h.rule(), new Hit(h.rule(), h.name(), h.level(), (prev == null ? 0 : prev.count()) + h.count()));
        }
        return r.text();
    }
}
