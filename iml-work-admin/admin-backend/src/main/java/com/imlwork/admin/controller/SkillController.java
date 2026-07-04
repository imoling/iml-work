package com.imlwork.admin.controller;

import com.imlwork.admin.model.Skill;
import com.imlwork.admin.service.SkillService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

/** 企业技能中心。仅做 HTTP 塑形；目录/生命周期/录制转换/上传解析/模型生成在 {@link SkillService}。 */
@RestController
@RequestMapping("/api/v1/skills")
public class SkillController {

    private final SkillService service;

    public SkillController(SkillService service) {
        this.service = service;
    }

    @PostMapping("/generate")
    public ResponseEntity<Map<String, Object>> generate(@RequestBody Map<String, String> body) {
        return ResponseEntity.ok(service.generate(
                body.getOrDefault("name", ""), body.getOrDefault("description", ""),
                body.getOrDefault("type", ""), body.getOrDefault("category", "")));
    }

    @GetMapping
    public ResponseEntity<List<Skill>> list(@RequestParam(value = "q", required = false) String q) {
        return ResponseEntity.ok(service.list(q));
    }

    @GetMapping("/{id}")
    public Skill get(@PathVariable String id) {
        return service.get(id);
    }

    @GetMapping("/summary")
    public ResponseEntity<Map<String, Object>> summary() {
        return ResponseEntity.ok(service.summary());
    }

    @PostMapping("/from-recording")
    public Skill fromRecording(@RequestBody Map<String, Object> body) {
        return service.fromRecording(body);
    }

    @PostMapping("/gen-sop")
    public ResponseEntity<Map<String, Object>> genSop(@RequestBody Map<String, Object> body) {
        return ResponseEntity.ok(service.genSop(body));
    }

    @PostMapping
    public Skill create(@RequestBody Skill skill) {
        return service.create(skill);
    }

    @PutMapping("/{id}")
    public Skill update(@PathVariable String id, @RequestBody Skill update) {
        return service.update(id, update);
    }

    @PostMapping("/{id}/status")
    public Skill setStatus(@PathVariable String id, @RequestBody Map<String, String> body) {
        return service.setStatus(id, body.getOrDefault("status", "PUBLISHED"));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable String id) {
        return ResponseEntity.ok(service.delete(id));
    }

    @PostMapping("/upload")
    public ResponseEntity<Map<String, Object>> upload(@RequestParam("file") MultipartFile file) {
        try {
            return ResponseEntity.ok(service.upload(file));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("success", false, "error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("success", false, "error", e.getMessage()));
        }
    }

    @PostMapping("/{id}/test")
    public ResponseEntity<Map<String, Object>> test(@PathVariable String id, @RequestBody(required = false) Map<String, Object> body) {
        return ResponseEntity.ok(service.test(id, body));
    }

    // ── 技能包导出 / 安装（导入前强制安全检查，参考 AI-Infra-Guard 风险模型）──

    /** 导出单个技能为便携包（含信封,剥离本地系统绑定）。 */
    @GetMapping("/{id}/export")
    public ResponseEntity<Map<String, Object>> exportOne(@PathVariable String id) {
        return ResponseEntity.ok(service.exportOne(id));
    }

    /** 导出全部技能。 */
    @GetMapping("/export/all")
    public ResponseEntity<Map<String, Object>> exportAll() {
        return ResponseEntity.ok(service.exportAll());
    }

    /**
     * 从 GitHub 安装：confirm=false 仅安全预检；confirm=true 落库(DRAFT)。域名白名单防 SSRF。
     * force=true：管理员已人工审核安全报告，接受 HIGH 风险强制安装（如官方技能脚本合法使用 subprocess）。
     */
    @PostMapping("/import-github")
    public ResponseEntity<Map<String, Object>> importGithub(@RequestBody Map<String, Object> body) {
        String url = String.valueOf(body.getOrDefault("url", ""));
        boolean confirm = Boolean.TRUE.equals(body.get("confirm")) || "true".equals(String.valueOf(body.get("confirm")));
        boolean force = Boolean.TRUE.equals(body.get("force")) || "true".equals(String.valueOf(body.get("force")));
        if (url.isBlank()) throw new IllegalArgumentException("url 不能为空");
        return ResponseEntity.ok(service.importGithub(url, confirm, force));
    }

    /** 从本地技能包文件安装（与导出格式互逆）。force 语义同 import-github。 */
    @PostMapping("/import-file")
    public ResponseEntity<Map<String, Object>> importFile(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "confirm", defaultValue = "false") boolean confirm,
            @RequestParam(value = "force", defaultValue = "false") boolean force) throws Exception {
        String json = new String(file.getBytes(), java.nio.charset.StandardCharsets.UTF_8);
        return ResponseEntity.ok(service.importPackage(json, confirm, "file", force));
    }
}
