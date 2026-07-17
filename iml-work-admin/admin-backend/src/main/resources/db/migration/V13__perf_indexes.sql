-- 性能索引：列表/审计/聚合接口的排序与过滤路径（这些表随使用无界增长，此前只有主键索引）。
-- 单语句、幂等（IF NOT EXISTS），与既有库/全新库均兼容。

-- 本体：对象引用按最近活跃倒序（管理端默认视图）+ 按类型过滤
CREATE INDEX IF NOT EXISTS idx_onto_ref_last_seen ON ontology_object_ref (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_onto_ref_type_seen ON ontology_object_ref (object_type, last_seen_at DESC);

-- 本体：业务事件全局时间线 + 单对象回溯两条查询路径
CREATE INDEX IF NOT EXISTS idx_onto_event_created ON ontology_business_event (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_onto_event_ref_created ON ontology_business_event (object_ref_id, created_at DESC);

-- 岗位-技能绑定：按 skill_id 反查/清绑定（技能下架、删除、usedBy 统计），PG 不会自动给 FK 建索引
CREATE INDEX IF NOT EXISTS idx_expert_skill_skill ON expert_skill (skill_id);

-- 执行轨迹：Top200 列表 / 运营聚合窗口（created_at > ?）都按时间走，写入频率全库最高
CREATE INDEX IF NOT EXISTS idx_agent_trace_created ON agent_trace (created_at DESC);

-- 审计三表：Top N 按时间倒序
CREATE INDEX IF NOT EXISTS idx_retrieval_audit_created ON retrieval_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_audit_created ON login_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_desensitize_audit_created ON desensitize_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_desensitize_audit_trace ON desensitize_audit (trace_id);

-- 连接器动作：目录按最近维护倒序 + 按系统/连接过滤
CREATE INDEX IF NOT EXISTS idx_connector_action_updated ON connector_action (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_connector_action_system ON connector_action (system_id);
CREATE INDEX IF NOT EXISTS idx_connector_action_conn ON connector_action (connection_id);

-- 知识文档：按范围/归属/晋升状态过滤（chunk 表已有索引，文档表此前缺）
CREATE INDEX IF NOT EXISTS idx_knowledge_doc_scope ON knowledge_document (scope);
CREATE INDEX IF NOT EXISTS idx_knowledge_doc_owner ON knowledge_document (owner_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_doc_promotion ON knowledge_document (promotion_status);
