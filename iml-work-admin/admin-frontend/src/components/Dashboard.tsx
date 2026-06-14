import { useState, useEffect } from 'react'
import { Activity, Cpu, Database, Plug, RefreshCw, TrendingUp, Target } from 'lucide-react'

interface Overview {
  activeAgents: number
  skillCount: number
  knowledgeDocCount: number
  connectedIntegrations: number
  totalRequests: number
  totalTokens: number
  successRate: number
  ragHitRate: number
  ragRetrievals: number
  ragAvgLatencyMs: number
}

interface Point {
  label: string
  requests: number
  tokens: number
  successRate: number
}

const EMPTY: Overview = {
  activeAgents: 0, skillCount: 0, knowledgeDocCount: 0, connectedIntegrations: 0,
  totalRequests: 0, totalTokens: 0, successRate: 0, ragHitRate: 0, ragRetrievals: 0, ragAvgLatencyMs: 0
}

export default function Dashboard() {
  const [overview, setOverview] = useState<Overview>(EMPTY)
  const [points, setPoints] = useState<Point[]>([])
  const [loading, setLoading] = useState(true)

  const fetchAll = async () => {
    setLoading(true)
    try {
      const [ovRes, tsRes] = await Promise.all([
        fetch('/api/v1/dashboard/overview'),
        fetch('/api/v1/dashboard/timeseries')
      ])
      if (ovRes.ok) setOverview(await ovRes.json())
      if (tsRes.ok) setPoints((await tsRes.json()).points || [])
    } catch (err) {
      console.error(err)
    }
    setLoading(false)
  }

  useEffect(() => { fetchAll() }, [])

  const card = (icon: React.ReactNode, label: string, value: string, sub: string, color: string) => (
    <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
      <div style={{ color }}>{icon}</div>
      <div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{label}</div>
        <div style={{ fontSize: '22px', fontWeight: 'bold' }}>{value}</div>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{sub}</div>
      </div>
    </div>
  )

  const maxReq = Math.max(1, ...points.map(p => p.requests))
  const maxTok = Math.max(1, ...points.map(p => p.tokens))

  // Build an SVG polyline for the success-rate trend.
  const W = 560, H = 160, PAD = 30
  const linePts = points.map((p, i) => {
    const x = PAD + (i * (W - 2 * PAD)) / Math.max(1, points.length - 1)
    const y = H - PAD - p.successRate * (H - 2 * PAD)
    return `${x},${y}`
  }).join(' ')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
          实时聚合全企业 Agent 活跃度、统一网关调用频次、任务成功率与 RAG 检索命中率。
        </div>
        <button className="btn-secondary" onClick={fetchAll}>
          <RefreshCw size={14} />
          <span>刷新指标</span>
        </button>
      </div>

      {/* Metric cards */}
      <div className="dashboard-grid">
        {card(<Activity size={34} />, '活跃岗位 Agent', String(overview.activeAgents), `${overview.skillCount} 个已发布技能`, 'var(--brand-primary)')}
        {card(<TrendingUp size={34} />, '网关总调用次数', String(overview.totalRequests), `累计 ${overview.totalTokens} tokens`, 'var(--accent-yellow)')}
        {card(<Target size={34} />, '任务成功率', `${(overview.successRate * 100).toFixed(1)}%`, '统一中转网关 SLA', 'var(--accent-green)')}
        {card(<Database size={34} />, 'RAG 检索命中率', `${(overview.ragHitRate * 100).toFixed(1)}%`, `${overview.ragRetrievals} 次检索 · 均${overview.ragAvgLatencyMs}ms`, 'var(--brand-secondary)')}
        {card(<Cpu size={34} />, '知识库文档', String(overview.knowledgeDocCount), 'PGVector 已索引', 'var(--brand-primary)')}
        {card(<Plug size={34} />, '已连接业务系统', String(overview.connectedIntegrations), 'OA / CRM / GitHub', 'var(--accent-green)')}
      </div>

      {loading && <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '10px' }}>正在拉取监控数据...</div>}

      {/* Charts */}
      <div className="dashboard-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        {/* Bar chart: requests + tokens per day */}
        <div className="glass-panel">
          <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '14px' }}>每日网关调用 / Token 消耗 (柱状图)</h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '14px', height: '170px', paddingTop: '10px' }}>
            {points.map((p, i) => (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', height: '100%', justifyContent: 'flex-end' }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '130px' }}>
                  <div title={`${p.requests} 次`} style={{ width: '12px', height: `${(p.requests / maxReq) * 130}px`, background: 'var(--brand-primary)', borderRadius: '3px 3px 0 0' }} />
                  <div title={`${p.tokens} tk`} style={{ width: '12px', height: `${(p.tokens / maxTok) * 130}px`, background: 'var(--brand-secondary)', borderRadius: '3px 3px 0 0' }} />
                </div>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{p.label}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '16px', marginTop: '10px', fontSize: '10px', color: 'var(--text-secondary)' }}>
            <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--brand-primary)', marginRight: 4 }} />调用次数</span>
            <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--brand-secondary)', marginRight: 4 }} />Token 消耗</span>
          </div>
        </div>

        {/* Line chart: success rate trend */}
        <div className="glass-panel">
          <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '14px' }}>任务成功率趋势 (折线图)</h3>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: '170px' }}>
            <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--border-color)" />
            <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="var(--border-color)" />
            <polyline points={linePts} fill="none" stroke="var(--accent-green)" strokeWidth={2} />
            {points.map((p, i) => {
              const x = PAD + (i * (W - 2 * PAD)) / Math.max(1, points.length - 1)
              const y = H - PAD - p.successRate * (H - 2 * PAD)
              return (
                <g key={i}>
                  <circle cx={x} cy={y} r={3} fill="var(--accent-green)" />
                  <text x={x} y={H - PAD + 14} fontSize={9} fill="var(--text-muted)" textAnchor="middle">{p.label}</text>
                </g>
              )
            })}
          </svg>
        </div>
      </div>
    </div>
  )
}
