package com.imlwork.admin.service;

import com.imlwork.admin.model.RetrievalAudit;
import com.imlwork.admin.repository.RetrievalAuditRepository;
import com.pgvector.PGvector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
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
        float[] q = embeddingService.embed(queryText);
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
        float[] q = embeddingService.embed(queryText);
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

    /** Flip all chunks of a document to a new scope/category (e.g. promotion to enterprise). */
    public void updateDocumentScope(String docId, String scope, String category, String ownerId) {
        jdbc.update("UPDATE knowledge_chunk SET scope = ?, category = ?, owner_id = ? WHERE document_id = ?",
                scope, category, ownerId, docId);
    }

    public void deleteDocumentChunks(String docId) {
        jdbc.update("DELETE FROM knowledge_chunk WHERE document_id = ?", docId);
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
