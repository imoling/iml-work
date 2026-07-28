-- 令牌纪元（体检 P2-5：JWT 无状态、无撤销手段，泄露后最长可用 72h）。
-- 每次改密/管理员强制下线时 +1；JWT 载荷带签发时的 ep，与用户当前值不符即视为已撤销。
-- 比黑名单表轻：一列 + 一次内存缓存查询，撤销是低频写。
-- ⚠️ 原始类型加列对非空表必须显式给 DEFAULT（ddl-auto 生成的 NOT NULL 无默认会静默失败，见项目已知坑）。
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_epoch bigint NOT NULL DEFAULT 0;
