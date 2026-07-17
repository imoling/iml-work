package com.imlwork.admin.controller;

import com.imlwork.admin.model.Expert;
import com.imlwork.admin.service.ExpertService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 岗位分身管理。CRUD/领用/技能指纹委托 {@link ExpertService}；
 * generate（大模型辅助生成岗位描述）为 LLM 编排，保留在控制器。
 */
@RestController
@RequestMapping("/api/v1/experts")
public class ExpertController {

    private final ExpertService expertService;
    private final ModelProxyController modelProxy;
    private final com.imlwork.admin.service.DictService dictService;
    private final com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();

    public ExpertController(ExpertService expertService, ModelProxyController modelProxy,
                            com.imlwork.admin.service.DictService dictService) {
        this.expertService = expertService;
        this.modelProxy = modelProxy;
        this.dictService = dictService;
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
                + "3) knowledgeCategories：从【" + String.join("、", dictService.labels(com.imlwork.admin.service.DictService.KNOWLEDGE_CATEGORY)) + "】中选出该岗位最相关的若干项（数组，只能取这些值）。\n"
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
                    List<String> valid = dictService.labels(com.imlwork.admin.service.DictService.KNOWLEDGE_CATEGORY);
                    for (Object o : list) if (valid.contains(String.valueOf(o))) cats.add(String.valueOf(o));
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

    /** 列表（瘦身投影：技能只带元数据摘要；完整技能走 /{id}/skills 或技能详情）。 */
    @GetMapping
    public ResponseEntity<List<com.imlwork.admin.dto.ExpertSummary>> getAllExperts() {
        return ResponseEntity.ok(expertService.list());
    }

    @GetMapping("/{id}")
    public Expert getExpert(@PathVariable String id) {
        return expertService.get(id);
    }

    @PostMapping
    public Expert createExpert(@RequestBody Expert expert) {
        return expertService.create(expert);
    }

    @PutMapping("/{id}")
    public Expert updateExpert(@PathVariable String id, @RequestBody Expert update) {
        return expertService.update(id, update);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> deleteExpert(@PathVariable String id) {
        expertService.delete(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }

    @PostMapping("/claim/{id}")
    public ResponseEntity<Map<String, Object>> claimExpert(@PathVariable String id) {
        return ResponseEntity.ok(expertService.claim(id));
    }

    @GetMapping("/{id}/skills")
    public ResponseEntity<Map<String, Object>> expertSkills(@PathVariable String id) {
        return ResponseEntity.ok(expertService.skillsWithFingerprint(id));
    }
}
