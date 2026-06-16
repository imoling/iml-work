package com.imlwork.admin.controller;

import com.imlwork.admin.model.Expert;
import com.imlwork.admin.model.Skill;
import com.imlwork.admin.repository.ExpertRepository;
import com.imlwork.admin.repository.SkillRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/experts")
public class ExpertController {

    private static final List<String> KNOWLEDGE_CATEGORIES = List.of("公司基本信息", "行政财务制度", "企业合规制度", "人事审批规范");

    private final ExpertRepository expertRepository;
    private final SkillRepository skillRepository;
    private final ModelProxyController modelProxy;
    private final com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();

    public ExpertController(ExpertRepository expertRepository, SkillRepository skillRepository, ModelProxyController modelProxy) {
        this.expertRepository = expertRepository;
        this.skillRepository = skillRepository;
        this.modelProxy = modelProxy;
    }

    /** 用大模型（经企业模型中转站）根据岗位名称生成功能描述、职责背景与建议知识库范围。 */
    @PostMapping("/generate")
    public ResponseEntity<Map<String, Object>> generate(@RequestBody Map<String, String> body) {
        String title = body.getOrDefault("title", "").trim();
        if (title.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("success", false, "error", "请先填写岗位名称"));
        }
        String prompt = "你是企业岗位分身设计助手。根据岗位名称生成：\n"
                + "1) spec：一句话功能描述（简短，突出该岗位分身能自动完成的核心工作）。\n"
                + "2) description：详细职责背景（2-4 句，说明岗位职责、能力与适用场景）。\n"
                + "3) knowledgeCategories：从【" + String.join("、", KNOWLEDGE_CATEGORIES) + "】中选出该岗位最相关的若干项（数组，只能取这些值）。\n"
                + "岗位名称：" + title + "\n"
                + "只输出严格 JSON，不要任何解释或代码块标记：{\"spec\":\"...\",\"description\":\"...\",\"knowledgeCategories\":[\"...\"]}";
        Map<String, Object> payload = new HashMap<>();
        payload.put("model", "corp-default");
        payload.put("messages", List.of(Map.of("role", "user", "content", prompt)));
        try {
            ResponseEntity<?> resp = modelProxy.chatCompletion(payload, "Bearer sk-corp-default-key");
            String content = extractContent(resp.getBody());
            Map<String, Object> parsed = parseLooseJson(content);
            Object spec = parsed.get("spec");
            Object desc = parsed.get("description");
            if (spec != null && desc != null) {
                List<String> cats = new ArrayList<>();
                if (parsed.get("knowledgeCategories") instanceof List<?> list) {
                    for (Object o : list) if (KNOWLEDGE_CATEGORIES.contains(String.valueOf(o))) cats.add(String.valueOf(o));
                }
                return ResponseEntity.ok(Map.of("success", true, "spec", spec.toString(), "description", desc.toString(), "knowledgeCategories", cats, "source", "model"));
            }
        } catch (Exception e) {
            // 落到模板回退
        }
        return ResponseEntity.ok(Map.of("success", true,
                "spec", title + "：自动处理相关业务的智能工作分身",
                "description", "负责" + title + "相关的日常事务处理，可在安全沙箱内自动执行流程、调用业务技能并按企业规范完成任务。",
                "knowledgeCategories", List.of(), "source", "fallback"));
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
    public ResponseEntity<List<Expert>> getAllExperts() {
        return ResponseEntity.ok(expertRepository.findAll());
    }

    @GetMapping("/{id}")
    public ResponseEntity<Expert> getExpert(@PathVariable String id) {
        return expertRepository.findById(id)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<Expert> createExpert(@RequestBody Expert expert) {
        if (expert.getId() == null || expert.getId().trim().isEmpty()) {
            expert.setId("expert-" + System.currentTimeMillis());
        }
        linkExistingSkills(expert);
        return ResponseEntity.ok(expertRepository.save(expert));
    }

    @PutMapping("/{id}")
    public ResponseEntity<Expert> updateExpert(@PathVariable String id, @RequestBody Expert update) {
        return expertRepository.findById(id).map(existing -> {
            existing.setTitle(update.getTitle());
            existing.setSpec(update.getSpec());
            existing.setDescription(update.getDescription());
            if (update.getSkills() != null) {
                update.setId(id);
                linkExistingSkills(update);
                existing.setSkills(update.getSkills());
            }
            if (update.getKnowledgeCategories() != null) {
                existing.setKnowledgeCategories(update.getKnowledgeCategories());
            }
            existing.setWebSearchEnabled(update.isWebSearchEnabled());
            return ResponseEntity.ok(expertRepository.save(existing));
        }).orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> deleteExpert(@PathVariable String id) {
        if (!expertRepository.existsById(id)) {
            return ResponseEntity.notFound().build();
        }
        expertRepository.deleteById(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }

    /**
     * Claim an expert: returns the synchronized skill set plus the corporate
     * knowledge retrieval scope the client should load into its harness memory.
     */
    @PostMapping("/claim/{id}")
    public ResponseEntity<Map<String, Object>> claimExpert(@PathVariable String id) {
        return expertRepository.findById(id).<ResponseEntity<Map<String, Object>>>map(found ->
                ResponseEntity.ok(Map.of(
                        "success", true,
                        "expertId", found.getId(),
                        "skillsSynced", found.getSkills(),
                        "knowledgeScope", found.getKnowledgeCategories(),
                        "webSearchEnabled", found.isWebSearchEnabled()
                ))
        ).orElse(ResponseEntity.notFound().build());
    }

    /**
     * Reuse persisted skills when the incoming payload references an existing
     * skill id, so binding a SkillsHub skill to an expert does not duplicate it.
     */
    private void linkExistingSkills(Expert expert) {
        if (expert.getSkills() == null) {
            expert.setSkills(new ArrayList<>());
            return;
        }
        List<Skill> resolved = new ArrayList<>();
        for (Skill s : expert.getSkills()) {
            if (s.getId() != null) {
                resolved.add(skillRepository.findById(s.getId()).orElse(s));
            } else {
                s.setId("skill-" + System.currentTimeMillis() + "-" + resolved.size());
                resolved.add(s);
            }
        }
        expert.setSkills(resolved);
    }
}
