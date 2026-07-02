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

-- Layered knowledge base: PERSONAL chunks belong to a single owner (only that
-- user retrieves them); ENTERPRISE chunks are company-wide and filtered by
-- category. owner_id is NULL for enterprise chunks.
ALTER TABLE knowledge_chunk ADD COLUMN IF NOT EXISTS scope    VARCHAR(16) DEFAULT 'ENTERPRISE';
ALTER TABLE knowledge_chunk ADD COLUMN IF NOT EXISTS owner_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_owner ON knowledge_chunk (owner_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_scope ON knowledge_chunk (scope);

-- 向量 ANN 索引（余弦距离 <=>，对应 vector_cosine_ops）。没有它，RAG 检索会全表顺序扫描，
-- 数据量上来后急剧变慢。用 HNSW（pgvector >= 0.5）；老版本/异常时优雅跳过，绝不影响启动。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_knowledge_chunk_embedding') THEN
    BEGIN
      CREATE INDEX idx_knowledge_chunk_embedding
        ON knowledge_chunk USING hnsw (embedding vector_cosine_ops);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'HNSW 向量索引不可用(%)，已跳过；余弦检索将顺序扫描。', SQLERRM;
    END;
  END IF;
END$$;
