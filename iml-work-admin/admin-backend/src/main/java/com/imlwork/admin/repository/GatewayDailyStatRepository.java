package com.imlwork.admin.repository;

import com.imlwork.admin.model.GatewayDailyStat;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface GatewayDailyStatRepository extends JpaRepository<GatewayDailyStat, String> {

    @Query("select coalesce(sum(s.requests), 0) from GatewayDailyStat s")
    long sumRequests();

    @Query("select coalesce(sum(s.promptTokens), 0) from GatewayDailyStat s")
    long sumPromptTokens();

    @Query("select coalesce(sum(s.completionTokens), 0) from GatewayDailyStat s")
    long sumCompletionTokens();

    @Query("select coalesce(sum(s.failed), 0) from GatewayDailyStat s")
    long sumFailed();
}
