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

    /** 查看已入库内容：某文档的分块正文（管理端点「查看」按钮用）。 */
    @GetMapping("/docs/{id}/chunks")
    public ResponseEntity<Map<String, Object>> getDocChunks(
            @PathVariable String id,
            @RequestParam(value = "limit", defaultValue = "200") int limit) {
        return ResponseEntity.ok(service.getDocChunks(id, limit));
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

    /** 改文档分类（上传时选错分类是常事；此前只能删了重传）。文档表 + chunk 冗余字段同步更新。 */
    @PutMapping("/docs/{id}/category")
    public Map<String, Object> recategorize(@PathVariable String id, @RequestBody Map<String, String> body) {
        return service.recategorize(id, body.get("category"));
    }

    @DeleteMapping("/docs/{id}")
    public ResponseEntity<Map<String, Object>> deleteDoc(@PathVariable String id) {
        return ResponseEntity.ok(service.deleteDoc(id));
    }

    /** 向量服务健康（真发一次向量请求，不是只 ping 端口——容器活着但模型没拉进去，端口照样通）。 */
    @GetMapping("/embedding/health")
    public Map<String, Object> embeddingHealth() {
        return service.embeddingHealth();
    }

    /**
     * 重建全部向量（换 embedding 模型后必须跑一次；否则旧向量在新空间里毫无意义）。
     * 需 KNOWLEDGE_MANAGE 权限——这是重活，不能让谁都能触发。
     */
    @PostMapping("/reindex")
    public Map<String, Object> reindex() {
        return service.reindexAll();
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
