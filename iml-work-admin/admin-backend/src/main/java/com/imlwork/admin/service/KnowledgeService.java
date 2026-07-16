package com.imlwork.admin.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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

    private static final Logger log = LoggerFactory.getLogger(KnowledgeService.class);

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
        // ⚠️ 质量闸必须在**剥图之后**：剥图前正文里还嵌着图片 base64（几十万字符），
        // 任何"内容够不够长"的判断都会被它撑过去。剥完才看得见真实正文有多少。
        assertHasSubstance(content, file.getOriginalFilename());
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
        assertHasSubstance(content, file.getOriginalFilename());   // 剥图后才看得见真实正文（见企业库路径的注释）
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

    /** 向量服务健康（管理端「知识中心」流程条据此显示真实状态）。 */
    public Map<String, Object> embeddingHealth() {
        return ragService.embeddingHealth();
    }

    /** 重建全部向量（换 embedding 模型后必跑）。仅 KNOWLEDGE_MANAGE 可触发——这是重活。 */
    public Map<String, Object> reindexAll() {
        if (!canManageKnowledge()) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "无权重建知识库向量");
        return ragService.reindexAll(200);
    }

    /**
     * 改文档分类（错分类是必然会发生的——此前只能删了重传，重传要重新切片+向量化，代价大且会丢审计）。
     *
     * ⚠️ 分类**冗余在 chunk 上**（检索按 chunk.category 过滤）。只改文档表的话，文档看着归对了，
     * **检索却还按旧分类走** —— 一个悄无声息的坑。必须两处一起改，同一事务。
     */
    @Transactional
    public Map<String, Object> recategorize(String id, String category) {
        if (category == null || category.isBlank()) throw new IllegalArgumentException("分类不能为空");
        if (!canManageKnowledge()) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "无权修改企业知识库文档分类");
        KnowledgeDocument doc = documentRepository.findById(id).orElseThrow(() -> notFound());
        String old = doc.getCategory();
        doc.setCategory(category);
        documentRepository.save(doc);
        int n = ragService.recategorizeChunks(id, category);   // 检索按 chunk.category 过滤，必须同步
        return Map.of("success", true, "id", id, "from", old == null ? "" : old, "to", category, "chunks", n);
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
                throw new IllegalArgumentException("该格式需文档解析引擎解析，当前引擎未配置或离线。请在管理端「安全沙箱 › 文档引擎」启动后重试，或改传 txt/md 等文本格式。");
            }
            try {
                return sanitize(docling.toMarkdown(file.getBytes(), name, "知识入库"));
            } catch (Exception e) {
                // 把真实原因带出去。原来一律翻译成"引擎异常，请确认引擎在线"——
                // 而引擎明明 {"status":"ok"}，运维照着提示去查引擎，白折腾。
                // 解析失败的原因可能是文件损坏、格式不支持、文档过大、引擎内部错误…… 各有各的处置办法。
                log.warn("[Knowledge] 《{}》解析失败：{}", name, e.getMessage(), e);
                throw new IllegalArgumentException("《" + name + "》解析失败：" + e.getMessage()
                        + "（若引擎离线，请到管理端「安全沙箱 › 文档引擎」启动后重试）");
            }
        }
        try (BufferedReader br = new BufferedReader(new InputStreamReader(file.getInputStream(), StandardCharsets.UTF_8))) {
            return sanitize(br.lines().collect(Collectors.joining("\n")));
        }
    }

    /**
     * 入库质量闸：解析成功 ≠ 解析出了东西。
     *
     * 真事：一份 1.5MB 的 PDF，docling 只解析出图片、正文一个字都没出来。
     * saveImagesAndStrip 把图抽走后，剩下的正文是 `【图1】【图2】…【图20】` —— 纯占位符。
     * 代码照样入库，于是知识库里躺着一条"1 块、1.5MB"的垃圾文档（还被重复上传了三次）。
     * 它检索不到任何东西，却占着位置、误导运维以为"文档已入库"。
     *
     * 判据：剥掉【图N】占位与空白后，实质正文少于 30 字 → 判定解析失败，拒绝入库并给出可操作的原因。
     */
    private static void assertHasSubstance(String content, String filename) {
        String body = content == null ? "" : content.replaceAll("【图\\d+】", "").replaceAll("\\s+", "");
        if (body.length() >= 30) return;
        boolean imageOnly = content != null && content.contains("【图");
        throw new IllegalArgumentException(imageOnly
                ? "《" + filename + "》解析后**只有图片、没有正文**（可能是扫描件/图片型 PDF）。"
                        + "这类文档入库后检索不到任何内容。请改传可选中文字的版本，或先做 OCR。"
                : "《" + filename + "》解析后正文为空，无法入库。请确认文件未损坏、且不是纯图片/扫描件。");
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
