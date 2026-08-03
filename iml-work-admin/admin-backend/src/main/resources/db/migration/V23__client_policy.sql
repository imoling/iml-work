-- 客户端策略（单例 row id=1）：管理员对员工客户端的集中管控项。
-- 首项 allow_custom_model：是否允许员工在客户端自配模型（直连厂商 API）。
-- 默认 true = 保持现状（此前客户端本就能自配，改成默认禁止会让已在用的人一升级就断）；
-- 企业要收紧时在管理端关掉，客户端心跳拿到后禁用「网络模型服务/本地模型」两类。
CREATE TABLE IF NOT EXISTS client_policy (
    id                  BIGINT PRIMARY KEY,
    allow_custom_model  BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at          TIMESTAMP
);

INSERT INTO client_policy (id, allow_custom_model, updated_at)
VALUES (1, TRUE, now())
ON CONFLICT (id) DO NOTHING;
