package com.imlwork.admin.controller;

import com.imlwork.admin.model.DoclingSettings;
import com.imlwork.admin.service.DoclingOpsService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.Map;

/**
 * Server-side document parsing engine (docling) — parsing + monitoring +
 * management. Client terminals upload the raw file and receive clean Markdown,
 * so heavy PDF/OCR parsing never runs on the end-user machine. The admin console
 * uses the status/config/check endpoints to monitor and manage the engine.
 * Only user-supplied documents pass through — never credentials or login state.
 * 编排与状态组装见 {@link DoclingOpsService}。
 */
@RestController
@RequestMapping("/api/v1/parse")
public class ParseController {

    private final DoclingOpsService doclingOps;

    public ParseController(DoclingOpsService doclingOps) {
        this.doclingOps = doclingOps;
    }

    /** Rich status for the admin monitor: config + live health + parse metrics. */
    @GetMapping("/status")
    public ResponseEntity<Map<String, Object>> status() {
        return ResponseEntity.ok(doclingOps.status(false));
    }

    /** Force a fresh health probe (admin "检测" button). */
    @PostMapping("/check")
    public ResponseEntity<Map<String, Object>> check() {
        return ResponseEntity.ok(doclingOps.status(true));
    }

    /** 解析历史（最近 50 条审计，与虾池执行历史同构）：文档引擎页历史区。 */
    @GetMapping("/history")
    public ResponseEntity<java.util.List<com.imlwork.admin.model.ParseAudit>> history() {
        return ResponseEntity.ok(doclingOps.history());
    }

    /** Current runtime config (for the admin config form). */
    @GetMapping("/config")
    public ResponseEntity<DoclingSettings> config() {
        return ResponseEntity.ok(doclingOps.settings());
    }

    /** Update runtime config (endpoint / convertPath / doOcr / timeout). No restart. */
    @PutMapping("/config")
    public ResponseEntity<DoclingSettings> updateConfig(@RequestBody DoclingSettings update) {
        return ResponseEntity.ok(doclingOps.updateSettings(update));
    }

    // ── 容器化生命周期（经沙箱同款 Docker Remote API）─────────────────────────

    /** 启动 docling 容器（按需拉镜像/创建）。异步执行，轮询 /parse/status 观察阶段。 */
    @PostMapping("/container/start")
    public ResponseEntity<Map<String, Object>> startContainer() {
        return ResponseEntity.ok(doclingOps.startContainer());
    }

    /** 停止 docling 容器（保留容器，便于快速再启动）。 */
    @PostMapping("/container/stop")
    public ResponseEntity<Map<String, Object>> stopContainer() {
        return ResponseEntity.ok(doclingOps.stopContainer());
    }

    /** 重启：先停后启（异步启动）。 */
    @PostMapping("/container/restart")
    public ResponseEntity<Map<String, Object>> restartContainer() {
        return ResponseEntity.ok(doclingOps.restartContainer());
    }

    /**
     * Parse one document to Markdown. Always responds 200; {@code ok:false} lets
     * the client fall back to its local basic parsing without HTTP error handling.
     */
    @PostMapping("/document")
    public ResponseEntity<Map<String, Object>> parse(@RequestParam("file") MultipartFile file) {
        return ResponseEntity.ok(doclingOps.parseDocument(file));
    }
}
