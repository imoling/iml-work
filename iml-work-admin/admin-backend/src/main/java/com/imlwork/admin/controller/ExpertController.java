package com.imlwork.admin.controller;

import com.imlwork.admin.model.Expert;
import com.imlwork.admin.model.Skill;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/experts")
public class ExpertController {

    private final List<Expert> experts = new ArrayList<>();

    public ExpertController() {
        // Seed default experts
        experts.add(new Expert("expert-1", "OA 审批助手", 
                "自动处理企业OA系统审批、表单自动填写与远程通知催办", 
                "负责对接企业内部OA审批流。可以自动填充表单，获取审批状态，并支持通过飞书/微信进行审批催办。",
                Arrays.asList(
                        new Skill("skill-sync-expert-1-1", "OA系统表单自动填充", "playwright"),
                        new Skill("skill-sync-expert-1-2", "内网数据清洗总结", "python-sandbox")
                )
        ));
        experts.add(new Expert("expert-2", "财务报销专家", 
                "负责发票审核、报销单比对及企业合规检查", 
                "熟悉企业差旅与福利报销规范，可自动扫描比对票据真伪并执行Playwright账目录入。",
                Arrays.asList(
                        new Skill("skill-sync-expert-2-1", "发票OCR文字捕捉", "python-sandbox"),
                        new Skill("skill-sync-expert-2-2", "财务账单自动录入", "playwright")
                )
        ));
        experts.add(new Expert("expert-3", "知识管理顾问", 
                "个人与企业多层级知识提取、问答与差量备份同步", 
                "负责把控分级记忆库，将本地文件索引归档，提取向量，并自动将核心差量数据同步到云端知识库。",
                Arrays.asList(
                        new Skill("skill-sync-expert-3-1", "本地文档自动化块级索引", "python-sandbox"),
                        new Skill("skill-sync-expert-3-2", "向量嵌入生成服务", "onnx-bge")
                )
        ));
    }

    @GetMapping
    public ResponseEntity<List<Expert>> getAllExperts() {
        return ResponseEntity.ok(experts);
    }

    @PostMapping
    public ResponseEntity<Expert> createExpert(@RequestBody Expert expert) {
        if (expert.getId() == null || expert.getId().trim().isEmpty()) {
            expert.setId("expert-" + (experts.size() + 1));
        }
        experts.add(expert);
        return ResponseEntity.ok(expert);
    }

    @PostMapping("/claim/{id}")
    public ResponseEntity<Map<String, Object>> claimExpert(@PathVariable String id) {
        Expert found = experts.stream()
                .filter(e -> e.getId().equals(id))
                .findFirst()
                .orElse(null);

        if (found == null) {
            return ResponseEntity.notFound().build();
        }

        return ResponseEntity.ok(Map.of(
                "success", true,
                "expertId", found.getId(),
                "skillsSynced", found.getSkills()
        ));
    }
}
