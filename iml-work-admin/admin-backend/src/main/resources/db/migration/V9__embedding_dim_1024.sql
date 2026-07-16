-- 向量维度 384 → 1024：接入真实的中文向量模型（bge-m3）。
--
-- 为什么必须换：此前 rag.embedding.endpoint 没配，服务退化到**本地特征哈希兜底向量**——
-- 那不是语义模型，只做字面重叠。实测查询「动态虾池」命中标题就叫《动态虾池》的文档，
-- 相似度只有 **0.359**（低于 0.45 的相关性下限），于是**真命中被系统当噪声滤掉**。
-- 换成 bge-m3 后同一对比：真命中 0.801、无关文档 0.19 —— 区分度这才拉得开，阈值才有意义。
--
-- 换模型必然作废所有历史向量（维度和空间都变了）。本迁移只负责改列与索引；
-- 向量重建走 POST /api/v1/knowledge/reindex（后端按 chunk 原文重新调用 embedding 服务）。
--
-- 顺序不能反：HNSW 索引绑定了列的维度，必须**先删索引、再改列类型**，否则 ALTER 直接失败。
DROP INDEX IF EXISTS idx_knowledge_chunk_embedding;

-- 旧向量在新空间里没有任何意义（不是"精度差一点"，是彻底无关），置空等待重建，
-- 免得残留脏向量继续参与检索、给出看似有分数实则荒谬的结果。
UPDATE knowledge_chunk SET embedding = NULL;

ALTER TABLE knowledge_chunk ALTER COLUMN embedding TYPE vector(1024) USING NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_embedding
    ON knowledge_chunk USING hnsw (embedding vector_cosine_ops);
