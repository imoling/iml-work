package com.imlwork.admin.repository;

import com.imlwork.admin.model.Skill;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface SkillRepository extends JpaRepository<Skill, String> {

    List<Skill> findByNameContainingIgnoreCaseOrDescriptionContainingIgnoreCase(String name, String description, Pageable pageable);

    /** 用户私有技能（skill-creator 自建 / 上传待审）。 */
    List<Skill> findByOwnerUserId(String ownerUserId);

    /** 按名精确取（读取技能库里的 skill-creator 方法论包等）。 */
    List<Skill> findByNameIgnoreCase(String name);
}
