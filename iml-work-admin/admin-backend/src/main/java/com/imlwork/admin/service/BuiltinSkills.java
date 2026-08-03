package com.imlwork.admin.service;

import com.imlwork.admin.repository.SkillRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.stereotype.Component;

import java.util.Set;

/**
 * 系统预置技能名单的**唯一来源**。
 *
 * <p>这些技能构成产品的基础能力面（取数、调研、造技能、四类文档产出、图片/视频生成），
 * 删掉任何一个都会让"分身能干什么"出现缺口，因此不允许在界面上删除（见 SkillService.delete）。
 *
 * <p>为什么不只靠 Flyway 迁移打标：迁移是**一次性**的，只覆盖执行那一刻库里已有的技能。
 * 名单以后要加（比如现在加的 image-gen / video-gen），或者技能是迁移之后才导入的，
 * 迁移就够不着了——那条技能会以 builtin=false 落库，界面上照样能删。
 * 所以名单放这里，配一个启动同步：无论技能什么时候进的库，启动一次就对齐一次。
 */
@Component
public class BuiltinSkills {
    private static final Logger log = LoggerFactory.getLogger(BuiltinSkills.class);

    /** 按 name 而非 id：id 各环境是生成的（skill-imp-xxx），换个部署就对不上；name 稳定。 */
    public static final Set<String> NAMES = Set.of(
            "a-stock-data",   // A 股行情/财务取数
            "deep-research",  // 深度调研
            "skill-creator",  // 造技能
            "docx", "pptx", "xlsx", "pdf",   // 四类文档产出
            "image-gen",      // 图片生成
            "video-gen");     // 视频生成

    public static boolean isBuiltin(String name) {
        return name != null && NAMES.contains(name.trim());
    }

    /** 启动时把库里同名技能对齐为 builtin（幂等；只加不减，不会把管理员手工建的同名技能变回可删）。 */
    @Bean
    ApplicationRunner syncBuiltinSkills(SkillRepository repo) {
        return args -> {
            int n = repo.markBuiltinByNames(NAMES);
            if (n > 0) log.info("[BuiltinSkills] 已对齐 {} 个系统预置技能（不可删除）", n);
        };
    }
}
