package com.imlwork.admin.dto;

import java.time.LocalDateTime;

/**
 * 连接器动作的瘦身目录投影（浏览/绑定下拉用，体检 P3-2）：不带 stepsJson/fieldsJson/irJson/
 * apiBodyTemplate/sopHint/outputDesc 六个大 TEXT 列——录制产物单条可达几十 KB，且随录制持续增长。
 * 与技能的 GET /skills（全量·FDE 创作）vs /skills/catalog（瘦身·浏览）同一先例：
 * FDE「系统连接」的编辑抽屉从全量列表取正文，继续用 GET /connector-actions；
 * 管理端本体治理视图与 FDE 本体页的绑定下拉只认 id/name/actionKey → 用本目录。
 */
public record ConnectorActionBrief(
        String id, String systemId, String connectionId,
        String name, String actionKey, String capability, String kind,
        String version, LocalDateTime updatedAt) {
}
