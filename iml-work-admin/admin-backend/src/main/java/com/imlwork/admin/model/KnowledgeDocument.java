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

    // ── Layered knowledge base ──────────────────────────────────────────────
    /** PERSONAL (owner-scoped private) or ENTERPRISE (company-wide, categorized). */
    private String scope = "ENTERPRISE";
    /** Owner user id for PERSONAL docs; null for ENTERPRISE. */
    private String ownerId;
    /** Promotion workflow: NONE | PENDING | APPROVED | REJECTED (personal→enterprise). */
    private String promotionStatus = "NONE";
    /** Category proposed when a personal doc is nominated for the enterprise base. */
    private String proposedCategory;

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

    public String getScope() { return scope; }
    public void setScope(String scope) { this.scope = scope; }

    public String getOwnerId() { return ownerId; }
    public void setOwnerId(String ownerId) { this.ownerId = ownerId; }

    public String getPromotionStatus() { return promotionStatus; }
    public void setPromotionStatus(String promotionStatus) { this.promotionStatus = promotionStatus; }

    public String getProposedCategory() { return proposedCategory; }
    public void setProposedCategory(String proposedCategory) { this.proposedCategory = proposedCategory; }
}
