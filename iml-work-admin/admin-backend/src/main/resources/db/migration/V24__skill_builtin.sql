-- 系统预置技能标记：这些技能构成产品的基础能力面（取数、调研、造技能、四类文档产出），
-- 删掉任何一个都会让"分身能干什么"出现缺口，因此不允许在界面上删除/停用。
--
-- 为什么不复用既有的 source 字段：那一列记的是**来源**（file / github-dir / preset /
-- user-created:<用户> / user-upload / user-recorded），同为预置的 7 个技能取值就有三种，
-- 判断不出"能不能删"。语义不同，另立一列。
--
-- 显式 ADD COLUMN 而不依赖 ddl-auto：实体上是 boolean 原始类型，
-- ddl-auto 对**非空表**生成的 ADD COLUMN ... NOT NULL 会静默失败，
-- 之后所有查询报 column does not exist（项目已踩过，见 CLAUDE.md 已知坑）。
ALTER TABLE skill ADD COLUMN IF NOT EXISTS builtin BOOLEAN NOT NULL DEFAULT FALSE;

-- 按 name 标记而非 id：id 在各环境是生成的（skill-imp-xxx），换个部署就对不上；name 稳定。
UPDATE skill SET builtin = TRUE
WHERE name IN ('a-stock-data', 'deep-research', 'skill-creator', 'docx', 'pptx', 'xlsx', 'pdf');
