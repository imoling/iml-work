-- 岗位协作者：team/子智能体协作功能，Expert.collaborators（List<String>，StringListConverter 存 JSON 文本）。
-- ddl-auto=none，此列必须由 Flyway 建，否则新后端 select expert 报 column does not exist。
-- text 可空：Converter 读 NULL 返回空 list，无需 NOT NULL/DEFAULT（避免非空表 ADD NOT NULL 静默失败坑）。
ALTER TABLE expert ADD COLUMN IF NOT EXISTS collaborators text;
