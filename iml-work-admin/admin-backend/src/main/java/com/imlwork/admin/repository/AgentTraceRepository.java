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

    /**
     * 同上，但走窄投影构造器：不出库 reasoningSummary/finalAnswer/spans/sources/events
     * 五个大 TEXT 列（单条 trace 的 spans/events 可达几十 KB，聚合窗口一大就是 MB 级内存）。
     */
    @org.springframework.data.jpa.repository.Query("select new com.imlwork.admin.model.AgentTrace("
            + "t.id, t.createdAt, t.userId, t.userNickname, t.expertId, t.expertName, t.userQuestion, "
            + "t.modelName, t.modelProvider, t.promptTokens, t.completionTokens, t.durationMs, "
            + "t.skillUsed, t.status, t.failureReason, t.approvalTriggered) "
            + "from AgentTrace t where t.createdAt > :after")
    List<AgentTrace> findSlimByCreatedAtAfter(@org.springframework.data.repository.query.Param("after") LocalDateTime after);
}
