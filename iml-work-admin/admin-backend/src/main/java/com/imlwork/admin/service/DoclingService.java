package com.imlwork.admin.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.imlwork.admin.model.DoclingSettings;
import com.imlwork.admin.repository.DoclingSettingsRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestTemplate;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Server-side document parsing via a docling-serve instance (IBM Docling).
 * Converts PDF / DOCX / PPTX / XLSX / HTML / images into clean Markdown with
 * tables, reading order and OCR preserved. Runs server-side so client terminals
 * stay light. Only user-supplied documents are sent here — never credentials or
 * login state.
 *
 * <p>Configuration ({@link DoclingSettings}) is runtime-editable from the admin
 * console (no restart), seeded from {@code docling.*} in application.yml. This
 * service also exposes health probing and parse metrics for monitoring.
 */
@Service
public class DoclingService {

    private static final Logger log = LoggerFactory.getLogger(DoclingService.class);
    private static final String ID = "default";
    private static final long PROBE_CACHE_MS = 15_000; // avoid hammering the health endpoint

    private final RestTemplateBuilder builder;
    private final DoclingSettingsRepository repo;
    private final ObjectMapper mapper = new ObjectMapper();

    // Seed defaults from application.yml (first-run only).
    @Value("${docling.endpoint:}") private String seedEndpoint;
    @Value("${docling.convert-path:/v1/convert/file}") private String seedConvertPath;
    @Value("${docling.do-ocr:false}") private boolean seedDoOcr;
    @Value("${docling.timeout-ms:120000}") private int seedTimeoutMs;

    // In-memory parse metrics (reset on restart).
    private final AtomicLong totalParses = new AtomicLong();
    private final AtomicLong successParses = new AtomicLong();
    private final AtomicLong failedParses = new AtomicLong();
    private final AtomicLong sumLatencyMs = new AtomicLong();

    // Cached health probe.
    private volatile boolean lastOnline = false;
    private volatile long lastProbeLatencyMs = -1;
    private volatile String lastProbeError = null;
    private volatile long lastProbeAt = 0;

    public DoclingService(RestTemplateBuilder builder, DoclingSettingsRepository repo) {
        this.builder = builder;
        this.repo = repo;
    }

    /** Current settings, seeded from application.yml on first access; self-heals nulls. */
    public DoclingSettings settings() {
        DoclingSettings s = repo.findById(ID).orElseGet(() -> {
            DoclingSettings n = new DoclingSettings();
            n.setId(ID);
            n.setEndpoint(seedEndpoint);
            n.setDoOcr(seedDoOcr);
            n.setTimeoutMs(seedTimeoutMs > 0 ? seedTimeoutMs : 120000);
            return n;
        });
        // Backfill any null/zero fields (e.g. row predates a newer column).
        boolean dirty = false;
        if (s.getConvertPath() == null || s.getConvertPath().isBlank()) {
            s.setConvertPath(seedConvertPath == null || seedConvertPath.isBlank() ? "/v1/convert/file" : seedConvertPath); dirty = true;
        }
        if (s.getTimeoutMs() <= 0) { s.setTimeoutMs(seedTimeoutMs > 0 ? seedTimeoutMs : 120000); dirty = true; }
        if (s.getImage() == null || s.getImage().isBlank()) { s.setImage("ghcr.io/docling-project/docling-serve"); dirty = true; }
        if (s.getHostPort() <= 0) { s.setHostPort(5001); dirty = true; }
        if (s.getContainerName() == null || s.getContainerName().isBlank()) { s.setContainerName("iml-docling-serve"); dirty = true; }
        if (s.getDockerHost() == null) { s.setDockerHost(""); dirty = true; }
        return dirty ? repo.save(s) : s;
    }

    public DoclingSettings updateSettings(DoclingSettings update) {
        DoclingSettings s = settings();
        if (update.getEndpoint() != null) s.setEndpoint(update.getEndpoint().trim());
        if (update.getConvertPath() != null && !update.getConvertPath().isBlank()) s.setConvertPath(update.getConvertPath().trim());
        s.setDoOcr(update.isDoOcr());
        if (update.getTimeoutMs() > 0) s.setTimeoutMs(update.getTimeoutMs());
        s.setUpdatedAt(LocalDateTime.now());
        DoclingSettings saved = repo.save(s);
        lastProbeAt = 0; // force a fresh probe after config change
        return saved;
    }

    /** Whether a docling endpoint is configured (does not verify reachability). */
    public boolean isConfigured() {
        String ep = settings().getEndpoint();
        return ep != null && !ep.isBlank();
    }

    /**
     * Formats that benefit from docling. Plain-text formats are read directly by
     * callers and need not be routed through docling.
     */
    public boolean needsDocling(String filename) {
        if (filename == null) return false;
        String f = filename.toLowerCase(Locale.ROOT);
        return f.endsWith(".pdf") || f.endsWith(".docx") || f.endsWith(".doc")
                || f.endsWith(".pptx") || f.endsWith(".ppt") || f.endsWith(".xlsx")
                || f.endsWith(".xls") || f.endsWith(".png") || f.endsWith(".jpg")
                || f.endsWith(".jpeg") || f.endsWith(".tiff") || f.endsWith(".tif")
                || f.endsWith(".bmp") || f.endsWith(".html") || f.endsWith(".htm");
    }

    private RestTemplate rest(int timeoutMs) {
        return builder
                .setConnectTimeout(Duration.ofSeconds(10))
                .setReadTimeout(Duration.ofMillis(timeoutMs > 0 ? timeoutMs : 120000))
                .build();
    }

    /**
     * Convert a document to Markdown via docling-serve. Throws on any failure so
     * callers can fall back to basic parsing. Updates parse metrics.
     */
    public String toMarkdown(byte[] bytes, String filename) {
        DoclingSettings s = settings();
        if (s.getEndpoint() == null || s.getEndpoint().isBlank()) {
            throw new IllegalStateException("docling endpoint 未配置");
        }
        String url = s.getEndpoint().replaceAll("/+$", "") + s.getConvertPath();
        long start = System.nanoTime();
        totalParses.incrementAndGet();
        try {
            ByteArrayResource fileRes = new ByteArrayResource(bytes) {
                @Override public String getFilename() { return filename; }
            };
            MultiValueMap<String, Object> form = new LinkedMultiValueMap<>();
            form.add("files", fileRes);
            form.add("to_formats", "md");
            form.add("do_ocr", String.valueOf(s.isDoOcr()));
            // 图文知识库：插图以 base64 data-URI 内嵌进 markdown（默认 placeholder 会把插图丢弃）。
            // scale=2.0（docling 默认）保证大图查看清晰度——1.0 会得到低清缩略图，点开大图也糊。
            // 体积由 RagService 的单图/单文档上限兜底。
            form.add("image_export_mode", "embedded");
            form.add("images_scale", "2.0");

            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.MULTIPART_FORM_DATA);
            HttpEntity<MultiValueMap<String, Object>> req = new HttpEntity<>(form, headers);

            ResponseEntity<String> resp = rest(s.getTimeoutMs()).postForEntity(url, req, String.class);
            String md = extractMarkdown(resp.getBody());
            if (md == null || md.isBlank()) {
                throw new IllegalStateException("docling 未返回 Markdown 内容");
            }
            successParses.incrementAndGet();
            sumLatencyMs.addAndGet((System.nanoTime() - start) / 1_000_000);
            lastOnline = true; // a successful parse proves it's up
            return md;
        } catch (RuntimeException e) {
            failedParses.incrementAndGet();
            throw e;
        }
    }

    /** Live health probe (cached ~15s). Any HTTP response from the host counts as online. */
    public synchronized void checkHealth(boolean force) {
        DoclingSettings s = settings();
        String ep = s.getEndpoint();
        if (ep == null || ep.isBlank()) {
            lastOnline = false; lastProbeLatencyMs = -1; lastProbeError = "未配置地址"; lastProbeAt = now();
            return;
        }
        if (!force && (now() - lastProbeAt) < PROBE_CACHE_MS) return;
        String base = ep.replaceAll("/+$", "");
        long start = System.nanoTime();
        try {
            RestTemplate rt = builder.setConnectTimeout(Duration.ofSeconds(5)).setReadTimeout(Duration.ofSeconds(5)).build();
            try {
                rt.getForEntity(base + "/health", String.class);
            } catch (org.springframework.web.client.HttpStatusCodeException hs) {
                // 4xx/5xx still means the server is up and answering.
            }
            lastOnline = true;
            lastProbeError = null;
        } catch (Exception e) {
            lastOnline = false;
            lastProbeError = e.getMessage();
        } finally {
            lastProbeLatencyMs = (System.nanoTime() - start) / 1_000_000;
            lastProbeAt = now();
        }
    }

    public boolean isOnline() { return lastOnline; }
    public long getLastProbeLatencyMs() { return lastProbeLatencyMs; }
    public String getLastProbeError() { return lastProbeError; }
    public long getLastProbeAt() { return lastProbeAt; }

    public long getTotalParses() { return totalParses.get(); }
    public long getSuccessParses() { return successParses.get(); }
    public long getFailedParses() { return failedParses.get(); }
    public long getAvgLatencyMs() {
        long ok = successParses.get();
        return ok == 0 ? 0 : sumLatencyMs.get() / ok;
    }

    private static long now() { return System.currentTimeMillis(); }

    /**
     * docling-serve response shapes vary by version; locate the first
     * {@code md_content} string anywhere in the JSON tree.
     */
    private String extractMarkdown(String body) {
        if (body == null) return null;
        try {
            JsonNode found = findMdContent(mapper.readTree(body));
            return found != null ? found.asText() : null;
        } catch (Exception e) {
            log.warn("[Docling] failed to parse response: {}", e.getMessage());
            return null;
        }
    }

    private JsonNode findMdContent(JsonNode node) {
        if (node == null) return null;
        if (node.isObject()) {
            JsonNode direct = node.get("md_content");
            if (direct != null && direct.isTextual()) return direct;
            var it = node.fields();
            while (it.hasNext()) {
                JsonNode r = findMdContent(it.next().getValue());
                if (r != null) return r;
            }
        } else if (node.isArray()) {
            for (JsonNode c : node) {
                JsonNode r = findMdContent(c);
                if (r != null) return r;
            }
        }
        return null;
    }
}
