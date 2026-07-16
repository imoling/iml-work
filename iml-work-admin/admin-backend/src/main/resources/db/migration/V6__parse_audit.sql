-- 文档解析审计：每次解析（知识入库/手动解析）留痕，供「安全沙箱 › 文档引擎」历史回溯。
-- 与虾池的 sandbox_exec_audit 同构：容器/引擎侧无状态，历史一律靠审计表。
CREATE TABLE IF NOT EXISTS parse_audit (
    id         BIGSERIAL PRIMARY KEY,
    filename   VARCHAR(512),
    size_bytes BIGINT  DEFAULT 0,
    success    BOOLEAN NOT NULL,
    error      TEXT,
    latency_ms BIGINT  DEFAULT 0,
    source     VARCHAR(32) DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_parse_audit_id ON parse_audit (id DESC);
