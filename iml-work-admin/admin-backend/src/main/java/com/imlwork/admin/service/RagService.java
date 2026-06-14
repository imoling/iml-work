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

        public Chunk(String documentId, String text, double score) {
            this.documentId = documentId;
            this.text = text;
            this.score = score;
        }

        public String getDocumentId() { return documentId; }
        public String getText() { return text; }
        public double getScore() { return score; }
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

    /** Chunk + embed + persist a document. Returns the number of chunks created. */
    public int processAndAddDocument(String docId, String category, String content, int chunkSize, int overlap) {
        List<String> chunks = chunk(content, chunkSize, overlap);
        for (String c : chunks) {
            float[] emb = embeddingService.embed(c);
            String vec = new PGvector(emb).toString();
            jdbc.update(
                    "INSERT INTO knowledge_chunk (document_id, category, text, embedding) VALUES (?, ?, ?, ?::vector)",
                    docId, category, c, vec);
        }
        return chunks.size();
    }

    public void deleteDocumentChunks(String docId) {
        jdbc.update("DELETE FROM knowledge_chunk WHERE document_id = ?", docId);
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
