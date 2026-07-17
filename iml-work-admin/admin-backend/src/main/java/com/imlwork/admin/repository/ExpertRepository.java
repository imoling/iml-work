package com.imlwork.admin.repository;

import com.imlwork.admin.model.Expert;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface ExpertRepository extends JpaRepository<Expert, String> {

    /**
     * 岗位→技能摘要的窄行（expertId + 技能元数据），一条 join 查询喂全列表，
     * 代替 EAGER 逐岗位抓全量技能实体（N+1 + 大 TEXT 列出库）。
     * 行结构：[0]=expertId, [1]=skillId, [2]=name, [3]=type, [4]=category, [5]=version, [6]=status, [7]=description, [8]=triggerKeywords。
     */
    @Query("select e.id, s.id, s.name, s.type, s.category, s.version, s.status, s.description, s.triggerKeywords "
            + "from Expert e join e.skills s")
    List<Object[]> findSkillBriefRows();

    /** 技能下架/删除时按 skill_id 一条 SQL 清空所有岗位绑定，代替加载全部岗位逐个改集合。 */
    @Modifying
    @Query(value = "delete from expert_skill where skill_id = :skillId", nativeQuery = true)
    int detachSkillFromAllExperts(@Param("skillId") String skillId);
}
