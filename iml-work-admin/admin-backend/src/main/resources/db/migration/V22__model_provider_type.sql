-- 模型通道类型标注（2026-07-29）：chat=对话快档（默认）/ reasoning=推理档。
-- 客户端按用途请求别名模型（如 corp-reasoning），网关按类型路由到对应通道——
-- 调研等重推理场景自动用推理档，管理员改通道配置全员生效，客户端无需各自手填模型名。
ALTER TABLE model_provider ADD COLUMN IF NOT EXISTS model_type VARCHAR(20) NOT NULL DEFAULT 'chat';
