package com.imlwork.admin.repository;

import com.imlwork.admin.model.ParseAudit;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ParseAuditRepository extends JpaRepository<ParseAudit, Long> {
    List<ParseAudit> findTop50ByOrderByIdDesc();
}
