-- 客户端 UI 配置 KV（首页卡片语料等，管理端「卡片管理」下发；value 为 JSON 文本）
CREATE TABLE IF NOT EXISTS client_ui_config (
    id         varchar(64) PRIMARY KEY,
    value      text,
    updated_at timestamp
);
