package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

@Entity
@Table(name = "sync_file")
public class SyncFile {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String name;
    private String path;

    @Column(length = 1000)
    private String summary;

    private boolean synced;
    private long sizeBytes;
    private String employeeName;

    /** PASS | RISK | PENDING — DLP/compliance verdict for the synced file. */
    private String auditStatus = "PASS";

    private LocalDateTime createdAt = LocalDateTime.now();

    public SyncFile() {}

    public SyncFile(String name, String path, String summary, boolean synced, long sizeBytes, String employeeName) {
        this.name = name;
        this.path = path;
        this.summary = summary;
        this.synced = synced;
        this.sizeBytes = sizeBytes;
        this.employeeName = employeeName;
    }

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getPath() { return path; }
    public void setPath(String path) { this.path = path; }

    public String getSummary() { return summary; }
    public void setSummary(String summary) { this.summary = summary; }

    public boolean isSynced() { return synced; }
    public void setSynced(boolean synced) { this.synced = synced; }

    public long getSizeBytes() { return sizeBytes; }
    public void setSizeBytes(long sizeBytes) { this.sizeBytes = sizeBytes; }

    public String getEmployeeName() { return employeeName; }
    public void setEmployeeName(String employeeName) { this.employeeName = employeeName; }

    public String getAuditStatus() { return auditStatus; }
    public void setAuditStatus(String auditStatus) { this.auditStatus = auditStatus; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
