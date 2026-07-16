import React, { useEffect, useState, useRef } from 'react'
import cytoscape from 'cytoscape'
import { Ontology, Admin, SkillCenter, ConnectorActions } from '../services/api'

const DOMAIN_COLOR = { OA: '#2563EB', CRM: '#7C3AED', ERM: '#B45309' }
const domainColor = (d) => DOMAIN_COLOR[d] || '#475569'
const parse = (s) => { try { return s ? JSON.parse(s) : null } catch { return null } }
const fmt = (s) => s ? String(s).replace('T', ' ').slice(0, 19) : '—'
const cap = (c) => c === 'read' ? '读·read' : '写·' + c
const money = (n) => '¥' + Number(n || 0).toLocaleString('en-US')

const badge = (text, color) => <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 4, fontSize: 11, border: `1px solid ${color}55`, background: `${color}14`, color }}>{text}</span>
const th: any = { textAlign: "left", padding: '8px 10px', fontSize: 12, color: '#55606e', background: '#f7f9fc', fontWeight: 600, borderBottom: '1px solid #eef1f5' }
const td: any = { padding: "8px 10px", fontSize: 12.5, borderBottom: '1px solid #f0f3f7' }

export default function OntologyPage() {
  const [tab, setTab] = useState('graph')
  const [types, setTypes] = useState([])
  const [actions, setActions] = useState([])
  const [refs, setRefs] = useState([])
  const [events, setEvents] = useState([])
  const [systems, setSystems] = useState([])
  const [skills, setSkills] = useState([])
  const [connectors, setConnectors] = useState([])
  const [experts, setExperts] = useState([])   // 本体动作的岗位授权（谁有权执行）
  const [detail, setDetail] = useState(null)
  const [typeForm, setTypeForm] = useState(null)
  const [actionForm, setActionForm] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      const [t, a, r, e, sys, sk, c, ex] = await Promise.all([
        Ontology.types().catch(() => []), Ontology.actions().catch(() => []),
        Ontology.refs().catch(() => []), Ontology.events().catch(() => []),
        Admin.integrations().catch(() => []), SkillCenter.list().catch(() => []),
        ConnectorActions.list().catch(() => []), Admin.experts().catch(() => []),
      ])
      setExperts(Array.isArray(ex) ? ex : (ex?.content || []))
      setTypes(t || []); setActions(a || []); setRefs(r || []); setEvents(e || [])
      setSystems(sys || [])
      setSkills((sk || []).filter(s => s.targetSystemId && s.actionScript))
      setConnectors(c || [])
    } catch (_) {}
  }
  useEffect(() => { load() }, [])

  const sysName = (id) => { const s = systems.find(x => x.id === id); return s ? s.name : (id || '—') }
  const execName = (id) => { if (!id) return ''; const s = skills.find(x => x.id === id); if (s) return s.name; const c = connectors.find(x => x.id === id); return c ? (c.name || c.actionKey) : id }
  const refCount = (tk) => refs.filter(r => r.objectType === tk).length
  const typeKeys = Array.from(new Set(types.map(t => t.typeKey)))
  const statesOf = (domain, ot) => { const t = types.find(x => x.domain === domain && x.typeKey === ot); const sm = t ? parse(t.stateMachineJson) : null; return sm ? (sm.states || []) : [] }

  // ---- 建模：对象类型 ----
  const newType = () => ({ domain: 'OA', typeKey: '', label: '', boundSystemId: '', resolveListPath: '', description: '', properties: [], relations: [], states: '', initial: '', transitions: [] })
  const editType = (t) => { const sm = parse(t.stateMachineJson) || {}; setTypeForm({ id: t.id, domain: t.domain, typeKey: t.typeKey, label: t.label, boundSystemId: t.boundSystemId || '', resolveListPath: t.resolveListPath || '', description: t.description || '', properties: parse(t.propertiesJson) || [], relations: parse(t.relationsJson) || [], states: (sm.states || []).join(', '), initial: sm.initial || '', transitions: sm.transitions || [] }) }
  const saveType = async () => {
    if (!typeForm.typeKey.trim() || !typeForm.label.trim()) return alert('类型键与标签必填')
    const st = typeForm.states.split(/[，,\s]+/).map(s => s.trim()).filter(Boolean)
    const body = { id: typeForm.id, domain: typeForm.domain.trim(), typeKey: typeForm.typeKey.trim(), label: typeForm.label.trim(), boundSystemId: typeForm.boundSystemId || null, resolveListPath: typeForm.resolveListPath.trim() || null, description: typeForm.description, propertiesJson: JSON.stringify(typeForm.properties.filter(p => p.key)), relationsJson: JSON.stringify(typeForm.relations.filter(r => r.name && r.targetType)), stateMachineJson: st.length ? JSON.stringify({ initial: typeForm.initial || st[0], states: st, transitions: typeForm.transitions.filter(x => x.from && x.to && x.action) }) : null }
    setBusy(true)
    try { typeForm.id ? await Ontology.updateType(typeForm.id, body) : await Ontology.createType(body); setTypeForm(null); await load() }
    catch (e) { alert('保存失败：' + (e.message || e)) } finally { setBusy(false) }
  }
  const removeType = async (t) => { if (!confirm(`删除对象类型「${t.label}」？`)) return; try { await Ontology.removeType(t.id); setDetail(null); await load() } catch (e) { alert('删除失败') } }

  // ---- 建模：动作 ----
  const newAction = () => ({ domain: 'OA', objectType: '', actionKey: '', label: '', capability: 'update', fromState: '', toState: '', auto: true, confirmIf: '', eventType: '', risk: '', connectorActionId: '', allowedExperts: [] })
  const editAction = (a) => { const p = parse(a.policyJson) || {}; setActionForm({ id: a.id, domain: a.domain, objectType: a.objectType, actionKey: a.actionKey, label: a.label, capability: a.capability || 'update', fromState: a.fromState || '', toState: a.toState || '', auto: p.auto !== false, confirmIf: p.confirmIf || '', eventType: p.eventType || '', risk: p.risk || '', connectorActionId: a.connectorActionId || '', allowedExperts: a.allowedExperts || [] }) }
  const saveAction = async () => {
    if (!actionForm.objectType || !actionForm.actionKey.trim() || !actionForm.label.trim()) return alert('对象类型、动作键、标签必填')
    const policy: any = { auto: !!actionForm.auto }
    if (actionForm.confirmIf.trim()) policy.confirmIf = actionForm.confirmIf.trim()
    if (actionForm.eventType.trim()) policy.eventType = actionForm.eventType.trim()
    if (actionForm.risk.trim()) policy.risk = actionForm.risk.trim()
    const body = { id: actionForm.id, domain: actionForm.domain, objectType: actionForm.objectType, actionKey: actionForm.actionKey.trim(), label: actionForm.label.trim(), capability: actionForm.capability, fromState: actionForm.fromState || null, toState: actionForm.toState || null, connectorActionId: actionForm.connectorActionId || null, policyJson: JSON.stringify(policy), allowedExperts: actionForm.allowedExperts || [] }
    setBusy(true)
    try { actionForm.id ? await Ontology.updateAction(actionForm.id, body) : await Ontology.createAction(body); setActionForm(null); await load() }
    catch (e) { alert('保存失败：' + (e.message || e)) } finally { setBusy(false) }
  }
  const removeAction = async (a) => { if (!confirm(`删除动作「${a.label}」？`)) return; try { await Ontology.removeAction(a.id); await load() } catch (e) { alert('删除失败') } }
  const bindExec = async (a, id) => { try { await Ontology.updateAction(a.id, { ...a, connectorActionId: id || null, allowedExperts: a.allowedExperts || [] }); setActions(prev => prev.map(x => x.id === a.id ? { ...x, connectorActionId: id || undefined } : x)) } catch (e) { alert('绑定失败') } }


  const TABS = [['graph', '本体图谱'], ['lineage', '执行链路'], ['types', '对象类型'], ['actions', '对象动作'], ['refs', '对象实例'], ['events', '业务事件']]
  const chip = (active) => ({ padding: '6px 12px', borderRadius: '8px 8px 0 0', border: 'none', background: active ? '#eaf2fd' : 'transparent', color: active ? '#2563EB' : '#55606e', fontWeight: active ? 700 : 500, cursor: 'pointer', fontSize: 13 })

  return (
    <div style={{ padding: '18px 22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>本体建模</h2>
        <span className="muted" style={{ fontSize: 12.5 }}>前置工程师在此为该客户建对象/关系/状态/动作，并绑定录制的技能/连接器</span>
        <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setTypeForm(newType())}>+ 新建对象类型</button>
        <button className="primary" onClick={() => setActionForm(newAction())}>+ 新建动作</button>
        <button className="ghost" onClick={load}>刷新</button>
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e3e8ef', margin: '10px 0 14px' }}>
        {TABS.map(([k, l]) => <button key={k} style={chip(tab === k)} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === 'graph' && <div><p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>知识图谱视图：滚轮缩放 · 拖拽平移/移动节点 · 点节点看/改属性、状态机、关系。</p><OntologyGraphView types={types} actions={actions} refs={refs} onSelect={setDetail} /></div>}

      {tab === 'lineage' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>执行血缘：业务系统 → 读消解(列表页) → 对象 → 动作(策略) → 执行器 → 业务事件。</p>
          {actions.map(a => {
            const t = types.find(x => x.domain === a.domain && x.typeKey === a.objectType); const p = parse(a.policyJson) || {}
            const conf = p.confirmIf === 'always' ? '始终人工确认' : (p.confirmIf ? '条件确认:' + p.confirmIf : '自动')
            const evc = events.filter(e => e.actionKey === a.actionKey && e.objectType === a.objectType).length
            const N = (lb: any, sub: any, col: any, strong?: any) => <div title={lb} style={{ flex: '0 0 auto', width: 140, background: '#fff', border: `1.4px solid ${col}`, borderRadius: 8, padding: '7px 10px' }}><div style={{ fontSize: 12.5, fontWeight: strong ? 700 : 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lb}</div><div style={{ fontSize: 10.5, color: '#7b8794', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div></div>
            const A = (l?: any) => <div style={{ flex: '0 0 auto', width: 46, color: '#94a3b8', textAlign: 'center' }}><div style={{ fontSize: 9.5, height: 13 }}>{l || ''}</div><div style={{ fontSize: 15, lineHeight: 1 }}>→</div></div>
            return (<div key={a.id} style={{ border: '1px solid #e3e8ef', borderRadius: 8, padding: '10px 12px', background: '#fbfcfe' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>{badge(a.domain, DOMAIN_COLOR[a.domain] || '#475569')}<b style={{ fontSize: 13 }}>{a.objectType}.{a.actionKey}</b><span className="muted" style={{ fontSize: 12 }}>{a.label}</span>{badge(cap(a.capability), a.capability === 'read' ? '#0C8154' : '#B45309')}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                {N(sysName(t?.boundSystemId), '业务系统', '#94a3b8')}{A('读消解')}
                {N(t?.resolveListPath || '（无列表页）', '候选来源', t?.resolveListPath ? '#2563EB' : '#cbd5e1')}{A()}
                {N(t?.label || a.objectType, `对象·${refCount(a.objectType)}实例`, DOMAIN_COLOR[a.domain] || '#475569', true)}{A(conf === '自动' ? '' : '策略')}
                {N(a.label, `${a.fromState || '*'}→${a.toState || '-'} · ${conf}`, conf === '始终人工确认' ? '#DC2626' : (conf === '自动' ? '#0C8154' : '#B45309'))}{A('执行')}
                {N(a.connectorActionId ? execName(a.connectorActionId) : '未绑定', a.connectorActionId ? '连接器/技能' : '语义登记', a.connectorActionId ? '#0C8154' : '#cbd5e1')}{A('回写')}
                {N(p.eventType || 'StateChanged', `事件·${evc}条`, '#7C3AED')}
              </div>
            </div>)
          })}
        </div>
      )}

      {tab === 'types' && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>域</th><th style={th}>类型</th><th style={th}>标签</th><th style={th}>来源系统</th><th style={th}>属性</th><th style={th}>状态机</th><th style={th}>关系</th><th style={th}>操作</th></tr></thead>
          <tbody>{types.map(t => { const props = parse(t.propertiesJson) || []; const sm = parse(t.stateMachineJson); const rels = parse(t.relationsJson) || []; return (
            <tr key={t.id}>
              <td style={td}>{badge(t.domain, DOMAIN_COLOR[t.domain] || '#475569')}</td>
              <td style={{ ...td, fontFamily: 'monospace', cursor: 'pointer' }} onClick={() => setDetail(t)}>{t.typeKey}</td>
              <td style={{ ...td, cursor: 'pointer' }} onClick={() => setDetail(t)}>{t.label}</td>
              <td style={{ ...td, color: '#7b8794' }}>{sysName(t.boundSystemId)}</td>
              <td style={td}>{props.length} 项</td>
              <td style={{ ...td, fontSize: 11 }}>{sm ? (sm.states || []).join(' → ') : <span className="muted">无</span>}</td>
              <td style={{ ...td, fontSize: 11 }}>{rels.length ? rels.map(r => `${r.name}:${r.targetType}`).join('、') : <span className="muted">—</span>}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}><button className="ghost" style={{ padding: '3px 8px' }} onClick={() => editType(t)}>编辑</button><button className="ghost danger" style={{ padding: '3px 8px', marginLeft: 6 }} onClick={() => removeType(t)}>删除</button></td>
            </tr>) })}</tbody>
        </table>
      )}

      {tab === 'actions' && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>域</th><th style={th}>对象</th><th style={th}>动作</th><th style={th}>能力</th><th style={th}>状态迁移</th><th style={th}>策略</th><th style={th}>绑定执行器</th><th style={th}>操作</th></tr></thead>
          <tbody>{actions.map(a => { const p = parse(a.policyJson) || {}; return (
            <tr key={a.id}>
              <td style={td}>{badge(a.domain, DOMAIN_COLOR[a.domain] || '#475569')}</td>
              <td style={{ ...td, fontFamily: 'monospace' }}>{a.objectType}</td>
              <td style={td}><b>{a.label}</b> <span className="muted" style={{ fontSize: 11 }}>{a.actionKey}</span></td>
              <td style={td}>{badge(cap(a.capability), a.capability === 'read' ? '#0C8154' : '#B45309')}</td>
              <td style={{ ...td, fontSize: 11 }}>{a.fromState || '*'} → {a.toState || '（不变）'}</td>
              <td style={{ ...td, fontSize: 11 }}>{p.confirmIf === 'always' ? badge('始终人工确认', '#DC2626') : (p.confirmIf ? badge('条件:' + p.confirmIf, '#B45309') : badge('自动', '#0C8154'))}</td>
              <td style={td}>
                <select value={a.connectorActionId || ''} onChange={e => bindExec(a, e.target.value)} style={{ fontSize: 11, padding: '3px 6px', maxWidth: 200 }}>
                  <option value="">未绑定（语义登记）</option>
                  {skills.length > 0 && <optgroup label="技能">{skills.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>}
                  {connectors.length > 0 && <optgroup label="连接器动作">{connectors.map(c => <option key={c.id} value={c.id}>{c.name || c.actionKey}</option>)}</optgroup>}
                </select>
              </td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}><button className="ghost" style={{ padding: '3px 8px' }} onClick={() => editAction(a)}>编辑</button><button className="ghost danger" style={{ padding: '3px 8px', marginLeft: 6 }} onClick={() => removeAction(a)}>删除</button></td>
            </tr>) })}</tbody>
        </table>
      )}

      {tab === 'refs' && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>类型</th><th style={th}>系统</th><th style={th}>外部主键</th><th style={th}>显示名</th><th style={th}>状态</th><th style={th}>最近</th></tr></thead>
          <tbody>{refs.length === 0 && <tr><td style={td} colSpan={6}><span className="muted">暂无对象引用（客户端执行本体动作后自动登记，仅存身份不存业务数据）。</span></td></tr>}
            {refs.map(r => <tr key={r.id}><td style={{ ...td, fontFamily: 'monospace' }}>{r.objectType}</td><td style={{ ...td, color: '#7b8794' }}>{sysName(r.systemId)}</td><td style={{ ...td, fontFamily: 'monospace' }}>{r.externalId}</td><td style={td}>{r.displayName || '—'}</td><td style={td}>{badge(r.currentState || '—', '#2563EB')}</td><td style={{ ...td, color: '#7b8794', fontSize: 11 }}>{fmt(r.lastSeenAt)}</td></tr>)}</tbody>
        </table>
      )}

      {tab === 'events' && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>时间</th><th style={th}>事件</th><th style={th}>对象</th><th style={th}>动作</th><th style={th}>状态迁移</th><th style={th}>操作人</th><th style={th}>风险</th></tr></thead>
          <tbody>{events.length === 0 && <tr><td style={td} colSpan={7}><span className="muted">暂无业务事件。</span></td></tr>}
            {events.map(e => <tr key={e.id}><td style={{ ...td, color: '#7b8794', fontSize: 11, whiteSpace: 'nowrap' }}>{fmt(e.createdAt)}</td><td style={td}>{badge(e.eventType, '#7C3AED')}</td><td style={{ ...td, fontFamily: 'monospace' }}>{e.objectType}</td><td style={td}>{e.actionKey}</td><td style={{ ...td, fontSize: 11 }}>{e.fromState || '*'} → {e.toState || '—'}</td><td style={td}>{e.actorName || '—'}</td><td style={td}>{badge(e.riskLevel || 'LOW', e.riskLevel === 'HIGH' ? '#DC2626' : e.riskLevel === 'MEDIUM' ? '#B45309' : '#0C8154')}</td></tr>)}</tbody>
        </table>
      )}

      {/* 对象类型详情 */}
      {detail && <Drawer title={`${detail.label}（${detail.typeKey}）`} onClose={() => setDetail(null)} width={520}>
        {detail.description && <p style={{ fontSize: 13, color: '#55606e' }}>{detail.description}</p>}
        <div className="muted" style={{ fontSize: 12 }}>来源系统：{sysName(detail.boundSystemId)}｜列表页：{detail.resolveListPath || '—'}</div>
        <Section title="属性"><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th}>字段</th><th style={th}>标签</th><th style={th}>类型</th></tr></thead><tbody>{(parse(detail.propertiesJson) || []).map(p => <tr key={p.key}><td style={{ ...td, fontFamily: 'monospace' }}>{p.key}</td><td style={td}>{p.label}</td><td style={td}>{p.type}</td></tr>)}</tbody></table></Section>
        {parse(detail.stateMachineJson) && (() => { const sm = parse(detail.stateMachineJson); return <Section title="状态机"><div style={{ marginBottom: 6 }}>{(sm.states || []).map(s => <span key={s} style={{ marginRight: 4 }}>{badge(s, s === sm.initial ? '#2563EB' : '#94a3b8')}</span>)}</div>{(sm.transitions || []).map((t, i) => <div key={i} style={{ fontSize: 12, color: '#55606e' }}>{t.from} → {t.to} {badge(t.action, '#0C8154')}</div>)}</Section> })()}
        {(parse(detail.relationsJson) || []).length > 0 && <Section title="关系">{(parse(detail.relationsJson) || []).map((r, i) => <div key={i} style={{ fontSize: 12, color: '#55606e' }}>{detail.typeKey} ─{r.name}→ {r.targetType} <span className="muted">({r.cardinality})</span></div>)}</Section>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><button className="primary" onClick={() => { const t = detail; setDetail(null); editType(t) }}>编辑此对象类型</button><button className="ghost danger" onClick={() => removeType(detail)}>删除</button></div>
      </Drawer>}

      {/* 对象类型建模 */}
      {typeForm && <Drawer title={typeForm.id ? '编辑对象类型' : '新建对象类型'} onClose={() => setTypeForm(null)} width={640}>
        <Grid2>
          <Field label="域(domain)"><input value={typeForm.domain} onChange={e => setTypeForm({ ...typeForm, domain: e.target.value })} placeholder="OA / CRM" /></Field>
          <Field label="类型键(typeKey)*"><input value={typeForm.typeKey} onChange={e => setTypeForm({ ...typeForm, typeKey: e.target.value })} placeholder="如 Contract" /></Field>
          <Field label="标签*"><input value={typeForm.label} onChange={e => setTypeForm({ ...typeForm, label: e.target.value })} placeholder="如 合同" /></Field>
          <Field label="来源系统"><select value={typeForm.boundSystemId} onChange={e => setTypeForm({ ...typeForm, boundSystemId: e.target.value })}><option value="">（未绑定）</option>{systems.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="对象列表页路径(读消解)"><input value={typeForm.resolveListPath} onChange={e => setTypeForm({ ...typeForm, resolveListPath: e.target.value })} placeholder="如 /contract/list" /></Field>
          <Field label="描述"><input value={typeForm.description} onChange={e => setTypeForm({ ...typeForm, description: e.target.value })} /></Field>
        </Grid2>
        <Editor title="属性" onAdd={() => setTypeForm({ ...typeForm, properties: [...typeForm.properties, { key: '', label: '', type: 'string' }] })}>
          {typeForm.properties.map((p, i) => <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5 }}>
            <input style={{ flex: 1 }} placeholder="key" value={p.key} onChange={e => upd(typeForm, setTypeForm, 'properties', i, { ...p, key: e.target.value })} />
            <input style={{ flex: 1 }} placeholder="标签" value={p.label} onChange={e => upd(typeForm, setTypeForm, 'properties', i, { ...p, label: e.target.value })} />
            <select style={{ width: 92 }} value={p.type} onChange={e => upd(typeForm, setTypeForm, 'properties', i, { ...p, type: e.target.value })}>{['string', 'number', 'enum', 'date', 'ref', 'text'].map(x => <option key={x}>{x}</option>)}</select>
            <button className="ghost danger" onClick={() => del(typeForm, setTypeForm, 'properties', i)}>×</button>
          </div>)}
        </Editor>
        <Editor title="关系" onAdd={() => setTypeForm({ ...typeForm, relations: [...typeForm.relations, { name: '', targetType: '', cardinality: 'one' }] })}>
          {typeForm.relations.map((r, i) => <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5 }}>
            <input style={{ flex: 1 }} placeholder="关系名 如 belongsTo" value={r.name} onChange={e => upd(typeForm, setTypeForm, 'relations', i, { ...r, name: e.target.value })} />
            <select style={{ flex: 1 }} value={r.targetType} onChange={e => upd(typeForm, setTypeForm, 'relations', i, { ...r, targetType: e.target.value })}><option value="">目标类型</option>{typeKeys.map(k => <option key={k} value={k}>{k}</option>)}</select>
            <select style={{ width: 80 }} value={r.cardinality} onChange={e => upd(typeForm, setTypeForm, 'relations', i, { ...r, cardinality: e.target.value })}><option value="one">one</option><option value="many">many</option></select>
            <button className="ghost danger" onClick={() => del(typeForm, setTypeForm, 'relations', i)}>×</button>
          </div>)}
        </Editor>
        <div style={{ marginTop: 6 }}><b style={{ fontSize: 13 }}>状态机</b>
          <div style={{ display: 'flex', gap: 10, margin: '6px 0' }}>
            <input style={{ flex: 2 }} placeholder="状态(逗号分隔) 如 pending,approved,rejected" value={typeForm.states} onChange={e => setTypeForm({ ...typeForm, states: e.target.value })} />
            <input style={{ flex: 1 }} placeholder="初始状态" value={typeForm.initial} onChange={e => setTypeForm({ ...typeForm, initial: e.target.value })} />
          </div>
          <Editor title="状态迁移" onAdd={() => setTypeForm({ ...typeForm, transitions: [...typeForm.transitions, { from: '', to: '', action: '' }] })}>
            {typeForm.transitions.map((tr, i) => <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5, alignItems: 'center' }}>
              <input style={{ flex: 1 }} placeholder="from" value={tr.from} onChange={e => upd(typeForm, setTypeForm, 'transitions', i, { ...tr, from: e.target.value })} />→
              <input style={{ flex: 1 }} placeholder="to" value={tr.to} onChange={e => upd(typeForm, setTypeForm, 'transitions', i, { ...tr, to: e.target.value })} />
              <input style={{ flex: 1 }} placeholder="动作 action" value={tr.action} onChange={e => upd(typeForm, setTypeForm, 'transitions', i, { ...tr, action: e.target.value })} />
              <button className="ghost danger" onClick={() => del(typeForm, setTypeForm, 'transitions', i)}>×</button>
            </div>)}
          </Editor>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}><button className="primary" disabled={busy} onClick={saveType}>{busy ? '保存中…' : '保存对象类型'}</button><button className="ghost" onClick={() => setTypeForm(null)}>取消</button></div>
      </Drawer>}

      {/* 动作建模 */}
      {actionForm && <Drawer title={actionForm.id ? '编辑对象动作' : '新建对象动作'} onClose={() => setActionForm(null)} width={560}>
        <Grid2>
          <Field label="域"><input value={actionForm.domain} onChange={e => setActionForm({ ...actionForm, domain: e.target.value })} /></Field>
          <Field label="对象类型*"><select value={actionForm.objectType} onChange={e => setActionForm({ ...actionForm, objectType: e.target.value })}><option value="">选择对象</option>{typeKeys.map(k => <option key={k} value={k}>{k}</option>)}</select></Field>
          <Field label="动作键*"><input value={actionForm.actionKey} onChange={e => setActionForm({ ...actionForm, actionKey: e.target.value })} placeholder="如 approve" /></Field>
          <Field label="标签*"><input value={actionForm.label} onChange={e => setActionForm({ ...actionForm, label: e.target.value })} placeholder="如 审批通过" /></Field>
          <Field label="能力"><select value={actionForm.capability} onChange={e => setActionForm({ ...actionForm, capability: e.target.value })}>{['read', 'create', 'update', 'delete', 'batch'].map(x => <option key={x}>{x}</option>)}</select></Field>
          <Field label="状态迁移"><div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select value={actionForm.fromState} onChange={e => setActionForm({ ...actionForm, fromState: e.target.value })}><option value="">from(任意)</option>{statesOf(actionForm.domain, actionForm.objectType).map(s => <option key={s}>{s}</option>)}</select>→
            <select value={actionForm.toState} onChange={e => setActionForm({ ...actionForm, toState: e.target.value })}><option value="">to(不变)</option>{statesOf(actionForm.domain, actionForm.objectType).map(s => <option key={s}>{s}</option>)}</select>
          </div></Field>
        </Grid2>
        <div style={{ borderTop: '1px solid #e3e8ef', paddingTop: 10, marginTop: 6 }}>
          <b style={{ fontSize: 13 }}>策略</b>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', margin: '8px 0' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={actionForm.auto} onChange={e => setActionForm({ ...actionForm, auto: e.target.checked })} />默认自动</label>
            <input style={{ flex: 1 }} placeholder="confirmIf：always 或 amount>5000000" value={actionForm.confirmIf} onChange={e => setActionForm({ ...actionForm, confirmIf: e.target.value })} />
          </div>
          <Grid2>
            <Field label="事件类型"><input value={actionForm.eventType} onChange={e => setActionForm({ ...actionForm, eventType: e.target.value })} placeholder="如 ApprovalPassed" /></Field>
            <Field label="风险"><select value={actionForm.risk} onChange={e => setActionForm({ ...actionForm, risk: e.target.value })}><option value="">（默认）</option><option>LOW</option><option>MEDIUM</option><option>HIGH</option></select></Field>
          </Grid2>
        </div>
        <Field label="允许岗位（谁有权执行该动作 · 不选=不限岗位）">
          {/* 本体动作原先没有权限概念：只要业务域命中，一线「装置操作工」的分身就能批准生产指令。
              高危动作（审批/批准/签批）务必在这里限定岗位——留空就是裸奔。 */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '4px 0' }}>
            {experts.length === 0 && <span style={{ color: '#94a3b8', fontSize: 12 }}>（暂无岗位）</span>}
            {experts.map(e => {
              const on = (actionForm.allowedExperts || []).includes(e.id)
              return (
                <label key={e.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                  <input type="checkbox" checked={on} style={{ width: 'auto' }}
                    onChange={ev => setActionForm({ ...actionForm, allowedExperts: ev.target.checked
                      ? [...(actionForm.allowedExperts || []), e.id]
                      : (actionForm.allowedExperts || []).filter(x => x !== e.id) })} />
                  {e.title}
                </label>
              )
            })}
          </div>
          {actionForm.capability !== 'read' && !(actionForm.allowedExperts || []).length &&
            <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}>⚠️ 这是写操作且未限定岗位——任何业务域命中的岗位都能执行它。</div>}
        </Field>
        <Field label="绑定执行器（连接器动作/技能）"><select value={actionForm.connectorActionId} onChange={e => setActionForm({ ...actionForm, connectorActionId: e.target.value })}><option value="">未绑定（语义登记）</option>{skills.length > 0 && <optgroup label="技能">{skills.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>}{connectors.length > 0 && <optgroup label="连接器动作">{connectors.map(c => <option key={c.id} value={c.id}>{c.name || c.actionKey}</option>)}</optgroup>}</select></Field>
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}><button className="primary" disabled={busy} onClick={saveAction}>{busy ? '保存中…' : '保存动作'}</button><button className="ghost" onClick={() => setActionForm(null)}>取消</button></div>
      </Drawer>}
    </div>
  )
}

// ---- 小组件 ----
function upd(form, set, key, i, val) { const a = [...form[key]]; a[i] = val; set({ ...form, [key]: a }) }
function del(form, set, key, i) { set({ ...form, [key]: form[key].filter((_, j) => j !== i) }) }
function Drawer({ title, onClose, width, children }) {
  return (<>
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(20,40,70,.28)', zIndex: 40 }} />
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width, maxWidth: '92vw', background: '#fff', boxShadow: '-8px 0 30px rgba(0,0,0,.12)', zIndex: 41, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #e3e8ef' }}><b style={{ fontSize: 15 }}>{title}</b><button className="ghost" style={{ marginLeft: 'auto', fontSize: 18, padding: '2px 8px' }} onClick={onClose}>×</button></div>
      <div style={{ padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  </>)
}
function Section({ title, children }) { return <div><div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>{children}</div> }
function Grid2({ children }) { return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{children}</div> }
function Field({ label, children }) { return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><label style={{ fontSize: 12.5, color: '#55606e', fontWeight: 600 }}>{label}</label>{children}</div> }
function Editor({ title, onAdd, children }) { return <div><div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}><b style={{ fontSize: 13 }}>{title}</b><button className="ghost" style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 11 }} onClick={onAdd}>+ 添加</button></div>{children}</div> }


// ===== 知识图谱视图（cytoscape）：域=复合父节点分组，对象=节点，关系=有向边 =====
// 与管理端 OntologyManager.OntologyGraphView **同构**（跨仓库无法共包，改动两边同步）：
// 交错网格默认展开 + 拖动持久化 + 重置/缩放按钮 + 点击域定位居中 + 整域可拖动。
function OntologyGraphView({ types, actions, refs, onSelect }) {
  const holder = useRef(null)
  const cyRef = useRef(null)
  const [layoutGen, setLayoutGen] = useState(0)   // 「重置布局」自增 → 重建图
  useEffect(() => {
    if (!holder.current) return
    const seen = new Set()
    const uniq = types.filter(t => { const k = t.domain + ':' + t.typeKey; if (seen.has(k)) return false; seen.add(k); return true })
    const DOM_ORDER = ['OA', 'CRM', 'ERM']
    const domains = [...new Set<string>(uniq.map((t: any) => t.domain))].sort((a, b) => {
      const ia = DOM_ORDER.indexOf(a), ib = DOM_ORDER.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    const refCountOf = (tk) => refs.filter(r => r.objectType === tk).length
    const byId = new Map()
    const els = []
    // 域框可拖动（复合父节点拖动时子节点整体跟随）；tap 事件照常触发
    domains.forEach(d => els.push({ data: { id: 'dom:' + d, label: d + ' 域', color: domainColor(d) }, classes: 'domain', selectable: false, grabbable: true }))
    // 预置坐标：域分列、域内两列交错网格——默认即"展开"，零重叠（确定性，不靠力导向）
    const COLGAP = 215, VGAP = 125, DOM_GAP_X = 130, DOM_GAP_Y = 150
    const domNodes = {}
    uniq.forEach(t => { (domNodes[t.domain] = domNodes[t.domain] || []).push(t) })
    // 栅栏式排布域（两列换行）：一字横铺 → 整图特别宽、初始缩放特别小；换行后方正、默认更大
    const DOM_PER_ROW = domains.length <= 2 ? domains.length : 2
    const domX = {}, domY = {}, domCols = {}
    const dims = domains.map(d => {
      const n = (domNodes[d] || []).length
      const cols = n <= 3 ? 1 : 2
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
    let savedPos = {}
    try { savedPos = JSON.parse(localStorage.getItem('onto-graph-pos') || '{}') } catch (_) { savedPos = {} }
    const rowIdx = {}
    uniq.forEach(t => {
      const id = 't:' + t.domain + ':' + t.typeKey
      byId.set(id, t)
      const acts = actions.filter(a => a.objectType === t.typeKey).length
      const i = (rowIdx[t.domain] = (rowIdx[t.domain] ?? -1) + 1)
      const cols = domCols[t.domain] || 1
      const col = i % cols, row = Math.floor(i / cols)
      const grid = { x: domX[t.domain] + col * COLGAP, y: (domY[t.domain] || 0) + row * VGAP + (col % 2) * (VGAP / 2) }
      els.push({
        data: { id, parent: 'dom:' + t.domain, label: t.label + '\n' + t.typeKey + ' · ' + acts + '动作 · ' + refCountOf(t.typeKey) + '实例', color: domainColor(t.domain) },
        position: savedPos[id] || grid,
        classes: 'obj',
      })
    })
    uniq.forEach(t => (parse(t.relationsJson) || []).forEach((r, i) => {
      const src = 't:' + t.domain + ':' + t.typeKey
      const tgt = uniq.find(x => x.domain === t.domain && x.typeKey === r.targetType) || uniq.find(x => x.typeKey === r.targetType)
      if (!tgt) return
      const tgtId = 't:' + tgt.domain + ':' + tgt.typeKey
      if (tgtId === src) return
      els.push({ data: { id: 'e:' + src + ':' + r.name + ':' + i, source: src, target: tgtId, label: r.name, color: domainColor(t.domain) } })
    }))
    const cy = cytoscape({
      container: holder.current,
      elements: els,
      minZoom: 0.25, maxZoom: 3, wheelSensitivity: 0.2,
      style: [
        { selector: 'node.domain', style: { shape: 'round-rectangle', 'background-color': 'data(color)', 'background-opacity': 0.04, 'border-width': 1, 'border-color': '#e2e8f0', label: 'data(label)', 'text-valign': 'top', 'text-margin-y': -8, 'font-size': 13, 'font-weight': 'bold', color: 'data(color)', padding: '26px' } },
        { selector: 'node.obj', style: { shape: 'round-rectangle', 'background-color': '#ffffff', 'border-width': 1.6, 'border-color': 'data(color)', label: 'data(label)', 'text-wrap': 'wrap', 'text-valign': 'center', 'text-halign': 'center', 'font-size': 10, 'text-max-width': '165px', width: 178, height: 48, color: '#1a2530' } },
        { selector: 'edge', style: { 'curve-style': 'bezier', 'control-point-step-size': 36, width: 1.4, 'line-color': 'data(color)', 'line-opacity': 0.5, 'target-arrow-shape': 'triangle', 'target-arrow-color': 'data(color)', 'arrow-scale': 0.8, label: 'data(label)', 'font-size': 9, color: 'data(color)', 'text-rotation': 'autorotate', 'text-background-color': '#fbfcfe', 'text-background-opacity': 1, 'text-background-padding': '2px' } },
        { selector: 'node.obj:selected', style: { 'border-width': 3 } },
      ],
      layout: { name: 'preset', padding: 28 },
    })
    // fit 后钳住最小初始缩放：小窗口整图 fit 会把字缩没，可读性优先
    const fitReadable = () => { try { cy.fit(undefined, 28); if (cy.zoom() < 0.55) cy.zoom(0.55) } catch (_) { /* 容器未就绪 */ } }
    cy.one('layoutstop', fitReadable)
    fitReadable()
    cyRef.current = cy
    cy.on('tap', 'node.obj', evt => { const t = byId.get(evt.target.id()); if (t) onSelect(t) })
    // 点击空白区（画布本体）＝视角复位（fit 全图，非布局重置）——和「点域聚焦」构成一对进出操作
    cy.on('tap', evt => { if (evt.target === cy) fitReadable() })
    // 点击域 → 定位居中并放大（封顶 1.5）
    cy.on('tap', 'node.domain', evt => {
      cy.animate({ fit: { eles: evt.target, padding: 50 }, duration: 250 })
      setTimeout(() => { try { if (cy.zoom() > 1.5) cy.zoom({ level: 1.5, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }) } catch (_) { /* 已销毁 */ } }, 300)
    })
    cy.on('dragfree', 'node.obj', evt => {
      try { const pos = JSON.parse(localStorage.getItem('onto-graph-pos') || '{}'); pos[evt.target.id()] = evt.target.position(); localStorage.setItem('onto-graph-pos', JSON.stringify(pos)) } catch (_) { /* 忽略 */ }
    })
    cy.on('dragfree', 'node.domain', evt => {
      try { const pos = JSON.parse(localStorage.getItem('onto-graph-pos') || '{}'); evt.target.children().forEach(ch => { pos[ch.id()] = ch.position() }); localStorage.setItem('onto-graph-pos', JSON.stringify(pos)) } catch (_) { /* 忽略 */ }
    })
    return () => { cyRef.current = null; try { cy.destroy() } catch (_) { /* 已销毁 */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types, actions, refs, layoutGen])
  const zoomBy = (f) => {
    const cy = cyRef.current; if (!cy) return
    const level = Math.min(3, Math.max(0.25, cy.zoom() * f))
    cy.stop(); cy.animate({ zoom: { level, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }, duration: 150 })
  }
  const BTN = { fontSize: 12, padding: '4px 10px' }
  return (
    <div style={{ position: 'relative' }}>
      <div ref={holder} style={{ width: '100%', height: '68vh', minHeight: 420, background: '#fbfcfe', border: '1px solid #e3e8ef', borderRadius: 8 }} />
      <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', gap: 6 }}>
        <button className="btn ghost" style={BTN} title="放大" onClick={() => zoomBy(1.25)}>＋</button>
        <button className="btn ghost" style={BTN} title="缩小" onClick={() => zoomBy(0.8)}>－</button>
        <button className="btn ghost" style={BTN} onClick={() => { localStorage.removeItem('onto-graph-pos'); setLayoutGen(v => v + 1) }}>重置布局</button>
      </div>
      <span style={{ position: 'absolute', bottom: 8, right: 12, fontSize: 11, color: '#8a94a3' }}>点击域＝聚焦 · 点击空白＝复位 · 可拖动整域/单节点</span>
    </div>
  )
}

