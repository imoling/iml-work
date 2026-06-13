package com.imlwork.admin.controller;

import com.imlwork.admin.model.KnowledgeDocument;
import com.imlwork.admin.service.RagService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/v1/knowledge")
public class KnowledgeController {

    private final List<KnowledgeDocument> documents = new ArrayList<>();
    private final RagService ragService;

    public KnowledgeController(RagService ragService) {
        this.ragService = ragService;
        
        // Seed default corporate knowledge documents info
        documents.add(new KnowledgeDocument("corp-doc-1", "企业基础纳税识别规范.txt", 1024L, 1, "公司基本信息", LocalDateTime.now().minusDays(3)));
        documents.add(new KnowledgeDocument("corp-doc-2", "企业差旅与福利报销规范.txt", 2048L, 2, "行政财务制度", LocalDateTime.now().minusDays(2)));
        documents.add(new KnowledgeDocument("corp-doc-3", "公章申请审批细则.txt", 3072L, 2, "企业合规制度", LocalDateTime.now().minusDays(1)));
    }

    @GetMapping("/docs")
    public ResponseEntity<List<KnowledgeDocument>> getDocs() {
        return ResponseEntity.ok(documents);
    }

    @PostMapping("/upload")
    public ResponseEntity<Map<String, Object>> uploadDocument(
            @RequestParam("file") MultipartFile file,
            @RequestParam("category") String category) {
        
        try {
            // Read content from file
            String content = new BufferedReader(new InputStreamReader(file.getInputStream()))
                    .lines().collect(Collectors.joining("\n"));
            
            String docId = "doc-" + UUID.randomUUID().toString().substring(0, 8);
            
            // Segment and load to RAG Service
            ragService.processAndAddDocument(docId, content);
            
            // Count approximate chunks
            int chunksCount = Math.max(1, content.split("(?<=[。！？\n])").length);
            
            KnowledgeDocument doc = new KnowledgeDocument(
                    docId,
                    file.getOriginalFilename(),
                    file.getSize(),
                    chunksCount,
                    category,
                    LocalDateTime.now()
            );
            documents.add(doc);
            
            return ResponseEntity.ok(Map.of(
                    "success", true,
                    "documentId", docId,
                    "chunksCreated", chunksCount
            ));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of(
                    "success", false,
                    "error", e.getMessage()
            ));
        }
    }

    @GetMapping("/query")
    public ResponseEntity<List<Map<String, Object>>> queryRag(
            @RequestParam("text") String text,
            @RequestParam(value = "topK", defaultValue = "3") int topK) {
        
        List<RagService.Chunk> chunks = ragService.query(text, topK);
        List<Map<String, Object>> results = chunks.stream()
                .map(chunk -> Map.<String, Object>of(
                        "documentId", chunk.getDocumentId(),
                        "text", chunk.getText(),
                        "score", 0.85f // Mock similarity score
                ))
                .collect(Collectors.toList());
        
        return ResponseEntity.ok(results);
    }
}
