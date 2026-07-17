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

    public SkillService(SkillRepository skillRepository, ExpertRepository expertRepository,
                        ModelProxyService modelProxy, SkillSecurityService security) {
        this.skillRepository = skillRepository;
        this.expertRepository = expertRepository;
        this.modelProxy = modelProxy;
        this.security = security;
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

    @Transactional
    // 部分更新语义：缺省字段一律不动。标量判 null；集合判非空——实体字段带 `= new ArrayList<>()`
    // 初始化器，Jackson 对缺失字段给的是「空集合」而非 null，`!= null` 判断会把集合误清空
    //（曾连环清掉 triggerKeywords/type/name）。代价：显式清空集合需在管理端整体编辑时连同其他字段一起提交。
    public Skill update(String id, Skill update) {
        Skill existing = skillRepository.findById(id).orElseThrow(() -> notFound());
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
        if (update.getCode() != null) existing.setCode(update.getCode());
        if (update.getActionScript() != null) existing.setActionScript(update.getActionScript());
        if (update.getBundle() != null) existing.setBundle(update.getBundle());   // 工作台编辑 agentic/知识型技能的脚本目录
        if (update.getFocusMapJson() != null) existing.setFocusMapJson(update.getFocusMapJson());   // 画像沉淀映射（漏拷贝=保存静默不生效，教训同 allowedExperts）
        if (update.getReviewNote() != null) existing.setReviewNote(update.getReviewNote());   // 审核备注/退回原因（回传上传者）
        blockIfHighRisk(existing);
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
        String sop = (providedSop != null && !providedSop.isBlank()) ? providedSop : generateSop(name, dsl, fields, desktop);

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
            Map<String, Object> parsed = parseLooseJson(skill.getActionScript() == null ? "{}" : skill.getActionScript());
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
            Map<String, Object> out = parseLooseJson(extractContent(chat(prompt)));
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
        String sop = generateSop(name, dsl.isBlank() ? "# 录制为空" : dsl, fields, desktop);
        return Map.of("success", true, "sop", sop);
    }

    /** 模型辅助生成触发关键词 + SOP（含离线模板回退）。 */
    public Map<String, Object> generate(String name, String desc, String type, String category) {
        String nm = name == null ? "" : name.trim();
        String ds = desc == null ? "" : desc.trim();
        if (nm.isBlank() && ds.isBlank()) throw new IllegalArgumentException("请先填写技能名称或描述");
        String prompt = "你是企业自动化技能设计助手。请根据技能信息生成两部分内容：\n"
                + "1) 触发关键词 triggerKeywords：5-8 个，简短、贴近用户口语、覆盖常见说法（中文为主，可含必要英文）。\n"
                + "2) 标准作业流程 sop：用 Markdown 写，分步骤、可执行，描述该技能从开始到给出反馈的关键步骤与规则，会被注入到分身的上下文。\n"
                + "技能名称：" + nm + "\n技能描述：" + ds + "\n执行引擎：" + type + "\n业务分类：" + category + "\n"
                + "只输出严格的 JSON，不要任何解释或代码块标记：{\"triggerKeywords\":[\"...\"],\"sop\":\"# ...\"}";
        try {
            String content = extractContent(chat(prompt));
            Map<String, Object> parsed = parseLooseJson(content);
            Object kw = parsed.get("triggerKeywords");
            Object sop = parsed.get("sop");
            if (kw instanceof List<?> && sop != null) {
                return Map.of("success", true, "triggerKeywords", kw, "sop", sop.toString(), "source", "model");
            }
        } catch (Exception e) { /* 模板回退 */ }
        List<String> kws = new ArrayList<>();
        if (!nm.isBlank()) kws.add(nm);
        for (String w : (nm + " " + ds).split("[\\s，,、/]+")) if (w.length() >= 2 && kws.size() < 6 && !kws.contains(w)) kws.add(w);
        String sop = "# " + (nm.isBlank() ? "技能" : nm) + " SOP\n\n## 执行步骤\n1. 解析用户意图与所需参数。\n2. 执行核心动作（" + ds + "）。\n3. 校验结果并向用户如实反馈。\n\n## 注意事项\n- 仅基于真实结果作答，不编造数据。";
        return Map.of("success", true, "triggerKeywords", kws, "sop", sop, "source", "fallback");
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
                ? installBundle(unzipBundle(bytes), filename.replaceAll("(?i)\\.zip$", ""), "upload-zip", true, false)
                : importPackage(new String(bytes, StandardCharsets.UTF_8), true, "upload-md", false);

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
                ? installBundle(unzipBundle(bytes), filename.replaceAll("(?i)\\.zip$", ""), tag, true, true)
                : importPackage(new String(bytes, StandardCharsets.UTF_8), true, tag, true);
        if (!Boolean.TRUE.equals(r.get("success"))) {
            throw new IllegalArgumentException(String.valueOf(r.getOrDefault("error", "技能包解析失败")));
        }
        @SuppressWarnings("unchecked") List<String> ids = (List<String>) r.get("installed");
        String riskNote = "";
        if (r.get("skills") instanceof List<?> sl && !sl.isEmpty() && sl.get(0) instanceof Map<?, ?> sk && sk.get("security") instanceof Map<?, ?> sec) {
            riskNote = "安全扫描：" + sec.get("risk");
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
            out.add(Map.of("id", s.getId(), "name", s.getName() == null ? s.getId() : s.getName(), "status", s.getStatus()));
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

    private Object chat(String prompt) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("model", "corp-default");
        payload.put("messages", List.of(Map.of("role", "user", "content", prompt)));
        // 服务内直调中转 Service：网关鉴权（corp key）只对外部调用方生效，
        // 之前经 Controller 硬编码默认 key，一旦生产改了 corp-key 这里会全 401。
        ResponseEntity<?> resp = modelProxy.chat(payload);
        return resp.getBody();
    }

    @SuppressWarnings("unchecked")
    private String extractContent(Object respBody) throws Exception {
        Map<String, Object> m = respBody instanceof Map ? (Map<String, Object>) respBody : mapper.readValue(String.valueOf(respBody), Map.class);
        List<?> choices = (List<?>) m.get("choices");
        if (choices == null || choices.isEmpty()) return "";
        Map<?, ?> first = (Map<?, ?>) choices.get(0);
        Map<?, ?> msg = (Map<?, ?>) first.get("message");
        return msg == null ? "" : String.valueOf(msg.get("content"));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> parseLooseJson(String content) {
        if (content == null) return Map.of();
        String s = content.replaceAll("```json", "").replaceAll("```", "").trim();
        int a = s.indexOf('{'), b = s.lastIndexOf('}');
        if (a >= 0 && b > a) s = s.substring(a, b + 1);
        try { return mapper.readValue(s, Map.class); } catch (Exception e) { return Map.of(); }
    }

    @SuppressWarnings("unchecked")
    private String generateSop(String name, String dsl, List<Object> fields, boolean desktop) {
        StringBuilder pf = new StringBuilder();
        for (Object fo : fields) { if (fo instanceof Map) { Map<String, Object> f = (Map<String, Object>) fo; if (pf.length() > 0) pf.append("、"); pf.append(f.get("name")).append("=").append(f.get("label")); } }
        String paramSummary = pf.length() > 0 ? pf.toString() : "无";
        String engineName = desktop ? "桌面自动化（鼠标/键盘）" : "浏览器自动化（业务系统网页）";
        String sop = "";
        try {
            String prompt = "你是企业自动化技能的 SOP（标准作业流程）撰写助手。请根据下面录制生成的操作脚本，写一份**详细、专业、可读**的中文 SOP，说明该技能"
                    + "「做什么、怎么一步步做、如何向用户反馈」。\n\n"
                    + "技能名称：" + name + "\n执行引擎：" + engineName + "\n"
                    + "需用户确认的参数（执行时弹表单收集）：" + paramSummary + "\n"
                    + "操作脚本（DSL，每行一个动作；{{x}} 是用户参数；行尾 @sel=… 是录制定位、可忽略其细节）：\n" + dsl + "\n\n"
                    + "严格按以下 Markdown 结构输出（不要代码块标记，不要逐行复制 DSL）：\n"
                    + "# " + name + " SOP\n\n## 执行步骤\n"
                    + "用业务语言逐条编号描述：把 click/fill/select/searchSelect/hover/wait 等动作翻译成"
                    + "「进入X菜单」「在X字段填入{{参数}}」「选择X」「在检索框输入并选择匹配项」「等待列表加载完成」等业务动作；"
                    + (desktop ? "" : "首步说明「打开绑定的业务系统，地址来自业务系统连接，登录会话由客户端注入，无需输入账号密码」；")
                    + "可把连续的导航点击合并成一句（如「进入 客户管理 → 拜访反馈 → 新建」）；对带 {{}} 的步骤说明该值由用户确认填写；涉及读取/列表的步骤说明要抓取并整理哪些信息。\n\n"
                    + "## 反馈要求\n用要点说明：成功/失败如何向用户汇报；结果为空时如何提示；列表过长时如何截断与提示总数；异常（如未登录/无权限/弹窗拦截）时的处理。\n\n"
                    + "正文要具体、贴合脚本，不要泛泛而谈。";
            String content = extractContent(chat(prompt));
            if (content != null && !content.isBlank()) sop = content.replaceAll("```\\w*", "").trim();
        } catch (Exception e) { /* 模板 SOP */ }
        if (sop == null || sop.isBlank()) sop = "# " + name + " SOP\n\n## 执行步骤\n本技能由实操录制转换为语义脚本，执行时先弹表单确认参数（" + paramSummary + "），再按脚本逐步操作目标系统。\n\n## 反馈要求\n- 成功后向用户汇总执行结果；\n- 若遇未登录/无权限/页面异常，如实告知并停止，不编造结果。";
        return sop;
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

    private String[] readZip(byte[] bytes) throws Exception {
        String md = null;
        String code = null;
        try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                String name = entry.getName().toLowerCase();
                String content = new String(zis.readAllBytes(), StandardCharsets.UTF_8);
                if (name.endsWith(".md")) md = content;
                else if (name.endsWith(".js") || name.endsWith(".ts") || name.endsWith(".py")) code = content;
            }
        }
        return new String[]{md, code};
    }

    private Skill parseSkillMarkdown(String content) {
        Skill skill = new Skill();
        skill.setSource("upload-md");
        String body = content;
        String frontmatter = "";
        String trimmed = content.stripLeading();
        if (trimmed.startsWith("---")) {
            int end = trimmed.indexOf("\n---", 3);
            if (end > 0) {
                frontmatter = trimmed.substring(3, end);
                body = trimmed.substring(end + 4).stripLeading();
            }
        }
        List<String> triggers = new ArrayList<>();
        List<String> roles = new ArrayList<>();
        String currentList = null;
        for (String raw : frontmatter.split("\n")) {
            String t = raw.replace("\t", "  ").trim();
            if (t.isEmpty()) continue;
            if (t.startsWith("- ")) {
                String item = t.substring(2).trim().replaceAll("^['\"]|['\"]$", "");
                if ("trigger_keywords".equals(currentList)) triggers.add(item);
                else if ("allowed_roles".equals(currentList)) roles.add(item);
                continue;
            }
            int colon = t.indexOf(':');
            if (colon < 0) continue;
            String key = t.substring(0, colon).trim();
            String value = t.substring(colon + 1).trim().replaceAll("^['\"]|['\"]$", "");
            switch (key) {
                case "name" -> { skill.setName(value); skill.setId(value); currentList = null; }
                case "description" -> { skill.setDescription(value); currentList = null; }
                case "type" -> { skill.setType(value); currentList = null; }
                case "category" -> { skill.setCategory(value); currentList = null; }
                case "version" -> { skill.setVersion(value); currentList = null; }
                case "target_system" -> { skill.setTargetSystemId(value); currentList = null; }
                case "trigger_keywords" -> currentList = "trigger_keywords";
                case "allowed_roles" -> currentList = "allowed_roles";
                default -> currentList = null;
            }
        }
        skill.setTriggerKeywords(triggers);
        skill.setAllowedRoles(roles);
        skill.setSopContent(body);
        // 无显式 type 的裸 SKILL.md 本质是「知识/指南型」——不含可执行代码、由模型按 SOP 应用（如 brand-guidelines）。
        // 带代码(zip)或目录含脚本的会在调用方提升为 python-sandbox。
        if (skill.getType() == null) skill.setType("knowledge");
        return skill;
    }

    /** 目录技能按 bundle 内是否含可执行脚本判定引擎类型：有 .py/.js/.ts → 沙箱执行(python-sandbox)；纯 SKILL.md+参考资料 → 知识/指南型。 */
    private String deriveTypeFromBundle(Map<String, String> bundle) {
        boolean hasScript = bundle.keySet().stream().anyMatch(k -> {
            String lk = k.toLowerCase();
            return !lk.equals("skill.md") && (lk.endsWith(".py") || lk.endsWith(".js") || lk.endsWith(".ts"));
        });
        return hasScript ? "python-sandbox" : "knowledge";
    }

    /**
     * 导入的技能若无触发关键词则自动派生（否则客户端按关键词匹配永远命中不了——Anthropic 等外源
     * SKILL.md 没有 trigger_keywords 字段）。规则：技能名必进；再用模型/离线回退补中文口语词。
     */
    private void ensureTriggerKeywords(Skill s) {
        if (s.getTriggerKeywords() != null && !s.getTriggerKeywords().isEmpty()) return;
        List<String> kws = new ArrayList<>();
        String nm = s.getName() == null ? "" : s.getName().trim();
        if (!nm.isBlank()) kws.add(nm.toLowerCase());
        try {
            Object gen = generate(nm, s.getDescription(), s.getType(), s.getCategory()).get("triggerKeywords");
            if (gen instanceof List<?> l) for (Object o : l) {
                String k = String.valueOf(o).trim();
                if (!k.isEmpty() && !kws.contains(k) && kws.size() < 8) kws.add(k);
            }
        } catch (Exception e) { /* 模型不可用时保底只有技能名 */ }
        s.setTriggerKeywords(kws);
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "技能不存在");
    }

    // ════════════ 技能包导出 / 安装（GitHub·本地包）+ 导入前安全检查 ════════════

    /** 便携技能包字段：剥离本地环境绑定（targetSystemId 各环境不同，导入后需重新绑定）。 */
    private Map<String, Object> portable(Skill s) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("originId", s.getId());
        m.put("name", s.getName());
        m.put("type", s.getType());
        m.put("category", s.getCategory());
        m.put("version", s.getVersion());
        m.put("description", s.getDescription());
        m.put("triggerKeywords", s.getTriggerKeywords());
        m.put("sopContent", s.getSopContent());
        m.put("code", s.getCode());
        m.put("allowedRoles", s.getAllowedRoles());
        m.put("actionScript", s.getActionScript());
        m.put("skillKind", s.getSkillKind());
        m.put("navHash", s.getNavHash());
        // bundle = 技能的**整个目录**（SKILL.md + 脚本 + 参考资料）。此前导出漏了它——
        // 导出的包只有元数据，脚本和参考文件全丢，导进去就是个空壳技能，跑不起来。
        // 以**对象**形态导出（而非转义过的 JSON 字符串），包可读、也便于人工审核脚本内容。
        if (s.getBundle() != null && !s.getBundle().isBlank()) {
            try {
                m.put("bundle", mapper.readValue(s.getBundle(),
                        new com.fasterxml.jackson.core.type.TypeReference<Map<String, String>>() {}));
            } catch (Exception ignored) { m.put("bundle", s.getBundle()); }   // 非法 JSON → 原样带出，不丢
        }
        return m;
    }

    private Map<String, Object> envelope(List<Skill> skills) {
        Map<String, Object> pkg = new LinkedHashMap<>();
        pkg.put("format", "iml-skill-package");
        pkg.put("formatVersion", 1);
        pkg.put("exportedAt", LocalDateTime.now().toString());
        pkg.put("skills", skills.stream().map(this::portable).toList());
        return pkg;
    }

    @Transactional(readOnly = true)
    public Map<String, Object> exportOne(String id) {
        Skill s = skillRepository.findById(id).orElseThrow(SkillService::notFound);
        return envelope(List.of(s));
    }

    /**
     * 导出为**真正的技能包**（zip 目录），而不是一坨 JSON。
     *
     * 为什么：技能包的通用形态就是一个目录（SKILL.md + scripts/ + 参考资料）——能直接看、直接改、
     * 直接给别人、也能被别的工具认。此前只导出 JSON 信封：即便把 bundle 塞进去，拿到手也是个
     * 166KB 的 blob，脚本读不了、改不了。而且**导入认 zip、导出吐 json**，本身就不对称。
     *
     * 包内结构：
     *   SKILL.md            —— 技能说明（bundle 里没有就按 sopContent 生成，保证导回去能认）
     *   scripts/…、*.md     —— bundle 里的原始文件，原样铺开
     *   iml-skill.json      —— iML 专有元数据（触发词/录制脚本/引擎类型/直达路由…），
     *                          纯 SKILL.md 装不下这些，丢了技能就跑不起来。导入时会读回。
     */
    @Transactional(readOnly = true)
    public byte[] exportZip(String id) {
        Skill s = skillRepository.findById(id).orElseThrow(SkillService::notFound);
        Map<String, String> files = new LinkedHashMap<>();
        if (s.getBundle() != null && !s.getBundle().isBlank()) {
            try {
                files.putAll(mapper.readValue(s.getBundle(),
                        new com.fasterxml.jackson.core.type.TypeReference<Map<String, String>>() {}));
            } catch (Exception ignored) { /* bundle 非法 JSON → 按无 bundle 处理，下面会生成 SKILL.md */ }
        }
        // 没有 SKILL.md（录制类技能就没有）→ 用技能元数据生成一份，否则导回去会被判"技能包内没有 SKILL.md"
        boolean hasMd = files.keySet().stream().anyMatch(k -> k.equalsIgnoreCase("SKILL.md"));
        if (!hasMd) files.put("SKILL.md", renderSkillMarkdown(s));

        // iML 专有元数据：SKILL.md 的 frontmatter 装不下录制脚本/直达路由/引擎类型，单独落一个文件
        Map<String, Object> meta = portable(s);
        meta.remove("bundle");   // 文件已经铺开在 zip 里了，不必再塞一份
        try { files.put("iml-skill.json", mapper.writerWithDefaultPrettyPrinter().writeValueAsString(meta)); }
        catch (Exception e) { throw new IllegalStateException("元数据序列化失败", e); }

        String root = safeDirName(s.getName(), s.getId());
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        try (java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(bos)) {
            for (Map.Entry<String, String> e : files.entrySet()) {
                zos.putNextEntry(new java.util.zip.ZipEntry(root + "/" + e.getKey()));
                zos.write(e.getValue().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                zos.closeEntry();
            }
        } catch (Exception e) { throw new IllegalStateException("技能包打包失败：" + e.getMessage(), e); }
        return bos.toByteArray();
    }

    /** 技能名 → 安全的目录名（去掉路径分隔符与空白；空则退回 id）。 */
    private static String safeDirName(String name, String id) {
        String n = (name == null ? "" : name).trim().replaceAll("[\\\\/:*?\"<>|\\s]+", "-");
        return n.isBlank() ? id : n;
    }

    /** 无 bundle 的技能（如录制类）→ 生成一份 SKILL.md，让导出的包仍是合法技能包。 */
    private static String renderSkillMarkdown(Skill s) {
        StringBuilder b = new StringBuilder();
        b.append("---\n");
        b.append("name: ").append(s.getName() == null ? "" : s.getName()).append("\n");
        if (s.getDescription() != null && !s.getDescription().isBlank())
            b.append("description: ").append(s.getDescription().replace("\n", " ")).append("\n");
        b.append("---\n\n");
        b.append("# ").append(s.getName() == null ? "" : s.getName()).append("\n\n");
        if (s.getDescription() != null && !s.getDescription().isBlank())
            b.append(s.getDescription()).append("\n\n");
        if (s.getSopContent() != null && !s.getSopContent().isBlank())
            b.append(s.getSopContent()).append("\n");
        return b.toString();
    }

    @Transactional(readOnly = true)
    public Map<String, Object> exportAll() {
        return envelope(skillRepository.findAll());
    }

    /** GitHub 域名白名单（防 SSRF：安装端点绝不允许指向任意地址/内网）。 */
    private static final Set<String> GITHUB_HOSTS = Set.of(
            "github.com", "raw.githubusercontent.com", "gist.github.com", "gist.githubusercontent.com", "api.github.com");
    /** 只收录文本类文件进 bundle（二进制/模板/图片跳过，避免撑爆库且无扫描意义）。 */
    private static final Set<String> TEXT_EXT = Set.of(
            "py","md","txt","json","js","mjs","cjs","ts","sh","bash","yaml","yml","toml","cfg","ini","csv","xml","html","htm","css","rst");
    private static final int MAX_BUNDLE_FILES = 60;
    private static final int MAX_BUNDLE_BYTES = 3_000_000;

    /** github.com 的 blob 页面地址自动转 raw 直链。 */
    private static String toRawUrl(String url) {
        // https://github.com/{owner}/{repo}/blob/{ref}/{path} → raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("^https://github\\.com/([^/]+)/([^/]+)/blob/(.+)$").matcher(url);
        if (m.matches()) return "https://raw.githubusercontent.com/" + m.group(1) + "/" + m.group(2) + "/" + m.group(3);
        return url;
    }

    private final java.net.http.HttpClient ghHttp = java.net.http.HttpClient.newBuilder()
            .connectTimeout(java.time.Duration.ofSeconds(10))
            .followRedirects(java.net.http.HttpClient.Redirect.NORMAL)
            .proxy(java.net.ProxySelector.getDefault())
            .build();

    /** GitHub 域名内的 GET（防 SSRF：仅白名单主机；带上限）。 */
    private byte[] ghGet(String url, int maxBytes) {
        if (url == null || !url.startsWith("https://")) throw new IllegalArgumentException("仅支持 https 的 GitHub 地址");
        String host;
        try { host = java.net.URI.create(url).getHost(); } catch (Exception e) { throw new IllegalArgumentException("地址无效"); }
        if (host == null || !GITHUB_HOSTS.contains(host.toLowerCase()))
            throw new IllegalArgumentException("仅允许 GitHub 域名——防止内网探测");
        try {
            java.net.http.HttpRequest.Builder b = java.net.http.HttpRequest.newBuilder(java.net.URI.create(url))
                    .timeout(java.time.Duration.ofSeconds(30)).header("User-Agent", "iml-work").GET();
            java.net.http.HttpResponse<byte[]> res = ghHttp.send(b.build(), java.net.http.HttpResponse.BodyHandlers.ofByteArray());
            if (res.statusCode() / 100 != 2) throw new IllegalArgumentException("GitHub 请求失败 HTTP " + res.statusCode()
                    + (res.statusCode() == 403 ? "（可能触发匿名 API 限流，稍后重试）" : ""));
            if (res.body().length > maxBytes) throw new IllegalArgumentException("内容超过上限 " + (maxBytes / 1_000_000) + "MB");
            return res.body();
        } catch (IllegalArgumentException e) { throw e; }
        catch (Exception e) { throw new IllegalArgumentException("下载失败：" + e.getMessage()); }
    }

    /** 单文件下载（JSON 包 / 单 SKILL.md），2MB 上限。 */
    public String downloadFromGithub(String url) {
        return new String(ghGet(toRawUrl(url.trim()), 2_000_000), StandardCharsets.UTF_8);
    }

    private record GhLoc(String owner, String repo, String ref, String dir) {}

    /** 解析 GitHub 目录/文件地址；返回技能目录（blob/…/SKILL.md → 其父目录；tree/…/dir → 该目录）。非目录返回 null。 */
    private GhLoc resolveSkillDir(String url) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("^https://github\\.com/([^/]+)/([^/]+)/(blob|tree)/([^/]+)/(.+)$").matcher(url.trim());
        if (!m.matches()) return null;
        String path = m.group(5);
        if ("blob".equals(m.group(3))) {
            if (!path.toLowerCase().endsWith("/skill.md") && !path.equalsIgnoreCase("skill.md")) return null; // 单文件(非 SKILL.md)走原逻辑
            int slash = path.lastIndexOf('/');
            path = slash > 0 ? path.substring(0, slash) : "";
        }
        return new GhLoc(m.group(1), m.group(2), m.group(4), path);
    }

    /** 递归抓取技能目录下的文本文件（相对目录的路径 → 内容）；二进制/超限跳过。 */
    private Map<String, String> fetchGithubBundle(GhLoc loc) {
        Map<String, String> files = new LinkedHashMap<>();
        int[] total = {0};
        crawl(loc, loc.dir(), "", files, total);
        if (files.keySet().stream().noneMatch(k -> k.equalsIgnoreCase("SKILL.md")))
            throw new IllegalArgumentException("目录内未找到 SKILL.md");
        return files;
    }

    private void crawl(GhLoc loc, String apiPath, String rel, Map<String, String> out, int[] total) {
        if (out.size() >= MAX_BUNDLE_FILES || total[0] >= MAX_BUNDLE_BYTES) return;
        String api = "https://api.github.com/repos/" + loc.owner() + "/" + loc.repo()
                + "/contents/" + apiPath + "?ref=" + loc.ref();
        try {
            com.fasterxml.jackson.databind.JsonNode arr = mapper.readTree(new String(ghGet(api, 1_000_000), StandardCharsets.UTF_8));
            if (!arr.isArray()) return;
            for (com.fasterxml.jackson.databind.JsonNode n : arr) {
                if (out.size() >= MAX_BUNDLE_FILES || total[0] >= MAX_BUNDLE_BYTES) break;
                String name = n.path("name").asText(), type = n.path("type").asText();
                String childRel = rel.isEmpty() ? name : rel + "/" + name;
                if ("dir".equals(type)) {
                    crawl(loc, apiPath + "/" + name, childRel, out, total);
                } else if ("file".equals(type)) {
                    String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : "";
                    long size = n.path("size").asLong(0);
                    if (!TEXT_EXT.contains(ext)) continue;              // 跳过二进制/模板/图片
                    if (size > 500_000) continue;                       // 跳过异常大文件
                    String dl = n.path("download_url").asText("");
                    if (dl.isBlank()) continue;
                    String content = new String(ghGet(dl, 500_000), StandardCharsets.UTF_8);
                    out.put(childRel, content);
                    total[0] += content.length();
                }
            }
        } catch (IllegalArgumentException e) { throw e; }
        catch (Exception e) { throw new IllegalArgumentException("读取目录失败：" + e.getMessage()); }
    }

    /** 解析技能包：自动识别 iML JSON 包 / 通用 SKILL.md(YAML frontmatter+Markdown) 两种格式。 */
    private List<Skill> parsePackage(String raw) {
        if (raw == null || raw.isBlank()) throw new IllegalArgumentException("技能包内容为空");
        String head = raw.stripLeading();
        // 非 JSON 起始({/[) → 当作 SKILL.md 解析(复用上传解析器);GitHub 上多为此格式
        if (!head.startsWith("{") && !head.startsWith("[")) {
            Skill s = parseSkillMarkdown(raw);
            if (s.getName() == null || s.getName().isBlank())
                throw new IllegalArgumentException("SKILL.md 缺少 name 字段（frontmatter 内 name:）");
            ensureTriggerKeywords(s);   // 外源 SKILL.md 无 trigger_keywords → 自动派生
            s.setId("skill-imp-" + UUID.randomUUID().toString().substring(0, 8));
            s.setStatus("DRAFT");
            s.setSource("imported");
            s.setUpdatedAt(LocalDateTime.now());
            return new ArrayList<>(List.of(s));
        }
        return parseJsonPackage(raw);
    }

    /** 解析 iML JSON 包（信封 / 单技能 / 数组三种形态），转为待装 Skill 列表（未落库）。 */
    private List<Skill> parseJsonPackage(String json) {
        try {
            com.fasterxml.jackson.databind.JsonNode root = mapper.readTree(json);
            com.fasterxml.jackson.databind.JsonNode arr =
                    root.has("skills") ? root.get("skills") : (root.isArray() ? root : mapper.createArrayNode().add(root));
            List<Skill> out = new ArrayList<>();
            for (com.fasterxml.jackson.databind.JsonNode n : arr) {
                Skill s = new Skill();
                s.setId("skill-imp-" + UUID.randomUUID().toString().substring(0, 8));
                s.setName(n.path("name").asText(""));
                if (s.getName().isBlank()) throw new IllegalArgumentException("技能缺少 name 字段");
                s.setType(n.path("type").asText("playwright"));
                s.setCategory(n.path("category").asText("导入技能"));
                s.setVersion(n.path("version").asText("1.0.0"));
                s.setDescription(n.path("description").asText(""));
                s.setSopContent(n.path("sopContent").asText(""));
                s.setCode(n.path("code").asText(""));
                s.setActionScript(n.path("actionScript").asText(""));
                s.setSkillKind(n.path("skillKind").asText(""));
                s.setNavHash(n.path("navHash").asText(""));
                // bundle：导出时是对象、手写包里也可能是字符串——两种都收，否则脚本目录悄悄丢失。
                com.fasterxml.jackson.databind.JsonNode bn = n.path("bundle");
                if (bn.isObject()) {
                    try { s.setBundle(mapper.writeValueAsString(bn)); } catch (Exception ignored) { /* 序列化失败则不带 bundle */ }
                } else if (bn.isTextual() && !bn.asText().isBlank()) {
                    s.setBundle(bn.asText());
                }
                List<String> kws = new ArrayList<>();
                n.path("triggerKeywords").forEach(k -> kws.add(k.asText()));
                s.setTriggerKeywords(kws);
                List<String> roles = new ArrayList<>();
                n.path("allowedRoles").forEach(r -> roles.add(r.asText()));
                s.setAllowedRoles(roles);
                // 安全默认：导入即 DRAFT（人工审核后再上架）；外源系统绑定清空
                s.setStatus("DRAFT");
                s.setSource("imported");
                if (n.has("targetSystemId") && !n.path("targetSystemId").asText("").isBlank()) {
                    s.setTargetSystemId(n.path("targetSystemId").asText());   // 保留原值供扫描器报出，落库前清空
                }
                s.setUpdatedAt(LocalDateTime.now());
                out.add(s);
            }
            if (out.isEmpty()) throw new IllegalArgumentException("包内没有技能");
            if (out.size() > 50) throw new IllegalArgumentException("单包技能数超过 50 上限");
            return out;
        } catch (IllegalArgumentException e) { throw e; }
        catch (Exception e) { throw new IllegalArgumentException("技能包 JSON 解析失败：" + e.getMessage()); }
    }

    /**
     * 导入技能包：先安全扫描（参考 AI-Infra-Guard 风险模型），HIGH 一律阻断；
     * confirm=false 仅返回预检报告；confirm=true 且无 HIGH 时以 DRAFT 落库。
     */
    @Transactional
    public Map<String, Object> importPackage(String json, boolean confirm, String sourceTag) {
        return importPackage(json, confirm, sourceTag, false);
    }

    /** force=true：管理员已人工审核安全报告，接受 HIGH 风险强制安装（审计走 source 标记 + DRAFT 人工上架）。 */
    @Transactional
    public Map<String, Object> importPackage(String json, boolean confirm, String sourceTag, boolean force) {
        List<Skill> skills = parsePackage(json);
        List<Map<String, Object>> perSkill = new ArrayList<>();
        boolean hasHigh = false;
        for (Skill s : skills) {
            List<SkillSecurityService.Finding> fs = security.scan(s);
            Map<String, Object> rep = security.report(fs);
            if ("HIGH".equals(rep.get("risk"))) hasHigh = true;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", s.getName());
            m.put("description", s.getDescription());
            m.put("keywords", s.getTriggerKeywords());
            m.put("security", rep);
            perSkill.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("skills", perSkill);
        out.put("blocked", hasHigh && !force);
        if (!confirm) { out.put("preview", true); return out; }
        if (hasHigh && !force) {
            out.put("success", false);
            out.put("error", "存在 HIGH 级安全发现，已阻断安装。请人工审核安全报告后选择「接受风险安装」，或修复技能包重试。");
            return out;
        }
        if (hasHigh) out.put("forced", true);   // 管理员确认后的强制安装，落库仍为 DRAFT 待人工上架
        List<String> ids = new ArrayList<>();
        for (Skill s : skills) {
            s.setTargetSystemId(null);   // 外源环境系统 id 无意义，清空待重新绑定
            s.setSource(sourceTag == null ? "imported" : sourceTag);
            skillRepository.save(s);
            ids.add(s.getId());
        }
        out.put("success", true);
        out.put("installed", ids);
        return out;
    }

    /** GitHub 安装入口：目录地址 → 整目录 bundle 技能(SKILL.md+scripts);单文件 → 走包解析。force 语义同 importPackage。 */
    @Transactional
    public Map<String, Object> importGithub(String url, boolean confirm, boolean force) {
        GhLoc loc = resolveSkillDir(url);
        if (loc == null) return importPackage(downloadFromGithub(url), confirm, "github", force);   // 单文件(JSON/单md)

        Map<String, String> bundle = fetchGithubBundle(loc);
        String fallbackName = loc.dir().substring(loc.dir().lastIndexOf('/') + 1);
        return installBundle(bundle, fallbackName, "github-dir", confirm, force);
    }

    /**
     * 从**技能目录**（SKILL.md + 脚本 + 参考资料）安装技能。GitHub 目录导入与本地 zip 导入共用这一条路径
     * ——安全扫描、类型派生、关键词派生、DRAFT 落库的规则必须**一模一样**，不能因为来源不同就松一档。
     */
    @Transactional
    public Map<String, Object> installBundle(Map<String, String> bundle, String fallbackName,
                                             String sourceTag, boolean confirm, boolean force) {
        String skillMd = bundle.entrySet().stream().filter(e -> e.getKey().equalsIgnoreCase("SKILL.md"))
                .map(Map.Entry::getValue).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("技能包内没有 SKILL.md（技能目录必须含 SKILL.md）"));
        Skill s = parseSkillMarkdown(skillMd);
        if (s.getName() == null || s.getName().isBlank()) s.setName(fallbackName);

        // iML 专有元数据（我们自己导出的包会带）：触发词、录制脚本、引擎类型、直达路由——
        // 这些 SKILL.md 的 frontmatter 装不下，丢了技能装进去也跑不起来（触发词没了 → 客户端永远匹配不到）。
        // 从 bundle 里取出后**移出 bundle**：它是元数据，不是技能文件，不该被当脚本扫描、也不该铺回目录。
        String metaJson = null;
        for (Map.Entry<String, String> e : new ArrayList<>(bundle.entrySet())) {
            if (e.getKey().equalsIgnoreCase("iml-skill.json")) { metaJson = e.getValue(); bundle.remove(e.getKey()); }
        }
        if (metaJson != null) applyImlMeta(s, metaJson);

        ensureTriggerKeywords(s);   // 外源 SKILL.md 无 trigger_keywords → 自动派生，否则客户端永远匹配不到
        s.setId("skill-imp-" + UUID.randomUUID().toString().substring(0, 8));
        s.setStatus("DRAFT");
        s.setSource(sourceTag);
        s.setUpdatedAt(LocalDateTime.now());
        // 按目录内是否含可执行脚本定引擎类型（未显式声明 type 时）：纯指南目录 → knowledge，不进沙箱
        if (s.getType() == null || "knowledge".equals(s.getType())) s.setType(deriveTypeFromBundle(bundle));
        try { s.setBundle(mapper.writeValueAsString(bundle)); } catch (Exception e) { throw new IllegalArgumentException("bundle 序列化失败"); }

        // 安全扫描：SKILL.md(随 Skill) + 所有脚本文件
        List<SkillSecurityService.Finding> findings = new ArrayList<>(security.scan(s));
        findings.addAll(security.scanBundle(bundle));
        Map<String, Object> rep = security.report(findings);
        boolean high = "HIGH".equals(rep.get("risk"));

        Map<String, Object> skInfo = new LinkedHashMap<>();
        skInfo.put("name", s.getName());
        skInfo.put("description", s.getDescription());
        skInfo.put("keywords", s.getTriggerKeywords());
        skInfo.put("bundleFiles", new ArrayList<>(bundle.keySet()));
        skInfo.put("security", rep);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("skills", List.of(skInfo));
        out.put("blocked", high && !force);
        if (!confirm) { out.put("preview", true); return out; }
        if (high && !force) {
            out.put("success", false);
            out.put("error", "存在 HIGH 级安全发现，已阻断安装。请人工审核安全报告后选择「接受风险安装」，或修复技能包重试。");
            return out;
        }
        if (high) out.put("forced", true);   // 管理员确认后的强制安装，落库仍为 DRAFT 待人工上架
        s.setTargetSystemId(null);
        skillRepository.save(s);
        out.put("success", true);
        out.put("installed", List.of(s.getId()));
        return out;
    }

    /** 把 iml-skill.json 里的元数据合并到技能上（只补 SKILL.md 装不下的字段，不覆盖已从 md 解析出的名称/描述）。 */
    private void applyImlMeta(Skill s, String metaJson) {
        try {
            com.fasterxml.jackson.databind.JsonNode n = mapper.readTree(metaJson);
            if (blank(s.getName())) s.setName(n.path("name").asText(""));
            if (blank(s.getDescription())) s.setDescription(n.path("description").asText(""));
            if (!n.path("type").asText("").isBlank()) s.setType(n.path("type").asText());
            if (!n.path("category").asText("").isBlank()) s.setCategory(n.path("category").asText());
            if (!n.path("version").asText("").isBlank()) s.setVersion(n.path("version").asText());
            if (blank(s.getSopContent())) s.setSopContent(n.path("sopContent").asText(""));
            if (!n.path("code").asText("").isBlank()) s.setCode(n.path("code").asText());
            if (!n.path("actionScript").asText("").isBlank()) s.setActionScript(n.path("actionScript").asText());
            if (!n.path("skillKind").asText("").isBlank()) s.setSkillKind(n.path("skillKind").asText());
            if (!n.path("navHash").asText("").isBlank()) s.setNavHash(n.path("navHash").asText());
            if (n.path("triggerKeywords").isArray() && (s.getTriggerKeywords() == null || s.getTriggerKeywords().isEmpty())) {
                List<String> kws = new ArrayList<>();
                n.path("triggerKeywords").forEach(k -> kws.add(k.asText()));
                s.setTriggerKeywords(kws);
            }
            if (n.path("allowedRoles").isArray()) {
                List<String> roles = new ArrayList<>();
                n.path("allowedRoles").forEach(r -> roles.add(r.asText()));
                if (!roles.isEmpty()) s.setAllowedRoles(roles);
            }
        } catch (Exception ignored) { /* 元数据坏了不阻断安装：SKILL.md 仍是技能的主体 */ }
    }

    private static boolean blank(String x) { return x == null || x.isBlank(); }

    /**
     * 解压技能包 zip → 文件目录（复用 GitHub 目录导入的同一套白名单与上限）。
     * 只收文本类文件；目录前缀（GitHub 下载的 zip 常带一层 repo-name/）自动剥掉。
     * 防 zip-slip：条目名含 .. 或绝对路径一律拒收。
     */
    public Map<String, String> unzipBundle(byte[] data) {
        Map<String, String> files = new LinkedHashMap<>();
        long total = 0;
        try (java.util.zip.ZipInputStream zis = new java.util.zip.ZipInputStream(new java.io.ByteArrayInputStream(data))) {
            java.util.zip.ZipEntry e;
            while ((e = zis.getNextEntry()) != null) {
                if (e.isDirectory()) continue;
                String name = e.getName().replace('\\', '/');
                if (name.contains("..") || name.startsWith("/")) throw new IllegalArgumentException("技能包内含非法路径：" + name);
                if (name.contains("__MACOSX/") || name.substring(name.lastIndexOf('/') + 1).startsWith("._")) continue;
                String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase() : "";
                if (!TEXT_EXT.contains(ext)) continue;                      // 二进制/图片跳过：撑库且无扫描意义
                if (files.size() >= MAX_BUNDLE_FILES) throw new IllegalArgumentException("技能包文件数超过上限 " + MAX_BUNDLE_FILES);
                byte[] buf = zis.readAllBytes();
                total += buf.length;
                if (total > MAX_BUNDLE_BYTES) throw new IllegalArgumentException("技能包总大小超过上限 " + (MAX_BUNDLE_BYTES / 1_000_000) + "MB");
                files.put(name, new String(buf, java.nio.charset.StandardCharsets.UTF_8));
            }
        } catch (IllegalArgumentException ex) { throw ex;
        } catch (Exception ex) { throw new IllegalArgumentException("技能包解压失败：" + ex.getMessage()); }
        if (files.isEmpty()) throw new IllegalArgumentException("技能包里没有可识别的文本文件");
        return stripCommonPrefix(files);
    }

    /** 剥掉 zip 里统一的顶层目录（如 my-skill/SKILL.md → SKILL.md），否则找不到 SKILL.md。 */
    private static Map<String, String> stripCommonPrefix(Map<String, String> files) {
        String prefix = null;
        for (String k : files.keySet()) {
            int i = k.indexOf('/');
            if (i < 0) return files;                       // 有文件在根，说明没有统一前缀
            String p = k.substring(0, i + 1);
            if (prefix == null) prefix = p;
            else if (!prefix.equals(p)) return files;      // 前缀不一致 → 不剥
        }
        if (prefix == null) return files;
        Map<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<String, String> e : files.entrySet()) out.put(e.getKey().substring(prefix.length()), e.getValue());
        return out;
    }
}
