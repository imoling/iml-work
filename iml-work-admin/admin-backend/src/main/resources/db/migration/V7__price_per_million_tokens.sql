-- 模型单价的计价单位从「每 1K tokens」改为「每百万 tokens」。
--
-- 为什么改：厂商公开标价现在一律以百万 tokens 为阶梯（DeepSeek：输入 1 元/百万、输出 2 元/百万），
-- 按 1K 记要手动除以 1000，极易填错——库里 DeepSeek 存的 0.0002/1K（=0.2 元/百万）就比官方标价小了 5 倍。
-- 单位与厂商官网一致，运维照抄即可，不再心算。
--
-- 旧值换算：X 元/1K == X * 1000 元/百万。
ALTER TABLE model_provider RENAME COLUMN input_price_per1k TO input_price_per_1m;
ALTER TABLE model_provider RENAME COLUMN output_price_per1k TO output_price_per_1m;

UPDATE model_provider SET input_price_per_1m  = input_price_per_1m  * 1000 WHERE input_price_per_1m  IS NOT NULL;
UPDATE model_provider SET output_price_per_1m = output_price_per_1m * 1000 WHERE output_price_per_1m IS NOT NULL;
