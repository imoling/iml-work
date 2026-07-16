package com.imlwork.admin.controller;

import com.imlwork.admin.dto.SkillRequests;
import com.imlwork.admin.model.Skill;
import com.imlwork.admin.security.JwtAuthFilter.AuthPrincipal;
import com.imlwork.admin.service.SkillCreatorService;
import com.imlwork.admin.service.SkillService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

/** 企业技能中心。仅做 HTTP 塑形；目录/生命周期/录制转换/上传解析/模型生成在 {@link SkillService}。 */
@RestController
@RequestMapping("/api/v1/skills")
public class SkillController {

    private final SkillService service;
    private final SkillCreatorService creator;

    public SkillController(SkillService service, SkillCreatorService creator) {
        this.service = service;
        this.creator = creator;
    }

    // ── 技能智能创造器（管理端/FDE/被授权员工共用；权限见 SecurityConfig）──────

    /** 一句话指令 → 追问选项卡或技能草稿。answers 为追问的回答（首轮不传）。 */
    @PostMapping("/creator/draft")
    public ResponseEntity<Map<String, Object>> creatorDraft(@RequestBody Map<String, Object> body) {
        String instruction = body.get("instruction") == null ? "" : String.valueOf(body.get("instruction"));
        Map<String, String> answers = new java.util.LinkedHashMap<>();
        if (body.get("answers") instanceof Map<?, ?> m) {
            for (Map.Entry<?, ?> e : m.entrySet()) answers.put(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
        }
        return ResponseEntity.ok(creator.draft(instruction, answers));
    }

    /** 草稿静态校验 + 安全扫描（验收表）。 */
    @PostMapping("/creator/validate")
    @SuppressWarnings("unchecked")
    public ResponseEntity<Map<String, Object>> creatorValidate(@RequestBody Map<String, Object> body) {
        Object d = body.get("draft");
        if (!(d instanceof Map)) throw new IllegalArgumentException("缺少草稿内容");
        return ResponseEntity.ok(creator.validate((Map<String, Object>) d));
    }

    /** 员工保存为私有技能（立即可用，仅本人客户端下发）。 */
    @PostMapping("/creator/save")
    @SuppressWarnings("unchecked")
    public ResponseEntity<Skill> creatorSave(@RequestBody Map<String, Object> body) {
        Object d = body.get("draft");
        if (!(d instanceof Map)) throw new IllegalArgumentException("缺少草稿内容");
        AuthPrincipal p = principal();
        return ResponseEntity.ok(creator.saveAsPrivate((Map<String, Object>) d, p.userId(), p.username()));
    }

    /** 员工上传第三方技能包：落库即待审核（先审后用）。 */
    @PostMapping("/submit-package")
    public ResponseEntity<Map<String, Object>> submitPackage(@RequestParam("file") MultipartFile file) throws Exception {
        AuthPrincipal p = principal();
        return ResponseEntity.ok(service.submitUserPackage(file, p.userId(), p.username()));
    }

    /** 审核员工上传的技能：{approve: true} 发布 / {approve: false, reason: "…"} 退回。 */
    @PostMapping("/{id}/review")
    public ResponseEntity<Skill> review(@PathVariable String id, @RequestBody Map<String, Object> body) {
        boolean approve = Boolean.TRUE.equals(body.get("approve"));
        String reason = body.get("reason") == null ? "" : String.valueOf(body.get("reason"));
        return ResponseEntity.ok(service.review(id, approve, reason));
    }

    /** 本人私有技能清单（客户端安装 + 上传状态展示）。 */
    @GetMapping("/mine")
    public ResponseEntity<List<Skill>> mine() {
        return ResponseEntity.ok(service.mine(principal().userId()));
    }

    private static AuthPrincipal principal() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        if (a == null || !(a.getPrincipal() instanceof AuthPrincipal p)) throw new IllegalArgumentException("未登录");
        return p;
    }

    @PostMapping("/generate")
    public ResponseEntity<Map<String, Object>> generate(@RequestBody SkillRequests.Generate body) {
        return ResponseEntity.ok(service.generate(
                nz(body.name()), nz(body.description()), nz(body.type()), nz(body.category())));
    }

    private static String nz(String s) { return s == null ? "" : s; }

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

    @PostMapping("/{id}/dry-run")
    public ResponseEntity<Map<String, Object>> dryRun(@PathVariable String id, @RequestBody Map<String, Object> body) {
        return ResponseEntity.ok(service.dryRunExtract(id, String.valueOf(body.getOrDefault("text", ""))));
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
    public Skill setStatus(@PathVariable String id, @Valid @RequestBody SkillRequests.SetStatus body) {
        return service.setStatus(id, body.status());
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

    /** 导出为**技能包 zip**（真实目录：SKILL.md + scripts/ + iml-skill.json）。与 zip 导入互逆。 */
    @GetMapping("/{id}/export.zip")
    public ResponseEntity<byte[]> exportZip(@PathVariable String id) {
        byte[] zip = service.exportZip(id);
        return ResponseEntity.ok()
                .header("Content-Type", "application/zip")
                .header("Content-Disposition", "attachment")
                .body(zip);
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
    public ResponseEntity<Map<String, Object>> importGithub(@Valid @RequestBody SkillRequests.ImportGithub body) {
        return ResponseEntity.ok(service.importGithub(body.url(),
                Boolean.TRUE.equals(body.confirm()), Boolean.TRUE.equals(body.force())));
    }

    /**
     * 从本地技能包文件安装（与导出格式互逆）。force 语义同 import-github。
     *
     * 支持三种形态：
     *   · **.zip**   —— 技能目录压缩包（SKILL.md + 脚本 + 参考资料）。真实的技能包就长这样，
     *                   此前只按 JSON 解析，塞 zip 进来必崩。走与 GitHub 目录导入**完全相同**的安装路径。
     *   · .json      —— iML 技能包信封（导出的格式）
     *   · .md        —— 裸 SKILL.md
     * zip 按**魔数**判（PK\x03\x04），不信文件名——扩展名可以随便改。
     */
    @PostMapping("/import-file")
    public ResponseEntity<Map<String, Object>> importFile(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "confirm", defaultValue = "false") boolean confirm,
            @RequestParam(value = "force", defaultValue = "false") boolean force) throws Exception {
        byte[] bytes = file.getBytes();
        if (isZip(bytes)) {
            String fallbackName = java.util.Optional.ofNullable(file.getOriginalFilename()).orElse("imported-skill")
                    .replaceAll("(?i)\\.zip$", "");
            return ResponseEntity.ok(service.installBundle(service.unzipBundle(bytes), fallbackName, "file-zip", confirm, force));
        }
        String json = new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
        return ResponseEntity.ok(service.importPackage(json, confirm, "file", force));
    }

    /** zip 魔数 PK\x03\x04（扩展名不可信，内容说了算）。 */
    private static boolean isZip(byte[] b) {
        return b != null && b.length > 4 && b[0] == 0x50 && b[1] == 0x4B && b[2] == 0x03 && b[3] == 0x04;
    }
}
