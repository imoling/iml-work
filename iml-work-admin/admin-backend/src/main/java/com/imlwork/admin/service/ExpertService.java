package com.imlwork.admin.service;

import com.imlwork.admin.dto.ExpertSummary;
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

    /** 列表：瘦身投影。技能只带元数据摘要（一条 join 窄行查询），大 TEXT 列不出库。 */
    @Transactional(readOnly = true)
    public List<ExpertSummary> list() {
        Map<String, List<ExpertSummary.SkillBrief>> briefs = new HashMap<>();
        for (Object[] r : expertRepository.findSkillBriefRows()) {
            @SuppressWarnings("unchecked")
            List<String> kw = r[8] == null ? List.of() : (List<String>) r[8];
            briefs.computeIfAbsent((String) r[0], k -> new ArrayList<>()).add(new ExpertSummary.SkillBrief(
                    (String) r[1], (String) r[2], (String) r[3], (String) r[4],
                    (String) r[5], (String) r[6], (String) r[7], kw));
        }
        List<ExpertSummary> out = new ArrayList<>();
        for (Expert e : expertRepository.findAll()) {
            out.add(new ExpertSummary(e.getId(), e.getTitle(), e.getSpec(), e.getDescription(),
                    e.isWebSearchEnabled(), e.getKnowledgeCategories(), e.getPrinciples(), e.getWorkStyle(),
                    e.getOntologyDomains(), e.getCollaborators(), briefs.getOrDefault(e.getId(), List.of())));
        }
        return out;
    }

    @Transactional(readOnly = true)
    public Expert get(String id) {
        Expert found = expertRepository.findById(id).orElseThrow(() -> notFound());
        // LAZY + open-in-view=false：序列化在事务外，绑定技能须在事务内初始化
        found.getSkills().size();
        return found;
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
        // null 保护与上面几项同款：老客户端/局部更新不带这个字段时，绝不能把已配的协作关系清空
        //（技能安装链路踩过这个坑：实体初始化器导致部分更新清空字段）。
        if (update.getCollaborators() != null) existing.setCollaborators(update.getCollaborators());
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
        // 拷贝触发 LAZY 初始化（open-in-view=false，出事务后 Jackson 才序列化）
        m.put("skillsSynced", new ArrayList<>(found.getSkills()));
        m.put("knowledgeScope", found.getKnowledgeCategories());
        m.put("webSearchEnabled", found.isWebSearchEnabled());
        return m;
    }

    /** 只读：技能 + 指纹（id|status|updatedAt 哈希），供客户端做增量同步。 */
    @Transactional(readOnly = true)
    public Map<String, Object> skillsWithFingerprint(String id) {
        Expert found = expertRepository.findById(id).orElseThrow(() -> notFound());
        // 拷贝触发 LAZY 初始化（open-in-view=false，出事务后 Jackson 才序列化）
        List<Skill> all = found.getSkills() == null ? new ArrayList<>() : new ArrayList<>(found.getSkills());
        // **只下发已上架的**。这条接口是客户端心跳同步的数据源——落到客户端就等于可路由可执行。
        // 管理端技能目录里连待审(PENDING_REVIEW)、已退回(REJECTED)、已下架(DISABLED)的都在，
        // 管理员一旦把其中之一绑到岗位，它会被推到每个员工的客户端并可被调用，
        // 「先审后用」这条治理线就从侧门被绕过去了。状态判定放在下发口，绑定本身不拦
        //（管理员可以先绑好、审核通过后自动生效，这更顺手）。
        List<Skill> skills = all.stream().filter(s -> "PUBLISHED".equals(s.getStatus())).toList();
        // 指纹按**全量**算（含未下发的）：只按已下发的算的话，"待审 → 审核通过"
        // 这个状态跃迁不会改变指纹，客户端就永远不会去重新拉那条刚上架的技能。
        String sig = all.stream()
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
