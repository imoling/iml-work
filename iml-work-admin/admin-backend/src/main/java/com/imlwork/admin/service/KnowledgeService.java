package com.imlwork.admin.service;

import com.imlwork.admin.model.Expert;
import com.imlwork.admin.model.KnowledgeDocument;
import com.imlwork.admin.model.RetrievalAudit;
import com.imlwork.admin.repository.ExpertRepository;
import com.imlwork.admin.repository.KnowledgeDocumentRepository;
import com.imlwork.admin.repository.RetrievalAuditRepository;
import com.imlwork.admin.security.JwtAuthFilter;
import com.imlwork.admin.security.Permissions;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

/** 企业/个人分层知识库领域服务：文档入库(docling)、个人→企业提升审批、RAG 检索与审计。 */
@Service
public class KnowledgeService {

    private final KnowledgeDocumentRepository documentRepository;
    private final RetrievalAuditRepository auditRepository;
    private final RagService ragService;
    private final DoclingService docling;
    private final ExpertRepository expertRepository;
    private final DictService dictService;

    @Value("${rag.chunk.default-size:280}") private int defaultChunkSize;
    @Value("${rag.chunk.default-overlap:40}") private int defaultOverlap;

    public KnowledgeService(KnowledgeDocumentRepository documentRepository, RetrievalAuditRepository auditRepository,
                            RagService ragService, DoclingService docling, ExpertRepository expertRepository,
                            DictService dictService) {
        this.documentRepository = documentRepository;
        this.auditRepository = auditRepository;
        this.ragService = ragService;
        this.docling = docling;
        this.expertRepository = expertRepository;
        this.dictService = dictService;
    }

    @Transactional(readOnly = true)
    public List<KnowledgeDocument> getDocs(String scope, String ownerId, int page, int size) {
        // 文档随上传增长：按上传时间倒序取一页，带上限兜底，避免 findAll 全量拉进内存。
        int capped = Math.max(1, Math.min(size, 1000));
        Pageable pageable = PageRequest.of(Math.max(0, page), capped, Sort.by(Sort.Direction.DESC, "uploadTime"));
        if (scope != null && ownerId != null) return documentRepository.findByScopeAndOwnerId(scope, ownerId, pageable);
        if (scope != null) return documentRepository.findByScope(scope, pageable);
        return documentRepository.findAll(pageable).getContent();
    }

    /** 查看已入库内容：某文档的分块正文（按插入顺序，带上限）。文档不存在 → 404。 */
    @Transactional(readOnly = true)
    public Map<String, Object> getDocChunks(String id, int limit) {
        KnowledgeDocument doc = documentRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "文档不存在: " + id));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", doc.getId());
        out.put("filename", doc.getFilename());
        out.put("category", doc.getCategory());
        out.put("chunksCount", doc.getChunksCount());
        Map<String, Map<Integer, String>> cache = new HashMap<>();
        List<Map<String, Object>> chunks = ragService.chunksOf(id, limit);
        for (Map<String, Object> c : chunks) {
            List<Map<String, Object>> imgs = imagesForMarkers(id, (String) c.get("text"), cache);
            if (!imgs.isEmpty()) c.put("images", imgs);
        }
        out.put("chunks", chunks);
        return out;
    }

    /** 企业文档上传：解析(docling) → 切块入 RAG → 登记文档。异常向上抛，由控制器给出错误。 */
    @Transactional
    public Map<String, Object> upload(MultipartFile file, String category, Integer chunkSize, Integer chunkOverlap) throws Exception {
        String content = extractContent(file);
        int size = chunkSize != null ? chunkSize : defaultChunkSize;
        int overlap = chunkOverlap != null ? chunkOverlap : defaultOverlap;
        String docId = "doc-" + UUID.randomUUID().toString().substring(0, 8);
        content = ragService.saveImagesAndStrip(docId, content);   // 插图抽离存库，正文留【图N】占位
        int chunksCreated = ragService.processAndAddDocument(docId, category, content, size, overlap);
        KnowledgeDocument doc = new KnowledgeDocument(docId, file.getOriginalFilename(), file.getSize(), chunksCreated, category, LocalDateTime.now());
        doc.setChunkSize(size);
        doc.setChunkOverlap(overlap);
        documentRepository.save(doc);
        return Map.of("success", true, "documentId", docId, "chunksCreated", chunksCreated, "chunkSize", size, "chunkOverlap", overlap);
    }

    /** 个人知识入库（owner 私有层）。 */
    @Transactional
    public Map<String, Object> ingestPersonal(MultipartFile file, String ownerId, Integer chunkSize, Integer chunkOverlap) throws Exception {
        if (ownerId == null || ownerId.isBlank()) throw new IllegalArgumentException("ownerId required");
        String content = extractContent(file);
        int size = chunkSize != null ? chunkSize : defaultChunkSize;
        int overlap = chunkOverlap != null ? chunkOverlap : defaultOverlap;
        String docId = "doc-" + UUID.randomUUID().toString().substring(0, 8);
        content = ragService.saveImagesAndStrip(docId, content);   // 插图抽离存库，正文留【图N】占位
        int chunksCreated = ragService.processAndAddDocument(docId, "个人知识", content, size, overlap, "PERSONAL", ownerId);
        KnowledgeDocument doc = new KnowledgeDocument(docId, file.getOriginalFilename(), file.getSize(), chunksCreated, "个人知识", LocalDateTime.now());
        doc.setChunkSize(size);
        doc.setChunkOverlap(overlap);
        doc.setScope("PERSONAL");
        doc.setOwnerId(ownerId);
        documentRepository.save(doc);
        return Map.of("success", true, "documentId", docId, "chunksCreated", chunksCreated, "scope", "PERSONAL");
    }

    @Transactional
    public Map<String, Object> proposePromotion(String id, String category) {
        KnowledgeDocument doc = documentRepository.findById(id).orElseThrow(() -> notFound());
        if (!"PERSONAL".equals(doc.getScope())) throw new IllegalArgumentException("only personal docs can be promoted");
        // 归属校验：以 token 身份为准，不信任入参 ownerId。
        if (!canManageKnowledge()) {
            String uid = currentUserId();
            if (doc.getOwnerId() == null || !doc.getOwnerId().equals(uid)) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "只能提升自己的个人知识库文档");
            }
        }
        doc.setPromotionStatus("PENDING");
        doc.setProposedCategory(category);
        documentRepository.save(doc);
        return Map.of("success", true, "documentId", id, "status", "PENDING");
    }

    @Transactional(readOnly = true)
    public List<KnowledgeDocument> pendingPromotions() {
        return documentRepository.findByPromotionStatus("PENDING");
    }

    /** 审批通过：文档 + 其分块一并翻转为 ENTERPRISE + 分类（同一事务，原子）。 */
    @Transactional
    public Map<String, Object> approvePromotion(String id, String category) {
        KnowledgeDocument doc = documentRepository.findById(id).orElseThrow(() -> notFound());
        String cat = (category != null && !category.isBlank()) ? category
                : (doc.getProposedCategory() != null ? doc.getProposedCategory() : defaultCategory());
        ragService.updateDocumentScope(id, "ENTERPRISE", cat, null);
        doc.setScope("ENTERPRISE");
        doc.setOwnerId(null);
        doc.setCategory(cat);
        doc.setPromotionStatus("APPROVED");
        documentRepository.save(doc);
        return Map.of("success", true, "documentId", id, "category", cat);
    }

    @Transactional
    public Map<String, Object> rejectPromotion(String id) {
        KnowledgeDocument doc = documentRepository.findById(id).orElseThrow(() -> notFound());
        doc.setPromotionStatus("REJECTED");
        documentRepository.save(doc);
        return Map.of("success", true, "documentId", id, "status", "REJECTED");
    }

    /** 删除：有 KNOWLEDGE_MANAGE 可删任意，否则仅删自己的 PERSONAL 文档。分块与文档一并删除。 */
    @Transactional
    public Map<String, Object> deleteDoc(String id) {
        KnowledgeDocument doc = documentRepository.findById(id).orElseThrow(() -> notFound());
        if (!canManageKnowledge()) {
            String uid = currentUserId();
            boolean ownsPersonal = "PERSONAL".equals(doc.getScope()) && doc.getOwnerId() != null && doc.getOwnerId().equals(uid);
            if (!ownsPersonal) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "只能删除自己的个人知识库文档");
        }
        ragService.deleteDocumentChunks(id);
        documentRepository.deleteById(id);
        return Map.of("success", true, "deletedId", id);
    }

    // 注意：检索会写入检索审计(queryLayeredWithAudit 内 auditRepo.save)，不能用 readOnly 事务
    // ——否则只读事务里 INSERT 直接 500(与「登录失败也要落审计」同类教训)。
    @Transactional
    public List<Map<String, Object>> query(String text, int topK, String categories, String ownerId, String clientId) {
        List<String> categoryList = (categories == null || categories.isBlank()) ? null
                : Arrays.stream(categories.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
        // 范围治理服务端权威：clientId 即客户端岗位 id，命中岗位则以其**实时**领用范围为准，
        // 覆盖客户端传来的类目（客户端缓存只在认领时下发一次，会漂移导致检索静默为空）。
        if (clientId != null && !clientId.isBlank()) {
            Expert ex = expertRepository.findById(clientId).orElse(null);
            if (ex != null && ex.getKnowledgeCategories() != null && !ex.getKnowledgeCategories().isEmpty()) {
                categoryList = ex.getKnowledgeCategories();
            }
        }
        List<RagService.Chunk> chunks = ragService.queryLayeredWithAudit(text, topK, categoryList, ownerId, clientId);
        Map<String, Map<Integer, String>> imageCache = new HashMap<>();   // docId → (seq → dataUri)
        Map<String, String> nameCache = new HashMap<>();                   // docId → filename（客户端溯源展示）
        return chunks.stream().map(chunk -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("documentId", chunk.getDocumentId());
            m.put("filename", nameCache.computeIfAbsent(chunk.getDocumentId(),
                    id -> documentRepository.findById(id).map(KnowledgeDocument::getFilename).orElse(id)));
            m.put("text", chunk.getText());
            m.put("score", Math.max(0.0, chunk.getScore()));
            m.put("scope", chunk.getScope() == null ? "ENTERPRISE" : chunk.getScope());
            List<Map<String, Object>> imgs = imagesForMarkers(chunk.getDocumentId(), chunk.getText(), imageCache);
            if (!imgs.isEmpty()) m.put("images", imgs);
            return m;
        }).collect(Collectors.toList());
    }

    private static final java.util.regex.Pattern IMG_MARKER = java.util.regex.Pattern.compile("【图(\\d+)】");

    /** 图文回填：找出文本里的【图N】占位，返回该块实际引用的插图（marker + dataUri）。 */
    private List<Map<String, Object>> imagesForMarkers(String docId, String text, Map<String, Map<Integer, String>> cache) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (text == null || !text.contains("【图")) return out;
        java.util.regex.Matcher m = IMG_MARKER.matcher(text);
        Set<Integer> seen = new LinkedHashSet<>();
        while (m.find()) seen.add(Integer.parseInt(m.group(1)));
        if (seen.isEmpty()) return out;
        Map<Integer, String> imgs = cache.computeIfAbsent(docId, ragService::imagesOf);
        for (Integer seq : seen) {
            String uri = imgs.get(seq);
            if (uri != null) {
                Map<String, Object> im = new LinkedHashMap<>();
                im.put("marker", "【图" + seq + "】");
                im.put("dataUri", uri);
                out.add(im);
            }
        }
        return out;
    }

    @Transactional(readOnly = true)
    public Map<String, Object> audit() {
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
        return result;
    }

    // ── helpers ──────────────────────────────────────────────────────────────
    private String extractContent(MultipartFile file) throws Exception {
        String name = file.getOriginalFilename();
        if (docling.needsDocling(name)) {
            // 二进制文档（PDF/Office/图片）只能走 docling：离线/失败必须干净拒绝——
            // 曾经的"回退纯文本"会把二进制当 UTF-8 硬读，乱码带 0x00 直插 pgvector 报 SQL 错。
            if (!docling.isConfigured()) {
                throw new IllegalArgumentException("该格式需文档解析引擎（docling）解析，当前引擎未配置或离线。请在管理端「知识库管理 › 解析引擎」启动后重试，或改传 txt/md 等文本格式。");
            }
            try {
                return sanitize(docling.toMarkdown(file.getBytes(), name));
            } catch (Exception e) {
                throw new IllegalArgumentException("文档解析失败（解析引擎异常）。请确认管理端「解析引擎」在线后重试。");
            }
        }
        try (BufferedReader br = new BufferedReader(new InputStreamReader(file.getInputStream(), StandardCharsets.UTF_8))) {
            return sanitize(br.lines().collect(Collectors.joining("\n")));
        }
    }

    /** PostgreSQL text/vector 列不接受 NUL(0x00)：入库前一律剥掉，防御任何来源的脏字节。 */
    private static String sanitize(String s) {
        return s == null ? "" : s.replace(String.valueOf((char) 0), "");
    }

    /** 审批默认分类取字典首项（管理端「字典管理」可调整）；字典为空兜底"未分类"。 */
    private String defaultCategory() {
        List<String> cats = dictService.labels(DictService.KNOWLEDGE_CATEGORY);
        return cats.isEmpty() ? "未分类" : cats.get(0);
    }

    private boolean canManageKnowledge() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return auth != null && auth.getAuthorities().stream()
                .anyMatch(a -> Permissions.KNOWLEDGE_MANAGE.equals(a.getAuthority()) || Permissions.ALL.equals(a.getAuthority()));
    }

    private String currentUserId() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        return (auth != null && auth.getPrincipal() instanceof JwtAuthFilter.AuthPrincipal p) ? p.userId() : null;
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "文档不存在");
    }
}
