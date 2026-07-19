-- 信源分级名单（6d01162 加了 SearchConfig.sourceTiers 实体字段但漏了迁移——ddl-auto=none 下
-- 实体加字段必须配 V* 迁移，否则运行时查询直接 column does not exist）。
ALTER TABLE search_config ADD COLUMN IF NOT EXISTS source_tiers text;
