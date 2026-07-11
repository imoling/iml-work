-- 连接器动作新增 sop 智能体形态（免录制）：入口锚点列。
-- kind 已是既有 varchar，取值扩展到 replay|api|sop 无需改列；仅补 sop 的入口锚点存储。
-- 单语句 ADD COLUMN IF NOT EXISTS，可空 text，非 NOT NULL——对非空表安全。
ALTER TABLE connector_action ADD COLUMN IF NOT EXISTS entry_hash text;
