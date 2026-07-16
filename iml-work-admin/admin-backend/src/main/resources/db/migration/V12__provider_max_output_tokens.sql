-- 模型通道级最大输出 tokens：调用方未指定 max_tokens 时由网关注入（防长输出被厂商默认 4k 截断）
ALTER TABLE model_provider ADD COLUMN IF NOT EXISTS max_output_tokens integer;
