package com.imlwork.admin.service;

import com.imlwork.admin.model.Expert;
import com.imlwork.admin.model.Skill;
import com.imlwork.admin.repository.ExpertRepository;
import com.imlwork.admin.repository.SkillRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** 岗位分身领域服务：CRUD + 技能去重绑定 + 领用/技能指纹。 */
@Service
public class ExpertService {

    private final ExpertRepository expertRepository;
    private final SkillRepository skillRepository;

    public ExpertService(ExpertRepository expertRepository, SkillRepository skillRepository) {
        this.expertRepository = expertRepository;
        this.skillRepository = skillRepository;
    }

    @Transactional(readOnly = true)
    public List<Expert> getAll() {
        return expertRepository.findAll();
    }

    @Transactional(readOnly = true)
    public Expert get(String id) {
        return expertRepository.findById(id).orElseThrow(() -> notFound());
    }

    @Transactional
    public Expert create(Expert expert) {
        if (expert.getId() == null || expert.getId().trim().isEmpty()) {
            expert.setId("expert-" + System.currentTimeMillis());
        }
        linkExistingSkills(expert);
        return expertRepository.save(expert);
    }

    @Transactional
    public Expert update(String id, Expert update) {
        Expert existing = expertRepository.findById(id).orElseThrow(() -> notFound());
        existing.setTitle(update.getTitle());
        existing.setSpec(update.getSpec());
        existing.setDescription(update.getDescription());
        if (update.getSkills() != null) {
            update.setId(id);
            linkExistingSkills(update);
            existing.setSkills(update.getSkills());
        }
        if (update.getKnowledgeCategories() != null) existing.setKnowledgeCategories(update.getKnowledgeCategories());
        if (update.getPrinciples() != null) existing.setPrinciples(update.getPrinciples());
        if (update.getWorkStyle() != null) existing.setWorkStyle(update.getWorkStyle());
        if (update.getOntologyDomains() != null) existing.setOntologyDomains(update.getOntologyDomains());
        existing.setWebSearchEnabled(update.isWebSearchEnabled());
        return expertRepository.save(existing);
    }

    @Transactional
    public void delete(String id) {
        if (!expertRepository.existsById(id)) throw notFound();
        expertRepository.deleteById(id);
    }

    /** 领用：返回同步的技能集 + 客户端应载入的知识检索范围。 */
    @Transactional(readOnly = true)
    public Map<String, Object> claim(String id) {
        Expert found = expertRepository.findById(id).orElseThrow(() -> notFound());
        Map<String, Object> m = new HashMap<>();
        m.put("success", true);
        m.put("expertId", found.getId());
        m.put("skillsSynced", found.getSkills());
        m.put("knowledgeScope", found.getKnowledgeCategories());
        m.put("webSearchEnabled", found.isWebSearchEnabled());
        return m;
    }

    /** 只读：技能 + 指纹（id|status|updatedAt 哈希），供客户端做增量同步。 */
    @Transactional(readOnly = true)
    public Map<String, Object> skillsWithFingerprint(String id) {
        Expert found = expertRepository.findById(id).orElseThrow(() -> notFound());
        List<Skill> skills = found.getSkills() == null ? new ArrayList<>() : found.getSkills();
        String sig = skills.stream()
                .map(s -> s.getId() + "|" + s.getStatus() + "|" + (s.getUpdatedAt() == null ? "" : s.getUpdatedAt().toString()))
                .sorted()
                .reduce("", (a, b) -> a + ";" + b);
        Map<String, Object> m = new HashMap<>();
        m.put("fingerprint", Integer.toHexString(sig.hashCode()) + "-" + skills.size());
        m.put("skills", skills);
        return m;
    }

    /** 引用已存在的技能 id 时复用持久化技能，避免绑定 SkillsHub 技能时重复。 */
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

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "岗位分身不存在");
    }
}
