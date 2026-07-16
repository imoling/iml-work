package com.imlwork.admin.service;

import com.imlwork.admin.model.RetrievalAudit;
import com.imlwork.admin.repository.RetrievalAuditRepository;
import com.pgvector.PGvector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Real RAG over PostgreSQL + pgvector. Documents are chunked with a configurable
 * size/overlap window, embedded via {@link EmbeddingService} and stored in the
 * {@code knowledge_chunk} table. Retrieval ranks by pgvector cosine distance
 * ({@code <=>}) and every query is recorded for the hit-rate audit.
 */
@Service
public class RagService {

    private static final Logger log = LoggerFactory.getLogger(RagService.class);

    /** Top result must clear this cosine similarity to count as an audit hit. */
    private static final double HIT_THRESHOLD = 0.45;

    public static class Chunk {
        private final String documentId;
        private final String text;
        private final double score;
        private final String scope;

        public Chunk(String documentId, String text, double score) {
            this(documentId, text, score, null);
        }

        public Chunk(String documentId, String text, double score, String scope) {
            this.documentId = documentId;
            this.text = text;
            this.score = score;
            this.scope = scope;
        }

        public String getDocumentId() { return documentId; }
        public String getText() { return text; }
        public double getScore() { return score; }
        public String getScope() { return scope; }
    }

    private final JdbcTemplate jdbc;
    private final EmbeddingService embeddingService;
    private final RetrievalAuditRepository auditRepository;

    public RagService(JdbcTemplate jdbc, EmbeddingService embeddingService, RetrievalAuditRepository auditRepository) {
        this.jdbc = jdbc;
        this.embeddingService = embeddingService;
        this.auditRepository = auditRepository;
    }

    /** Plain ranked retrieval (no audit), optionally scoped to categories. */
    public List<Chunk> query(String queryText, int topK, List<String> categories) {
        float[] q;
        // 向量服务不可达 → 返回空（调用方如实说"没查到相关制度"），而不是把请求打成 500，
        // 更不是拿哈希向量硬凑一个荒谬的相似度。检索失败要么如实为空，要么给真结果，绝无中间态。
        try { q = embeddingService.embed(queryText); }
        catch (Exception e) { log.error("[RAG] 检索失败（向量服务不可达）：{}", e.getMessage()); return List.of(); }
        String vec = new PGvector(q).toString();

        StringBuilder sql = new StringBuilder(
                "SELECT document_id, text, 1 - (embedding <=> ?::vector) AS score FROM knowledge_chunk");
        List<Object> args = new ArrayList<>();
        args.add(vec);
        if (categories != null && !categories.isEmpty()) {
            String placeholders = String.join(",", categories.stream().map(c -> "?").toList());
            sql.append(" WHERE category IN (").append(placeholders).append(")");
            args.addAll(categories);
        }
        sql.append(" ORDER BY embedding <=> ?::vector LIMIT ?");
        args.add(vec);
        args.add(topK);

        return jdbc.query(sql.toString(), (rs, rowNum) ->
                new Chunk(rs.getString("document_id"), rs.getString("text"), rs.getDouble("score")),
                args.toArray());
    }

    public List<Chunk> query(String queryText, int topK) {
        return query(queryText, topK, null);
    }

    /**
     * Layered retrieval for the personal + enterprise knowledge base. Returns the
     * union of: ENTERPRISE chunks in the allowed {@code categories} (all enterprise
     * chunks when categories is null/empty) PLUS PERSONAL chunks owned by
     * {@code ownerId}. When {@code ownerId} is null this reduces to enterprise-only
     * retrieval, preserving the previous behaviour.
     */
    public List<Chunk> queryLayered(String queryText, int topK, List<String> categories, String ownerId) {
        float[] q;
        try { q = embeddingService.embed(queryText); }
        catch (Exception e) { log.error("[RAG] 分层检索失败（向量服务不可达）：{}", e.getMessage()); return List.of(); }
        String vec = new PGvector(q).toString();

        StringBuilder where = new StringBuilder();
        List<Object> args = new ArrayList<>();
        args.add(vec); // for SELECT score

        // Enterprise branch (optionally category-scoped)
        StringBuilder ent = new StringBuilder("scope = 'ENTERPRISE'");
        if (categories != null && !categories.isEmpty()) {
            String placeholders = String.join(",", categories.stream().map(c -> "?").toList());
            ent.append(" AND category IN (").append(placeholders).append(")");
        }
        where.append("(").append(ent).append(")");

        // Personal branch (owner-scoped) — only when an owner is provided
        if (ownerId != null && !ownerId.isBlank()) {
            where.append(" OR (scope = 'PERSONAL' AND owner_id = ?)");
        }

        String sql = "SELECT document_id, text, scope, 1 - (embedding <=> ?::vector) AS score"
                + " FROM knowledge_chunk WHERE " + where
                + " ORDER BY embedding <=> ?::vector LIMIT ?";

        // Bind order must match the SQL: score-vec, [categories], [ownerId], order-vec, topK
        if (categories != null && !categories.isEmpty()) args.addAll(categories);
        if (ownerId != null && !ownerId.isBlank()) args.add(ownerId);
        args.add(vec);
        args.add(topK);

        return jdbc.query(sql, (rs, rowNum) ->
                        new Chunk(rs.getString("document_id"), rs.getString("text"),
                                rs.getDouble("score"), rs.getString("scope")),
                args.toArray());
    }

    /** Layered retrieval + audit persistence. */
    public List<Chunk> queryLayeredWithAudit(String queryText, int topK, List<String> categories,
                                             String ownerId, String clientId) {
        long start = System.nanoTime();
        List<Chunk> results = queryLayered(queryText, topK, categories, ownerId);
        long latencyMs = (System.nanoTime() - start) / 1_000_000;
        double topScore = results.isEmpty() ? 0.0 : results.get(0).getScore();
        boolean hit = topScore >= HIT_THRESHOLD;
        try {
            auditRepository.save(new RetrievalAudit(queryText, hit, topScore, latencyMs, clientId));
        } catch (Exception e) {
            log.warn("[RAG] Failed to persist retrieval audit: {}", e.getMessage());
        }
        return results;
    }

    /** Retrieval that also persists a {@link RetrievalAudit} record. */
    public List<Chunk> queryWithAudit(String queryText, int topK, List<String> categories, String clientId) {
        long start = System.nanoTime();
        List<Chunk> results = query(queryText, topK, categories);
        long latencyMs = (System.nanoTime() - start) / 1_000_000;

        double topScore = results.isEmpty() ? 0.0 : results.get(0).getScore();
        boolean hit = topScore >= HIT_THRESHOLD;
        try {
            auditRepository.save(new RetrievalAudit(queryText, hit, topScore, latencyMs, clientId));
        } catch (Exception e) {
            log.warn("[RAG] Failed to persist retrieval audit: {}", e.getMessage());
        }
        return results;
    }

    /** Chunk + embed + persist an ENTERPRISE document. Returns chunks created. */
    public int processAndAddDocument(String docId, String category, String content, int chunkSize, int overlap) {
        return processAndAddDocument(docId, category, content, chunkSize, overlap, "ENTERPRISE", null);
    }

    /**
     * Chunk + embed + persist a document into the given layer. {@code scope} is
     * ENTERPRISE or PERSONAL; {@code ownerId} is required for PERSONAL and ignored
     * for ENTERPRISE. Returns the number of chunks created.
     */
    public int processAndAddDocument(String docId, String category, String content,
                                     int chunkSize, int overlap, String scope, String ownerId) {
        List<String> chunks = chunk(content, chunkSize, overlap);
        for (String c : chunks) {
            float[] emb = embeddingService.embed(c);
            String vec = new PGvector(emb).toString();
            jdbc.update(
                    "INSERT INTO knowledge_chunk (document_id, category, text, embedding, scope, owner_id) "
                            + "VALUES (?, ?, ?, ?::vector, ?, ?)",
                    docId, category, c, vec, scope, ownerId);
        }
        return chunks.size();
    }

    /** 向量服务健康（转发到 EmbeddingService，真发一次请求）。 */
    public Map<String, Object> embeddingHealth() {
        return embeddingService.health();
    }

    /**
     * 按 chunk 原文**重建全部向量**。换 embedding 模型时的必备能力——否则换个模型就只能删库重传所有文档。
     *
     * 一次只捞一批（分页），避免把十万级分块的正文一次性拉进内存。
     * 逐条更新而非批量：embedding 服务可能失败，失败一条不该拖垮整批（如实返回失败数，不假装成功）。
     */
    public Map<String, Object> reindexAll(int batchSize) {
        int ok = 0, failed = 0;
        long lastId = 0;
        while (true) {
            List<Map<String, Object>> rows = jdbc.queryForList(
                    "SELECT id, text FROM knowledge_chunk WHERE id > ? ORDER BY id LIMIT ?", lastId, batchSize);
            if (rows.isEmpty()) break;
            for (Map<String, Object> r : rows) {
                long id = ((Number) r.get("id")).longValue();
                lastId = id;
                try {
                    float[] emb = embeddingService.embed(String.valueOf(r.get("text")));
                    jdbc.update("UPDATE knowledge_chunk SET embedding = ?::vector WHERE id = ?",
                            new PGvector(emb).toString(), id);
                    ok++;
                } catch (Exception e) {
                    failed++;
                    log.warn("[RAG] 分块 {} 向量重建失败：{}", id, e.getMessage());
                }
            }
        }
        log.info("[RAG] 向量重建完成：成功 {}，失败 {}", ok, failed);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("success", failed == 0);
        m.put("reindexed", ok);
        m.put("failed", failed);
        m.put("dimension", embeddingService.getDimension());
        // 明确回报用的是真语义模型还是哈希兜底 —— 兜底是"能跑但不准"，悄悄退化最要命：
        // 没配 endpoint 时它照样返回分数，只是分数毫无语义可言（真命中 0.36、被阈值当噪声滤掉）。
        m.put("embedding", embeddingService.isRemote() ? "远程语义模型" : "⚠️ 本地特征哈希兜底（非语义，检索质量差）");
        return m;
    }

    /** Flip all chunks of a document to a new scope/category (e.g. promotion to enterprise). */
    public void updateDocumentScope(String docId, String scope, String category, String ownerId) {
        jdbc.update("UPDATE knowledge_chunk SET scope = ?, category = ?, owner_id = ? WHERE document_id = ?",
                scope, category, ownerId, docId);
    }

    /** 同步 chunk 上的分类冗余字段（检索按它过滤——文档改了分类而 chunk 没改，检索就还按旧分类走）。 */
    public int recategorizeChunks(String docId, String category) {
        return jdbc.update("UPDATE knowledge_chunk SET category = ? WHERE document_id = ?", category, docId);
    }

    public void deleteDocumentChunks(String docId) {
        jdbc.update("DELETE FROM knowledge_chunk WHERE document_id = ?", docId);
        jdbc.update("DELETE FROM knowledge_image WHERE document_id = ?", docId);
    }

    // ── 图文知识库：插图抽离与按需取回 ─────────────────────────────────────────
    private static final java.util.regex.Pattern MD_DATA_IMAGE =
            java.util.regex.Pattern.compile("!\\[[^\\]]*\\]\\((data:image/[a-zA-Z+]+;base64,[^)]+)\\)");
    private static final int MAX_IMAGES_PER_DOC = 20;
    private static final int MAX_IMAGE_DATA_URI_LEN = 4_000_000;   // ~3MB 图片的 base64 上限(scale=2.0 的整页大图也能容纳)

    /**
     * 从 docling 内嵌图片的 markdown 中抽离插图：图片存 knowledge_image，正文以【图N】占位。
     * 图片不参与向量化（base64 会污染 embedding），检索命中后按占位回填。返回清洗后的正文。
     */
    public String saveImagesAndStrip(String docId, String content) {
        if (content == null || !content.contains("data:image/")) return content;
        StringBuilder out = new StringBuilder();
        java.util.regex.Matcher m = MD_DATA_IMAGE.matcher(content);
        int seq = 0;
        while (m.find()) {
            String dataUri = m.group(1);
            String replacement;
            if (seq >= MAX_IMAGES_PER_DOC || dataUri.length() > MAX_IMAGE_DATA_URI_LEN) {
                replacement = "";   // 超限图片丢弃（防大文档撑爆库），正文不留占位
            } else {
                seq++;
                jdbc.update("INSERT INTO knowledge_image (document_id, seq, data_uri) VALUES (?, ?, ?)",
                        docId, seq, dataUri);
                replacement = "【图" + seq + "】";
            }
            m.appendReplacement(out, java.util.regex.Matcher.quoteReplacement(replacement));
        }
        m.appendTail(out);
        return out.toString();
    }

    /** 某文档的全部插图（seq → data_uri）。 */
    public Map<Integer, String> imagesOf(String docId) {
        Map<Integer, String> out = new java.util.LinkedHashMap<>();
        jdbc.query("SELECT seq, data_uri FROM knowledge_image WHERE document_id = ? ORDER BY seq",
                rs -> { out.put(rs.getInt("seq"), rs.getString("data_uri")); }, docId);
        return out;
    }

    /** 按插入顺序取某文档的分块正文（管理端「查看已入库内容」用；带上限防大文档拖垮）。 */
    public List<Map<String, Object>> chunksOf(String docId, int limit) {
        int capped = Math.max(1, Math.min(limit, 1000));
        return jdbc.query(
                "SELECT id, text FROM knowledge_chunk WHERE document_id = ? ORDER BY id LIMIT " + capped,
                (rs, i) -> {
                    Map<String, Object> m = new java.util.LinkedHashMap<>();
                    m.put("seq", i + 1);
                    m.put("text", rs.getString("text"));
                    return m;
                }, docId);
    }

    public long chunkCount() {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM knowledge_chunk", Long.class);
        return n == null ? 0 : n;
    }

    /**
     * Sliding-window chunking. Splits on sentence boundaries first, then packs
     * sentences up to {@code chunkSize} characters, carrying {@code overlap}
     * trailing characters into the next window for context continuity.
     */
    private List<String> chunk(String content, int chunkSize, int overlap) {
        List<String> result = new ArrayList<>();
        if (content == null || content.isBlank()) {
            return result;
        }
        if (chunkSize <= 0) {
            chunkSize = 280;
        }
        if (overlap < 0 || overlap >= chunkSize) {
            overlap = Math.min(40, chunkSize / 4);
        }

        String[] sentences = content.split("(?<=[。！？!?\\n])");
        StringBuilder current = new StringBuilder();
        for (String sentence : sentences) {
            String s = sentence.trim();
            if (s.isEmpty()) {
                continue;
            }
            if (current.length() + s.length() > chunkSize && current.length() > 0) {
                result.add(current.toString().trim());
                String tail = current.substring(Math.max(0, current.length() - overlap));
                current = new StringBuilder(tail);
            }
            current.append(s);
        }
        if (current.length() > 0 && current.toString().trim().length() > 0) {
            result.add(current.toString().trim());
        }
        return result;
    }
}
