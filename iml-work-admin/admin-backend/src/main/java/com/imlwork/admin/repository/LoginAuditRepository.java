package com.imlwork.admin.repository;

import com.imlwork.admin.model.LoginAudit;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface LoginAuditRepository extends JpaRepository<LoginAudit, Long> {
    List<LoginAudit> findTop100ByOrderByCreatedAtDesc();
    long countBySuccess(boolean success);
}
