package com.imlwork.admin.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.imlwork.admin.model.Skill;
import com.imlwork.admin.repository.SkillRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.util.List;

/**
 * 系统预置技能播种：首启时把 {@code resources/seed/builtin-skills.json} 里的技能包灌进库。
 *
 * <p>这批技能构成产品的基础能力面（深度调研 / A股取数 / 造技能 / docx·pptx·xlsx·pdf 四类
 * 文档产出 / 图片·视频生成），名单与 {@link com.imlwork.admin.service.BuiltinSkills} 对应。
 * 与 DataSeeder 的演示数据不同，它们是产品功能而非假业务数据，因此 **prod 也播种**——
 * 否则全新部署的技能中心是空的，客户端「分身能干什么」直接缺一整面。
 *
 * <p>幂等：按名字判重，已存在同名技能（无论谁建的）即跳过，绝不覆盖管理员改过的内容。
 */
@Component
@Order(10)
public class BuiltinSkillSeeder implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(BuiltinSkillSeeder.class);
    private static final String SEED_PATH = "seed/builtin-skills.json";

    /** 种子文件里的一条技能包记录（字段与 Skill 实体同名子集）。 */
    record SeedSkill(String id, String name, String type, String category, String skillKind,
                     String source, String version, String description, List<String> triggerKeywords,
                     String sopContent, String code, String bundle, String focusMapJson) {}

    private final SkillRepository skillRepository;
    private final ObjectMapper objectMapper;

    public BuiltinSkillSeeder(SkillRepository skillRepository, ObjectMapper objectMapper) {
        this.skillRepository = skillRepository;
        this.objectMapper = objectMapper;
    }

    @Override
    public void run(String... args) throws Exception {
        List<SeedSkill> seeds;
        try (InputStream in = new ClassPathResource(SEED_PATH).getInputStream()) {
            seeds = objectMapper.readerForListOf(SeedSkill.class).readValue(in);
        }
        int created = 0;
        for (SeedSkill seed : seeds) {
            if (!skillRepository.findByNameIgnoreCase(seed.name()).isEmpty()) {
                continue;   // 已有同名技能（含管理员改过的版本），不覆盖
            }
            Skill s = new Skill();
            s.setId(seed.id());
            s.setName(seed.name());
            s.setType(seed.type());
            s.setCategory(blankToNull(seed.category()));
            s.setSkillKind(blankToNull(seed.skillKind()));
            s.setSource(seed.source());
            s.setVersion(seed.version());
            s.setDescription(seed.description());
            s.setTriggerKeywords(seed.triggerKeywords());
            s.setSopContent(blankToNull(seed.sopContent()));
            s.setCode(blankToNull(seed.code()));
            s.setBundle(blankToNull(seed.bundle()));
            s.setFocusMapJson(blankToNull(seed.focusMapJson()));
            s.setStatus("PUBLISHED");
            s.setBuiltin(true);
            skillRepository.save(s);
            created++;
        }
        if (created > 0) {
            log.info("[BuiltinSkillSeeder] 已播种 {} 个系统预置技能（共 {} 个候选）", created, seeds.size());
        }
    }

    private static String blankToNull(String v) {
        return v == null || v.isBlank() ? null : v;
    }
}
