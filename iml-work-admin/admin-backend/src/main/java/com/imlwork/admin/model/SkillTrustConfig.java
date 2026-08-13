package com.imlwork.admin.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/**
 * 技能信任策略（单行配置，id 恒为 "default"）。
 *
 * policy 三档（不同企业安全水位不同）：
 *   · strict   —— 严格：MEDIUM 及以上全部进管理员审核；
 *   · balanced —— 均衡（默认）：HIGH/REVIEW 进管理员，MEDIUM 用户签字即装；
 *   · loose    —— 宽松：组合信号（REVIEW）也只需用户签字，仅 HIGH 进管理员。
 * trustedSources：每行一个来源前缀（如 https://github.com/my-org/）——命中的来源视为企业认可，
 * 跳过阻断与复核（扫描照做、发现照记，只是不拦）。
 */
@Entity
@Table(name = "skill_trust_config")
public class SkillTrustConfig {

    @Id
    @Column(length = 32)
    private String id = "default";

    @Column(length = 16, nullable = false)
    private String policy = "balanced";

    @Column(name = "trusted_sources", columnDefinition = "text")
    private String trustedSources;

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getPolicy() { return policy; }
    public void setPolicy(String policy) { this.policy = policy; }

    public String getTrustedSources() { return trustedSources; }
    public void setTrustedSources(String trustedSources) { this.trustedSources = trustedSources; }
}
