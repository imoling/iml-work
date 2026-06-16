package com.imlwork.admin.controller;

import com.imlwork.admin.model.Expert;
import com.imlwork.admin.model.Skill;
import com.imlwork.admin.repository.ExpertRepository;
import com.imlwork.admin.repository.SkillRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/experts")
public class ExpertController {

    private final ExpertRepository expertRepository;
    private final SkillRepository skillRepository;

    public ExpertController(ExpertRepository expertRepository, SkillRepository skillRepository) {
        this.expertRepository = expertRepository;
        this.skillRepository = skillRepository;
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
