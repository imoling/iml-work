package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * One RAG retrieval event. Powers the knowledge-base hit-rate / consumption
 * audit required by the KnowledgeManager admin console.
 */
@Entity
@Table(name = "retrieval_audit")
public class RetrievalAudit {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(length = 1000)
    private String queryText;

    /** Whether the top result cleared the configured similarity threshold. */
    private boolean hit;

    private double topScore;
    private long latencyMs;
    private String clientId;

    private LocalDateTime createdAt = LocalDateTime.now();

    public RetrievalAudit() {}

    public RetrievalAudit(String queryText, boolean hit, double topScore, long latencyMs, String clientId) {
        this.queryText = queryText;
        this.hit = hit;
        this.topScore = topScore;
        this.latencyMs = latencyMs;
        this.clientId = clientId;
    }

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public String getQueryText() { return queryText; }
    public void setQueryText(String queryText) { this.queryText = queryText; }

    public boolean isHit() { return hit; }
    public void setHit(boolean hit) { this.hit = hit; }

    public double getTopScore() { return topScore; }
    public void setTopScore(double topScore) { this.topScore = topScore; }

    public long getLatencyMs() { return latencyMs; }
    public void setLatencyMs(long latencyMs) { this.latencyMs = latencyMs; }

    public String getClientId() { return clientId; }
    public void setClientId(String clientId) { this.clientId = clientId; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
