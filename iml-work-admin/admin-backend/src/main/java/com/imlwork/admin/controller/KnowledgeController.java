package com.imlwork.admin.controller;

import com.imlwork.admin.model.KnowledgeDocument;
import com.imlwork.admin.service.KnowledgeService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

/** 分层知识库。仅做 HTTP 塑形；入库/提升审批/检索/审计在 {@link KnowledgeService}。 */
@RestController
@RequestMapping("/api/v1/knowledge")
public class KnowledgeController {

    private final KnowledgeService service;

    public KnowledgeController(KnowledgeService service) {
        this.service = service;
    }

    @GetMapping("/docs")
    public ResponseEntity<List<KnowledgeDocument>> getDocs(
            @RequestParam(value = "scope", required = false) String scope,
            @RequestParam(value = "ownerId", required = false) String ownerId,
            @RequestParam(value = "page", defaultValue = "0") int page,
            @RequestParam(value = "size", defaultValue = "200") int size) {
        return ResponseEntity.ok(service.getDocs(scope, ownerId, page, size));
    }

    @PostMapping("/upload")
    public ResponseEntity<Map<String, Object>> uploadDocument(
            @RequestParam("file") MultipartFile file,
            @RequestParam("category") String category,
            @RequestParam(value = "chunkSize", required = false) Integer chunkSize,
            @RequestParam(value = "chunkOverlap", required = false) Integer chunkOverlap) {
        try {
            return ResponseEntity.ok(service.upload(file, category, chunkSize, chunkOverlap));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("success", false, "error", e.getMessage()));
        }
    }

    @PostMapping("/ingest")
    public ResponseEntity<Map<String, Object>> ingestPersonal(
            @RequestParam("file") MultipartFile file,
            @RequestParam("ownerId") String ownerId,
            @RequestParam(value = "chunkSize", required = false) Integer chunkSize,
            @RequestParam(value = "chunkOverlap", required = false) Integer chunkOverlap) {
        try {
            return ResponseEntity.ok(service.ingestPersonal(file, ownerId, chunkSize, chunkOverlap));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("success", false, "error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("success", false, "error", e.getMessage()));
        }
    }

    @PostMapping("/docs/{id}/promote")
    public ResponseEntity<Map<String, Object>> proposePromotion(
            @PathVariable String id, @RequestParam("category") String category,
            @RequestParam(value = "ownerId", required = false) String ownerId) {
        return ResponseEntity.ok(service.proposePromotion(id, category));
    }

    @GetMapping("/promotions")
    public ResponseEntity<List<KnowledgeDocument>> pendingPromotions() {
        return ResponseEntity.ok(service.pendingPromotions());
    }

    @PostMapping("/docs/{id}/approve")
    public ResponseEntity<Map<String, Object>> approvePromotion(
            @PathVariable String id, @RequestParam(value = "category", required = false) String category) {
        return ResponseEntity.ok(service.approvePromotion(id, category));
    }

    @PostMapping("/docs/{id}/reject")
    public ResponseEntity<Map<String, Object>> rejectPromotion(@PathVariable String id) {
        return ResponseEntity.ok(service.rejectPromotion(id));
    }

    @DeleteMapping("/docs/{id}")
    public ResponseEntity<Map<String, Object>> deleteDoc(@PathVariable String id) {
        return ResponseEntity.ok(service.deleteDoc(id));
    }

    @GetMapping("/query")
    public ResponseEntity<List<Map<String, Object>>> queryRag(
            @RequestParam("text") String text,
            @RequestParam(value = "topK", defaultValue = "3") int topK,
            @RequestParam(value = "categories", required = false) String categories,
            @RequestParam(value = "ownerId", required = false) String ownerId,
            @RequestParam(value = "clientId", defaultValue = "admin-console") String clientId) {
        return ResponseEntity.ok(service.query(text, topK, categories, ownerId, clientId));
    }

    @GetMapping("/audit")
    public ResponseEntity<Map<String, Object>> audit() {
        return ResponseEntity.ok(service.audit());
    }
}
