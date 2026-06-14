package com.imlwork.admin.controller;

import com.imlwork.admin.model.KnowledgeDocument;
import com.imlwork.admin.model.RetrievalAudit;
import com.imlwork.admin.repository.KnowledgeDocumentRepository;
import com.imlwork.admin.repository.RetrievalAuditRepository;
import com.imlwork.admin.service.RagService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/v1/knowledge")
public class KnowledgeController {

    private final KnowledgeDocumentRepository documentRepository;
    private final RetrievalAuditRepository auditRepository;
    private final RagService ragService;

    @Value("${rag.chunk.default-size:280}")
    private int defaultChunkSize;

    @Value("${rag.chunk.default-overlap:40}")
    private int defaultOverlap;

    public KnowledgeController(KnowledgeDocumentRepository documentRepository,
                              RetrievalAuditRepository auditRepository,
                              RagService ragService) {
        this.documentRepository = documentRepository;
        this.auditRepository = auditRepository;
        this.ragService = ragService;
    }

    @GetMapping("/docs")
    public ResponseEntity<List<KnowledgeDocument>> getDocs() {
        return ResponseEntity.ok(documentRepository.findAll());
    }

    @PostMapping("/upload")
    public ResponseEntity<Map<String, Object>> uploadDocument(
            @RequestParam("file") MultipartFile file,
            @RequestParam("category") String category,
            @RequestParam(value = "chunkSize", required = false) Integer chunkSize,
            @RequestParam(value = "chunkOverlap", required = false) Integer chunkOverlap) {

        try {
            String content = new BufferedReader(new InputStreamReader(file.getInputStream(), StandardCharsets.UTF_8))
                    .lines().collect(Collectors.joining("\n"));

            int size = chunkSize != null ? chunkSize : defaultChunkSize;
            int overlap = chunkOverlap != null ? chunkOverlap : defaultOverlap;

            String docId = "doc-" + UUID.randomUUID().toString().substring(0, 8);
            int chunksCreated = ragService.processAndAddDocument(docId, category, content, size, overlap);

            KnowledgeDocument doc = new KnowledgeDocument(
                    docId, file.getOriginalFilename(), file.getSize(), chunksCreated, category, LocalDateTime.now());
            doc.setChunkSize(size);
            doc.setChunkOverlap(overlap);
            documentRepository.save(doc);

            return ResponseEntity.ok(Map.of(
                    "success", true,
                    "documentId", docId,
                    "chunksCreated", chunksCreated,
                    "chunkSize", size,
                    "chunkOverlap", overlap
            ));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("success", false, "error", e.getMessage()));
        }
    }

    @DeleteMapping("/docs/{id}")
    public ResponseEntity<Map<String, Object>> deleteDoc(@PathVariable String id) {
        if (!documentRepository.existsById(id)) {
            return ResponseEntity.notFound().build();
        }
        ragService.deleteDocumentChunks(id);
        documentRepository.deleteById(id);
        return ResponseEntity.ok(Map.of("success", true, "deletedId", id));
    }

    @GetMapping("/query")
    public ResponseEntity<List<Map<String, Object>>> queryRag(
            @RequestParam("text") String text,
            @RequestParam(value = "topK", defaultValue = "3") int topK,
            @RequestParam(value = "categories", required = false) String categories,
            @RequestParam(value = "clientId", defaultValue = "admin-console") String clientId) {

        List<String> categoryList = (categories == null || categories.isBlank())
                ? null
                : Arrays.stream(categories.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();

        List<RagService.Chunk> chunks = ragService.queryWithAudit(text, topK, categoryList, clientId);
        List<Map<String, Object>> results = chunks.stream()
                .map(chunk -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("documentId", chunk.getDocumentId());
                    m.put("text", chunk.getText());
                    m.put("score", Math.max(0.0, chunk.getScore())); // real pgvector cosine similarity
                    return m;
                })
                .collect(Collectors.toList());

        return ResponseEntity.ok(results);
    }

    /** Retrieval hit-rate / consumption audit for the KnowledgeManager console. */
    @GetMapping("/audit")
    public ResponseEntity<Map<String, Object>> audit() {
        long total = auditRepository.count();
        long hits = auditRepository.countByHit(true);
        double hitRate = total == 0 ? 0.0 : hits / (double) total;

        List<Map<String, Object>> recent = new ArrayList<>();
        for (RetrievalAudit a : auditRepository.findTop20ByOrderByCreatedAtDesc()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("query", a.getQueryText());
            m.put("hit", a.isHit());
            m.put("topScore", Math.round(a.getTopScore() * 1000.0) / 1000.0);
            m.put("latencyMs", a.getLatencyMs());
            m.put("clientId", a.getClientId());
            m.put("createdAt", a.getCreatedAt());
            recent.add(m);
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("totalRetrievals", total);
        result.put("hits", hits);
        result.put("misses", total - hits);
        result.put("hitRate", Math.round(hitRate * 1000.0) / 1000.0);
        result.put("avgLatencyMs", Math.round(auditRepository.averageLatency() * 100.0) / 100.0);
        result.put("totalChunks", ragService.chunkCount());
        result.put("recent", recent);
        return ResponseEntity.ok(result);
    }
}
