package com.imlwork.admin.service;

import com.imlwork.admin.model.Expert;
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

    @Transactional(readOnly = true)
    public List<Skill> list(String q) {
        var cap = org.springframework.data.domain.PageRequest.of(0, MAX_LIST,
                org.springframework.data.domain.Sort.by(org.springframework.data.domain.Sort.Direction.DESC, "updatedAt"));
        if (q == null || q.isBlank()) return skillRepository.findAll(cap).getContent();
        return skillRepository.findByNameContainingIgnoreCaseOrDescriptionContainingIgnoreCase(q, q, cap);
    }

    @Transactional(readOnly = true)
    public Skill get(String id) {
        return skillRepository.findById(id).orElseThrow(() -> notFound());
    }

    @Transactional(readOnly = true)
    public Map<String, Object> summary() {
        List<Skill> all = skillRepository.findAll();
        Map<String, Long> byCategory = new LinkedHashMap<>();
        Map<String, Long> byType = new LinkedHashMap<>();
        long published = 0, draft = 0, disabled = 0;
        for (Skill s : all) {
            String cat = s.getCategory() == null || s.getCategory().isBlank() ? "未分类" : s.getCategory();
            byCategory.merge(cat, 1L, Long::sum);
            byType.merge(s.getType() == null ? "其他" : s.getType(), 1L, Long::sum);
            String st = s.getStatus() == null ? "PUBLISHED" : s.getStatus();
            if ("PUBLISHED".equals(st)) published++;
            else if ("DRAFT".equals(st)) draft++;
            else if ("DISABLED".equals(st)) disabled++;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("total", all.size());
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
        skill.setUpdatedAt(LocalDateTime.now());
        return skillRepository.save(skill);
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
        String sop = (providedSop != null && !providedSop.isBlank()) ? providedSop : generateSop(name, dsl, fields, desktop);

        Skill skill = new Skill();
        skill.setId("skill-" + UUID.randomUUID().toString().substring(0, 8));
        skill.setName(name);
        skill.setType(desktop ? "nut-js" : "playwright");
        skill.setCategory(desktop ? "桌面录制技能" : "录制技能");
        skill.setStatus("PUBLISHED");
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
                if (act.equals("fill") || act.equals("select") || act.equals("search") || act.equals("pickOption")) return true;
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
            skill.setActionScript(mapper.writeValueAsString(as));
        } catch (Exception ignored) {}
        skill.setUpdatedAt(LocalDateTime.now());
        return skillRepository.save(skill);
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
    public Map<String, Object> upload(MultipartFile file) throws Exception {
        String filename = file.getOriginalFilename() == null ? "skill" : file.getOriginalFilename();
        String mdContent;
        String code = null;
        String source;
        if (filename.toLowerCase().endsWith(".zip")) {
            String[] extracted = readZip(file.getBytes());
            mdContent = extracted[0];
            code = extracted[1];
            source = "upload-zip";
        } else {
            mdContent = new String(file.getBytes(), StandardCharsets.UTF_8);
            source = "upload-md";
        }
        if (mdContent == null || mdContent.isBlank()) throw new IllegalArgumentException("未找到 SKILL.md 内容");
        Skill skill = parseSkillMarkdown(mdContent);
        if (skill.getId() == null || skill.getId().isBlank()) skill.setId("skill-" + UUID.randomUUID().toString().substring(0, 8));
        if (code != null) { skill.setCode(code); if ("knowledge".equals(skill.getType())) skill.setType("python-sandbox"); }
        skill.setSource(source);
        skill.setStatus("DRAFT");
        if (skill.getCategory() == null || skill.getCategory().isBlank()) skill.setCategory("未分类");
        skill.setUpdatedAt(LocalDateTime.now());
        skillRepository.save(skill);
        return Map.of("success", true, "skillId", skill.getId(),
                "name", skill.getName() == null ? skill.getId() : skill.getName(),
                "triggerKeywords", skill.getTriggerKeywords(), "allowedRoles", skill.getAllowedRoles());
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
        for (Expert e : expertRepository.findAll()) {
            List<Skill> sk = e.getSkills();
            if (sk != null && sk.removeIf(s -> s != null && skillId.equals(s.getId()))) {
                expertRepository.save(e);
            }
        }
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
        String skillMd = bundle.entrySet().stream().filter(e -> e.getKey().equalsIgnoreCase("SKILL.md"))
                .map(Map.Entry::getValue).findFirst().orElseThrow(() -> new IllegalArgumentException("目录内无 SKILL.md"));
        Skill s = parseSkillMarkdown(skillMd);
        if (s.getName() == null || s.getName().isBlank()) s.setName(loc.dir().substring(loc.dir().lastIndexOf('/') + 1));
        ensureTriggerKeywords(s);   // 外源 SKILL.md 无 trigger_keywords → 自动派生，否则客户端永远匹配不到
        s.setId("skill-imp-" + UUID.randomUUID().toString().substring(0, 8));
        s.setStatus("DRAFT");
        s.setSource("github-dir");
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
}
