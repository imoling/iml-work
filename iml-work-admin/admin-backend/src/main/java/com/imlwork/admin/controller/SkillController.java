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
}
