package com.imlwork.admin.dto;

import java.util.List;

/**
 * 岗位分身列表条目（瘦身投影）：岗位自身字段全量保留（都很小），
 * 绑定技能只带元数据摘要——完整技能内容走 GET /experts/{id}/skills（指纹同步）或技能详情。
 * SkillBrief 字段面与客户端 expert:list 的映射一致，增删字段先查该消费端。
 */
public record ExpertSummary(
        String id,
        String title,
        String spec,
        String description,
        boolean webSearchEnabled,
        List<String> knowledgeCategories,
        List<String> principles,
        List<String> workStyle,
        List<String> ontologyDomains,
        List<SkillBrief> skills) {

    /** 绑定技能摘要（不含脚本/SOP/bundle 正文）。 */
    public record SkillBrief(
            String id,
            String name,
            String type,
            String category,
            String version,
            String status,
            String description,
            List<String> triggerKeywords) {
    }
}
