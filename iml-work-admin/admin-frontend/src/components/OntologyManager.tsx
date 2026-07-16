import { useState, useEffect, useRef } from 'react'
import cytoscape from 'cytoscape'
import { Network, RefreshCw, X, Boxes, Zap, Link2, ScrollText, GitBranch, Share2 } from 'lucide-react'

interface OType { id: string; domain: string; typeKey: string; label: string; boundSystemId: string; propertiesJson?: string; relationsJson?: string; stateMachineJson?: string; resolveListPath?: string; description?: string }
interface OAction { id: string; domain: string; objectType: string; actionKey: string; label: string; capability: string; fromState?: string; toState?: string; connectorActionId?: string; policyJson?: string; description?: string; allowedExperts?: string[] }
interface ORef { id: string; objectType: string; systemId: string; externalId: string; displayName?: string; currentState?: string; lastSeenAt?: string }
interface OEvent { id: string; eventType: string; objectType: string; actionKey: string; fromState?: string; toState?: string; actorName?: string; riskLevel?: string; createdAt?: string; note?: string }

type TabKey = 'graph' | 'lineage' | 'types' | 'actions' | 'refs' | 'events'
const DOMAIN_COLOR: Record<string, string> = { OA: '#2563EB', CRM: '#7C3AED', ERM: '#B45309' }
const domainColor = (d: string) => DOMAIN_COLOR[d] || '#475569'

const domainBadge = (d: string) => d === 'OA'
  ? <span className="badge badge-blue">OA</span>
  : d === 'CRM' ? <span className="badge badge-purple">CRM</span>
  : d === 'ERM' ? <span className="badge badge-yellow">ERM</span> : <span className="badge">{d}</span>
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
  const [experts, setExperts] = useState<any[]>([])   // 解析「允许岗位」的 id → 岗位名
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<OType | null>(null)
  // 中文名查找（数据驱动，来自建模时配置的 sm.labels / type.label；没配才回落英文键，代码不写死领域词）
  const stLbl = (d: OType | null, st?: string): string => {
    if (!d || !st) return ''
    const sm = parse(d.stateMachineJson)
    return (sm && sm.labels && typeof sm.labels[st] === 'string') ? sm.labels[st] : ''
  }
  const typeLbl = (key: string): string => types.find(t => t.typeKey === key)?.label || key

  const load = async () => {
    setLoading(true)
    try {
      const [t, a, r, e, c, sk, sys, ex] = await Promise.all([
        fetch('/api/v1/ontology/types').then(x => x.ok ? x.json() : []),
        fetch('/api/v1/ontology/actions').then(x => x.ok ? x.json() : []),
        fetch('/api/v1/ontology/object-refs').then(x => x.ok ? x.json() : []),
        fetch('/api/v1/ontology/events').then(x => x.ok ? x.json() : []),
        fetch('/api/v1/connector-actions').then(x => x.ok ? x.json() : []).catch(() => []),
        fetch('/api/v1/skills').then(x => x.ok ? x.json() : []).catch(() => []),
        fetch('/api/v1/integrations').then(x => x.ok ? x.json() : []).catch(() => []),
        fetch('/api/v1/experts').then(x => x.ok ? x.json() : []).catch(() => []),
      ])
      setTypes(t); setActions(a); setRefs(r); setEvents(e)
      setConnectors(Array.isArray(c) ? c : [])
      setSystems(Array.isArray(sys) ? sys : [])
      setExperts(Array.isArray(ex) ? ex : (ex?.content || []))
      // 只列「可回放执行」的技能：绑定了目标系统、有录制步骤（actionScript）
      const execSkills = (Array.isArray(sk) ? sk : []).filter((s: any) => s.targetSystemId && s.actionScript)
      setSkills(execSkills)
    } catch { /* ignore */ }
    setLoading(false)
  }
  const sysName = (id?: string) => { const s = systems.find((x: any) => x.id === id); return s ? s.name : (id || '—') }
  const expertName = (id: string) => experts.find(e => e.id === id)?.title || id
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
            知识图谱视图：对象类型为节点（按域分组着色）、关系为有向边。滚轮缩放 · 拖拽平移/移动节点 · 点节点看属性/状态机/关系。
          </p>
          <OntologyGraphView types={types} actions={actions} refs={refs} onSelect={setDetail} />
        </div>
      )}

      {tab === 'lineage' && (
        <div>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 12px' }}>
            每个对象动作的执行血缘：<b>授权岗位 → 业务系统 → 读驱动消解(列表页) → 对象 → 动作(策略) → 执行器(连接器/技能) → 业务事件</b>。这是本体把「谁有权做」「数据从哪来」「怎么执行」「留了什么痕」串成的一条链。
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
                    {/* 授权岗位放在链路最前：一个动作首先要回答"谁有权做"。
                        写操作未限定岗位 = 任何业务域命中的岗位都能执行它 —— 红框告警，不能让它悄悄溜过去。 */}
                    {Node(
                      a.allowedExperts && a.allowedExperts.length ? a.allowedExperts.map(expertName).join('、') : (a.capability !== 'read' ? '⚠ 不限岗位' : '不限'),
                      '授权岗位',
                      a.allowedExperts && a.allowedExperts.length ? '#7C3AED' : (a.capability !== 'read' ? '#DC2626' : '#cbd5e1'),
                    )}
                    {Arrow()}
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
          <thead><tr><th>域</th><th>对象</th><th>动作</th><th>能力</th><th>状态迁移</th><th>策略</th><th>允许岗位</th><th>绑定执行器</th></tr></thead>
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
                  {/* 岗位授权：谁有权执行这个动作。空 = 不限岗位——高危动作（审批/批准）不该是"不限"，
                      运维要能一眼扫出哪些高危动作还在裸奔。 */}
                  <td style={{ fontSize: 11 }}>
                    {a.allowedExperts && a.allowedExperts.length
                      ? a.allowedExperts.map(id => <span key={id} className="badge badge-purple" style={{ marginRight: 4 }}>{expertName(id)}</span>)
                      : <span className={a.capability !== 'read' ? 'badge badge-yellow' : ''} style={a.capability === 'read' ? { color: 'var(--text-muted)' } : undefined}>
                          {a.capability !== 'read' ? '⚠ 不限岗位' : '不限'}
                        </span>}
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

              {/* 动作 + 岗位授权。此前详情弹窗只有属性/状态机——对象"能干什么、谁有权干"完全看不到，
                  而这恰恰是本体最要紧的两件事（尤其"谁有权批准生产指令"）。 */}
              {actions.filter(a => a.domain === detail.domain && a.objectType === detail.typeKey).length > 0 && (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>动作与授权</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {actions.filter(a => a.domain === detail.domain && a.objectType === detail.typeKey).map(a => {
                      const write = a.capability !== 'read'
                      const allow = a.allowedExperts || []
                      return (
                        <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, padding: '5px 8px', border: '1px solid var(--border-color)', borderRadius: 4 }}>
                          {capBadge(a.capability)}
                          <b>{a.label}</b>
                          <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)', fontSize: 11 }}>{a.actionKey}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{stLbl(detail, a.fromState) || a.fromState || '任意状态'} → {stLbl(detail, a.toState) || a.toState || '不变'}</span>
                          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                            {allow.length
                              ? allow.map(id => <span key={id} className="badge badge-purple">{expertName(id)}</span>)
                              : <span className={write ? 'badge badge-red' : ''} style={!write ? { color: 'var(--text-muted)', fontSize: 11 } : undefined}>{write ? '⚠ 不限岗位' : '不限'}</span>}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>授权在「岗位专家 → 本体能力」里勾选（也可在 FDE 本体建模的动作编辑器里配）。</div>
                </div>
              )}

              {parse(detail.stateMachineJson) && (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>状态机</div>
                  {(() => {
                    const sm = parse(detail.stateMachineJson)
                    // 状态的展示名：中文 label 先行，英文键退居其后（等宽小字）
                    const st = (k: string) => {
                      const cn = stLbl(detail, k)
                      return cn ? <>{cn} <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-muted)' }}>{k}</span></> : <span style={{ fontFamily: 'monospace' }}>{k}</span>
                    }
                    // 迁移弧上的动作：用本对象动作的中文 label（actionKey 只作回落）
                    const actLbl = (key: string) => actions.find(x => x.domain === detail.domain && x.objectType === detail.typeKey && x.actionKey === key)?.label || key
                    return (
                      <div style={{ fontSize: 12 }}>
                        {/* ⚠️ 这是**图例**不是选择器：曾把初始态渲染成蓝色高亮 badge，
                            看着像"选中了 draft、其他都点不动"——纯展示信息绝不用交互控件的视觉语言。 */}
                        <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                          <span style={{ color: 'var(--text-muted)' }}>全部状态：</span>
                          {(sm.states || []).map((k: string) => (
                            <span key={k} className="badge" style={{ fontWeight: 400 }}>
                              {st(k)}{k === sm.initial && <span style={{ marginLeft: 4, color: 'var(--text-muted)', fontSize: 10 }}>（初始）</span>}
                            </span>
                          ))}
                        </div>
                        <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>流转规则（执行动作时按此迁移）：</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {(sm.transitions || []).map((t: any, i: number) => (
                            <div key={i} style={{ color: 'var(--text-secondary)' }}>
                              {st(t.from)} → {st(t.to)} <span className="badge badge-green" style={{ marginLeft: 4 }}>{actLbl(t.action)}</span>
                            </div>
                          ))}
                          {!(sm.transitions || []).length && <div style={{ color: 'var(--text-muted)' }}>未配置流转规则。</div>}
                        </div>
                      </div>
                    )
                  })()}
                </div>
              )}

              {(parse(detail.relationsJson) || []).length > 0 && (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>关系</div>
                  {(parse(detail.relationsJson) || []).map((r: any, i: number) => (
                    <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {detail.label} ─{r.name}→ {typeLbl(r.targetType)}
                      <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>{detail.typeKey} → {r.targetType}</span>
                      <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>({r.cardinality === 'one' ? '单个' : r.cardinality === 'many' ? '多个' : r.cardinality})</span>
                    </div>
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

// ===== 知识图谱视图（cytoscape）：域=复合父节点分组，对象=节点，关系=有向边 =====
// 力导向布局 + 滚轮缩放 + 拖拽平移/移动节点 + 点选看详情；随容器尺寸自适应（初始自动 fit）。
function OntologyGraphView({ types, actions, refs, onSelect }: { types: OType[]; actions: OAction[]; refs: ORef[]; onSelect: (t: OType) => void }) {
  const holder = useRef<HTMLDivElement>(null)
  const cyRef = useRef<cytoscape.Core | null>(null)   // 缩放/定位按钮要拿到实例
  const [layoutGen, setLayoutGen] = useState(0)   // 「重置布局」自增 → 触发 effect 重建图
  useEffect(() => {
    if (!holder.current) return
    // 同域同 typeKey 去重（历史 seed 有重复行）
    const seen = new Set<string>()
    const uniq = types.filter(t => { const k = t.domain + ':' + t.typeKey; if (seen.has(k)) return false; seen.add(k); return true })
    const DOM_ORDER = ['OA', 'CRM', 'ERM']
    const domains = [...new Set(uniq.map(t => t.domain))].sort((a, b) => {
      const ia = DOM_ORDER.indexOf(a), ib = DOM_ORDER.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    const refCountOf = (tk: string) => refs.filter(r => r.objectType === tk).length
    const byId = new Map<string, OType>()
    const els: any[] = []
    // 域框可拖动（复合父节点拖动时子节点整体跟随）；selectable 关掉避免选中样式干扰，tap 事件照常触发
    domains.forEach(d => els.push({ data: { id: 'dom:' + d, label: `${d} 域`, color: domainColor(d) }, classes: 'domain', selectable: false, grabbable: true }))
    // 预置坐标：域分列，**域内两列交错网格**——默认即"展开"（多数图谱工具的默认观感），
    // 且确定性布局保证域框/节点零重叠（力导向对复合节点分离不稳，曾试过放弃）。
    // 曾经是"每域一条竖列"：节点全叠在一根线上，边和文字挤成一团；用户手动拖开的 CRM/ERM
    // 好看，一刷新又挤回竖列——所以拖动位置也持久化（localStorage），刷新不丢。
    const COLGAP = 215, VGAP = 125, DOM_GAP_X = 130, DOM_GAP_Y = 150
    const domNodes: Record<string, OType[]> = {}
    uniq.forEach(t => { (domNodes[t.domain] = domNodes[t.domain] || []).push(t) })
    // 栅栏式排布域（两列换行）：域横向一字铺开会让整图特别宽 → 初始 fit 缩放特别小、每个域都看不清。
    // 两列换行后整图接近方正，默认缩放明显更大。
    const DOM_PER_ROW = domains.length <= 2 ? domains.length : 2
    const domX: Record<string, number> = {}, domY: Record<string, number> = {}, domCols: Record<string, number> = {}
    const dims = domains.map(d => {
      const n = (domNodes[d] || []).length
      const cols = n <= 3 ? 1 : 2          // ≤3 个节点一列已够展开；再多分两列
      const rows = Math.max(1, Math.ceil(n / cols))
      return { d, cols, w: cols * COLGAP, h: (rows - 1) * VGAP + (cols > 1 ? VGAP / 2 : 0) }
    })
    let gridY = 0
    for (let r = 0; r * DOM_PER_ROW < dims.length; r++) {
      const rowDims = dims.slice(r * DOM_PER_ROW, (r + 1) * DOM_PER_ROW)
      let gridX = 0, rowH = 0
      rowDims.forEach(dm => {
        domX[dm.d] = gridX; domY[dm.d] = gridY; domCols[dm.d] = dm.cols
        gridX += dm.w + DOM_GAP_X
        rowH = Math.max(rowH, dm.h)
      })
      gridY += rowH + DOM_GAP_Y
    }
    // 手动拖动过的位置优先（按节点 id 存 localStorage）
    let savedPos: Record<string, { x: number; y: number }> = {}
    try { savedPos = JSON.parse(localStorage.getItem('onto-graph-pos') || '{}') } catch { savedPos = {} }
    const rowIdx: Record<string, number> = {}
    uniq.forEach(t => {
      const id = 't:' + t.domain + ':' + t.typeKey
      byId.set(id, t)
      const acts = actions.filter(a => a.objectType === t.typeKey).length
      const i = (rowIdx[t.domain] = (rowIdx[t.domain] ?? -1) + 1)
      const cols = domCols[t.domain] || 1
      const col = i % cols, row = Math.floor(i / cols)
      // 第二列纵向错开半格：斜向边走对角线，标签不压在节点上
      const grid = { x: domX[t.domain] + col * COLGAP, y: (domY[t.domain] || 0) + row * VGAP + (col % 2) * (VGAP / 2) }
      els.push({
        data: { id, parent: 'dom:' + t.domain, label: `${t.label}\n${t.typeKey} · ${acts}动作 · ${refCountOf(t.typeKey)}实例`, color: domainColor(t.domain) },
        position: savedPos[id] || grid,
        classes: 'obj',
      })
    })
    uniq.forEach(t => ((parse(t.relationsJson) || []) as any[]).forEach((r, i) => {
      const src = 't:' + t.domain + ':' + t.typeKey
      const tgt = uniq.find(x => x.domain === t.domain && x.typeKey === r.targetType) || uniq.find(x => x.typeKey === r.targetType)
      if (!tgt) return
      const tgtId = 't:' + tgt.domain + ':' + tgt.typeKey
      if (tgtId === src) return
      els.push({ data: { id: `e:${src}:${r.name}:${i}`, source: src, target: tgtId, label: r.name, color: domainColor(t.domain) } })
    }))
    const cy = cytoscape({
      container: holder.current,
      elements: els,
      minZoom: 0.25, maxZoom: 3, wheelSensitivity: 0.2,
      style: [
        { selector: 'node.domain', style: { shape: 'round-rectangle', 'background-color': 'data(color)', 'background-opacity': 0.04, 'border-width': 1, 'border-color': '#e2e8f0', label: 'data(label)', 'text-valign': 'top', 'text-margin-y': -8, 'font-size': 13, 'font-weight': 'bold', color: 'data(color)', padding: '26px' } as any },
        { selector: 'node.obj', style: { shape: 'round-rectangle', 'background-color': '#ffffff', 'border-width': 1.6, 'border-color': 'data(color)', label: 'data(label)', 'text-wrap': 'wrap', 'text-valign': 'center', 'text-halign': 'center', 'font-size': 10, 'text-max-width': '165px', width: 178, height: 48, color: '#1a2530' } as any },
        { selector: 'edge', style: { 'curve-style': 'bezier', 'control-point-step-size': 36, width: 1.4, 'line-color': 'data(color)', 'line-opacity': 0.5, 'target-arrow-shape': 'triangle', 'target-arrow-color': 'data(color)', 'arrow-scale': 0.8, label: 'data(label)', 'font-size': 9, color: 'data(color)', 'text-rotation': 'autorotate', 'text-background-color': '#fbfcfe', 'text-background-opacity': 1, 'text-background-padding': '2px' } as any },
        { selector: 'node.obj:selected', style: { 'border-width': 3 } as any },
      ],
      layout: { name: 'preset', padding: 28 } as any,
    })
    // fit 后钳住最小初始缩放：小窗口里整图 fit 会把字缩到看不清——宁可让用户平移，可读性优先
    const fitReadable = () => {
      try {
        cy.fit(undefined, 28)
        if (cy.zoom() < 0.55) cy.zoom(0.55)
      } catch { /* 容器未就绪 */ }
    }
    cy.one('layoutstop', fitReadable)
    fitReadable()
    cyRef.current = cy
    cy.on('tap', 'node.obj', evt => { const t = byId.get(evt.target.id()); if (t) onSelect(t) })
    // 点击空白区（画布本体）＝视角复位（fit 全图，非布局重置）——和「点域聚焦」构成一对进出操作
    cy.on('tap', evt => { if (evt.target === cy) fitReadable() })
    // 点击域标题/域框空白 → 该域定位居中并放大（封顶 1.5，别怼到脸上）
    cy.on('tap', 'node.domain', evt => {
      cy.animate({ fit: { eles: evt.target, padding: 50 }, duration: 250 } as never)
      setTimeout(() => { try { if (cy.zoom() > 1.5) cy.zoom({ level: 1.5, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }) } catch { /* 已销毁 */ } }, 300)
    })
    cy.on('dragfree', 'node.obj', evt => {
      try {
        const pos = JSON.parse(localStorage.getItem('onto-graph-pos') || '{}')
        pos[evt.target.id()] = evt.target.position()
        localStorage.setItem('onto-graph-pos', JSON.stringify(pos))
      } catch { /* 存不上就算了，不影响展示 */ }
    })
    // 拖动整个域 → 域内全部子节点的新位置一并持久化
    cy.on('dragfree', 'node.domain', evt => {
      try {
        const pos = JSON.parse(localStorage.getItem('onto-graph-pos') || '{}')
        evt.target.children().forEach((ch: cytoscape.NodeSingular) => { pos[ch.id()] = ch.position() })
        localStorage.setItem('onto-graph-pos', JSON.stringify(pos))
      } catch { /* 同上 */ }
    })
    return () => { cyRef.current = null; try { cy.destroy() } catch { /* 已销毁 */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types, actions, refs, layoutGen])
  // 以视口中心为锚缩放（滚轮之外给个明确的按钮入口）
  const zoomBy = (f: number) => {
    const cy = cyRef.current; if (!cy) return
    const level = Math.min(3, Math.max(0.25, cy.zoom() * f))
    cy.stop(); cy.animate({ zoom: { level, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }, duration: 150 } as never)
  }
  const BTN: React.CSSProperties = { fontSize: 12, padding: '4px 10px' }
  return (
    <div style={{ position: 'relative' }}>
      <div ref={holder} style={{ width: '100%', height: '68vh', minHeight: 420, background: '#fbfcfe', border: '1px solid var(--border-color)', borderRadius: 8 }} />
      <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', gap: 6 }}>
        <button className="btn-secondary" style={BTN} title="放大" onClick={() => zoomBy(1.25)}>＋</button>
        <button className="btn-secondary" style={BTN} title="缩小" onClick={() => zoomBy(0.8)}>－</button>
        {/* 拖动位置会持久化（localStorage）——没有这颗按钮，拖乱一次就永远乱 */}
        <button className="btn-secondary" style={BTN}
          onClick={() => { localStorage.removeItem('onto-graph-pos'); setLayoutGen(v => v + 1) }}>
          重置布局
        </button>
      </div>
      <span style={{ position: 'absolute', bottom: 8, right: 12, fontSize: 11, color: 'var(--text-muted)' }}>点击域＝聚焦 · 点击空白＝复位 · 可拖动整域/单节点</span>
    </div>
  )
}
