import { useState, useEffect } from 'react'
import { Network, RefreshCw, X, Boxes, Zap, Link2, ScrollText, GitBranch, Share2 } from 'lucide-react'

interface OType { id: string; domain: string; typeKey: string; label: string; boundSystemId: string; propertiesJson?: string; relationsJson?: string; stateMachineJson?: string; resolveListPath?: string; description?: string }
interface OAction { id: string; domain: string; objectType: string; actionKey: string; label: string; capability: string; fromState?: string; toState?: string; connectorActionId?: string; policyJson?: string; description?: string }
interface ORef { id: string; objectType: string; systemId: string; externalId: string; displayName?: string; currentState?: string; lastSeenAt?: string }
interface OEvent { id: string; eventType: string; objectType: string; actionKey: string; fromState?: string; toState?: string; actorName?: string; riskLevel?: string; createdAt?: string; note?: string }

type TabKey = 'graph' | 'lineage' | 'types' | 'actions' | 'refs' | 'events'
const DOMAIN_COLOR: Record<string, string> = { OA: '#2563EB', CRM: '#7C3AED' }

const domainBadge = (d: string) => d === 'OA'
  ? <span className="badge badge-blue">OA</span>
  : d === 'CRM' ? <span className="badge badge-purple">CRM</span> : <span className="badge">{d}</span>
const capBadge = (c: string) => c === 'read'
  ? <span className="badge badge-green">读·read</span>
  : <span className="badge badge-yellow">写·{c}</span>
const riskBadge = (r?: string) => r === 'HIGH' ? <span className="badge badge-red">高</span>
  : r === 'MEDIUM' ? <span className="badge badge-yellow">中</span> : <span className="badge badge-green">低</span>

const parse = (s?: string) => { try { return s ? JSON.parse(s) : null } catch { return null } }
const fmt = (s?: string) => s ? s.replace('T', ' ').slice(0, 19) : '—'

export default function OntologyManager() {
  const [tab, setTab] = useState<TabKey>('graph')
  const [types, setTypes] = useState<OType[]>([])
  const [actions, setActions] = useState<OAction[]>([])
  const [refs, setRefs] = useState<ORef[]>([])
  const [events, setEvents] = useState<OEvent[]>([])
  const [connectors, setConnectors] = useState<any[]>([])
  const [skills, setSkills] = useState<any[]>([])
  const [systems, setSystems] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<OType | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [t, a, r, e, c, sk, sys] = await Promise.all([
        fetch('/api/v1/ontology/types').then(x => x.ok ? x.json() : []),
        fetch('/api/v1/ontology/actions').then(x => x.ok ? x.json() : []),
        fetch('/api/v1/ontology/object-refs').then(x => x.ok ? x.json() : []),
        fetch('/api/v1/ontology/events').then(x => x.ok ? x.json() : []),
        fetch('/api/v1/connector-actions').then(x => x.ok ? x.json() : []).catch(() => []),
        fetch('/api/v1/skills').then(x => x.ok ? x.json() : []).catch(() => []),
        fetch('/api/v1/integrations').then(x => x.ok ? x.json() : []).catch(() => []),
      ])
      setTypes(t); setActions(a); setRefs(r); setEvents(e)
      setConnectors(Array.isArray(c) ? c : [])
      setSystems(Array.isArray(sys) ? sys : [])
      // 只列「可回放执行」的技能：绑定了目标系统、有录制步骤（actionScript）
      const execSkills = (Array.isArray(sk) ? sk : []).filter((s: any) => s.targetSystemId && s.actionScript)
      setSkills(execSkills)
    } catch { /* ignore */ }
    setLoading(false)
  }
  const sysName = (id?: string) => { const s = systems.find((x: any) => x.id === id); return s ? s.name : (id || '—') }
  const execName = (id?: string) => { if (!id) return ''; const s = skills.find((x: any) => x.id === id); if (s) return s.name; const c = connectors.find((x: any) => x.id === id); return c ? (c.name || c.actionKey) : id }
  const refCount = (typeKey: string) => refs.filter(r => r.objectType === typeKey).length

  useEffect(() => { load() }, [])

  const TABS: { k: TabKey; label: string; icon: React.ReactNode; n: number }[] = [
    { k: 'graph', label: '本体图谱', icon: <Share2 size={13} />, n: types.length },
    { k: 'lineage', label: '执行链路', icon: <GitBranch size={13} />, n: actions.length },
    { k: 'types', label: '对象类型', icon: <Boxes size={13} />, n: types.length },
    { k: 'actions', label: '对象动作', icon: <Zap size={13} />, n: actions.length },
    { k: 'refs', label: '对象实例', icon: <Link2 size={13} />, n: refs.length },
    { k: 'events', label: '业务事件审计', icon: <ScrollText size={13} />, n: events.length },
  ]

  // ===== 本体图谱：对象类型为节点、关系为边（按域分列，SVG 手绘）=====
  const graphSvg = () => {
    const NW = 176, NH = 56, laneX: Record<string, number> = { OA: 320, CRM: 700 }, W = 1200
    const pos: Record<string, { x: number; y: number; t: OType }> = {}
    const byDom: Record<string, OType[]> = { OA: [], CRM: [] }
    types.forEach(t => { (byDom[t.domain] = byDom[t.domain] || []).push(t) })
    Object.keys(byDom).forEach(dom => byDom[dom].forEach((t, i) => { pos[t.domain + ':' + t.typeKey] = { x: laneX[dom] ?? 510, y: 100 + i * 130, t } }))
    const H = Math.max(byDom.OA?.length || 0, byDom.CRM?.length || 0) * 130 + 100
    const laneEdges: Record<string, any[]> = { OA: [], CRM: [] }
    types.forEach(t => (parse(t.relationsJson) || []).forEach((r: any) => {
      const from = pos[t.domain + ':' + t.typeKey], to = pos[t.domain + ':' + r.targetType]
      if (from && to) (laneEdges[t.domain] = laneEdges[t.domain] || []).push({ from, to, name: r.name, dom: t.domain })
    }))
    const actCount = (tk: string) => actions.filter(a => a.objectType === tk).length
    // OA 域的边往左弯、CRM 域往右弯；同域各边弧度依次递增错开，避免线与标签重叠
    const renderEdge = (e: any, idx: number, key: string) => {
      const left = e.dom === 'OA'
      const step = 56 + idx * 44
      const sx = left ? e.from.x - NW / 2 : e.from.x + NW / 2
      const ex = left ? e.to.x - NW / 2 : e.to.x + NW / 2
      const cx = left ? e.from.x - NW / 2 - step : e.from.x + NW / 2 + step
      const path = `M ${sx} ${e.from.y} C ${cx} ${e.from.y}, ${cx} ${e.to.y}, ${ex} ${e.to.y}`
      return (
        <g key={key}>
          <path d={path} fill="none" stroke="#cbd5e1" strokeWidth="1.3" markerEnd="url(#oa-arrow)" />
          <text x={left ? cx - 6 : cx + 6} y={(e.from.y + e.to.y) / 2} fontSize="10.5" fill="#8a97a3" textAnchor={left ? 'end' : 'start'}>{e.name}</text>
        </g>
      )
    }
    return (
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, background: '#fbfcfe', border: '1px solid var(--border-color)', borderRadius: 8 }}>
        <defs>
          <marker id="oa-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#94a3b8" /></marker>
        </defs>
        <text x={laneX.OA} y={34} textAnchor="middle" fontSize="12" fontWeight="700" fill={DOMAIN_COLOR.OA}>OA 域</text>
        <text x={laneX.CRM} y={34} textAnchor="middle" fontSize="12" fontWeight="700" fill={DOMAIN_COLOR.CRM}>CRM 域</text>
        {(laneEdges.OA || []).map((e, i) => renderEdge(e, i, 'oa' + i))}
        {(laneEdges.CRM || []).map((e, i) => renderEdge(e, i, 'crm' + i))}
        {Object.values(pos).map(({ x, y, t }) => {
          const col = DOMAIN_COLOR[t.domain] || '#475569'
          const sm = parse(t.stateMachineJson)
          const nprops = (parse(t.propertiesJson) || []).length
          return (
            <g key={t.id} style={{ cursor: 'pointer' }} onClick={() => setDetail(t)}>
              <rect x={x - NW / 2} y={y - NH / 2} width={NW} height={NH} rx={9} fill="#fff" stroke={col} strokeWidth="1.6" />
              <rect x={x - NW / 2} y={y - NH / 2} width={5} height={NH} rx={2} fill={col} />
              <text x={x - NW / 2 + 14} y={y - 5} fontSize="13" fontWeight="700" fill="#1a2530">{t.label}</text>
              <text x={x - NW / 2 + 14} y={y + 13} fontSize="10" fill="#94a3b8">{t.typeKey}</text>
              <text x={x + NW / 2 - 10} y={y - 7} fontSize="9.5" fill="#94a3b8" textAnchor="end">{nprops}属性·{actCount(t.typeKey)}动作</text>
              <text x={x + NW / 2 - 10} y={y + 13} fontSize="9.5" fill={refCount(t.typeKey) ? '#0C8154' : '#cbd5e1'} textAnchor="end">{refCount(t.typeKey)}实例{sm ? ' · 状态机' : ''}</text>
            </g>
          )
        })}
      </svg>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Network size={20} />
        <h2 style={{ margin: 0 }}>本体建模（Ontology · 治理视图）</h2>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>建模在 FDE 工作台进行；此处用于查看图谱/链路与审计对象实例、业务事件</span>
        <button className="btn-secondary" style={{ marginLeft: 'auto' }} onClick={load}><RefreshCw size={14} /><span>刷新</span></button>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 0 }}>
        对象类型 / 动作 / 状态机 / 策略在此登记（Schema）。平台只存定义 + 对象引用 + 业务事件，实例数据由客户端运行时从业务系统按需读取、不落库不上传。
      </p>

      <div className="settings-tabbar" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-color)', marginBottom: 12 }}>
        {TABS.map(t => (
          <button key={t.k} className={`filter-chip ${tab === t.k ? 'active' : ''}`} style={{ borderRadius: '8px 8px 0 0', display: 'inline-flex', alignItems: 'center', gap: 5 }} onClick={() => setTab(t.k)}>
            {t.icon}{t.label}<span className="badge" style={{ fontSize: 9 }}>{t.n}</span>
          </button>
        ))}
      </div>

      {loading && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>加载中…</div>}

      {tab === 'graph' && (
        <div>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 10px' }}>
            对象类型为节点、关系(belongsTo / targets / hasContact …)为边。点节点看属性/状态机/关系。实例数=运行时已登记的对象引用。
          </p>
          {graphSvg()}
        </div>
      )}

      {tab === 'lineage' && (
        <div>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 12px' }}>
            每个对象动作的执行血缘：<b>业务系统 → 读驱动消解(列表页) → 对象 → 动作(策略) → 执行器(连接器/技能) → 业务事件</b>。这是本体把「真实系统的数据来源」与「语义动作、审计事件」串起来的链路。
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {actions.map(a => {
              const t = types.find(x => x.domain === a.domain && x.typeKey === a.objectType)
              const policy = parse(a.policyJson) || {}
              const confirm = policy.confirmIf === 'always' ? '始终人工确认' : (policy.confirmIf ? `条件确认:${policy.confirmIf}` : '自动')
              const bound = a.connectorActionId ? execName(a.connectorActionId) : '未绑定'
              const evCount = events.filter(e => e.actionKey === a.actionKey && e.objectType === a.objectType).length
              const Node = (label: string, sub: string, color: string, strong?: boolean) => (
                <div title={label} style={{ flex: '0 0 auto', width: 140, background: '#fff', border: `1.4px solid ${color}`, borderRadius: 8, padding: '7px 10px' }}>
                  <div style={{ fontSize: 12.5, fontWeight: strong ? 700 : 600, color: '#1a2530', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
                </div>
              )
              const Arrow = (lbl?: string) => (
                <div style={{ flex: '0 0 auto', width: 46, display: 'flex', flexDirection: 'column', alignItems: 'center', color: '#94a3b8' }}>
                  <span style={{ fontSize: 9.5, height: 13 }}>{lbl || ''}</span><span style={{ fontSize: 15, lineHeight: 1 }}>→</span>
                </div>
              )
              return (
                <div key={a.id} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '10px 12px', background: '#fbfcfe' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    {domainBadge(a.domain)}<b style={{ fontSize: 13 }}>{a.objectType}.{a.actionKey}</b>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{a.label}</span>{capBadge(a.capability)}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                    {Node(sysName(t?.boundSystemId), '业务系统', '#94a3b8')}
                    {Arrow('读消解')}
                    {Node(t?.resolveListPath || '（无列表页）', '候选来源', t?.resolveListPath ? '#2563EB' : '#e2e8f0')}
                    {Arrow()}
                    {Node(t?.label || a.objectType, `对象·${refCount(a.objectType)}实例`, DOMAIN_COLOR[a.domain] || '#475569', true)}
                    {Arrow(confirm === '自动' ? '' : '策略')}
                    {Node(a.label, `${a.fromState || '*'}→${a.toState || '-'} · ${confirm}`, confirm === '始终人工确认' ? '#DC2626' : (confirm === '自动' ? '#0C8154' : '#B45309'))}
                    {Arrow('执行')}
                    {Node(bound, a.connectorActionId ? '连接器/技能' : '语义登记', a.connectorActionId ? '#0C8154' : '#cbd5e1')}
                    {Arrow('回写')}
                    {Node(policy.eventType || 'StateChanged', `事件·${evCount}条`, '#7C3AED')}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'types' && (
        <table className="admin-table">
          <thead><tr><th>域</th><th>类型</th><th>标签</th><th>来源系统</th><th>属性</th><th>状态机</th><th>关系</th></tr></thead>
          <tbody>
            {types.map(t => {
              const props = parse(t.propertiesJson) || []
              const sm = parse(t.stateMachineJson)
              const rels = parse(t.relationsJson) || []
              return (
                <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => setDetail(t)}>
                  <td>{domainBadge(t.domain)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{t.typeKey}</td>
                  <td>{t.label}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sysName(t.boundSystemId)}</td>
                  <td style={{ fontSize: 12 }}>{props.length} 项</td>
                  <td style={{ fontSize: 11 }}>{sm ? (sm.states || []).join(' → ') : <span style={{ color: 'var(--text-muted)' }}>无</span>}</td>
                  <td style={{ fontSize: 11 }}>{rels.length ? rels.map((r: any) => `${r.name}:${r.targetType}`).join('、') : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {tab === 'actions' && (
        <table className="admin-table">
          <thead><tr><th>域</th><th>对象</th><th>动作</th><th>能力</th><th>状态迁移</th><th>策略</th><th>绑定执行器</th></tr></thead>
          <tbody>
            {actions.map(a => {
              const p = parse(a.policyJson) || {}
              return (
                <tr key={a.id}>
                  <td>{domainBadge(a.domain)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{a.objectType}</td>
                  <td><b>{a.label}</b> <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{a.actionKey}</span></td>
                  <td>{capBadge(a.capability)}</td>
                  <td style={{ fontSize: 11 }}>{a.fromState || '*'} → {a.toState || '（不变）'}</td>
                  <td style={{ fontSize: 11 }}>
                    {p.confirmIf === 'always'
                      ? <span className="badge badge-red">始终人工确认</span>
                      : p.confirmIf
                        ? <span className="badge badge-yellow">条件确认：{p.confirmIf}</span>
                        : <span className="badge badge-green">自动</span>}
                  </td>
                  <td style={{ fontSize: 11 }}>
                    {a.connectorActionId
                      ? <span className="badge badge-green">{execName(a.connectorActionId)}</span>
                      : <span style={{ color: 'var(--text-muted)' }}>未绑定（语义登记）</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {tab === 'refs' && (
        <table className="admin-table">
          <thead><tr><th>类型</th><th>系统</th><th>外部主键</th><th>显示名</th><th>当前状态</th><th>最近</th></tr></thead>
          <tbody>
            {refs.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--text-muted)', fontSize: 12 }}>暂无对象引用（客户端执行本体动作后自动登记，仅存身份不存业务数据）。</td></tr>}
            {refs.map(r => (
              <tr key={r.id}>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.objectType}</td>
                <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.systemId}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.externalId}</td>
                <td>{r.displayName || '—'}</td>
                <td><span className="badge badge-blue">{r.currentState || '—'}</span></td>
                <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmt(r.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === 'events' && (
        <table className="admin-table">
          <thead><tr><th>时间</th><th>事件</th><th>对象</th><th>动作</th><th>状态迁移</th><th>操作人</th><th>风险</th></tr></thead>
          <tbody>
            {events.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--text-muted)', fontSize: 12 }}>暂无业务事件。客户端执行审批/推进等动作后在此形成可追溯审计链。</td></tr>}
            {events.map(e => (
              <tr key={e.id}>
                <td style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmt(e.createdAt)}</td>
                <td><span className="badge badge-purple">{e.eventType}</span></td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{e.objectType}</td>
                <td style={{ fontSize: 12 }}>{e.actionKey}</td>
                <td style={{ fontSize: 11 }}>{e.fromState || '*'} → {e.toState || '—'}</td>
                <td style={{ fontSize: 12 }}>{e.actorName || '—'}</td>
                <td>{riskBadge(e.riskLevel)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 对象类型详情抽屉 */}
      {detail && (
        <div className="skill-drawer-overlay" onClick={() => setDetail(null)}>
          <div className="skill-drawer" style={{ width: 560 }} onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {domainBadge(detail.domain)}
                <b style={{ fontSize: 15 }}>{detail.label}</b>
                <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>{detail.typeKey}</span>
              </div>
              <button className="icon-btn" onClick={() => setDetail(null)}><X size={16} /></button>
            </div>
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
              {detail.description && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{detail.description}</div>}
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>来源系统：{detail.boundSystemId}</div>

              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>属性</div>
                <table className="admin-table" style={{ fontSize: 12 }}>
                  <thead><tr><th>字段</th><th>标签</th><th>类型</th></tr></thead>
                  <tbody>{(parse(detail.propertiesJson) || []).map((p: any) => (
                    <tr key={p.key}><td style={{ fontFamily: 'monospace' }}>{p.key}</td><td>{p.label}</td><td>{p.type}</td></tr>
                  ))}</tbody>
                </table>
              </div>

              {parse(detail.stateMachineJson) && (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>状态机</div>
                  {(() => { const sm = parse(detail.stateMachineJson); return (
                    <div style={{ fontSize: 12 }}>
                      <div style={{ marginBottom: 6 }}>状态：{(sm.states || []).map((s: string) => <span key={s} className={`badge ${s === sm.initial ? 'badge-blue' : ''}`} style={{ marginRight: 4 }}>{s}</span>)}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {(sm.transitions || []).map((t: any, i: number) => (
                          <div key={i} style={{ color: 'var(--text-secondary)' }}>{t.from} → {t.to} <span className="badge badge-green" style={{ marginLeft: 4 }}>{t.action}</span></div>
                        ))}
                      </div>
                    </div>
                  ) })()}
                </div>
              )}

              {(parse(detail.relationsJson) || []).length > 0 && (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>关系</div>
                  {(parse(detail.relationsJson) || []).map((r: any, i: number) => (
                    <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{detail.typeKey} ─{r.name}→ {r.targetType} <span style={{ color: 'var(--text-muted)' }}>({r.cardinality})</span></div>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>如需修改此对象类型，请到 FDE 工作台「本体建模」编辑。</div>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
