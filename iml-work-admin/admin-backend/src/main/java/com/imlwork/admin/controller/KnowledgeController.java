package com.imlwork.admin.controller;

import com.imlwork.admin.model.KnowledgeDocument;
import com.imlwork.admin.model.RetrievalAudit;
import com.imlwork.admin.repository.KnowledgeDocumentRepository;
import com.imlwork.admin.repository.RetrievalAuditRepository;
import com.imlwork.admin.service.DoclingService;
import com.imlwork.admin.service.RagService;
import com.imlwork.admin.security.JwtAuthFilter;
import com.imlwork.admin.security.Permissions;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
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
    private final DoclingService docling;

    @Value("${rag.chunk.default-size:280}")
    private int defaultChunkSize;

    @Value("${rag.chunk.default-overlap:40}")
    private int defaultOverlap;

    public KnowledgeController(KnowledgeDocumentRepository documentRepository,
                              RetrievalAuditRepository auditRepository,
                              RagService ragService,
                              DoclingService docling) {
        this.documentRepository = documentRepository;
        this.auditRepository = auditRepository;
        this.ragService = ragService;
        this.docling = docling;
    }

    /** Extract document text: docling (docx/pdf/xlsx/…) when available, else plain UTF-8. */
    private String extractContent(MultipartFile file) throws Exception {
        String name = file.getOriginalFilename();
        if (docling.isConfigured() && docling.needsDocling(name)) {
            try {
                return docling.toMarkdown(file.getBytes(), name);
            } catch (Exception e) {
                // Fall through to plain-text read; binary formats will likely be garbage
                // but we never fabricate — the caller sees whatever text we could recover.
            }
        }
        return new BufferedReader(new InputStreamReader(file.getInputStream(), StandardCharsets.UTF_8))
                .lines().collect(Collectors.joining("\n"));
    }

    @GetMapping("/docs")
    public ResponseEntity<List<KnowledgeDocument>> getDocs(
            @RequestParam(value = "scope", required = false) String scope,
            @RequestParam(value = "ownerId", required = false) String ownerId) {
        if (scope != null && ownerId != null) {
            return ResponseEntity.ok(documentRepository.findByScopeAndOwnerId(scope, ownerId));
        }
        if (scope != null) {
            return ResponseEntity.ok(documentRepository.findByScope(scope));
        }
        return ResponseEntity.ok(documentRepository.findAll());
    }

    @PostMapping("/upload")
    public ResponseEntity<Map<String, Object>> uploadDocument(
            @RequestParam("file") MultipartFile file,
            @RequestParam("category") String category,
            @RequestParam(value = "chunkSize", required = false) Integer chunkSize,
            @RequestParam(value = "chunkOverlap", required = false) Integer chunkOverlap) {

        try {
            String content = extractContent(file);

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

    /**
     * Personal knowledge ingestion. Parses (docling) and stores the document into
     * the caller's PERSONAL layer (owner-scoped, only retrievable by them). This is
     * how a user's working files silently become their private RAG as they work.
     */
    @PostMapping("/ingest")
    public ResponseEntity<Map<String, Object>> ingestPersonal(
            @RequestParam("file") MultipartFile file,
            @RequestParam("ownerId") String ownerId,
            @RequestParam(value = "chunkSize", required = false) Integer chunkSize,
            @RequestParam(value = "chunkOverlap", required = false) Integer chunkOverlap) {
        try {
            if (ownerId == null || ownerId.isBlank()) {
                return ResponseEntity.badRequest().body(Map.of("success", false, "error", "ownerId required"));
            }
            String content = extractContent(file);
            int size = chunkSize != null ? chunkSize : defaultChunkSize;
            int overlap = chunkOverlap != null ? chunkOverlap : defaultOverlap;

            String docId = "doc-" + UUID.randomUUID().toString().substring(0, 8);
            int chunksCreated = ragService.processAndAddDocument(
                    docId, "个人知识", content, size, overlap, "PERSONAL", ownerId);

            KnowledgeDocument doc = new KnowledgeDocument(
                    docId, file.getOriginalFilename(), file.getSize(), chunksCreated, "个人知识", LocalDateTime.now());
            doc.setChunkSize(size);
            doc.setChunkOverlap(overlap);
            doc.setScope("PERSONAL");
            doc.setOwnerId(ownerId);
            documentRepository.save(doc);

            return ResponseEntity.ok(Map.of(
                    "success", true, "documentId", docId, "chunksCreated", chunksCreated, "scope", "PERSONAL"));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("success", false, "error", e.getMessage()));
        }
    }

    // ── Personal → Enterprise promotion workflow (admin-approved) ────────────

    /** A user nominates one of their personal docs for the enterprise knowledge base. */
    @PostMapping("/docs/{id}/promote")
    public ResponseEntity<Map<String, Object>> proposePromotion(
            @PathVariable String id,
            @RequestParam("category") String category,
            @RequestParam(value = "ownerId", required = false) String ownerId) {
        return documentRepository.findById(id).map(doc -> {
            if (!"PERSONAL".equals(doc.getScope())) {
                return ResponseEntity.badRequest().body(Map.<String, Object>of(
                        "success", false, "error", "only personal docs can be promoted"));
            }
            doc.setPromotionStatus("PENDING");
            doc.setProposedCategory(category);
            documentRepository.save(doc);
            return ResponseEntity.ok(Map.<String, Object>of("success", true, "documentId", id, "status", "PENDING"));
        }).orElse(ResponseEntity.notFound().build());
    }

    /** Admin lists all pending personal→enterprise promotion requests. */
    @GetMapping("/promotions")
    public ResponseEntity<List<KnowledgeDocument>> pendingPromotions() {
        return ResponseEntity.ok(documentRepository.findByPromotionStatus("PENDING"));
    }

    /** Admin approves a promotion: flips the doc + its chunks to ENTERPRISE + category. */
    @PostMapping("/docs/{id}/approve")
    public ResponseEntity<Map<String, Object>> approvePromotion(
            @PathVariable String id,
            @RequestParam(value = "category", required = false) String category) {
        return documentRepository.findById(id).map(doc -> {
            String cat = (category != null && !category.isBlank()) ? category
                    : (doc.getProposedCategory() != null ? doc.getProposedCategory() : "公司基本信息");
            ragService.updateDocumentScope(id, "ENTERPRISE", cat, null);
            doc.setScope("ENTERPRISE");
            doc.setOwnerId(null);
            doc.setCategory(cat);
            doc.setPromotionStatus("APPROVED");
            documentRepository.save(doc);
            return ResponseEntity.ok(Map.<String, Object>of("success", true, "documentId", id, "category", cat));
        }).orElse(ResponseEntity.notFound().build());
    }

    /** Admin rejects a promotion: the doc stays personal. */
    @PostMapping("/docs/{id}/reject")
    public ResponseEntity<Map<String, Object>> rejectPromotion(@PathVariable String id) {
        return documentRepository.findById(id).map(doc -> {
            doc.setPromotionStatus("REJECTED");
            documentRepository.save(doc);
            return ResponseEntity.ok(Map.<String, Object>of("success", true, "documentId", id, "status", "REJECTED"));
        }).orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/docs/{id}")
    public ResponseEntity<Map<String, Object>> deleteDoc(@PathVariable String id) {
        KnowledgeDocument doc = documentRepository.findById(id).orElse(null);
        if (doc == null) {
            return ResponseEntity.notFound().build();
        }
        // 归属校验：有 KNOWLEDGE_MANAGE 可删任意；否则仅能删自己的 PERSONAL 文档。
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        boolean canManage = auth != null && auth.getAuthorities().stream()
                .anyMatch(a -> Permissions.KNOWLEDGE_MANAGE.equals(a.getAuthority()) || Permissions.ALL.equals(a.getAuthority()));
        if (!canManage) {
            String uid = (auth != null && auth.getPrincipal() instanceof JwtAuthFilter.AuthPrincipal p) ? p.userId() : null;
            boolean ownsPersonal = "PERSONAL".equals(doc.getScope()) && doc.getOwnerId() != null && doc.getOwnerId().equals(uid);
            if (!ownsPersonal) {
                return ResponseEntity.status(403).body(Map.of("success", false, "error", "只能删除自己的个人知识库文档"));
            }
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
            @RequestParam(value = "ownerId", required = false) String ownerId,
            @RequestParam(value = "clientId", defaultValue = "admin-console") String clientId) {

        List<String> categoryList = (categories == null || categories.isBlank())
                ? null
                : Arrays.stream(categories.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();

        // Layered retrieval: enterprise(categories) ∪ personal(owner). With no ownerId
        // this is enterprise-only, preserving prior behaviour.
        List<RagService.Chunk> chunks = ragService.queryLayeredWithAudit(text, topK, categoryList, ownerId, clientId);
        List<Map<String, Object>> results = chunks.stream()
                .map(chunk -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("documentId", chunk.getDocumentId());
                    m.put("text", chunk.getText());
                    m.put("score", Math.max(0.0, chunk.getScore())); // real pgvector cosine similarity
                    m.put("scope", chunk.getScope() == null ? "ENTERPRISE" : chunk.getScope());
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
