package com.imlwork.admin.model;

import java.time.LocalDateTime;

public class KnowledgeDocument {
    private String id;
    private String filename;
    private long sizeBytes;
    private int chunksCount;
    private String category;
    private LocalDateTime uploadTime;

    public KnowledgeDocument() {}

    public KnowledgeDocument(String id, String filename, long sizeBytes, int chunksCount, String category, LocalDateTime uploadTime) {
        this.id = id;
        this.filename = filename;
        this.sizeBytes = sizeBytes;
        this.chunksCount = chunksCount;
        this.category = category;
        this.uploadTime = uploadTime;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getFilename() { return filename; }
    public void setFilename(String filename) { this.filename = filename; }

    public long getSizeBytes() { return sizeBytes; }
    public void setSizeBytes(long sizeBytes) { this.sizeBytes = sizeBytes; }

    public int getChunksCount() { return chunksCount; }
    public void setChunksCount(int chunksCount) { this.chunksCount = chunksCount; }

    public String getCategory() { return category; }
    public void setCategory(String category) { this.category = category; }

    public LocalDateTime getUploadTime() { return uploadTime; }
    public void setUploadTime(LocalDateTime uploadTime) { this.uploadTime = uploadTime; }
}
