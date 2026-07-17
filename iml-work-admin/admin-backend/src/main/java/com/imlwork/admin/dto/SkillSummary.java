package com.imlwork.admin.dto;

import java.time.LocalDateTime;
import java.util.List;

/**
 * 技能目录条目（GET /skills/catalog 专用瘦身投影）。
 * 刻意不含 code/sopContent/actionScript/bundle/focusMapJson 等大 TEXT 字段——
 * 目录/绑定/展示只需元数据；正文走 GET /skills/{id} 详情单查。
 * GET /skills 仍返回全量实体：FDE 工作台的创作/试跑页面从列表直接取脚本正文。
 * reviewNote 保留：审核确认框要展示扫描摘要，内容本身很短。
 * hasActionScript：是否有录制回放脚本（管理端「可回放执行器」筛选用），代替传正文。
 */
public record SkillSummary(
        String id,
        String name,
        String type,
        String category,
        String status,
        String version,
        String description,
        List<String> triggerKeywords,
        List<String> allowedRoles,
        String source,
        String targetSystemId,
        String skillKind,
        String navHash,
        String ownerUserId,
        String reviewNote,
        LocalDateTime updatedAt,
        boolean hasActionScript) {
}
