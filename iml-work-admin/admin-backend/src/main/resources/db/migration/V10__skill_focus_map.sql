-- 技能级「画像沉淀映射」：执行成功后哪些确认字段沉淀为哪个本体对象类型。
-- JSON 数组 [{"field":"关联商机","objectType":"Opportunity"}]；objectType 为空串 = 明确不沉淀；
-- 整列为 NULL = 未配置，客户端退回自动匹配（字段标签 ⊇ 本体类型标签）。
ALTER TABLE skill ADD COLUMN IF NOT EXISTS focus_map_json text;
