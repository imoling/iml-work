package com.imlwork.admin.model;

import jakarta.persistence.*;
import java.time.LocalDateTime;

/** 文档解析审计（每次 docling 解析留痕）：建表见 Flyway V6；「安全沙箱 › 文档引擎」历史页消费。 */
@Entity
@Table(name = "parse_audit")
public class ParseAudit {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(length = 512)
    private String filename;

    @Column(name = "size_bytes")
    private long sizeBytes;

    @Column(nullable = false)
    private boolean success;

    @Column(columnDefinition = "TEXT")
    private String error;

    @Column(name = "latency_ms")
    private long latencyMs;

    @Column(length = 32)
    private String source = "";

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt = LocalDateTime.now();

    public Long getId() { return id; }
    public String getFilename() { return filename; }
    public void setFilename(String filename) { this.filename = filename; }
    public long getSizeBytes() { return sizeBytes; }
    public void setSizeBytes(long sizeBytes) { this.sizeBytes = sizeBytes; }
    public boolean isSuccess() { return success; }
    public void setSuccess(boolean success) { this.success = success; }
    public String getError() { return error; }
    public void setError(String error) { this.error = error; }
    public long getLatencyMs() { return latencyMs; }
    public void setLatencyMs(long latencyMs) { this.latencyMs = latencyMs; }
    public String getSource() { return source; }
    public void setSource(String source) { this.source = source; }
    public LocalDateTime getCreatedAt() { return createdAt; }
}
