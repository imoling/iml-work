package com.imlwork.admin.controller;

import com.imlwork.admin.model.AgentTrace;
import com.imlwork.admin.model.ModelProvider;
import com.imlwork.admin.repository.AgentTraceRepository;
import com.imlwork.admin.repository.ExpertRepository;
import com.imlwork.admin.repository.KnowledgeDocumentRepository;
import com.imlwork.admin.repository.ModelProviderRepository;
import com.imlwork.admin.repository.RetrievalAuditRepository;
import com.imlwork.admin.repository.SkillRepository;
import com.imlwork.admin.repository.SystemIntegrationRepository;
import com.imlwork.admin.service.GatewayMetrics;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;

/**
 * Aggregated operations dashboard: active agents, gateway call frequency, task
 * success rate, RAG hit-rate, relay-station channel health and per-provider
 * traffic distribution, plus the real per-day time series for the admin charts.
 */
@RestController
@RequestMapping("/api/v1/dashboard")
public class DashboardController {

    private final GatewayMetrics metrics;
    private final ExpertRepository expertRepository;
    private final SkillRepository skillRepository;
    private final KnowledgeDocumentRepository knowledgeRepository;
    private final SystemIntegrationRepository integrationRepository;
    private final RetrievalAuditRepository auditRepository;
    private final ModelProviderRepository providerRepository;
    private final AgentTraceRepository traceRepository;

    public DashboardController(GatewayMetrics metrics,
                               ExpertRepository expertRepository,
                               SkillRepository skillRepository,
                               KnowledgeDocumentRepository knowledgeRepository,
                               SystemIntegrationRepository integrationRepository,
                               RetrievalAuditRepository auditRepository,
                               ModelProviderRepository providerRepository,
                               AgentTraceRepository traceRepository) {
        this.metrics = metrics;
        this.expertRepository = expertRepository;
        this.skillRepository = skillRepository;
        this.knowledgeRepository = knowledgeRepository;
        this.integrationRepository = integrationRepository;
        this.auditRepository = auditRepository;
        this.providerRepository = providerRepository;
        this.traceRepository = traceRepository;
    }

    @GetMapping("/overview")
    public ResponseEntity<Map<String, Object>> overview() {
        long connectedIntegrations = integrationRepository.findAll().stream()
                .filter(i -> "CONNECTED".equals(i.getStatus()))
                .count();

        long totalRetrievals = auditRepository.count();
        long hits = auditRepository.countByHit(true);
        double hitRate = totalRetrievals == 0 ? 0.0 : hits / (double) totalRetrievals;

        // Relay-station channel health + weighted average latency across providers.
        List<ModelProvider> providers = providerRepository.findAll();
        long totalChannels = providers.size();
        long healthyChannels = providers.stream().filter(p -> "HEALTHY".equals(p.getStatus())).count();
        long enabledChannels = providers.stream().filter(ModelProvider::isEnabled).count();
        long latencyReqWeight = providers.stream().mapToLong(ModelProvider::getTotalRequests).sum();
        long weightedLatency = providers.stream()
                .mapToLong(p -> p.getAvgLatencyMs() * Math.max(0, p.getTotalRequests())).sum();
        long avgChannelLatency = latencyReqWeight == 0 ? 0 : weightedLatency / latencyReqWeight;

        Map<String, Object> overview = new LinkedHashMap<>();
        overview.put("activeAgents", expertRepository.count());
        overview.put("skillCount", skillRepository.count());
        overview.put("knowledgeDocCount", knowledgeRepository.count());
        overview.put("connectedIntegrations", connectedIntegrations);
        overview.put("totalRequests", metrics.getTotalRequests());
        overview.put("totalTokens", metrics.getTotalPromptTokens() + metrics.getTotalCompletionTokens());
        overview.put("successRate", round(metrics.getSuccessRate()));
        overview.put("ragHitRate", round(hitRate));
        overview.put("ragRetrievals", totalRetrievals);
        overview.put("ragAvgLatencyMs", round(auditRepository.averageLatency()));
        // Relay station
        overview.put("gatewayChannels", totalChannels);
        overview.put("gatewayHealthyChannels", healthyChannels);
        overview.put("gatewayEnabledChannels", enabledChannels);
        overview.put("gatewayAvgLatencyMs", avgChannelLatency);
        return ResponseEntity.ok(overview);
    }

    /** Real 7-day time series + relay-station provider traffic distribution. */
    @GetMapping("/timeseries")
    public ResponseEntity<Map<String, Object>> timeseries() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("points", metrics.getDailySeries(7));
        result.put("providers", providerDistribution());
        return ResponseEntity.ok(result);
    }

    /** Per-provider share of total served requests, busiest first. */
    private List<Map<String, Object>> providerDistribution() {
        List<ModelProvider> providers = providerRepository.findAll();
        long grand = providers.stream().mapToLong(ModelProvider::getTotalRequests).sum();
        List<Map<String, Object>> rows = new ArrayList<>();
        providers.stream()
                .sorted(Comparator.comparingLong(ModelProvider::getTotalRequests).reversed())
                .forEach(p -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("id", p.getId());
                    row.put("name", p.getName());
                    row.put("provider", p.getProvider());
                    row.put("requests", p.getTotalRequests());
                    row.put("failed", p.getFailedRequests());
                    row.put("avgLatencyMs", p.getAvgLatencyMs());
                    row.put("status", p.getStatus());
                    row.put("share", grand == 0 ? 0.0 : round(p.getTotalRequests() / (double) grand));
                    rows.add(row);
                });
        return rows;
    }

    /**
     * 运行总览：业务任务维度的真实聚合，全部来自 AgentTrace（一条 trace = 一次业务任务）。
     * days 时间范围作用于核心指标 / 趋势 / 热门岗位技能 / 失败原因 / 待处理事项；资产/网关为当前实时态。
     * 无对应数据来源的指标（如执行漏斗、P95、费用）由前端显示“暂无数据/数据采集中”，后端不臆造。
     */
    @GetMapping("/operations")
    public ResponseEntity<Map<String, Object>> operations(@RequestParam(defaultValue = "7") int days) {
        int d = Math.max(1, Math.min(days, 180));
        LocalDateTime now = LocalDateTime.now();
        LocalDateTime from = now.minusDays(d);
        LocalDateTime prevFrom = from.minusDays(d);
        // 只取窗口内（prevFrom 之后）的 trace，避免随累积把全表拉进内存；cur/prev 均落在此窗口内。
        List<AgentTrace> recent = traceRepository.findByCreatedAtAfter(prevFrom);
        List<AgentTrace> cur = recent.stream().filter(t -> t.getCreatedAt() != null && t.getCreatedAt().isAfter(from)).collect(Collectors.toList());
        List<AgentTrace> prev = recent.stream().filter(t -> t.getCreatedAt() != null && t.getCreatedAt().isAfter(prevFrom) && !t.getCreatedAt().isAfter(from)).collect(Collectors.toList());

        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> period = new LinkedHashMap<>();
        period.put("days", d);
        period.put("from", from.toString());
        period.put("to", now.toString());
        out.put("period", period);
        out.put("hasTaskData", traceRepository.count() > 0);

        out.put("core", coreMetrics(cur));
        out.put("prevCore", coreMetrics(prev));
        out.put("trend", dailyTrend(cur, d, now));
        out.put("hotExperts", hotExperts(cur));
        out.put("hotSkills", hotSkills(cur));
        out.put("failureBreakdown", failureBreakdown(cur));
        out.put("exceptions", exceptions(cur));
        out.put("assets", assets(cur));
        out.put("resource", resource(cur));
        return ResponseEntity.ok(out);
    }

    private Map<String, Object> pct(long num, long den) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("value", den == 0 ? 0.0 : round(num / (double) den));
        m.put("num", num);
        m.put("den", den);
        return m;
    }

    /** 核心指标：任务总量/有效完成/活跃用户/端到端成功率/自动完成率/待处理异常（均带样本量）。 */
    private Map<String, Object> coreMetrics(List<AgentTrace> list) {
        long total = list.size();
        long done = list.stream().filter(t -> "SUCCESS".equals(t.getStatus())).count();
        long activeUsers = list.stream().map(AgentTrace::getUserId).filter(u -> u != null && !u.isBlank()).distinct().count();
        long auto = list.stream().filter(t -> "SUCCESS".equals(t.getStatus()) && !t.isApprovalTriggered()).count();
        long pending = list.stream().filter(t -> "FAILED".equals(t.getStatus()) || "BLOCKED".equals(t.getStatus())).count();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("taskTotal", total);
        m.put("effectiveDone", done);
        m.put("activeUsers", activeUsers);
        m.put("e2eSuccess", pct(done, total));        // 有效完成÷任务总量
        m.put("autoComplete", pct(auto, done));        // 无需人工接管完成÷有效完成
        m.put("pendingExceptions", pending);           // 失败+拦截任务数（口径：当前周期内）
        return m;
    }

    /** 每日任务量 + 成功率趋势（柱=总量，线=成功率），从 trace.createdAt 真实分组。 */
    private List<Map<String, Object>> dailyTrend(List<AgentTrace> list, int days, LocalDateTime now) {
        DateTimeFormatter f = DateTimeFormatter.ofPattern("MM-dd");
        List<Map<String, Object>> rows = new ArrayList<>();
        for (int i = days - 1; i >= 0; i--) {
            LocalDate day = now.toLocalDate().minusDays(i);
            List<AgentTrace> dl = list.stream().filter(t -> t.getCreatedAt() != null && t.getCreatedAt().toLocalDate().equals(day)).collect(Collectors.toList());
            long tot = dl.size();
            long suc = dl.stream().filter(t -> "SUCCESS".equals(t.getStatus())).count();
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("date", day.format(f));
            r.put("total", tot);
            r.put("success", suc);
            r.put("failed", tot - suc);
            r.put("successRate", tot == 0 ? 0.0 : round(suc / (double) tot));
            rows.add(r);
        }
        return rows;
    }

    /** 热门岗位：按 expertId 聚合 —— 任务数/去重用户/成功率/平均耗时。 */
    private List<Map<String, Object>> hotExperts(List<AgentTrace> list) {
        Map<String, List<AgentTrace>> g = list.stream()
                .filter(t -> t.getExpertId() != null && !t.getExpertId().isBlank())
                .collect(Collectors.groupingBy(AgentTrace::getExpertId));
        List<Map<String, Object>> rows = new ArrayList<>();
        g.forEach((id, ts) -> {
            long tasks = ts.size();
            long suc = ts.stream().filter(t -> "SUCCESS".equals(t.getStatus())).count();
            long users = ts.stream().map(AgentTrace::getUserId).filter(u -> u != null && !u.isBlank()).distinct().count();
            long avgMs = (long) ts.stream().mapToLong(AgentTrace::getDurationMs).average().orElse(0);
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("expertId", id);
            r.put("name", ts.get(0).getExpertName() == null ? id : ts.get(0).getExpertName());
            r.put("users", users);
            r.put("tasks", tasks);
            r.put("successRate", pct(suc, tasks));
            r.put("avgMs", avgMs);
            rows.add(r);
        });
        rows.sort(Comparator.comparingLong(r -> -((Number) r.get("tasks")).longValue()));
        return rows.size() > 8 ? rows.subList(0, 8) : rows;
    }

    /** 热门技能：按 skillUsed 聚合 —— 调用次数/成功率/人工确认率/最近使用。skillUsed 可能是技能 ID 或名称，统一解析出「名称 + 编号」。 */
    private List<Map<String, Object>> hotSkills(List<AgentTrace> list) {
        // 技能 ID/名称 → 名称 映射，便于把 trace 里的 skillUsed 解析成可读名称
        Map<String, String> idToName = new LinkedHashMap<>();
        Map<String, String> nameToId = new LinkedHashMap<>();
        skillRepository.findAll().forEach(s -> { if (s.getId() != null) idToName.put(s.getId(), s.getName()); if (s.getName() != null) nameToId.put(s.getName(), s.getId()); });
        Map<String, List<AgentTrace>> g = list.stream()
                .filter(t -> t.getSkillUsed() != null && !t.getSkillUsed().isBlank())
                .collect(Collectors.groupingBy(AgentTrace::getSkillUsed));
        List<Map<String, Object>> rows = new ArrayList<>();
        g.forEach((skill, ts) -> {
            long calls = ts.size();
            long suc = ts.stream().filter(t -> "SUCCESS".equals(t.getStatus())).count();
            long appr = ts.stream().filter(AgentTrace::isApprovalTriggered).count();
            LocalDateTime last = ts.stream().map(AgentTrace::getCreatedAt).filter(java.util.Objects::nonNull).max(LocalDateTime::compareTo).orElse(null);
            // 解析名称与编号：skillUsed 命中 ID → 取其名称；命中名称 → 取其 ID
            String id = idToName.containsKey(skill) ? skill : nameToId.getOrDefault(skill, "");
            String name = idToName.containsKey(skill) ? idToName.get(skill) : skill;
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("skill", skill);
            r.put("name", name == null || name.isBlank() ? skill : name);
            r.put("id", id);
            r.put("calls", calls);
            r.put("successRate", pct(suc, calls));
            r.put("approvalRate", pct(appr, calls));
            r.put("lastUsed", last == null ? "" : last.toString());
            rows.add(r);
        });
        rows.sort(Comparator.comparingLong(r -> -((Number) r.get("calls")).longValue()));
        return rows.size() > 8 ? rows.subList(0, 8) : rows;
    }

    /** 失败原因分布：trace 仅记录 status（无细分原因字段），按状态给出可信的粗分类。 */
    private Map<String, Object> failureBreakdown(List<AgentTrace> list) {
        long failed = list.stream().filter(t -> "FAILED".equals(t.getStatus())).count();
        long blocked = list.stream().filter(t -> "BLOCKED".equals(t.getStatus())).count();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("failed", failed);     // 任务执行失败
        m.put("blocked", blocked);   // 安全拦截/高危授权未通过
        m.put("detailAvailable", false);  // 细分原因（模型/路由/知识/连接…）暂无结构化字段
        return m;
    }

    /** 待处理事项：失败/拦截任务 + 通道异常 + 业务系统失联（均来自真实记录）。 */
    private List<Map<String, Object>> exceptions(List<AgentTrace> list) {
        List<Map<String, Object>> rows = new ArrayList<>();
        list.stream().filter(t -> "FAILED".equals(t.getStatus()) || "BLOCKED".equals(t.getStatus()))
                .sorted(Comparator.comparing(AgentTrace::getCreatedAt, Comparator.nullsLast(Comparator.reverseOrder())))
                .limit(12)
                .forEach(t -> {
                    boolean blocked = "BLOCKED".equals(t.getStatus());
                    Map<String, Object> r = new LinkedHashMap<>();
                    r.put("type", blocked ? (t.isApprovalTriggered() ? "高风险操作待确认" : "权限校验/安全拦截") : "任务执行失败");
                    r.put("severity", blocked ? "warn" : "error");
                    r.put("desc", t.getUserQuestion() == null ? "" : (t.getUserQuestion().length() > 60 ? t.getUserQuestion().substring(0, 60) + "…" : t.getUserQuestion()));
                    r.put("time", t.getCreatedAt() == null ? "" : t.getCreatedAt().toString());
                    r.put("target", (t.getExpertName() == null ? "" : t.getExpertName()) + (t.getUserNickname() == null ? "" : " · " + t.getUserNickname()));
                    r.put("traceId", t.getId());
                    rows.add(r);
                });
        // 模型通道异常（实时）
        providerRepository.findAll().stream().filter(p -> "DOWN".equals(p.getStatus())).forEach(p -> {
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("type", "模型通道异常"); r.put("severity", "error");
            r.put("desc", "通道 " + p.getName() + "（" + p.getProvider() + "）健康探测为 DOWN");
            r.put("time", ""); r.put("target", p.getName()); r.put("link", "gateway");
            rows.add(r);
        });
        // 业务系统失联（实时）
        integrationRepository.findAll().stream().filter(i -> !"CONNECTED".equals(i.getStatus())).forEach(i -> {
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("type", "业务系统登录失效"); r.put("severity", "warn");
            r.put("desc", i.getName() + " 当前状态：" + i.getStatus());
            r.put("time", ""); r.put("target", i.getName()); r.put("link", "integrations");
            rows.add(r);
        });
        return rows;
    }

    /** 能力资产状态：健康/总数 + 活跃（岗位活跃=周期内有任务的去重岗位）。 */
    private Map<String, Object> assets(List<AgentTrace> cur) {
        Set<String> activeExperts = cur.stream().map(AgentTrace::getExpertId).filter(e -> e != null && !e.isBlank()).collect(Collectors.toCollection(TreeSet::new));
        long skillTotal = skillRepository.count();
        long skillPublished = skillRepository.findAll().stream().filter(s -> "PUBLISHED".equals(s.getStatus() == null ? "PUBLISHED" : s.getStatus())).count();
        long intgTotal = integrationRepository.count();
        // 业务系统资产口径：实时「探测可达」（HTTP 探测系统地址是否有响应），而非登记的验证状态
        long intgOk = integrationRepository.findAll().stream().filter(i -> isReachable(i.getBaseUrl())).count();
        long chTotal = providerRepository.count();
        long chOk = providerRepository.findAll().stream().filter(p -> "HEALTHY".equals(p.getStatus())).count();
        long kbTotal = knowledgeRepository.count();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("experts", asset(activeExperts.size(), expertRepository.count(), "experts"));
        m.put("skills", asset(skillPublished, skillTotal, "skills"));
        m.put("knowledge", asset(kbTotal, kbTotal, "knowledge"));   // 无文档状态字段 → 正常=总数
        m.put("integrations", asset(intgOk, intgTotal, "integrations"));
        m.put("channels", asset(chOk, chTotal, "gateway"));
        return m;   // 沙箱节点无后端聚合来源 → 前端显示“暂无数据”
    }

    private Map<String, Object> asset(long ok, long total, String link) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", ok); m.put("total", total); m.put("abnormal", Math.max(0, total - ok)); m.put("link", link);
        return m;
    }

    /** 模型与资源消耗：网关总量/通道分布为实时；单任务平均 Token 与 Token 日趋势来自周期内 trace。 */
    private Map<String, Object> resource(List<AgentTrace> cur) {
        long taskTokens = cur.stream().mapToLong(t -> t.getPromptTokens() + t.getCompletionTokens()).sum();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("gatewayRequests", metrics.getTotalRequests());
        m.put("gatewayTokens", metrics.getTotalPromptTokens() + metrics.getTotalCompletionTokens());
        m.put("taskTokens", taskTokens);
        m.put("perTaskTokens", cur.isEmpty() ? 0 : taskTokens / cur.size());
        m.put("providers", providerDistribution());
        m.put("p95Available", false);   // GatewayMetrics 仅有加权均值，暂无 P95
        return m;
    }

    // 探测结果缓存：url → [可达(0/1), 探测时刻ms]。避免每次刷新都重探导致状态来回跳（“打地鼠”）。
    private final java.util.Map<String, long[]> reachCache = new java.util.concurrent.ConcurrentHashMap<>();
    private static final long REACH_TTL_MS = 180_000;   // 3 分钟内复用缓存

    /** 探测业务系统地址是否可达：结果缓存 3 分钟；HTTP HEAD（失败回退 GET），有任何响应码即视为可达。 */
    private boolean isReachable(String rawUrl) {
        String url = com.imlwork.admin.service.SystemIntegrationService.sanitizeUrl(rawUrl);   // 去空格/去 #hash 片段/补协议
        if (url.isEmpty()) return false;
        long now = System.currentTimeMillis();
        long[] cached = reachCache.get(url);
        if (cached != null && now - cached[1] < REACH_TTL_MS) return cached[0] == 1;
        boolean ok = false;
        for (String method : new String[]{"HEAD", "GET"}) {
            try {
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) java.net.URI.create(url).toURL().openConnection();
                conn.setConnectTimeout(2500);
                conn.setReadTimeout(2500);
                conn.setRequestMethod(method);
                conn.setInstanceFollowRedirects(true);
                int code = conn.getResponseCode();
                conn.disconnect();
                if (code > 0) { ok = true; break; }   // 有任何 HTTP 响应即视为可达
            } catch (Exception ignored) { /* 换方法重试 / 视为不可达 */ }
        }
        reachCache.put(url, new long[]{ ok ? 1 : 0, now });
        return ok;
    }

    private double round(double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }
}
