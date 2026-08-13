-- 技能信任治理（语义审计后的分流方案）：
-- bundle_hash    技能包内容指纹——同哈希的包一经管理员发布（PUBLISHED），后续任何人安装免审；
-- security_report 安装时的完整安全扫描报告 JSON 留痕（审计链，经 /skills/{id}/security-report 查看）；
-- skill_trust_config 企业信任策略单行表（policy: strict/balanced/loose + 来源白名单）。
ALTER TABLE skill ADD COLUMN IF NOT EXISTS bundle_hash varchar(64);
ALTER TABLE skill ADD COLUMN IF NOT EXISTS security_report text;
CREATE INDEX IF NOT EXISTS idx_skill_bundle_hash ON skill (bundle_hash);
CREATE TABLE IF NOT EXISTS skill_trust_config (
    id varchar(32) PRIMARY KEY,
    policy varchar(16) NOT NULL DEFAULT 'balanced',
    trusted_sources text
);
