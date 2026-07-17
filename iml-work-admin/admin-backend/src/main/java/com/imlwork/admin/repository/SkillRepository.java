package com.imlwork.admin.repository;

import com.imlwork.admin.dto.SkillSummary;
import com.imlwork.admin.model.Skill;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface SkillRepository extends JpaRepository<Skill, String> {

    /** 目录投影：只取元数据列，code/sopContent/actionScript/bundle 等大 TEXT 列根本不出库。 */
    String SUMMARY_SELECT = "select new com.imlwork.admin.dto.SkillSummary("
            + "s.id, s.name, s.type, s.category, s.status, s.version, s.description, "
            + "s.triggerKeywords, s.allowedRoles, s.source, s.targetSystemId, s.skillKind, "
            + "s.navHash, s.ownerUserId, s.reviewNote, s.updatedAt, "
            + "case when s.actionScript is not null and s.actionScript <> '' then true else false end) from Skill s";

    @Query(SUMMARY_SELECT)
    List<SkillSummary> findSummaries(Pageable pageable);

    @Query(SUMMARY_SELECT + " where lower(s.name) like lower(concat('%', :q, '%'))"
            + " or lower(s.description) like lower(concat('%', :q, '%'))")
    List<SkillSummary> searchSummaries(@Param("q") String q, Pageable pageable);

    /** 统计聚合用的窄行（category/type/status），代替 findAll 全实体扫描。 */
    @Query("select s.category, s.type, s.status from Skill s")
    List<Object[]> findFacetRows();

    /** id→name 映射用窄行（Dashboard 热门技能解析名称）。 */
    @Query("select s.id, s.name from Skill s")
    List<Object[]> findIdNameRows();

    List<Skill> findByNameContainingIgnoreCaseOrDescriptionContainingIgnoreCase(String name, String description, Pageable pageable);

    /** 用户私有技能（skill-creator 自建 / 上传待审）。 */
    List<Skill> findByOwnerUserId(String ownerUserId);

    /** 按名精确取（读取技能库里的 skill-creator 方法论包等）。 */
    List<Skill> findByNameIgnoreCase(String name);
}
