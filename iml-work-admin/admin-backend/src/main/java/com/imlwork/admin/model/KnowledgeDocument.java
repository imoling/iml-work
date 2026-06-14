package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

@Entity
@Table(name = "knowledge_document")
public class KnowledgeDocument {

    @Id
    private String id;

    private String filename;
    private long sizeBytes;
    private int chunksCount;
    private String category;
    private LocalDateTime uploadTime;

    /** Chunking configuration actually used when this document was ingested. */
    private int chunkSize = 280;
    private int chunkOverlap = 40;

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

    public int getChunkSize() { return chunkSize; }
    public void setChunkSize(int chunkSize) { this.chunkSize = chunkSize; }

    public int getChunkOverlap() { return chunkOverlap; }
    public void setChunkOverlap(int chunkOverlap) { this.chunkOverlap = chunkOverlap; }
}
