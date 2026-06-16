package com.imlwork.admin.repository;

import com.imlwork.admin.model.AgentTrace;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

public interface AgentTraceRepository extends JpaRepository<AgentTrace, String> {
    List<AgentTrace> findTop200ByOrderByCreatedAtDesc();
}
