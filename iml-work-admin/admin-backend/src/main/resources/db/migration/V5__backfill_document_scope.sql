-- 回填存量文档的 scope：scope 列晚于早期种子文档加入，NULL 行会被 findByScope('ENTERPRISE') 漏掉——
-- 表现为客户端「企业知识库」清单缺文档（检索用的 knowledge_chunk 不受影响，其 scope 一直正确）。
-- 语义上非 PERSONAL 即企业，与管理端展示口径一致。
UPDATE knowledge_document SET scope = 'ENTERPRISE' WHERE scope IS NULL;
