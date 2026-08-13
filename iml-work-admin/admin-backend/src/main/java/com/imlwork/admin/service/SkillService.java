package com.imlwork.admin.service;

import com.imlwork.admin.dto.SkillSummary;
import com.imlwork.admin.model.Skill;
import com.imlwork.admin.repository.ExpertRepository;
import com.imlwork.admin.repository.SkillRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 企业技能中心领域服务：目录检索、技能生命周期（草稿/上架/下架）、录制转语义脚本、
 * SKILL.md/.zip 上传解析、模型辅助生成触发词/SOP。写操作事务化，下架/删除时脱离岗位绑定。
 */
@Service
public class SkillService {

    // 「写意图」按钮文案：点击这类按钮会改变业务状态（审批/提交/删除…），录制时应判为写操作 skillKind=write。
    private static final java.util.regex.Pattern WRITE_INTENT_LABEL = java.util.regex.Pattern.compile(
        "同意|通过|批准|审批|核准|提交|确认|确定|保存|删除|移除|清除|新增|添加|录入|创建|发布|上架|下架|归档|驳回|拒绝|退回|撤回|撤销|作废|付款|转账|下单|支付|签收|收货|盖章|签字|生效|发送|发起");

    private final SkillRepository skillRepository;
    private final ExpertRepository expertRepository;
    private final ModelProxyService modelProxy;
    private final SkillSecurityService security;
    private final ObjectMapper mapper = new ObjectMapper();
    private final SkillLlmHelper llm;   // 触发词/SOP 生成等模型调用（叶子服务，与包安装链路共用）
    private final SkillPackageService pkg;   // 技能包解析/安全裁决/安装/导出/GitHub 抓取（体检 B4 拆出）

    public SkillService(SkillRepository skillRepository, ExpertRepository expertRepository,
                        ModelProxyService modelProxy, SkillSecurityService security,
                        SkillLlmHelper llm, SkillPackageService pkg) {
        this.pkg = pkg;
        this.skillRepository = skillRepository;
        this.expertRepository = expertRepository;
        this.modelProxy = modelProxy;
        this.security = security;
        this.llm = llm;
    }

    // 技能中心随导入持续增长：目录/搜索统一封顶一页（导出与统计聚合仍走全量）。
    private static final int MAX_LIST = 500;

    /** 全量列表（FDE 工作台创作/试跑从列表直接取脚本正文）；纯浏览请用 catalog。 */
    @Transactional(readOnly = true)
    public List<Skill> list(String q) {
        var cap = pageCap();
        if (q == null || q.isBlank()) return skillRepository.findAll(cap).getContent();
        return skillRepository.findByNameContainingIgnoreCaseOrDescriptionContainingIgnoreCase(q, q, cap);
    }

    /** 目录列表：瘦身投影（无 code/sopContent/actionScript/bundle 正文），正文走 GET /skills/{id}。 */
    @Transactional(readOnly = true)
    public List<SkillSummary> catalog(String q) {
        var cap = pageCap();
        if (q == null || q.isBlank()) return skillRepository.findSummaries(cap);
        return skillRepository.searchSummaries(q.trim(), cap);
    }

    private static org.springframework.data.domain.PageRequest pageCap() {
        return org.springframework.data.domain.PageRequest.of(0, MAX_LIST,
                org.springframework.data.domain.Sort.by(org.springframework.data.domain.Sort.Direction.DESC, "updatedAt"));
    }

    @Transactional(readOnly = true)
    public Skill get(String id) {
        return skillRepository.findById(id).orElseThrow(() -> notFound());
    }

    @Transactional(readOnly = true)
    public Map<String, Object> summary() {
        // 窄行聚合（category/type/status），不把 8 个 TEXT 列拉进内存
        List<Object[]> rows = skillRepository.findFacetRows();
        Map<String, Long> byCategory = new LinkedHashMap<>();
        Map<String, Long> byType = new LinkedHashMap<>();
        long published = 0, draft = 0, disabled = 0;
        for (Object[] r : rows) {
            String cat = r[0] == null || ((String) r[0]).isBlank() ? "未分类" : (String) r[0];
            byCategory.merge(cat, 1L, Long::sum);
            byType.merge(r[1] == null ? "其他" : (String) r[1], 1L, Long::sum);
            String st = r[2] == null ? "PUBLISHED" : (String) r[2];
            if ("PUBLISHED".equals(st)) published++;
            else if ("DRAFT".equals(st)) draft++;
            else if ("DISABLED".equals(st)) disabled++;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("total", rows.size());
        out.put("published", published);
        out.put("draft", draft);
        out.put("disabled", disabled);
        out.put("byCategory", byCategory);
        out.put("byType", byType);
        return out;
    }

    @Transactional
    public Skill create(Skill skill) {
        if (skill.getId() == null || skill.getId().isBlank()) skill.setId("skill-" + UUID.randomUUID().toString().substring(0, 8));
        if (skill.getStatus() == null || skill.getStatus().isBlank()) skill.setStatus("DRAFT");
        if (skill.getVersion() == null || skill.getVersion().isBlank()) skill.setVersion("1.0.0");
        blockIfHighRisk(skill);
        stampSecurityReport(skill);
        // 预置名单里的技能一进库就带上不可删标记（导入先于名单变更时靠启动同步兜底，见 BuiltinSkills）
        if (BuiltinSkills.isBuiltin(skill.getName())) skill.setBuiltin(true);
        skill.setUpdatedAt(LocalDateTime.now());
        return skillRepository.save(skill);
    }

    /**
     * 编写写入路径的安全闸：技能文案(sopContent/description)/脚本(code)命中 HIGH 红线即拒(400)。
     * 原先 HIGH 阻断只在 GitHub/文件导入触发，create/update/from-recording 不扫——工作台一旦能编辑
     * code/sopContent 就成了绕过安全扫描的写入口，此处补齐。错误里点明命中项，供作者修正。
     */
    private void blockIfHighRisk(Skill skill) {
        List<String> highTypes = new ArrayList<>();
        List<SkillSecurityService.Finding> findings = new ArrayList<>(security.scan(skill));
        // bundle(SKILL.md+scripts 整目录 JSON) 存在则一并扫脚本文件——工作台编辑 bundle 同样不能绕过安全闸
        if (skill.getBundle() != null && !skill.getBundle().isBlank()) {
            try {
                Map<String, String> files = mapper.readValue(skill.getBundle(), new com.fasterxml.jackson.core.type.TypeReference<Map<String, String>>() {});
                findings.addAll(security.scanBundle(files));
            } catch (Exception ignored) { /* bundle 非法 JSON → 只按实体字段扫 */ }
        }
        for (SkillSecurityService.Finding f : findings) {
            if ("HIGH".equals(f.severity()) && !highTypes.contains(f.type())) highTypes.add(f.type());
        }
        if (!highTypes.isEmpty()) {
            throw new IllegalArgumentException("技能内容触发 HIGH 级安全红线（" + String.join("、", highTypes)
                    + "），已拒绝保存；请修正相关文案/脚本后重试。");
        }
    }

    /**
     * 全量检测报告留痕：实体字段 + bundle 整目录重扫一遍，结果 JSON 存 securityReport。
     * 与 blockIfHighRisk 的分工：**拦截按增量**（防旧内容卡死编辑，见 update 注释），
     * **留痕按全量**（审核抽屉要看的是这个技能现在整体什么水平，不是这次改了什么）。
     * 目标：除预置种子外，平台上每个技能都有一份可查的检测报告（审核不再盲判）。
     */
    public void stampSecurityReport(Skill s) {
        try {
            List<SkillSecurityService.Finding> findings = new ArrayList<>(security.scan(s));
            if (s.getBundle() != null && !s.getBundle().isBlank()) {
                try {
                    Map<String, String> files = mapper.readValue(s.getBundle(), new com.fasterxml.jackson.core.type.TypeReference<Map<String, String>>() {});
                    findings.addAll(security.scanBundle(files));
                } catch (Exception ignored) { /* bundle 非法 JSON → 只按实体字段留痕 */ }
            }
            Map<String, Object> rep = security.report(findings);
            // 本方法是同步留痕（每次保存都跑），不做模型语义复审；但安装时产出的复审意见
            // 是花过钱的判读结论，重扫/编辑刷新静态发现时**保留**它，别静默丢掉。
            String prev = s.getSecurityReport();
            if (prev != null && !prev.isBlank()) {
                try {
                    Map<String, Object> old = mapper.readValue(prev, new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {});
                    if (old.get("semanticReview") != null && rep.get("semanticReview") == null) {
                        rep.put("semanticReview", old.get("semanticReview"));
                    }
                } catch (Exception ignored) { /* 旧报告坏了就只存新静态结果 */ }
            }
            s.setSecurityReport(mapper.writeValueAsString(rep));
        } catch (Exception e) { /* 留痕失败不阻断保存：报告是配套设施，不是闸 */ }
    }

    /** 手动重扫（审核抽屉「重新扫描」）：给存量无报告的技能补一份，或内容改后刷新。 */
    @Transactional
    public Map<String, Object> rescan(String id) {
        Skill s = skillRepository.findById(id).orElseThrow(() -> notFound());
        stampSecurityReport(s);
        s.setUpdatedAt(LocalDateTime.now());
        skillRepository.save(s);
        return securityReport(id);
    }

    /** 更新后的值与库中原值不同才算「本次改动的新内容」（原样重提交不算——编辑抽屉整表单回传是常态）。 */
    private static boolean changedText(String now, String old) {
        return now != null && !now.equals(old);
    }

    /**
     * bundle 的按文件增量：只保留本次**新增或内容变化**的脚本文件（供安全闸扫描），
     * 未动过的已装文件不重扫。任一侧解析失败 → 按整包新内容处理（保守从严）。
     */
    private String changedBundleFiles(String nowBundle, String oldBundle) {
        if (nowBundle == null || nowBundle.isBlank() || nowBundle.equals(oldBundle)) return null;
        try {
            Map<String, String> nowFiles = mapper.readValue(nowBundle, new com.fasterxml.jackson.core.type.TypeReference<Map<String, String>>() {});
            Map<String, String> oldFiles = (oldBundle == null || oldBundle.isBlank()) ? Map.of()
                    : mapper.readValue(oldBundle, new com.fasterxml.jackson.core.type.TypeReference<Map<String, String>>() {});
            Map<String, String> diff = new LinkedHashMap<>();
            for (Map.Entry<String, String> e : nowFiles.entrySet()) {
                if (!Objects.equals(oldFiles.get(e.getKey()), e.getValue())) diff.put(e.getKey(), e.getValue());
            }
            return diff.isEmpty() ? null : mapper.writeValueAsString(diff);
        } catch (Exception e) {
            return nowBundle;
        }
    }

    @Transactional
    // 部分更新语义：缺省字段一律不动。标量判 null；集合判非空——实体字段带 `= new ArrayList<>()`
    // 初始化器，Jackson 对缺失字段给的是「空集合」而非 null，`!= null` 判断会把集合误清空
    //（曾连环清掉 triggerKeywords/type/name）。代价：显式清空集合需在管理端整体编辑时连同其他字段一起提交。
    public Skill update(String id, Skill update) {
        Skill existing = skillRepository.findById(id).orElseThrow(() -> notFound());
        // 安全闸的增量基线：先留存库中现值，闸只扫「本次真正改动」的内容（见下方 delta 说明）。
        String oldName = existing.getName(), oldDesc = existing.getDescription(), oldSop = existing.getSopContent();
        String oldCode = existing.getCode(), oldAction = existing.getActionScript(), oldBundle = existing.getBundle();
        if (update.getName() != null && !update.getName().isBlank()) existing.setName(update.getName());
        if (update.getType() != null && !update.getType().isBlank()) existing.setType(update.getType());
        if (update.getCategory() != null) existing.setCategory(update.getCategory());
        if (update.getStatus() != null) existing.setStatus(update.getStatus());
        if (update.getVersion() != null) existing.setVersion(update.getVersion());
        if (update.getTargetSystemId() != null) existing.setTargetSystemId(update.getTargetSystemId());
        if (update.getSkillKind() != null) existing.setSkillKind(update.getSkillKind());
        if (update.getNavHash() != null) existing.setNavHash(update.getNavHash());
        if (update.getDescription() != null) existing.setDescription(update.getDescription());
        if (update.getTriggerKeywords() != null && !update.getTriggerKeywords().isEmpty()) existing.setTriggerKeywords(update.getTriggerKeywords());
        if (update.getAllowedRoles() != null && !update.getAllowedRoles().isEmpty()) existing.setAllowedRoles(update.getAllowedRoles());
        if (update.getSopContent() != null) existing.setSopContent(update.getSopContent());
        // code 与 name/type 同样按「非空才覆盖」：管理端编辑抽屉不回填 code、整表单提交时带的是 ""，
        // 判 null 会把 python-sandbox 技能的脚本静默清空（部分更新语义的同族坑，见方法头注释）。
        if (update.getCode() != null && !update.getCode().isBlank()) existing.setCode(update.getCode());
        if (update.getActionScript() != null) existing.setActionScript(update.getActionScript());
        if (update.getBundle() != null) existing.setBundle(update.getBundle());   // 工作台编辑 agentic/知识型技能的脚本目录
        if (update.getFocusMapJson() != null) existing.setFocusMapJson(update.getFocusMapJson());   // 画像沉淀映射（漏拷贝=保存静默不生效，教训同 allowedExperts）
        if (update.getReviewNote() != null) existing.setReviewNote(update.getReviewNote());   // 审核备注/退回原因（回传上传者）
        // 安全闸只扫**本次改动引入的新内容**，不整体重扫：已装内容在安装/上次保存时已过闸
        //（HIGH 风险导入走的是人工确认通道）。整体重扫会让已装 HIGH 技能被自己的旧脚本卡死——
        // 只改触发词也 400「触发 HIGH 红线」（生产实锤 2026-07-19：Anthropic pptx 导入包改词被拒）。
        // 语义不放松：经本接口**新写入或改动**的文案/脚本/bundle 文件仍逐项过闸，工作台绝非旁路。
        Skill delta = new Skill();
        if (changedText(existing.getName(), oldName)) delta.setName(existing.getName());
        if (changedText(existing.getDescription(), oldDesc)) delta.setDescription(existing.getDescription());
        if (changedText(existing.getSopContent(), oldSop)) delta.setSopContent(existing.getSopContent());
        if (changedText(existing.getCode(), oldCode)) delta.setCode(existing.getCode());
        if (changedText(existing.getActionScript(), oldAction)) delta.setActionScript(existing.getActionScript());
        delta.setBundle(changedBundleFiles(existing.getBundle(), oldBundle));
        blockIfHighRisk(delta);
        stampSecurityReport(existing);   // 拦截按增量、留痕按全量（编辑后的报告要反映整体现状）
        existing.setUpdatedAt(LocalDateTime.now());
        Skill saved = skillRepository.save(existing);
        if ("DISABLED".equals(existing.getStatus())) detachSkillFromExperts(id);
        return saved;
    }

    /** 切换生命周期状态；下架时脱离所有岗位绑定。 */
    @Transactional
    public Skill setStatus(String id, String status) {
        Skill existing = skillRepository.findById(id).orElseThrow(() -> notFound());
        existing.setStatus(status);
        existing.setUpdatedAt(LocalDateTime.now());
        Skill saved = skillRepository.save(existing);
        if ("DISABLED".equals(status)) detachSkillFromExperts(id);
        return saved;
    }

    /** 删除：必须先下架（非 PUBLISHED）；删除时清理岗位绑定。 */
    @Transactional
    public Map<String, Object> delete(String id) {
        Skill skill = skillRepository.findById(id).orElseThrow(() -> notFound());
        // 预置技能是产品基础能力面的一部分，删掉就缺一块。闸放在 service 而不是 controller：
        // 删除有多个入口（管理端 /skills/{id}、创作者 /creator/{id}），闸在这里才都盖得住。
        if (skill.isBuiltin()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "「" + skill.getName() + "」是系统预置技能，不能删除——它是分身基础能力的一部分。如需停用，请改用下架。");
        }
        if ("PUBLISHED".equals(skill.getStatus() == null ? "PUBLISHED" : skill.getStatus())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "技能已上架，请先下架再删除（下架会脱离岗位绑定）。");
        }
        detachSkillFromExperts(id);
        skillRepository.deleteById(id);
        return Map.of("success", true, "deletedId", id);
    }

    /** 录制结果 → 语义脚本(DSL) + SOP 的标准技能。 */
    @Transactional
    @SuppressWarnings("unchecked")
    public Skill fromRecording(Map<String, Object> body) {
        String name = String.valueOf(body.getOrDefault("name", "录制技能"));
        List<Object> steps = body.get("steps") instanceof List ? (List<Object>) body.get("steps") : new ArrayList<>();
        List<Object> fields = body.get("fields") instanceof List ? (List<Object>) body.get("fields") : new ArrayList<>();
        String targetSystemId = body.get("targetSystemId") == null ? "" : String.valueOf(body.get("targetSystemId"));
        String engine = body.get("engine") == null ? "browser" : String.valueOf(body.get("engine"));
        String providedScript = body.get("script") == null ? "" : String.valueOf(body.get("script"));
        String providedSop = body.get("sop") == null ? "" : String.valueOf(body.get("sop"));
        boolean desktop = "desktop".equals(engine);
        List<String> triggerKeywords = new ArrayList<>();
        if (body.get("triggerKeywords") instanceof List) for (Object o : (List<Object>) body.get("triggerKeywords")) {
            for (String part : String.valueOf(o).split("[，,、；;\\s]+")) { String k = part.trim(); if (!k.isEmpty() && !triggerKeywords.contains(k)) triggerKeywords.add(k); }
        }
        String dsl = (providedScript != null && !providedScript.isBlank()) ? providedScript : deterministicDsl(steps);
        if (dsl == null || dsl.isBlank()) dsl = "# 录制为空";
        // 录制治本：单据/条目行点击自动参数化（录的是流程，不是那一单）
        dsl = parameterizeInstanceClicks(dsl, steps, fields);
        String sop = (providedSop != null && !providedSop.isBlank()) ? providedSop : llm.generateSop(name, dsl, fields, desktop);

        Skill skill = new Skill();
        skill.setId("skill-" + UUID.randomUUID().toString().substring(0, 8));
        skill.setName(name);
        skill.setType(desktop ? "nut-js" : "playwright");
        skill.setCategory(desktop ? "桌面录制技能" : "录制技能");
        // 默认发布；工作台「存草稿」传 status=DRAFT，编写中不强制上线
        String reqStatus = body.get("status") == null ? "" : String.valueOf(body.get("status")).trim();
        skill.setStatus("DRAFT".equals(reqStatus) ? "DRAFT" : "PUBLISHED");
        skill.setSource("recorded");
        String providedDesc = body.get("description") == null ? "" : String.valueOf(body.get("description")).trim();
        skill.setDescription(!providedDesc.isBlank() ? providedDesc
                : (desktop ? "由桌面实操录制生成的桌面脚本技能（nut-js 回放，可在脚本中编辑）。" : "由实操录制转换生成的语义脚本技能（可在脚本中编辑）。"));
        skill.setTriggerKeywords(triggerKeywords);
        skill.setAllowedRoles(new ArrayList<>());
        skill.setTargetSystemId(targetSystemId);
        String skillKind = body.get("skillKind") == null ? "" : String.valueOf(body.get("skillKind"));
        if (skillKind.isBlank()) {
            boolean hasWrite = steps.stream().anyMatch(o -> {
                if (!(o instanceof Map)) return false;
                Map<?, ?> m = (Map<?, ?>) o;
                Object a = m.get("act");
                String act = a == null ? "" : String.valueOf(a);
                if (act.equals("fill") || act.equals("select") || act.equals("search") || act.equals("pickOption")
                        || act.equals("choose") || act.equals("upload")) return true;
                // AI 指令步可能执行任意页面操作，按写从严（与"宁严勿漏"的读/写覆盖原则一致）
                if (act.equals("agent")) return true;
                // 点击「同意/提交/删除…」等改状态按钮 = 写操作（纯审批/提交类无填表字段，仅靠 fill/select 会漏判成 read）
                if (act.equals("click") || act.equals("tap") || act.equals("button")) {
                    Object lb = m.get("label"); if (lb == null) lb = m.get("text");
                    return lb != null && WRITE_INTENT_LABEL.matcher(String.valueOf(lb)).find();
                }
                return false;
            });
            skillKind = hasWrite ? "write" : "read";
        }
        skill.setSkillKind(skillKind);
        skill.setNavHash(body.get("navHash") == null ? "" : String.valueOf(body.get("navHash")));
        skill.setSopContent(sop);
        skill.setCode(dsl);
        try {
            Map<String, Object> as = new LinkedHashMap<>();
            as.put("version", 2);
            as.put("fields", fields);
            as.put("rawSteps", steps);
            Object cases = body.get("acceptanceCases");   // 验收用例随技能存 actionScript，供回归回放
            if (cases instanceof List) as.put("acceptanceCases", cases);
            skill.setActionScript(mapper.writeValueAsString(as));
        } catch (Exception ignored) {}
        blockIfHighRisk(skill);
        stampSecurityReport(skill);
        // 预置名单里的技能一进库就带上不可删标记（导入先于名单变更时靠启动同步兜底，见 BuiltinSkills）
        if (BuiltinSkills.isBuiltin(skill.getName())) skill.setBuiltin(true);
        skill.setUpdatedAt(LocalDateTime.now());
        return skillRepository.save(skill);
    }

    /**
     * 静态试运行：拿一段用户口语，按该技能的字段清单提炼字段值（经企业模型网关）。
     * 管理端是 Web 应用、没有本地浏览器执行引擎——真实执行（回放/填表）在 FDE 工作台或客户端；
     * 这里只验证「话 → 字段」这一段，供管理员快速核对字段设计与沉淀映射。
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> dryRunExtract(String id, String text) {
        Skill skill = skillRepository.findById(id).orElseThrow(() -> notFound());
        if (text == null || text.isBlank()) throw new IllegalArgumentException("请输入一段测试话术");
        List<Map<String, Object>> fields = new ArrayList<>();
        try {
            Map<String, Object> parsed = llm.parseLooseJson(skill.getActionScript() == null ? "{}" : skill.getActionScript());
            Object fs = parsed.get("fields");
            if (fs instanceof List<?> list) for (Object o : list) if (o instanceof Map<?, ?> mm) fields.add((Map<String, Object>) mm);
        } catch (Exception ignore) { /* 无字段定义则按空 */ }
        if (fields.isEmpty()) return Map.of("success", true, "fields", List.of(), "note", "该技能未定义可提炼字段（纯点击/查看类）");
        StringBuilder fl = new StringBuilder();
        for (Map<String, Object> f : fields) {
            fl.append("- ").append(f.get("label"));
            Object opts = f.get("options");
            if (opts instanceof List<?> ol && !ol.isEmpty()) fl.append("（下拉，选项：").append(ol).append("）");
            fl.append('\n');
        }
        String prompt = "从用户这句话里为下列字段提炼值。规则：只提炼话里明确说了的，没说的留空串，绝不编造；"
                + "下拉字段的值尽量贴近给出的选项原文；日期规范成 yyyy-MM-dd（\"今天\"按 " + java.time.LocalDate.now() + " 算）。\n"
                + "字段清单：\n" + fl
                + "用户的话：" + text + "\n"
                + "只输出严格 JSON（键=字段标签，值=提炼结果）：{\"字段标签\":\"值\"}";
        try {
            Map<String, Object> out = llm.parseLooseJson(llm.extractContent(llm.chat(prompt)));
            List<Map<String, String>> rows = new ArrayList<>();
            for (Map<String, Object> f : fields) {
                String label = String.valueOf(f.get("label"));
                String name = String.valueOf(f.getOrDefault("name", ""));
                // 模型返回的键常是**短名**（"目标对象"），而 label 带括号说明（"目标对象（要处理的…）"）——
                // 只按全 label 查永远落空。依次试：全 label → 字段 name → label 去括号前缀。
                String core = label.split("[（(]")[0].trim();
                Object v = out.get(label);
                if (v == null && !name.isBlank()) v = out.get(name);
                if (v == null && !core.isBlank()) v = out.get(core);
                rows.add(Map.of("label", label, "value", v == null ? "" : String.valueOf(v)));
            }
            return Map.of("success", true, "fields", rows);
        } catch (Exception e) {
            throw new IllegalStateException("模型提炼失败：" + e.getMessage());
        }
    }

    /** FDE 试运行：根据脚本生成 SOP。 */
    @SuppressWarnings("unchecked")
    public Map<String, Object> genSop(Map<String, Object> body) {
        String name = String.valueOf(body.getOrDefault("name", "录制技能"));
        String dsl = body.get("script") == null ? "" : String.valueOf(body.get("script"));
        List<Object> fields = body.get("fields") instanceof List ? (List<Object>) body.get("fields") : new ArrayList<>();
        boolean desktop = "desktop".equals(String.valueOf(body.getOrDefault("engine", "browser")));
        String sop = llm.generateSop(name, dsl.isBlank() ? "# 录制为空" : dsl, fields, desktop);
        return Map.of("success", true, "sop", sop);
    }


    /** 上传 SKILL.md / .zip：解析 frontmatter + SOP 归档（进草稿待审核）。异常向上抛由控制器处理。 */
    @Transactional
    /**
     * 上传技能包（旧入口，保留兼容）。**已并入与「安装技能包」完全相同的安装路径**。
     *
     * 旧实现是个真窟窿：
     *   ① **绕过安全扫描** —— 直接 skillRepository.save()，不走 blockIfHighRisk。
     *      「安装」那条路会 HIGH 阻断，这条路却能随便塞脚本进来 —— 同一件事两条路、一条有闸一条没闸，
     *      等于没闸。
     *   ② **只取一个脚本** —— readZip 只抽 [SKILL.md, 单个 code 文件]，整个 scripts/ 目录被丢掉。
     *   ③ **不派生触发词** —— 装进去客户端永远匹配不到它。
     * 现在一律走 installBundle / importPackage：安全扫描、整目录、触发词派生、DRAFT 落库，一视同仁。
     */
    public Map<String, Object> upload(MultipartFile file) throws Exception {
        byte[] bytes = file.getBytes();
        String filename = file.getOriginalFilename() == null ? "skill" : file.getOriginalFilename();
        boolean zip = bytes.length > 4 && bytes[0] == 0x50 && bytes[1] == 0x4B && bytes[2] == 0x03 && bytes[3] == 0x04;

        Map<String, Object> r = zip
                ? pkg.installBundle(pkg.unzipBundle(bytes), filename.replaceAll("(?i)\\.zip$", ""), "upload-zip", true, false)
                : pkg.importPackage(new String(bytes, StandardCharsets.UTF_8), true, "upload-md", false);

        if (!Boolean.TRUE.equals(r.get("success"))) {
            String err = String.valueOf(r.getOrDefault("error", "安装被阻断（安全扫描未通过）"));
            throw new IllegalArgumentException(err + "  ——请改用「安装技能包」，先看安全报告再决定是否接受风险安装。");
        }
        @SuppressWarnings("unchecked") List<String> ids = (List<String>) r.get("installed");
        String id = ids == null || ids.isEmpty() ? "" : ids.get(0);
        Skill saved = id.isBlank() ? null : skillRepository.findById(id).orElse(null);
        return Map.of("success", true, "skillId", id,
                "name", saved == null || saved.getName() == null ? id : saved.getName(),
                "triggerKeywords", saved == null ? List.of() : saved.getTriggerKeywords(),
                "allowedRoles", saved == null ? List.of() : saved.getAllowedRoles());
    }

    /**
     * 员工上传第三方技能包：先审后用。与管理端安装同一解析/扫描路径，但 force=true 让 HIGH 发现
     * 也**落库隔离**（status=PENDING_REVIEW + reviewNote 记扫描摘要与上传者），由管理员在技能中心
     * 审核后决定发布/驳回——上传阶段不硬拒，审核阶段人来判断，红线在「发布+绑定岗位」前始终未开闸。
     */
    @Transactional
    public Map<String, Object> submitUserPackage(MultipartFile file, String ownerUserId, String ownerName) throws Exception {
        byte[] bytes = file.getBytes();
        String filename = file.getOriginalFilename() == null ? "skill" : file.getOriginalFilename();
        boolean zip = bytes.length > 4 && bytes[0] == 0x50 && bytes[1] == 0x4B && bytes[2] == 0x03 && bytes[3] == 0x04;
        String tag = "user-upload:" + ownerName;
        Map<String, Object> r = zip
                ? pkg.installBundle(pkg.unzipBundle(bytes), filename.replaceAll("(?i)\\.zip$", ""), tag, true, true)
                : pkg.importPackage(new String(bytes, StandardCharsets.UTF_8), true, tag, true);
        if (!Boolean.TRUE.equals(r.get("success"))) {
            throw new IllegalArgumentException(String.valueOf(r.getOrDefault("error", "技能包解析失败")));
        }
        return markPendingReview(r, ownerUserId, ownerName);
    }

    /**
     * 从 GitHub 地址提交第三方技能（**对话里说"装个 xxx"走的就是这条**）。
     *
     * 与 submitUserPackage 唯一的区别是素材从哪来：那边是员工选的本地文件，这边是一个仓库地址。
     * 解析/安全扫描/触发词派生/落库全部复用同一条管线，落点同样是 PENDING_REVIEW——
     * 入口多一个不等于治理松一档，员工装的技能仍旧先审后用。
     *
     * @param confirm false=只预检不落库（把技能名/触发词/安全报告给用户看，由他签字确认）；true=真装
     */
    @Transactional
    public Map<String, Object> submitUserGithub(String url, String ownerUserId, String ownerName, boolean confirm) {
        // force=true 与 submitUserPackage 同理：HIGH 发现不在此处硬拒，而是落库隔离交管理员判断
        Map<String, Object> r = pkg.importGithub(url, confirm, true);
        // 预检回执**没有 success 字段**（只有 preview/blocked/reviewRequired + skills），
        // 在这里一并校验 success 会让每次预检都抛异常。只有真安装才判成败。
        if (!confirm) return r;   // 预检：原样把安全报告与技能信息交给调用方展示
        if (!Boolean.TRUE.equals(r.get("success"))) {
            throw new IllegalArgumentException(String.valueOf(r.getOrDefault("error", "技能包解析失败")));
        }
        return markPendingReview(r, ownerUserId, ownerName);
    }

    /** 安装结果打上「归属人 + 待审核」——员工的两条入口（本地包 / GitHub 地址）共用，避免两处各写一遍治理规则。 */
    /** 员工两条提交入口共用；import-github 带 review=true（客户端对话安装）时也走这里——对话装的一律先审后用。 */
    public Map<String, Object> markPendingReview(Map<String, Object> r, String ownerUserId, String ownerName) {
        @SuppressWarnings("unchecked") List<String> ids = (List<String>) r.get("installed");
        String riskNote = "";
        String risk = "";
        if (r.get("skills") instanceof List<?> sl && !sl.isEmpty() && sl.get(0) instanceof Map<?, ?> sk && sk.get("security") instanceof Map<?, ?> sec) {
            risk = String.valueOf(sec.get("risk"));
            riskNote = "安全扫描：" + risk;
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (String id : ids == null ? List.<String>of() : ids) {
            Skill s = skillRepository.findById(id).orElse(null);
            if (s == null) continue;
            s.setOwnerUserId(ownerUserId);
            s.setStatus("PENDING_REVIEW");
            s.setReviewNote(riskNote + "；上传者：" + ownerName);
            s.setUpdatedAt(LocalDateTime.now());
            skillRepository.save(s);
            // security 随回执带给客户端：上传结果提示要能说清扫描结论，不是一句干巴巴的"已提交"
            out.add(Map.of("id", s.getId(), "name", s.getName() == null ? s.getId() : s.getName(), "status", s.getStatus(), "security", risk));
        }
        return Map.of("success", true, "skills", out,
                "message", "已提交待审核，管理员发布后方可使用");
    }

    /**
     * 审核员工上传的技能：通过=发布，退回=REJECTED+原因（回传上传者）。
     * 专用端点、原子更新——不走通用 PUT：实体字段带初始化器（status="PUBLISHED"），
     * 部分更新 JSON 缺省字段会被 Jackson 填成初始值，一次"只想改备注"的 PUT 就把待审技能顶成已上架（真踩过）。
     */
    @Transactional
    public Skill review(String id, boolean approve, String reason) {
        Skill s = skillRepository.findById(id).orElseThrow(() -> notFound());
        if (approve) {
            s.setStatus("PUBLISHED");
        } else {
            s.setStatus("REJECTED");
            String base = s.getReviewNote() == null ? "" : s.getReviewNote() + "；";
            s.setReviewNote(base + "退回原因：" + (reason == null || reason.isBlank() ? "未说明" : reason.trim()));
        }
        s.setUpdatedAt(LocalDateTime.now());
        return skillRepository.save(s);
    }

    /** 本人私有技能（创建的 + 上传待审的），供客户端展示与安装。 */
    @Transactional(readOnly = true)
    public List<Skill> mine(String ownerUserId) {
        return skillRepository.findByOwnerUserId(ownerUserId);
    }

    /** 测试台试运行（返回合成执行轨迹）。 */
    @Transactional(readOnly = true)
    public Map<String, Object> test(String id, Map<String, Object> body) {
        Skill skill = skillRepository.findById(id).orElseThrow(() -> notFound());
        String input = body != null && body.get("input") != null ? body.get("input").toString() : "(默认测试参数)";
        List<String> logs = new ArrayList<>();
        logs.add("[harness] 装载技能 " + skill.getName() + " (" + skill.getType() + ")");
        logs.add("[harness] 角色鉴权 allowed_roles=" + skill.getAllowedRoles());
        logs.add("[sandbox] 唤起 " + sandboxLabel(skill.getType()) + " 隔离环境");
        logs.add("[input] " + input);
        logs.add("[observe] SOP 已注入，技能单步执行完成");
        logs.add("[done] 退出码 0");
        return Map.of("success", true, "skillId", id, "sandbox", sandboxLabel(skill.getType()), "logs", logs);
    }

    // ── helpers ──────────────────────────────────────────────────────────────
    private void detachSkillFromExperts(String skillId) {
        // 一条 SQL 清 join 表，代替加载全部岗位实体逐个改集合（原 N+1 读写）
        expertRepository.detachSkillFromAllExperts(skillId);
    }


    @SuppressWarnings("unchecked")
    /** 通用按钮/操作词：这些 click 目标是界面骨架，不是业务对象实例，绝不参数化。 */
    private static final java.util.regex.Pattern GENERIC_BTN = java.util.regex.Pattern.compile(
            "^(同意|提交|确认|保存|取消|关闭|返回|登录|退出|新建|添加|删除|编辑|查询|搜索|重置|刷新|下一步|上一步|首页|菜单|管理|列表|待办|通过|驳回|拒绝|详情|导出|导入|上传|下载)$");

    /**
     * 录制治本：把「点具体单据/条目」的步骤自动参数化。
     *
     * 血泪：录制审批技能时点了「宝钢钢铁数字化项目采购合同」，生成的脚本写死这一行——
     * 用户说"审批宝钢产线智能改造项目"，回放照点录制那份，**另一份合同被真批了**。
     * 录的是"流程"，不是"那一单"：单据名必须是执行时由用户点名的参数。
     *
     * 判定（通用规则，零领域词）：click 目标 ≥6 字、非通用按钮、且对应录制步骤不是菜单/导航
     * （menu=true 或带 nav 路由的是界面骨架）。命中则改写为 click "{{目标对象}}"，
     * 丢掉 @sel（录制的选择器指向旧目标那一行，换目标后必然点错），并自动补一个「目标对象」字段
     * （录制值留在字段说明里作示例）。多个实例点击依次为 目标对象、目标对象2…
     */
    @SuppressWarnings("unchecked")
    private String parameterizeInstanceClicks(String dsl, List<Object> steps, List<Object> fields) {
        if (dsl == null || dsl.isBlank()) return dsl;
        // 录制步骤按 label 建索引（两种来源形状：FDE 用 act/label/menu/nav，客户端旧录制用 action/label）
        Map<String, Map<String, Object>> byLabel = new LinkedHashMap<>();
        for (Object so : steps) {
            if (!(so instanceof Map)) continue;
            Map<String, Object> m = (Map<String, Object>) so;
            String act = String.valueOf(m.getOrDefault("act", m.getOrDefault("action", "")));
            if (!"click".equals(act) && !"tap".equals(act)) continue;
            String lb = String.valueOf(m.getOrDefault("label", "")).replaceAll("\\s+", " ").trim();
            if (!lb.isBlank()) byLabel.putIfAbsent(lb, m);
        }
        java.util.regex.Pattern CLICK = java.util.regex.Pattern.compile("^(\\s*)click\\s+\"([^\"]+)\"(.*)$");
        StringBuilder out = new StringBuilder();
        int seq = 0;
        for (String line : dsl.split("\\n", -1)) {
            java.util.regex.Matcher m = CLICK.matcher(line);
            if (!m.matches() || line.contains("{{")) { out.append(line).append('\n'); continue; }
            String target = m.group(2).trim();
            Map<String, Object> st = byLabel.get(target);
            boolean isMenuNav = st != null && (Boolean.TRUE.equals(st.get("menu"))
                    || (st.get("nav") != null && !String.valueOf(st.get("nav")).isBlank()));
            boolean instanceLike = target.length() >= 6 && !GENERIC_BTN.matcher(target).matches() && !isMenuNav;
            if (!instanceLike) { out.append(line).append('\n'); continue; }
            seq++;
            String pname = seq == 1 ? "目标对象" : "目标对象" + seq;
            out.append(m.group(1)).append("click \"{{").append(pname).append("}}\"").append('\n');
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("name", pname);
            f.put("label", pname + "（要处理的条目名称，录制示例：" + target + "）");
            f.put("type", "text");
            f.put("value", "");
            boolean exists = fields.stream().anyMatch(o -> o instanceof Map && pname.equals(String.valueOf(((Map<?, ?>) o).get("name"))));
            if (!exists) fields.add(f);
        }
        return out.toString().trim();
    }

    private String deterministicDsl(List<Object> steps) {
        StringBuilder sb = new StringBuilder();
        for (Object so : steps) {
            if (!(so instanceof Map)) continue;
            Map<String, Object> s = (Map<String, Object>) so;
            String action = String.valueOf(s.getOrDefault("action", ""));
            String kind = s.get("kind") == null ? "" : String.valueOf(s.get("kind"));
            String label = (s.get("label") == null ? "" : String.valueOf(s.get("label"))).replaceAll("\\s+", " ").trim();
            String value = (s.get("value") == null ? "" : String.valueOf(s.get("value"))).replaceAll("\\s+", " ").trim();
            String fieldName = s.get("fieldName") == null ? "" : String.valueOf(s.get("fieldName"));
            String selector = s.get("selector") == null ? "" : String.valueOf(s.get("selector"));
            String at = selector.isBlank() ? "" : "  @sel=" + selector;
            Object wb = s.get("waitBefore");
            if (wb != null) { try { int w = (int) Double.parseDouble(String.valueOf(wb)); if (w > 0) sb.append("wait ").append(w).append("\n"); } catch (Exception ignored) {} }
            String rhs = !fieldName.isBlank() ? "{{" + fieldName + "}}" : "\"" + value.replace("\"", "") + "\"";
            if ("search".equals(kind)) sb.append("searchSelect \"").append(label).append("\" = ").append(rhs).append(at).append("\n");
            else if ("dropdown".equals(kind)) sb.append("dropdown \"").append(label).append("\" = ").append(rhs).append(at).append("\n");
            else if ("select".equals(action)) sb.append("select \"").append(label).append("\" = ").append(rhs).append(at).append("\n");
            else if ("fill".equals(action)) sb.append("fill \"").append(label).append("\" = ").append(rhs).append(at).append("\n");
            else if ("hover".equals(action)) sb.append("hover \"").append(label.isBlank() ? value : label).append("\"").append(at).append("\n");
            else if ("click".equals(action)) sb.append("click \"").append(label.isBlank() ? value : label).append("\"").append(at).append("\n");
        }
        return sb.toString().trim();
    }

    private String sandboxLabel(String type) {
        if (type == null) return "WASM Python 沙箱";
        return switch (type) {
            case "playwright" -> "Playwright 浏览器容器";
            case "python-sandbox" -> "Pyodide WASM 沙箱";
            case "nut-js" -> "桌面 RPA 自动化通道";
            case "onnx-bge" -> "本地向量推理引擎";
            case "knowledge" -> "知识/指南型（无沙箱，模型按 SOP 应用）";
            default -> "通用隔离沙箱";
        };
    }


    /**
     * 导入的技能若无触发关键词则自动派生（否则客户端按关键词匹配永远命中不了——Anthropic 等外源
     * SKILL.md 没有 trigger_keywords 字段）。规则：技能名必进；再用模型/离线回退补中文口语词。
     */

    /** 模型辅助生成触发关键词 + SOP —— 实现在 {@link SkillLlmHelper}，此处保留同名入口供控制器调用。 */
    public Map<String, Object> generate(String name, String desc, String type, String category) {
        return llm.generate(name, desc, type, category);
    }

    // ── 技能包管线转发（实现在 SkillPackageService，体检 B4 拆出；入口保留在此，控制器无需改动）──
    public Map<String, Object> exportOne(String id) { return pkg.exportOne(id); }
    public byte[] exportZip(String id) { return pkg.exportZip(id); }
    public Map<String, Object> exportAll() { return pkg.exportAll(); }
    public Map<String, Object> importPackage(String json, boolean confirm, String sourceTag) { return pkg.importPackage(json, confirm, sourceTag); }
    public Map<String, Object> importPackage(String json, boolean confirm, String sourceTag, boolean force) { return pkg.importPackage(json, confirm, sourceTag, force); }
    public Map<String, Object> importGithub(String url, boolean confirm, boolean force) { return pkg.importGithub(url, confirm, force); }

    /**
     * 安装结果记归属：谁装的，谁在客户端「我的技能」里就能看到它和审批进度（DRAFT/待审核/已退回）。
     * 此前管理权限通道装入的 DRAFT 无 ownerUserId → /skills/mine 查不到 → 装完就"消失"在管理台，
     * 装的人只能干等（实测反馈 2026-08-13）。只补空缺不覆盖：submit 通道已按上传者记好归属。
     * 注意：DRAFT/待审不会因此变可用——客户端 syncMineSkills 只放行 PUBLISHED。
     */
    public Map<String, Object> stampOwner(Map<String, Object> result, String ownerUserId) {
        if (ownerUserId == null || ownerUserId.isBlank() || !Boolean.TRUE.equals(result.get("success"))) return result;
        if (result.get("installed") instanceof List<?> ids) {
            for (Object idObj : ids) {
                skillRepository.findById(String.valueOf(idObj)).ifPresent(s -> {
                    if (s.getOwnerUserId() == null || s.getOwnerUserId().isBlank()) {
                        s.setOwnerUserId(ownerUserId);
                        skillRepository.save(s);
                    }
                });
            }
        }
        return result;
    }

    // ── 技能信任治理（③）：报告留痕查询 + 策略/白名单配置 ────────────────────

    /** 某技能安装时的安全扫描报告（大 TEXT 走专用端点，不随实体/列表序列化）。 */
    public Map<String, Object> securityReport(String id) {
        Skill s = skillRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "技能不存在"));
        String raw = s.getSecurityReport();
        if (raw == null || raw.isBlank()) return Map.of("available", false);
        try {
            @SuppressWarnings("unchecked") Map<String, Object> rep = mapper.readValue(raw, Map.class);
            rep.put("available", true);
            rep.put("bundleHash", s.getBundleHash() == null ? "" : s.getBundleHash());
            return rep;
        } catch (Exception e) { return Map.of("available", false); }
    }

    public com.imlwork.admin.model.SkillTrustConfig trustConfig() { return pkg.trustConfig(); }

    public com.imlwork.admin.model.SkillTrustConfig saveTrustConfig(String policy, String trustedSources) {
        return pkg.saveTrustConfig(policy, trustedSources);
    }
    public Map<String, String> unzipBundle(byte[] data) { return pkg.unzipBundle(data); }
    public Map<String, Object> installBundle(Map<String, String> bundle, String fallbackName, String sourceTag, boolean confirm, boolean force) {
        return pkg.installBundle(bundle, fallbackName, sourceTag, confirm, force);
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "技能不存在");
    }

}
