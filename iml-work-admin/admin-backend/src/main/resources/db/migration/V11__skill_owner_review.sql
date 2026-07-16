-- 私有技能归属 + 上传审核备注（员工 skill-creator 自建 / 第三方包先审后用）
ALTER TABLE skill ADD COLUMN IF NOT EXISTS owner_user_id varchar(64);
ALTER TABLE skill ADD COLUMN IF NOT EXISTS review_note text;
