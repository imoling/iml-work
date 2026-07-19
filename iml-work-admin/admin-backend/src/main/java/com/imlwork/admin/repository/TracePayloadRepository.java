package com.imlwork.admin.repository;

import com.imlwork.admin.model.TracePayload;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface TracePayloadRepository extends JpaRepository<TracePayload, String> {
    Optional<TracePayload> findFirstByTraceIdAndSpanId(String traceId, String spanId);
}
