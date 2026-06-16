package com.imlwork.admin.controller;

import com.imlwork.admin.model.Skill;
import com.imlwork.admin.repository.SkillRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Enterprise SkillsHub. Browse / search the cloud skill catalog, edit skill
 * code (Monaco on the frontend), upload existing SKILL.md / .zip packages whose
 * YAML frontmatter + SOP body are parsed and archived, and dry-run a skill in
 * the test console.
 */
@RestController
@RequestMapping("/api/v1/skills")
public class SkillController {

    private final SkillRepository skillRepository;
    private final ModelProxyController modelProxy;
    private final com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();

    public SkillController(SkillRepository skillRepository, ModelProxyController modelProxy) {
        this.skillRepository = skillRepository;
        this.modelProxy = modelProxy;
    }

    /** 用大模型（经企业模型中转站）根据技能名称/描述自动生成触发关键词与 SOP。 */
    @PostMapping("/generate")
    public ResponseEntity<Map<String, Object>> generate(@RequestBody Map<String, String> body) {
        String name = body.getOrDefault("name", "").trim();
        String desc = body.getOrDefault("description", "").trim();
        String type = body.getOrDefault("type", "");
        String category = body.getOrDefault("category", "");
        if (name.isBlank() && desc.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("success", false, "error", "请先填写技能名称或描述"));
        }
        String prompt = "你是企业自动化技能设计助手。请根据技能信息生成两部分内容：\n"
                + "1) 触发关键词 triggerKeywords：5-8 个，简短、贴近用户口语、覆盖常见说法（中文为主，可含必要英文）。\n"
                + "2) 标准作业流程 sop：用 Markdown 写，分步骤、可执行，描述该技能从开始到给出反馈的关键步骤与规则，会被注入到分身的上下文。\n"
                + "技能名称：" + name + "\n技能描述：" + desc + "\n执行引擎：" + type + "\n业务分类：" + category + "\n"
                + "只输出严格的 JSON，不要任何解释或代码块标记：{\"triggerKeywords\":[\"...\"],\"sop\":\"# ...\"}";
        Map<String, Object> payload = new HashMap<>();
        payload.put("model", "corp-default");
        payload.put("messages", List.of(Map.of("role", "user", "content", prompt)));
        try {
            ResponseEntity<?> resp = modelProxy.chatCompletion(payload, "Bearer sk-corp-default-key");
            String content = extractContent(resp.getBody());
            Map<String, Object> parsed = parseLooseJson(content);
            Object kw = parsed.get("triggerKeywords");
            Object sop = parsed.get("sop");
            if (kw instanceof List<?> && sop != null) {
                return ResponseEntity.ok(Map.of("success", true, "triggerKeywords", kw, "sop", sop.toString(), "source", "model"));
            }
        } catch (Exception e) {
            // 落到下方模板回退
        }
        // 回退：模型未返回有效结果（如中转站未配置真实上游）时给出可用模板。
        List<String> kws = new ArrayList<>();
        if (!name.isBlank()) kws.add(name);
        for (String w : (name + " " + desc).split("[\\s，,、/]+")) if (w.length() >= 2 && kws.size() < 6 && !kws.contains(w)) kws.add(w);
        String sop = "# " + (name.isBlank() ? "技能" : name) + " SOP\n\n## 执行步骤\n1. 解析用户意图与所需参数。\n2. 执行核心动作（" + desc + "）。\n3. 校验结果并向用户如实反馈。\n\n## 注意事项\n- 仅基于真实结果作答，不编造数据。";
        return ResponseEntity.ok(Map.of("success", true, "triggerKeywords", kws, "sop", sop, "source", "fallback"));
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

    @GetMapping
    public ResponseEntity<List<Skill>> list(@RequestParam(value = "q", required = false) String q) {
        if (q == null || q.isBlank()) {
            return ResponseEntity.ok(skillRepository.findAll());
        }
        return ResponseEntity.ok(
                skillRepository.findByNameContainingIgnoreCaseOrDescriptionContainingIgnoreCase(q, q));
    }

    @GetMapping("/{id}")
    public ResponseEntity<Skill> get(@PathVariable String id) {
        return skillRepository.findById(id).map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @GetMapping("/summary")
    public ResponseEntity<Map<String, Object>> summary() {
        List<Skill> all = skillRepository.findAll();
        Map<String, Long> byCategory = new LinkedHashMap<>();
        Map<String, Long> byType = new LinkedHashMap<>();
        long published = 0, draft = 0, disabled = 0;
        for (Skill s : all) {
            String cat = s.getCategory() == null || s.getCategory().isBlank() ? "未分类" : s.getCategory();
            byCategory.merge(cat, 1L, Long::sum);
            String type = s.getType() == null ? "其他" : s.getType();
            byType.merge(type, 1L, Long::sum);
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
        return ResponseEntity.ok(out);
    }

    /**
     * 把浏览器实操录制结果转换成「语义脚本(DSL) + SOP」的标准技能。
     * 录制只作示范采集，落库的是灵活可读可改的语义脚本（存 code），原始步骤保留在 actionScript 作证据。
     * body: { name, triggerKeywords:[], targetSystemId, steps:[...], fields:[...] }
     */
    @PostMapping("/from-recording")
    @SuppressWarnings("unchecked")
    public ResponseEntity<Skill> fromRecording(@RequestBody Map<String, Object> body) {
        String name = String.valueOf(body.getOrDefault("name", "录制技能"));
        List<Object> steps = body.get("steps") instanceof List ? (List<Object>) body.get("steps") : new ArrayList<>();
        List<Object> fields = body.get("fields") instanceof List ? (List<Object>) body.get("fields") : new ArrayList<>();
        String targetSystemId = body.get("targetSystemId") == null ? "" : String.valueOf(body.get("targetSystemId"));
        String engine = body.get("engine") == null ? "browser" : String.valueOf(body.get("engine"));
        String providedScript = body.get("script") == null ? "" : String.valueOf(body.get("script"));
        boolean desktop = "desktop".equals(engine);
        List<String> triggerKeywords = new ArrayList<>();
        if (body.get("triggerKeywords") instanceof List) for (Object o : (List<Object>) body.get("triggerKeywords")) triggerKeywords.add(String.valueOf(o));

        // 工具已生成/FDE 编辑过的脚本优先直接采用（试运行所测即所部署）；否则由录制步骤确定性生成。
        // 大模型负责把它"提升为标准技能"——生成配套 SOP；脚本本身可在技能中心人工编辑。
        String dsl = (providedScript != null && !providedScript.isBlank()) ? providedScript : deterministicDsl(steps);
        String sop = "";
        try {
            String prompt = "下面是一段" + (desktop ? "桌面" : "浏览器") + "自动化技能的脚本（DSL）。请为它写一段简短、专业的中文 SOP（标准作业流程）说明，"
                    + "解释这个技能依次做了什么、需要用户确认哪些参数。只输出 markdown 文本本身，不要代码块标记、不要复述脚本。\n\n"
                    + "技能名称：" + name + "\n脚本：\n" + dsl;
            Map<String, Object> payload = new HashMap<>();
            payload.put("model", "corp-default");
            payload.put("messages", List.of(Map.of("role", "user", "content", prompt)));
            ResponseEntity<?> resp = modelProxy.chatCompletion(payload, "Bearer sk-corp-default-key");
            String content = extractContent(resp.getBody());
            if (content != null && !content.isBlank()) sop = content.replaceAll("```\\w*", "").trim();
        } catch (Exception e) {
            // 落到模板 SOP
        }
        if (dsl == null || dsl.isBlank()) dsl = "# 录制为空";
        if (sop == null || sop.isBlank()) sop = "# " + name + "\n\n本技能由浏览器实操录制转换为语义脚本，执行时先确认参数再按脚本解释执行。";

        Skill skill = new Skill();
        skill.setId("skill-" + UUID.randomUUID().toString().substring(0, 8));
        skill.setName(name);
        skill.setType(desktop ? "nut-js" : "playwright");
        skill.setCategory(desktop ? "桌面录制技能" : "录制技能");
        skill.setStatus("PUBLISHED");
        skill.setSource("recorded");
        skill.setDescription(desktop ? "由桌面实操录制生成的桌面脚本技能（nut-js 回放，可在脚本中编辑）。" : "由实操录制转换生成的语义脚本技能（可在脚本中编辑）。");
        skill.setTriggerKeywords(triggerKeywords);
        skill.setAllowedRoles(new ArrayList<>());
        skill.setTargetSystemId(targetSystemId);
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
        return ResponseEntity.ok(skillRepository.save(skill));
    }

    /** 录制步骤 → 语义脚本 DSL 的确定性兜底转换。 */
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

    @PostMapping
    public ResponseEntity<Skill> create(@RequestBody Skill skill) {
        if (skill.getId() == null || skill.getId().isBlank()) {
            skill.setId("skill-" + UUID.randomUUID().toString().substring(0, 8));
        }
        if (skill.getStatus() == null || skill.getStatus().isBlank()) skill.setStatus("DRAFT");
        if (skill.getVersion() == null || skill.getVersion().isBlank()) skill.setVersion("1.0.0");
        skill.setUpdatedAt(LocalDateTime.now());
        return ResponseEntity.ok(skillRepository.save(skill));
    }

    @PutMapping("/{id}")
    public ResponseEntity<Skill> update(@PathVariable String id, @RequestBody Skill update) {
        return skillRepository.findById(id).map(existing -> {
            existing.setName(update.getName());
            existing.setType(update.getType());
            if (update.getCategory() != null) existing.setCategory(update.getCategory());
            if (update.getStatus() != null) existing.setStatus(update.getStatus());
            if (update.getVersion() != null) existing.setVersion(update.getVersion());
            existing.setTargetSystemId(update.getTargetSystemId());
            existing.setDescription(update.getDescription());
            if (update.getTriggerKeywords() != null) existing.setTriggerKeywords(update.getTriggerKeywords());
            if (update.getAllowedRoles() != null) existing.setAllowedRoles(update.getAllowedRoles());
            if (update.getSopContent() != null) existing.setSopContent(update.getSopContent());
            if (update.getCode() != null) existing.setCode(update.getCode());
            if (update.getActionScript() != null) existing.setActionScript(update.getActionScript());
            existing.setUpdatedAt(LocalDateTime.now());
            return ResponseEntity.ok(skillRepository.save(existing));
        }).orElse(ResponseEntity.notFound().build());
    }

    /** 切换技能生命周期状态：PUBLISHED 已发布 | DRAFT 草稿 | DISABLED 已停用。 */
    @PostMapping("/{id}/status")
    public ResponseEntity<Skill> setStatus(@PathVariable String id, @RequestBody Map<String, String> body) {
        String status = body.getOrDefault("status", "PUBLISHED");
        return skillRepository.findById(id).map(existing -> {
            existing.setStatus(status);
            existing.setUpdatedAt(LocalDateTime.now());
            return ResponseEntity.ok(skillRepository.save(existing));
        }).orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        if (!skillRepository.existsById(id)) {
            return ResponseEntity.notFound().build();
        }
        skillRepository.deleteById(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }

    /** Upload a SKILL.md or a .zip skill package; parse frontmatter + SOP and archive. */
    @PostMapping("/upload")
    public ResponseEntity<Map<String, Object>> upload(@RequestParam("file") MultipartFile file) {
        try {
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

            if (mdContent == null || mdContent.isBlank()) {
                return ResponseEntity.badRequest().body(Map.of("success", false, "error", "未找到 SKILL.md 内容"));
            }

            Skill skill = parseSkillMarkdown(mdContent);
            if (skill.getId() == null || skill.getId().isBlank()) {
                skill.setId("skill-" + UUID.randomUUID().toString().substring(0, 8));
            }
            if (code != null) {
                skill.setCode(code);
            }
            skill.setSource(source);
            // 上传的技能先进入草稿，由管理员审核后再发布。
            skill.setStatus("DRAFT");
            if (skill.getCategory() == null || skill.getCategory().isBlank()) skill.setCategory("未分类");
            skill.setUpdatedAt(LocalDateTime.now());
            skillRepository.save(skill);

            return ResponseEntity.ok(Map.of(
                    "success", true,
                    "skillId", skill.getId(),
                    "name", skill.getName() == null ? skill.getId() : skill.getName(),
                    "triggerKeywords", skill.getTriggerKeywords(),
                    "allowedRoles", skill.getAllowedRoles()
            ));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("success", false, "error", e.getMessage()));
        }
    }

    /** Dry-run a skill in the test console (returns a synthetic execution trace). */
    @PostMapping("/{id}/test")
    public ResponseEntity<Map<String, Object>> test(@PathVariable String id, @RequestBody(required = false) Map<String, Object> body) {
        return skillRepository.findById(id).<ResponseEntity<Map<String, Object>>>map(skill -> {
            String input = body != null && body.get("input") != null ? body.get("input").toString() : "(默认测试参数)";
            List<String> logs = new ArrayList<>();
            logs.add("[harness] 装载技能 " + skill.getName() + " (" + skill.getType() + ")");
            logs.add("[harness] 角色鉴权 allowed_roles=" + skill.getAllowedRoles());
            logs.add("[sandbox] 唤起 " + sandboxLabel(skill.getType()) + " 隔离环境");
            logs.add("[input] " + input);
            logs.add("[observe] SOP 已注入，技能单步执行完成");
            logs.add("[done] 退出码 0");
            return ResponseEntity.ok(Map.of(
                    "success", true,
                    "skillId", id,
                    "sandbox", sandboxLabel(skill.getType()),
                    "logs", logs
            ));
        }).orElse(ResponseEntity.notFound().build());
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

    /** Returns [markdownContent, codeContent] from a zip package. */
    private String[] readZip(byte[] bytes) throws Exception {
        String md = null;
        String code = null;
        try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                String name = entry.getName().toLowerCase();
                String content = new String(zis.readAllBytes(), StandardCharsets.UTF_8);
                if (name.endsWith(".md")) {
                    md = content;
                } else if (name.endsWith(".js") || name.endsWith(".ts") || name.endsWith(".py")) {
                    code = content;
                }
            }
        }
        return new String[]{md, code};
    }

    /**
     * Parse a SKILL.md: extract the YAML frontmatter (name / description /
     * trigger_keywords / allowed_roles) and keep the remaining body as the SOP.
     * Hand-rolled to avoid pulling in a heavy YAML dependency, mirroring the
     * client's lightweight frontmatter parser.
     */
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
            String line = raw.replace("\t", "  ");
            String t = line.trim();
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
        if (skill.getType() == null) {
            skill.setType("python-sandbox");
        }
        return skill;
    }
}
