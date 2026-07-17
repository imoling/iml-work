-- 检索服务商新增 SEARXNG（自托管聚合检索，免密钥）：配置只多一个服务地址。
ALTER TABLE search_config ADD COLUMN IF NOT EXISTS endpoint character varying(500);
