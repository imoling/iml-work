package com.imlwork.admin.repository;

import com.imlwork.admin.model.RetrievalAudit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;

public interface RetrievalAuditRepository extends JpaRepository<RetrievalAudit, Long> {

    List<RetrievalAudit> findTop20ByOrderByCreatedAtDesc();

    long countByHit(boolean hit);

    @Query("select coalesce(avg(r.latencyMs), 0) from RetrievalAudit r")
    double averageLatency();
}
