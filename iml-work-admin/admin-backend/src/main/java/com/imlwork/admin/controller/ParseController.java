package com.imlwork.admin.controller;

import com.imlwork.admin.model.DoclingSettings;
import com.imlwork.admin.service.DockerMonitorService;
import com.imlwork.admin.service.DoclingService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Server-side document parsing engine (docling) — parsing + monitoring +
 * management. Client terminals upload the raw file and receive clean Markdown,
 * so heavy PDF/OCR parsing never runs on the end-user machine. The admin console
 * uses the status/config/check endpoints to monitor and manage the engine.
 * Only user-supplied documents pass through — never credentials or login state.
 */
@RestController
@RequestMapping("/api/v1/parse")
public class ParseController {

    private final DoclingService docling;
    private final DockerMonitorService docker;

    public ParseController(DoclingService docling, DockerMonitorService docker) {
        this.docling = docling;
        this.docker = docker;
    }

    /** Rich status for the admin monitor: config + live health + parse metrics. */
    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> status() {
        docling.checkHealth(false);
        return ResponseEntity.ok(buildStatus());
    }

    /** Force a fresh health probe (admin "检测" button). */
    @PostMapping("/check")
    public ResponseEntity<Map<String, Object>> check() {
        docling.checkHealth(true);
        return ResponseEntity.ok(buildStatus());
    }

    /** Current runtime config (for the admin config form). */
    @GetMapping("/config")
    public ResponseEntity<DoclingSettings> config() {
        return ResponseEntity.ok(docling.settings());
    }

    /** Update runtime config (endpoint / convertPath / doOcr / timeout). No restart. */
    @PutMapping("/config")
    public ResponseEntity<DoclingSettings> updateConfig(@RequestBody DoclingSettings update) {
        DoclingSettings saved = docling.updateSettings(update);
        docling.checkHealth(true);
        return ResponseEntity.ok(saved);
    }

    private Map<String, Object> buildStatus() {
        DoclingSettings s = docling.settings();
        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("total", docling.getTotalParses());
        metrics.put("success", docling.getSuccessParses());
        metrics.put("failed", docling.getFailedParses());
        metrics.put("avgLatencyMs", docling.getAvgLatencyMs());

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("configured", docling.isConfigured());
        m.put("online", docling.isOnline());
        m.put("endpoint", s.getEndpoint());
        m.put("convertPath", s.getConvertPath());
        m.put("doOcr", s.isDoOcr());
        m.put("timeoutMs", s.getTimeoutMs());
        m.put("probeLatencyMs", docling.getLastProbeLatencyMs());
        m.put("probeError", docling.getLastProbeError());
        m.put("lastCheckAt", docling.getLastProbeAt());
        m.put("metrics", metrics);
        // 容器化管理信息（镜像/端口/容器状态/生命周期阶段）
        m.put("image", s.getImage());
        m.put("hostPort", s.getHostPort());
        m.put("containerName", s.getContainerName());
        m.put("container", docker.doclingContainerStatus(s.getDockerHost(), s.getContainerName()));
        return m;
    }

    // ── 容器化生命周期（经沙箱同款 Docker Remote API）─────────────────────────

    /** 启动 docling 容器（按需拉镜像/创建）。异步执行，轮询 /parse/status 观察阶段。 */
    @PostMapping("/container/start")
    public ResponseEntity<Map<String, Object>> startContainer() {
        DoclingSettings s = docling.settings();
        Map<String, Object> r = docker.startDocling(s.getDockerHost(), s.getImage(), s.getContainerName(), s.getHostPort());
        // 首次启动且未配置解析地址时，自动指向本机映射端口
        if (s.getEndpoint() == null || s.getEndpoint().isBlank()) {
            s.setEndpoint("http://localhost:" + s.getHostPort());
            docling.updateSettings(s);
        }
        return ResponseEntity.ok(r);
    }

    /** 停止 docling 容器（保留容器，便于快速再启动）。 */
    @PostMapping("/container/stop")
    public ResponseEntity<Map<String, Object>> stopContainer() {
        DoclingSettings s = docling.settings();
        return ResponseEntity.ok(docker.stopDocling(s.getDockerHost(), s.getContainerName(), 15));
    }

    /** 重启：先停后启（异步启动）。 */
    @PostMapping("/container/restart")
    public ResponseEntity<Map<String, Object>> restartContainer() {
        DoclingSettings s = docling.settings();
        docker.stopDocling(s.getDockerHost(), s.getContainerName(), 15);
        Map<String, Object> r = docker.startDocling(s.getDockerHost(), s.getImage(), s.getContainerName(), s.getHostPort());
        return ResponseEntity.ok(r);
    }

    /**
     * Parse one document to Markdown. Always responds 200; {@code ok:false} lets
     * the client fall back to its local basic parsing without HTTP error handling.
     */
    @PostMapping("/document")
    public ResponseEntity<Map<String, Object>> parse(@RequestParam("file") MultipartFile file) {
        String name = file.getOriginalFilename() == null ? "upload" : file.getOriginalFilename();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("filename", name);
        try {
            if (!docling.isConfigured()) {
                m.put("ok", false);
                m.put("reason", "docling-not-configured");
                return ResponseEntity.ok(m);
            }
            String md = docling.toMarkdown(file.getBytes(), name);
            m.put("ok", true);
            m.put("markdown", md);
            return ResponseEntity.ok(m);
        } catch (Exception e) {
            m.put("ok", false);
            m.put("reason", "parse-failed");
            m.put("error", String.valueOf(e.getMessage()));
            return ResponseEntity.ok(m);
        }
    }
}
