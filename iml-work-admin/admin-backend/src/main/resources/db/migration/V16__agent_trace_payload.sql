-- 执行轨迹节点完整输入/输出（调用树点开查看）：与热表 agent_trace 分离——
-- 列表/时间线只读摘要，payload 按 traceId+spanId 单查（性能规则：大 TEXT 不进列表链路）。
CREATE TABLE IF NOT EXISTS agent_trace_payload (
    id varchar(64) PRIMARY KEY,
    trace_id varchar(255) NOT NULL,
    span_id varchar(64) NOT NULL,
    name varchar(255),
    input text,
    output text,
    created_at timestamp(6) without time zone DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trace_payload_trace ON agent_trace_payload (trace_id, span_id);
CREATE INDEX IF NOT EXISTS idx_trace_payload_created ON agent_trace_payload (created_at DESC);
