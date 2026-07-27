-- 沙箱出网依赖包白名单：网络隔离开启时，申报 packages 的执行会放开出网（pip 需联网）；
-- 白名单非空则只放行名单内的包，防止任意技能靠申报 packages 变相取得出网能力。空 = 不限制（旧行为）。
ALTER TABLE sandbox_config ADD COLUMN IF NOT EXISTS network_packages text;
