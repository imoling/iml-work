package com.imlwork.admin.service;

import com.imlwork.admin.controller.ModelProxyController;
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

    private final SkillRepository skillRepository;
    private final ExpertRepository expertRepository;
    private final ModelProxyController modelProxy;
    private final SkillSecurityService security;
    private final ObjectMapper mapper = new ObjectMapper();

    public SkillService(SkillRepository skillRepository, ExpertRepository expertRepository,
                        ModelProxyController modelProxy, SkillSecurityService security) {
        this.skillRepository = skillRepository;
        this.expertRepository = expertRepository;
        this.modelProxy = modelProxy;
        this.security = security;
    }

    @Transactional(readOnly = true)
    public List<Skill> list(String q) {
        if (q == null || q.isBlank()) return skillRepository.findAll();
        return skillRepository.findByNameContainingIgnoreCaseOrDescriptionContainingIgnoreCase(q, q);
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
    public Skill update(String id, Skill update) {
        Skill existing = skillRepository.findById(id).orElseThrow(() -> notFound());
        existing.setName(update.getName());
        existing.setType(update.getType());
        if (update.getCategory() != null) existing.setCategory(update.getCategory());
        if (update.getStatus() != null) existing.setStatus(update.getStatus());
        if (update.getVersion() != null) existing.setVersion(update.getVersion());
        existing.setTargetSystemId(update.getTargetSystemId());
        if (update.getSkillKind() != null) existing.setSkillKind(update.getSkillKind());
        if (update.getNavHash() != null) existing.setNavHash(update.getNavHash());
        existing.setDescription(update.getDescription());
        if (update.getTriggerKeywords() != null) existing.setTriggerKeywords(update.getTriggerKeywords());
        if (update.getAllowedRoles() != null) existing.setAllowedRoles(update.getAllowedRoles());
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
                Object a = ((Map<?, ?>) o).get("act");
                String act = a == null ? "" : String.valueOf(a);
                return act.equals("fill") || act.equals("select") || act.equals("search") || act.equals("pickOption");
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
        if (code != null) skill.setCode(code);
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
        ResponseEntity<?> resp = modelProxy.chatCompletion(payload, "Bearer sk-corp-default-key");
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
        if (skill.getType() == null) skill.setType("python-sandbox");
        return skill;
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
            "github.com", "raw.githubusercontent.com", "gist.github.com", "gist.githubusercontent.com");

    /** github.com 的 blob 页面地址自动转 raw 直链。 */
    private static String toRawUrl(String url) {
        // https://github.com/{owner}/{repo}/blob/{ref}/{path} → raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("^https://github\\.com/([^/]+)/([^/]+)/blob/(.+)$").matcher(url);
        if (m.matches()) return "https://raw.githubusercontent.com/" + m.group(1) + "/" + m.group(2) + "/" + m.group(3);
        return url;
    }

    /** 从 GitHub 下载技能包（走系统代理，2MB 上限）。 */
    public String downloadFromGithub(String url) {
        if (url == null || !url.startsWith("https://")) throw new IllegalArgumentException("仅支持 https 的 GitHub 地址");
        String raw = toRawUrl(url.trim());
        String host;
        try { host = java.net.URI.create(raw).getHost(); } catch (Exception e) { throw new IllegalArgumentException("地址无效"); }
        if (host == null || !GITHUB_HOSTS.contains(host.toLowerCase())) {
            throw new IllegalArgumentException("仅允许 GitHub 域名（github.com / raw.githubusercontent.com / gist）——防止内网探测");
        }
        try {
            java.net.http.HttpClient http = java.net.http.HttpClient.newBuilder()
                    .connectTimeout(java.time.Duration.ofSeconds(10))
                    .followRedirects(java.net.http.HttpClient.Redirect.NORMAL)
                    .proxy(java.net.ProxySelector.getDefault())
                    .build();
            java.net.http.HttpRequest req = java.net.http.HttpRequest.newBuilder(java.net.URI.create(raw))
                    .timeout(java.time.Duration.ofSeconds(30)).GET().build();
            java.net.http.HttpResponse<byte[]> res = http.send(req, java.net.http.HttpResponse.BodyHandlers.ofByteArray());
            if (res.statusCode() / 100 != 2) throw new IllegalArgumentException("下载失败 HTTP " + res.statusCode());
            if (res.body().length > 2_000_000) throw new IllegalArgumentException("技能包超过 2MB 上限");
            return new String(res.body(), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) { throw e; }
        catch (Exception e) { throw new IllegalArgumentException("下载失败：" + e.getMessage()); }
    }

    /** 解析包 JSON（信封 / 单技能 / 数组三种形态），转为待装 Skill 列表（未落库）。 */
    private List<Skill> parsePackage(String json) {
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
        out.put("blocked", hasHigh);
        if (!confirm) { out.put("preview", true); return out; }
        if (hasHigh) {
            out.put("success", false);
            out.put("error", "存在 HIGH 级安全发现，已阻断安装。请修复技能包后重试。");
            return out;
        }
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
}
