package com.imlwork.admin.repository;

import com.imlwork.admin.model.AgentTrace;
import org.springframework.data.jpa.repository.JpaRepository;
import java.time.LocalDateTime;
import java.util.List;

public interface AgentTraceRepository extends JpaRepository<AgentTrace, String> {
    List<AgentTrace> findTop200ByOrderByCreatedAtDesc();
    AgentTrace findFirstByUserQuestionOrderByCreatedAtDesc(String userQuestion);

    // 运营时序聚合只需窗口内数据（时间下界），避免随 trace 累积 findAll() 全量拉进内存。
    List<AgentTrace> findByCreatedAtAfter(LocalDateTime from);
}
