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

    public SkillController(SkillRepository skillRepository) {
        this.skillRepository = skillRepository;
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
            existing.setDescription(update.getDescription());
            if (update.getTriggerKeywords() != null) existing.setTriggerKeywords(update.getTriggerKeywords());
            if (update.getAllowedRoles() != null) existing.setAllowedRoles(update.getAllowedRoles());
            if (update.getSopContent() != null) existing.setSopContent(update.getSopContent());
            if (update.getCode() != null) existing.setCode(update.getCode());
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
