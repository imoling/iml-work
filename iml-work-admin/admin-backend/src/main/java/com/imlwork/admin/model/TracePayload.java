package com.imlwork.admin.model;

import jakarta.persistence.*;

import java.time.LocalDateTime;

/**
 * 执行轨迹节点的完整输入/输出（调用树点开查看 + 管线执行效果定位）。
 * 与热表 agent_trace **分离存储**：spans 里只留摘要，完整 prompt/检索素材可达几十 KB，
 * 进热表会把审计列表链路撑爆（性能规则）。列表接口绝不查本表，只按 traceId+spanId 单查。
 */
@Entity
@Table(name = "agent_trace_payload")
public class TracePayload {

    @Id
    private String id;

    private String traceId;

    private String spanId;

    /** 节点人话名（模型作答/联网检索/补查·XX），与时间线 span 名一致。 */
    private String name;

    @Column(columnDefinition = "text")
    private String input;

    @Column(columnDefinition = "text")
    private String output;

    private LocalDateTime createdAt = LocalDateTime.now();

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getTraceId() { return traceId; }
    public void setTraceId(String traceId) { this.traceId = traceId; }

    public String getSpanId() { return spanId; }
    public void setSpanId(String spanId) { this.spanId = spanId; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getInput() { return input; }
    public void setInput(String input) { this.input = input; }

    public String getOutput() { return output; }
    public void setOutput(String output) { this.output = output; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
