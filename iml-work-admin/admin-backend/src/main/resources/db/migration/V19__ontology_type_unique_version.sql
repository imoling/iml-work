-- 本体类型 schema 工程第 1 步（体检 P2-23 + 本体分析拍板 F）：
-- ① 清历史重复行（(domain,typeKey) 曾无唯一约束，早期 seed 产生过重复；保留每组 updated_at 最新的一行，
--    时间相同再按 id 兜底——确定性删除，不随机）。
DELETE FROM ontology_type a USING ontology_type b
  WHERE a.domain = b.domain AND a.type_key = b.type_key
    AND (a.updated_at < b.updated_at OR (a.updated_at = b.updated_at AND a.id < b.id));
-- ② 唯一约束落地：同一域内类型键唯一。
CREATE UNIQUE INDEX IF NOT EXISTS ux_ontology_type_domain_key ON ontology_type (domain, type_key);
-- ③ schema 版本号：每次修改自增（Service 维护），供客户端 resolve-hints 缓存按版本失效、后续 schema 演进追踪。
ALTER TABLE ontology_type ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
