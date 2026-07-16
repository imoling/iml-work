package com.imlwork.admin.security;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 权限点目录（模块 + 操作）与预设角色。权限点用点分字符串表示，作为 JWT/授权的
 * authority。超级管理员用通配符 {@code *} 代表全部权限。
 */
public final class Permissions {

    private Permissions() {}

    public static final String ALL = "*";

    // 管理端
    public static final String DASHBOARD_VIEW   = "admin.dashboard.view";
    public static final String EXPERT_MANAGE    = "admin.expert.manage";
    public static final String SKILL_MANAGE     = "admin.skill.manage";
    public static final String KNOWLEDGE_MANAGE = "admin.knowledge.manage";
    public static final String KNOWLEDGE_APPROVE = "admin.knowledge.approve";
    public static final String GATEWAY_MANAGE   = "admin.gateway.manage";
    public static final String SEARCH_MANAGE    = "admin.search.manage";
    public static final String TRACE_VIEW       = "admin.trace.view";
    public static final String SANDBOX_MANAGE   = "admin.sandbox.manage";
    public static final String DOCLING_MANAGE   = "admin.docling.manage";
    public static final String INTEGRATION_MANAGE = "admin.integration.manage";
    public static final String ENTERPRISE_MANAGE = "admin.enterprise.manage";
    public static final String USER_MANAGE      = "admin.user.manage";
    public static final String ONTOLOGY_MANAGE  = "admin.ontology.manage";
    // FDE 工作台
    public static final String FDE_ACCESS       = "fde.access";
    public static final String FDE_SKILL_AUTHOR = "fde.skill.author";
    // 客户端
    public static final String CLIENT_USE       = "client.use";
    public static final String CLIENT_SKILL_CREATE = "client.skill.create";
    public static final String CLIENT_SKILL_UPLOAD = "client.skill.upload";

    /** 全部权限点（供前端渲染角色权限勾选、后端校验合法性）。 */
    public static final List<String> ALL_POINTS = List.of(
            DASHBOARD_VIEW, EXPERT_MANAGE, SKILL_MANAGE, KNOWLEDGE_MANAGE, KNOWLEDGE_APPROVE,
            GATEWAY_MANAGE, SEARCH_MANAGE, TRACE_VIEW, SANDBOX_MANAGE, DOCLING_MANAGE,
            INTEGRATION_MANAGE, ENTERPRISE_MANAGE, USER_MANAGE, ONTOLOGY_MANAGE,
            FDE_ACCESS, FDE_SKILL_AUTHOR, CLIENT_USE, CLIENT_SKILL_CREATE, CLIENT_SKILL_UPLOAD);

    /** 权限点中文说明（前端展示）。 */
    public static final Map<String, String> LABELS = new LinkedHashMap<>();
    static {
        LABELS.put(DASHBOARD_VIEW, "运行总览-查看");
        LABELS.put(EXPERT_MANAGE, "岗位专家-管理");
        LABELS.put(SKILL_MANAGE, "技能中心-管理");
        LABELS.put(KNOWLEDGE_MANAGE, "知识中心-管理");
        LABELS.put(KNOWLEDGE_APPROVE, "知识汇聚-审批");
        LABELS.put(GATEWAY_MANAGE, "模型网关-管理");
        LABELS.put(SEARCH_MANAGE, "联网检索-管理");
        LABELS.put(TRACE_VIEW, "审计追溯-查看");
        LABELS.put(SANDBOX_MANAGE, "沙箱监控-管理");
        LABELS.put(DOCLING_MANAGE, "文档解析引擎-管理");
        LABELS.put(INTEGRATION_MANAGE, "业务系统-管理");
        LABELS.put(ENTERPRISE_MANAGE, "企业信息-管理");
        LABELS.put(USER_MANAGE, "用户与权限-管理");
        LABELS.put(ONTOLOGY_MANAGE, "本体建模-管理");
        LABELS.put(FDE_ACCESS, "FDE工作台-进入");
        LABELS.put(FDE_SKILL_AUTHOR, "FDE技能-录制/上架");
        LABELS.put(CLIENT_USE, "客户端-使用工作分身");
        LABELS.put(CLIENT_SKILL_CREATE, "客户端-创建技能（智能创造器，产出私有技能）");
        LABELS.put(CLIENT_SKILL_UPLOAD, "客户端-上传技能包（先审后用）");
    }

    /** 预设角色定义：角色名 → {显示名, 权限点集}。 */
    public record PresetRole(String name, String label, List<String> permissions) {}

    public static final List<PresetRole> PRESET_ROLES = List.of(
            new PresetRole("SUPER_ADMIN", "超级管理员", List.of(ALL)),
            new PresetRole("OPERATOR", "运营管理员", List.of(
                    DASHBOARD_VIEW, EXPERT_MANAGE, SKILL_MANAGE, KNOWLEDGE_MANAGE, KNOWLEDGE_APPROVE,
                    GATEWAY_MANAGE, SEARCH_MANAGE, TRACE_VIEW, SANDBOX_MANAGE, DOCLING_MANAGE,
                    INTEGRATION_MANAGE, ENTERPRISE_MANAGE, ONTOLOGY_MANAGE)),
            new PresetRole("KNOWLEDGE_ADMIN", "知识管理员", List.of(
                    DASHBOARD_VIEW, KNOWLEDGE_MANAGE, KNOWLEDGE_APPROVE, DOCLING_MANAGE, TRACE_VIEW)),
            new PresetRole("FDE", "FDE工程师", List.of(
                    FDE_ACCESS, FDE_SKILL_AUTHOR, SKILL_MANAGE, INTEGRATION_MANAGE, ONTOLOGY_MANAGE)),
            new PresetRole("EMPLOYEE", "员工", List.of(CLIENT_USE))
    );
}
