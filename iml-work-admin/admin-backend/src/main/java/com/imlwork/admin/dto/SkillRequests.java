package com.imlwork.admin.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

/**
 * 技能中心固定形状写请求 DTO。动态载荷端点（from-recording/gen-sop，字段随录制引擎演进）
 * 与多端消费的 Skill 实体（create/update）暂保留原契约，避免盲加校验破坏 FDE/客户端提交。
 */
public final class SkillRequests {
    private SkillRequests() {}

    /** 生命周期状态切换（消费方 SkillsHub/FDE 均显式传 status）。 */
    public record SetStatus(
            @NotBlank @Pattern(regexp = "DRAFT|PUBLISHED|DISABLED", message = "status 必须是 DRAFT/PUBLISHED/DISABLED")
            String status) {}

    /** GitHub 导入（服务层另有域名白名单防 SSRF）。 */
    public record ImportGithub(
            @NotBlank(message = "url 不能为空") String url,
            Boolean confirm, Boolean force) {}

    /** 模型辅助生成（字段均可省略，服务层有缺省语义）。 */
    public record Generate(String name, String description, String type, String category) {}
}
