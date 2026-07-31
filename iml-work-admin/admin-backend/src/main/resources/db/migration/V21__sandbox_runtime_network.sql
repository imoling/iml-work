-- 拍板 B（2026-07-29）：出网白名单里的包，允许该次执行**运行时**联网，而不只是装包阶段联网。
--
-- 背景：沙箱原本是两阶段切网（装包联网 → 断网 → 跑用户代码，fail-closed）。但 mootdx / requests /
-- stockstats 这类包装上不联网就毫无意义——A股取数技能连抛 ConnectionError，重试 3 轮也不可能成功。
-- 白名单的语义因此从"允许装"扩展为"允许用"：名单由管理员维护，技能安装本身还要过风险裁决。
--
-- 置 false 即退回旧的两阶段切网行为（出问题时的退路）。
ALTER TABLE sandbox_config ADD COLUMN IF NOT EXISTS runtime_network_whitelisted BOOLEAN NOT NULL DEFAULT TRUE;
