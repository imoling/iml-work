import { useState, useEffect } from 'react'
import {
  RefreshCw, Activity, CheckCircle2, Users, Target, Workflow,
  Boxes, Database, Plug, Award, ShieldCheck, ChevronRight
} from 'lucide-react'

// ===== 运行总览：业务任务维度的真实聚合（来自 AgentTrace）+ 资产/网关实时态 =====
// 全部指标对应后端 /api/v1/dashboard/operations 的明确统计口径；无数据来源的区块显示“暂无数据/数据采集中”，不臆造。

interface Pct { value: number; num: number; den: number }
interface Core {
  taskTotal: number; effectiveDone: number; activeUsers: number
  e2eSuccess: Pct; autoComplete: Pct; pendingExceptions: number
}
interface TrendPoint { date: string; total: number; success: number; failed: number; successRate: number }
interface HotExpert { expertId: string; name: string; users: number; tasks: number; successRate: Pct; avgMs: number }
interface HotSkill { skill: string; name: string; id: string; calls: number; successRate: Pct; approvalRate: Pct; lastUsed: string }
interface ExceptionItem { type: string; severity: string; desc: string; time: string; target: string; traceId?: string; link?: string }
interface AssetStat { ok: number; total: number; abnormal: number; link: string }
interface Provider { id: string; name: string; provider: string; requests: number; failed: number; avgLatencyMs: number; status: string; share: number }
interface Ops {
  period: { days: number; from: string; to: string }
  hasTaskData: boolean
  core: Core; prevCore: Core
  trend: TrendPoint[]
  hotExperts: HotExpert[]; hotSkills: HotSkill[]
  failureBreakdown: { failed: number; blocked: number; detailAvailable: boolean }
  exceptions: ExceptionItem[]
  assets: { experts: AssetStat; skills: AssetStat; knowledge: AssetStat; integrations: AssetStat; channels: AssetStat }
  resource: { gatewayRequests: number; gatewayTokens: number; taskTokens: number; perTaskTokens: number; providers: Provider[]; p95Available: boolean }
}

const fmtPct = (p?: Pct) => p && p.den > 0 ? `${(p.value * 100).toFixed(1)}%（${p.num}/${p.den}）` : '暂无数据'
const fmtTime = (s: string) => s ? s.replace('T', ' ').slice(5, 16) : '—'

function Delta({ cur, prev, suffix = '' }: { cur: number; prev: number; suffix?: string }) {
  if (prev === 0 && cur === 0) return <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>较上期 —</span>
  const diff = cur - prev
  const up = diff > 0, flat = diff === 0
  const color = flat ? 'var(--text-muted)' : up ? 'var(--accent-green)' : 'var(--accent-red)'
  return <span style={{ fontSize: 10, color }}>较上期 {flat ? '—' : (up ? '▲' : '▼') + Math.abs(diff) + suffix}</span>
}

export default function Dashboard({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [days, setDays] = useState(7)
  const [ops, setOps] = useState<Ops | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState('')
  const [hotTab, setHotTab] = useState<'experts' | 'skills'>('experts')
  // 企业安全沙箱实时态（后端 /sandbox/exec/status：Docker 可达 + 镜像就绪 + 并发容量）
  const [sbx, setSbx] = useState<{ reachable?: boolean; imageReady?: boolean; mode?: string; image?: string; maxConcurrent?: number; runningSlots?: number } | null>(null)

  const fetchAll = async (d = days) => {
    setLoading(true); setError('')
    try {
      const res = await fetch(`/api/v1/dashboard/operations?days=${d}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setOps(await res.json())
      setUpdatedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    } catch (e: any) { setError(e.message || '加载失败') }
    setLoading(false)
    try { const r = await fetch('/api/v1/sandbox/exec/status'); if (r.ok) setSbx(await r.json()) } catch { /* 非关键，忽略 */ }
  }

  useEffect(() => { fetchAll(days); const t = setInterval(() => fetchAll(days), 30000); return () => clearInterval(t) }, [days])

  const setRange = (d: number) => setDays(d)
  const customRange = () => {
    const v = prompt('自定义时间范围（天数，1-180）：', String(days))
    const n = Number(v)
    if (n >= 1 && n <= 180) setDays(Math.floor(n))
  }

  const c = ops?.core, pc = ops?.prevCore
  const noTask = ops && !ops.hasTaskData

  // 指标卡
  const metric = (icon: React.ReactNode, label: string, value: string, delta: React.ReactNode, hint: string, color: string, onClick?: () => void) => (
    <div className="glass-panel" style={{ padding: '14px 16px', cursor: onClick ? 'pointer' : 'default' }} onClick={onClick} title={hint}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color }}>{icon}<span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label}</span></div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 6 }}>{value}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
        {delta}
        {onClick && <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>{hint}</div>
    </div>
  )

  const sectionTitle = (text: string, extra?: React.ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600 }}>{text}</h3>{extra}
    </div>
  )

  const maxTotal = Math.max(1, ...(ops?.trend || []).map(p => p.total))
  const W = 560, H = 150, PAD = 28
  const trendLine = (ops?.trend || []).map((p, i, arr) => {
    const x = PAD + (i * (W - 2 * PAD)) / Math.max(1, arr.length - 1)
    const y = H - PAD - p.successRate * (H - 2 * PAD)
    return `${x},${y}`
  }).join(' ')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1600 }}>
      {/* 标题与全局筛选 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          汇总企业智能体使用情况、任务执行质量、运行异常与资源消耗。
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {[[7, '近7天'], [30, '近30天']].map(([d, l]) => (
            <button key={d} className={days === d ? 'btn-primary' : 'btn-secondary'} style={{ height: 32 }} onClick={() => setRange(d as number)}>{l}</button>
          ))}
          <button className={days !== 7 && days !== 30 ? 'btn-primary' : 'btn-secondary'} style={{ height: 32 }} onClick={customRange}>自定义{days !== 7 && days !== 30 ? `·${days}天` : ''}</button>
          <span title="接口暂未支持部门维度" style={{ fontSize: 11, color: 'var(--text-muted)', padding: '0 4px' }}>部门 / 岗位筛选：暂未支持</span>
          <button className="btn-secondary" style={{ height: 32 }} onClick={() => fetchAll(days)}><RefreshCw size={14} /><span>刷新</span></button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>最后更新 {updatedAt || '—'}</span>
        </div>
      </div>

      {error && <div className="glass-panel" style={{ color: 'var(--accent-red)' }}>运行数据加载失败：{error}　<button className="btn-secondary" onClick={() => fetchAll(days)}>重试</button></div>}
      {noTask && <div className="glass-panel" style={{ color: 'var(--text-secondary)' }}>当前周期内暂无业务任务记录（任务在客户端执行后由审计追溯沉淀）。下列资产状态仍为实时态。</div>}

      {/* 能力资产状态（库存类指标，置顶概览，不与运行指标并列） */}
      <div className="glass-panel">
        {sectionTitle('企业数智资产总览', <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>健康 / 总数 · 点击进入对应管理</span>)}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px,1fr))', gap: 12 }}>
          {ops && ([
            [<Award size={18} />, '岗位专家', ops.assets.experts, '活跃 / 总数', 'experts'],
            [<Workflow size={18} />, '技能中心', ops.assets.skills, '已发布 / 总数', 'skills'],
            [<Database size={18} />, '知识中心', ops.assets.knowledge, '文档总数', 'knowledge'],
            [<Plug size={18} />, '业务系统', ops.assets.integrations, '探测可达 / 总数', 'integrations'],
            [<Boxes size={18} />, '模型网关', ops.assets.channels, '健康 / 总通道', 'gateway'],
          ] as const).map(([icon, label, a, sub, link], i) => (
            <div key={i} style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: '12px 14px', cursor: 'pointer' }} onClick={() => onNavigate?.(link as string)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: (a as AssetStat).abnormal > 0 ? 'var(--accent-yellow)' : 'var(--brand-primary)' }}>{icon}<span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</span></div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 6 }}>{(a as AssetStat).ok}<span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 400 }}> / {(a as AssetStat).total}</span></div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{sub}{(a as AssetStat).abnormal > 0 ? ` · 异常 ${(a as AssetStat).abnormal}` : ''}</div>
            </div>
          ))}
          {(() => {
            const abnormal = sbx != null && (sbx.mode === 'disabled' || !sbx.reachable || !sbx.imageReady)
            const busy = sbx?.runningSlots ?? 0
            const cap = sbx?.maxConcurrent ?? 0
            const sub = sbx == null ? '并发执行容量'
              : sbx.mode === 'disabled' ? '已停用'
              : !sbx.reachable ? '沙箱不可达'
              : !sbx.imageReady ? '镜像拉取中 · ' + (sbx.image || '')
              : '执行中 / 并发容量 · ' + (sbx.image || 'Docker')
            return (
              <div style={{ border: '1px solid var(--border-color)', borderRadius: 10, padding: '12px 14px', cursor: 'pointer' }} onClick={() => onNavigate?.('sandbox')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: abnormal ? 'var(--accent-yellow)' : 'var(--brand-primary)' }}><ShieldCheck size={18} /><span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>安全沙箱</span></div>
                <div style={{ fontSize: 20, fontWeight: 700, marginTop: 6 }}>{sbx == null ? '—' : busy}<span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 400 }}> / {sbx == null ? '—' : cap}</span></div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{sub}</div>
              </div>
            )
          })()}
        </div>
      </div>

      {/* 核心运行指标：大屏6列/中屏3列/小屏2列 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {metric(<Activity size={18} />, '任务总量', String(c?.taskTotal ?? '—'),
          <Delta cur={c?.taskTotal || 0} prev={pc?.taskTotal || 0} />, '当前周期内发起的业务任务数', 'var(--brand-primary)', () => onNavigate?.('trace'))}
        {metric(<CheckCircle2 size={18} />, '有效完成任务', String(c?.effectiveDone ?? '—'),
          <Delta cur={c?.effectiveDone || 0} prev={pc?.effectiveDone || 0} />, '已获得有效业务结果（状态=成功）的任务数', 'var(--accent-green)', () => onNavigate?.('trace'))}
        {metric(<Users size={18} />, '活跃用户', c && c.activeUsers > 0 ? String(c.activeUsers) : '暂无数据',
          <Delta cur={c?.activeUsers || 0} prev={pc?.activeUsers || 0} />, '周期内至少执行过一次任务的去重用户数', 'var(--brand-secondary)')}
        {metric(<Target size={18} />, '端到端成功率', c && c.e2eSuccess.den > 0 ? `${(c.e2eSuccess.value * 100).toFixed(1)}%` : '暂无数据',
          c ? <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{c.e2eSuccess.num}/{c.e2eSuccess.den}</span> : null, '有效完成任务数 ÷ 任务总量', 'var(--accent-green)')}
        {metric(<Workflow size={18} />, '自动完成率', c && c.autoComplete.den > 0 ? `${(c.autoComplete.value * 100).toFixed(1)}%` : '暂无数据',
          c ? <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{c.autoComplete.num}/{c.autoComplete.den}</span> : null, '无需人工接管完成数 ÷ 有效完成任务数', 'var(--brand-primary)')}
      </div>

      {/* 任务运行趋势 ｜ 模型与资源消耗（横向对齐） */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, alignItems: 'stretch' }}>
        <div className="glass-panel">
          {sectionTitle('任务运行趋势', <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>柱=每日任务量 · 线=成功率</span>)}
          {loading && !ops ? <div style={{ color: 'var(--text-muted)', padding: 20 }}>加载中…</div> : (ops?.trend || []).every(p => p.total === 0)
            ? <div style={{ color: 'var(--text-muted)', padding: 20 }}>该时间范围内暂无任务数据</div>
            : (<>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 150, position: 'relative' }}>
                {(ops?.trend || []).map((p, i) => (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}
                    title={`${p.date}　任务 ${p.total}　成功 ${p.success}　失败 ${p.failed}　成功率 ${(p.successRate * 100).toFixed(1)}%`}>
                    <div style={{ width: 18, height: `${(p.total / maxTotal) * 110}px`, background: 'var(--brand-primary)', borderRadius: '3px 3px 0 0', cursor: 'pointer' }}
                      onClick={() => onNavigate?.('trace')} />
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 4 }}>{p.date}</span>
                  </div>
                ))}
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: 'calc(100% - 14px)', pointerEvents: 'none' }}>
                  <polyline points={trendLine} fill="none" stroke="var(--accent-green)" strokeWidth={2} />
                </svg>
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 10, color: 'var(--text-secondary)' }}>
                <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--brand-primary)', marginRight: 4 }} />每日任务量</span>
                <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--accent-green)', marginRight: 4 }} />成功率</span>
                <span style={{ color: 'var(--text-muted)' }}>点击柱状进入对应审计记录</span>
              </div>
            </>)}
        </div>

        <div className="glass-panel">
          {sectionTitle('模型与资源消耗', <button className="btn-secondary" style={{ height: 26 }} onClick={() => onNavigate?.('gateway')}>模型网关</button>)}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 12 }}>
            <div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>模型调用总量</div><div style={{ fontSize: 18, fontWeight: 700 }}>{ops?.resource.gatewayRequests ?? '—'}</div></div>
            <div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>周期任务 Token</div><div style={{ fontSize: 18, fontWeight: 700 }}>{ops?.resource.taskTokens ?? '—'}</div></div>
            <div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>单任务平均 Token</div><div style={{ fontSize: 18, fontWeight: 700 }}>{c && c.taskTotal > 0 ? ops?.resource.perTaskTokens : '暂无数据'}</div></div>
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>各通道调用占比 / 成功率　<span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>P95 延迟：暂无数据（当前仅有加权均值）</span></div>
          {!ops?.resource.providers.length ? <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>暂无已登记的模型通道。</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ops.resource.providers.map(p => {
                const okRate = p.requests > 0 ? Math.round((1 - p.failed / p.requests) * 100) : 0
                return (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 150, flexShrink: 0 }}><div style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</div><div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.provider} · 均{p.avgLatencyMs}ms</div></div>
                    <div style={{ flex: 1, height: 14, background: 'var(--bg-subtle)', borderRadius: 4, overflow: 'hidden' }}><div style={{ width: `${Math.round(p.share * 100)}%`, height: '100%', background: p.status === 'DOWN' ? 'var(--accent-red)' : 'var(--brand-primary)' }} /></div>
                    <div style={{ width: 120, textAlign: 'right', flexShrink: 0, fontSize: 11 }}><b>{p.requests}</b> 次 · {Math.round(p.share * 100)}% · 成功{p.requests > 0 ? `${okRate}%（${p.requests - p.failed}/${p.requests}）` : '—'}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* 失败原因分析 ｜ 热门岗位/技能 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 18 }}>
        <div className="glass-panel">
          {sectionTitle('失败原因分析')}
          {!c || (ops!.failureBreakdown.failed + ops!.failureBreakdown.blocked === 0)
            ? <div style={{ color: 'var(--accent-green)', fontSize: 13, padding: 12 }}>周期内无失败/拦截任务。</div>
            : (<div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[['任务执行失败', ops!.failureBreakdown.failed, 'var(--accent-red)'], ['安全拦截 / 高危授权未通过', ops!.failureBreakdown.blocked, 'var(--accent-yellow)']].map(([label, n, color]) => {
                const tot = ops!.failureBreakdown.failed + ops!.failureBreakdown.blocked
                return (
                  <div key={label as string} style={{ cursor: 'pointer' }} onClick={() => onNavigate?.('trace')}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}><span>{label}</span><span>{n as number}（{tot ? Math.round((n as number) / tot * 100) : 0}%）</span></div>
                    <div style={{ height: 10, background: 'var(--bg-subtle)', borderRadius: 4, overflow: 'hidden' }}><div style={{ width: `${tot ? (n as number) / tot * 100 : 0}%`, height: '100%', background: color as string }} /></div>
                  </div>
                )
              })}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>细分原因（模型/路由/知识/连接/权限/沙箱）数据采集中：审计记录暂无结构化失败原因字段。点击可进入审计追溯逐条排查。</div>
            </div>)}
        </div>

        <div className="glass-panel">
          {sectionTitle('热门岗位 / 技能', (
            <div style={{ display: 'flex', gap: 6 }}>
              {(['experts', 'skills'] as const).map(t => (
                <button key={t} className={hotTab === t ? 'btn-primary' : 'btn-secondary'} style={{ height: 28 }} onClick={() => setHotTab(t)}>{t === 'experts' ? '热门岗位' : '热门技能'}</button>
              ))}
            </div>
          ))}
          {hotTab === 'experts' ? (
            !ops?.hotExperts.length ? <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 12 }}>暂无数据</div> : (
              <table style={{ width: '100%', fontSize: 12 }}>
                <thead><tr style={{ color: 'var(--text-muted)', fontSize: 11 }}><th style={{ textAlign: 'left' }}>岗位</th><th>活跃用户</th><th>任务数</th><th>成功率</th><th>平均耗时</th></tr></thead>
                <tbody>{ops.hotExperts.map(e => (
                  <tr key={e.expertId} style={{ cursor: 'pointer' }} onClick={() => onNavigate?.('experts')}>
                    <td style={{ fontWeight: 600 }}>{e.name}<span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}> · {e.expertId}</span></td>
                    <td style={{ textAlign: 'center' }}>{e.users}</td>
                    <td style={{ textAlign: 'center' }}>{e.tasks}</td>
                    <td style={{ textAlign: 'center' }} title={fmtPct(e.successRate)}>{(e.successRate.value * 100).toFixed(0)}%</td>
                    <td style={{ textAlign: 'center' }}>{(e.avgMs / 1000).toFixed(1)}s</td>
                  </tr>
                ))}</tbody>
              </table>
            )
          ) : (
            !ops?.hotSkills.length ? <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 12 }}>暂无数据</div> : (
              <table style={{ width: '100%', fontSize: 12 }}>
                <thead><tr style={{ color: 'var(--text-muted)', fontSize: 11 }}><th style={{ textAlign: 'left' }}>技能</th><th>调用</th><th>成功率</th><th>人工确认率</th><th>最近使用</th></tr></thead>
                <tbody>{ops.hotSkills.map(s => (
                  <tr key={s.skill} style={{ cursor: 'pointer' }} onClick={() => onNavigate?.('skills')}>
                    <td style={{ fontWeight: 600 }}>{s.name}{s.id ? <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}> · {s.id}</span> : ''}</td>
                    <td style={{ textAlign: 'center' }}>{s.calls}</td>
                    <td style={{ textAlign: 'center' }} title={fmtPct(s.successRate)}>{(s.successRate.value * 100).toFixed(0)}%</td>
                    <td style={{ textAlign: 'center' }} title={fmtPct(s.approvalRate)}>{(s.approvalRate.value * 100).toFixed(0)}%</td>
                    <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{fmtTime(s.lastUsed)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )
          )}
        </div>
      </div>
    </div>
  )
}
