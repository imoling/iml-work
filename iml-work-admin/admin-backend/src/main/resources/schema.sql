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
