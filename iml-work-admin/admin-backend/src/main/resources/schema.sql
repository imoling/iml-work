-- pgvector extension + corporate knowledge chunk store.
-- This table is managed outside JPA because the `vector` column type is a
-- pgvector extension type queried with the `<=>` cosine-distance operator.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_chunk (
    id          BIGSERIAL PRIMARY KEY,
    document_id VARCHAR(64)  NOT NULL,
    category    VARCHAR(128),
    text        TEXT         NOT NULL,
    embedding   vector(384),
    created_at  TIMESTAMP    DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_document ON knowledge_chunk (document_id);

-- 文档插图（图文知识库）：docling 以 embedded 模式解析出的内嵌图片。
-- 正文中以【图N】占位（N=seq），检索命中后按需取图回填，图片不参与向量化。
CREATE TABLE IF NOT EXISTS knowledge_image (
    id          BIGSERIAL PRIMARY KEY,
    document_id VARCHAR(64) NOT NULL,
    seq         INT         NOT NULL,
    data_uri    TEXT        NOT NULL,
    created_at  TIMESTAMP   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_image_document ON knowledge_image (document_id);

-- Layered knowledge base: PERSONAL chunks belong to a single owner (only that
-- user retrieves them); ENTERPRISE chunks are company-wide and filtered by
-- category. owner_id is NULL for enterprise chunks.
ALTER TABLE knowledge_chunk ADD COLUMN IF NOT EXISTS scope    VARCHAR(16) DEFAULT 'ENTERPRISE';
ALTER TABLE knowledge_chunk ADD COLUMN IF NOT EXISTS owner_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_owner ON knowledge_chunk (owner_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_scope ON knowledge_chunk (scope);

-- 模型通道可选计费单价（元/千 token）。nullable：NULL=未配置=驾驶舱不计费（不臆造）。
-- 显式建列兜底 ddl-auto 在非空表增列的边界，保证运行时不报 column does not exist。
ALTER TABLE model_provider ADD COLUMN IF NOT EXISTS input_price_per1k  DOUBLE PRECISION;
ALTER TABLE model_provider ADD COLUMN IF NOT EXISTS output_price_per1k DOUBLE PRECISION;

-- 向量 ANN 索引（余弦距离 <=>，对应 vector_cosine_ops）。没有它，RAG 检索会全表顺序扫描，
-- 数据量上来后急剧变慢。用 HNSW（需 pgvector >= 0.5）。
-- 注意：必须是「单条」语句——Spring 的 schema.sql 执行器按 ; 切分，不支持 DO $$ 块。
-- 若 pgvector 过老导致 hnsw 不可用，本句报错会被 spring.sql.init.continue-on-error=true 跳过，不影响启动。
CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_embedding
  ON knowledge_chunk USING hnsw (embedding vector_cosine_ops);
