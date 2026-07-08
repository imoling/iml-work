-- 沙箱执行审计表：一次性容器"创建→执行→销毁"留痕（在线监控看不到历史，故落库）。
-- 只存元信息 + 截断预览，够溯源即可。ddl-auto 已交 Flyway，新表由此迁移建。
CREATE TABLE IF NOT EXISTS sandbox_exec_audit (
    id                BIGSERIAL PRIMARY KEY,
    created_at        TIMESTAMP,
    source            VARCHAR(255),
    container_id      VARCHAR(255),
    image             VARCHAR(255),
    packages          VARCHAR(1000),
    duration_ms       BIGINT       NOT NULL DEFAULT 0,
    success           BOOLEAN      NOT NULL DEFAULT FALSE,
    network_isolated  BOOLEAN      NOT NULL DEFAULT FALSE,
    status            VARCHAR(32),
    file_count        INTEGER      NOT NULL DEFAULT 0,
    file_names        VARCHAR(2000),
    code_preview      TEXT,
    stdout_preview    TEXT,
    stderr_preview    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sandbox_audit_created ON sandbox_exec_audit (created_at DESC);
