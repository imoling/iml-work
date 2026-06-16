package com.imlwork.admin.repository;

import com.imlwork.admin.model.DesensitizeAudit;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

public interface DesensitizeAuditRepository extends JpaRepository<DesensitizeAudit, Long> {
    List<DesensitizeAudit> findTop100ByOrderByCreatedAtDesc();
    List<DesensitizeAudit> findByTraceIdOrderByCreatedAtDesc(String traceId);
}
