import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Scenarios, Connections, ConnectorActions } from '../../services/api.js'
import { Tag } from '../../components/ui.jsx'
import { safeParse, SCENARIO_STATUS, NODE_TYPES, EXECUTOR_TYPES } from '../../lib/constants.js'

const OWNER = 'fde-local'
const CAP_LABEL = { read: '查询', create: '新增', update: '修改', delete: '删除', batch: '批量' }

export default function Orchestrate({ scenario, reload }) {
  const init = safeParse(scenario.contentJson, {})
  const nav = useNavigate()
  const [nodes, setNodes] = useState((init.flow && init.flow.nodes) || [])
  const [conns, setConns] = useState([])
  const [actions, setActions] = useState([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const note = (m) => { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 3000) }
  const fail = (e) => setErr(typeof e === 'string' ? e : (e.message || '操作失败'))

  useEffect(() => {
    Connections.list().then(c => setConns((c || []).filter(x => x.ownerUserId === OWNER))).catch(() => {})
    ConnectorActions.list().then(a => setActions(a || [])).catch(() => {})
  }, [])

  const setNode = (i, patch) => setNodes(nodes.map((n, j) => j === i ? { ...n, ...patch } : n))
  const setExec = (i, patch) => setNodes(nodes.map((n, j) => j === i ? { ...n, executor: { ...(n.executor || {}), ...patch } } : n))
  const verifiedConns = conns.filter(c => c.status === 'verified')

  async function save() {
    setBusy('save'); setErr('')
    try {
      const content = { ...init, flow: { nodes } }
      const cur = SCENARIO_STATUS[scenario.status]?.step ?? 0
      const status = (SCENARIO_STATUS.orchestrated.step > cur) ? 'orchestrated' : scenario.status
      await Scenarios.update(scenario.id, { ...scenario, contentJson: JSON.stringify(content), status })
      await reload(); note('编排已保存，状态 → 已编排')
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  if (!nodes.length) return <div className="hint">请先到「② 流程建模」生成并保存流程，再为各节点绑定执行器。</div>

  return (
    <div className="grid" style={{ gap: 16 }}>
      {(msg || err) && <div className={err ? 'err' : 'ok'}>{err || msg}</div>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b>执行编排 — 为每个流程节点绑定执行器</b>
          <button disabled={busy} onClick={save}>{busy === 'save' ? '保存中…' : '保存编排'}</button>
        </div>
        <div className="sec" style={{ fontSize: 12, marginTop: 6 }}>浏览器节点引用「连接器动作」（在<a style={{ color: 'var(--brand-d)', cursor: 'pointer' }} onClick={() => nav('/connections')}>系统连接</a>页录制），只有已验证连接的动作可用。</div>
      </div>

      {nodes.map((n, i) => (
        <div key={n.id || i} className="card">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <span className="tag gray">{i + 1}</span>
            <b>{n.title}</b>
            <span className="tag">{NODE_TYPES[n.type] || n.type}</span>
            <select style={{ width: 180, marginLeft: 'auto' }} value={n.executorType || ''} onChange={e => setNode(i, { executorType: e.target.value })}>
              <option value="">（无执行器）</option>
              {Object.entries(EXECUTOR_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            {n.executorType && <Tag kind={EXECUTOR_TYPES[n.executorType]?.real ? 'green' : 'gray'}>{EXECUTOR_TYPES[n.executorType]?.real ? '真执行' : '打桩'}</Tag>}
          </div>
          <ExecutorConfig n={n} i={i} verifiedConns={verifiedConns} actions={actions} setExec={setExec} nav={nav} />
        </div>
      ))}
    </div>
  )
}

function ExecutorConfig({ n, i, verifiedConns, actions, setExec, nav }) {
  const t = n.executorType, ex = n.executor || {}
  if (t === 'browser_automation') {
    if (verifiedConns.length === 0) {
      return <div className="hint">还没有已验证的业务系统连接。请先到<a style={{ color: 'var(--brand-d)', cursor: 'pointer' }} onClick={() => nav('/connections')}>系统连接</a>页完成本地登录验证并录制动作。</div>
    }
    const conn = verifiedConns.find(c => c.id === ex.connectionId) || null
    const sysActions = conn ? actions.filter(a => a.systemId === conn.systemId) : []
    return (
      <div className="grid" style={{ gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="fl" style={{ margin: 0 }}>已验证连接</label>
          <select style={{ width: 220 }} value={ex.connectionId || ''} onChange={e => setExec(i, { connectionId: e.target.value, systemId: verifiedConns.find(c => c.id === e.target.value)?.systemId, actionId: '', steps: [] })}>
            <option value="">请选择…</option>
            {verifiedConns.map(c => <option key={c.id} value={c.id}>{c.systemId}（{(c.capabilities || []).map(k => CAP_LABEL[k] || k).join('/')}）</option>)}
          </select>
          {conn && <>
            <label className="fl" style={{ margin: 0 }}>连接器动作</label>
            <select style={{ width: 220 }} value={ex.actionId || ''} onChange={e => {
              const a = sysActions.find(x => x.id === e.target.value)
              const ir = a ? safeParse(a.irJson, null) : null
              const irInputs = (ir && ir.inputs) || []
              const paramMap = {}; irInputs.forEach(inp => { if (inp.fromStep != null) paramMap[inp.fromStep] = inp.name })
              setExec(i, { actionId: e.target.value, capability: a?.capability, steps: a ? safeParse(a.stepsJson, []) : [], paramMap, irInputs })
            }}>
              <option value="">请选择…</option>
              {sysActions.map(a => <option key={a.id} value={a.id}>{a.name}（{CAP_LABEL[a.capability] || a.capability}）</option>)}
            </select>
          </>}
        </div>
        {conn && sysActions.length === 0 && <div className="hint">该连接还没有动作。到<a style={{ color: 'var(--brand-d)', cursor: 'pointer' }} onClick={() => nav('/connections')}>系统连接</a>页「录制新动作」。</div>}
        {ex.actionId && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Tag kind={['create', 'update', 'delete', 'batch'].includes(ex.capability) ? 'amber' : 'green'}>{CAP_LABEL[ex.capability] || ex.capability}</Tag>
          <Tag kind={(ex.steps || []).length ? 'green' : 'gray'}>{(ex.steps || []).length} 步</Tag>
          {(ex.irInputs || []).length > 0 && <Tag kind="green">{ex.irInputs.length} 入参（参数化）</Tag>}
          {['create', 'update', 'delete', 'batch'].includes(ex.capability) && <span className="sec" style={{ fontSize: 12 }}>写操作 · 试运行时需人工确认</span>}
        </div>}
      </div>
    )
  }
  if (t === 'human_confirmation') return <Cfg label="确认提示语" value={ex.confirmPrompt} onChange={v => setExec(i, { confirmPrompt: v })} ph="如：请确认拜访记录内容无误后提交" real />
  if (t === 'knowledge_lookup') return <Cfg label="检索关键词 / 问题" value={ex.query} onChange={v => setExec(i, { query: v })} ph="如：客户拜访记录填写规范" />
  if (t === 'notification') return <Cfg label="通知内容" value={ex.message} onChange={v => setExec(i, { message: v })} ph="如：拜访记录已更新，请知悉" />
  if (!t) return <div className="sec" style={{ fontSize: 12 }}>未指定执行器，试运行时将跳过。</div>
  return <div className="hint">「{EXECUTOR_TYPES[t]?.label}」执行器第一版以模拟方式参与试运行（打桩），后续接真实能力。</div>
}

function Cfg({ label, value, onChange, ph, real }) {
  return (
    <div>
      <label className="fl">{label} {!real && <span className="sec">（第一版模拟）</span>}</label>
      <input value={value || ''} onChange={e => onChange(e.target.value)} placeholder={ph} />
    </div>
  )
}
