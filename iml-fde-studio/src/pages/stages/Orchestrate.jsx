import React, { useState, useEffect, useRef } from 'react'
import { Scenarios, Admin, Browser } from '../../services/api.js'
import { Tag } from '../../components/ui.jsx'
import { safeParse, SCENARIO_STATUS, NODE_TYPES, EXECUTOR_TYPES } from '../../lib/constants.js'

export default function Orchestrate({ scenario, reload }) {
  const init = safeParse(scenario.contentJson, {})
  const [nodes, setNodes] = useState((init.flow && init.flow.nodes) || [])
  const [systems, setSystems] = useState([])
  const [recId, setRecId] = useState(null)   // 正在录制的节点 id
  const [recCount, setRecCount] = useState(0)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const unsubRef = useRef(null)
  const note = (m) => { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 3000) }
  const fail = (e) => setErr(typeof e === 'string' ? e : (e.message || '操作失败'))

  useEffect(() => { Admin.integrations().then(s => setSystems(s || [])).catch(() => {}) }, [])
  useEffect(() => () => { if (unsubRef.current) unsubRef.current() }, [])

  const setNode = (i, patch) => setNodes(nodes.map((n, j) => j === i ? { ...n, ...patch } : n))
  const setExec = (i, patch) => setNodes(nodes.map((n, j) => j === i ? { ...n, executor: { ...(n.executor || {}), ...patch } } : n))

  async function startRec(i) {
    const n = nodes[i]; const sysId = (n.executor && n.executor.systemId) || (systems[0] && systems[0].id)
    const sys = systems.find(s => s.id === sysId)
    if (!sys) return fail('请先选择目标业务系统（管理端「业务系统连接」中配置）')
    setBusy('rec'); setErr('')
    try {
      if (unsubRef.current) unsubRef.current()
      setRecCount(0)
      unsubRef.current = Browser.onStep(() => setRecCount(c => c + 1))
      const r = await Browser.recorderStart({ systemId: sys.id, baseUrl: sys.baseUrl, systemName: sys.name })
      if (!r || !r.ok) throw new Error((r && r.error) || '无法启动录制（需桌面端 + 已装 Chrome）')
      setExec(i, { systemId: sys.id }); setRecId(n.id)
      note('录制已开始：在弹出的 Chrome 中登录并完成一遍操作，然后回来点「结束录制」')
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  async function stopRec(i) {
    setBusy('rec')
    try {
      const r = await Browser.recorderStop()
      if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
      setRecId(null)
      const steps = (r && r.steps) || []
      setExec(i, { steps }); note(`录制完成，捕获 ${steps.length} 步`)
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  async function cancelRec() { try { await Browser.recorderCancel() } catch (_) {} if (unsubRef.current) { unsubRef.current(); unsubRef.current = null } setRecId(null) }

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
      {!Browser.available() && <div className="hint">当前为浏览器预览，录制/试运行需在桌面端运行。</div>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b>执行编排 — 为每个流程节点绑定执行器</b>
          <button disabled={busy || !!recId} onClick={save}>{busy === 'save' ? '保存中…' : '保存编排'}</button>
        </div>
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
          <ExecutorConfig n={n} i={i} systems={systems} setExec={setExec}
            recId={recId} recCount={recCount} busy={busy} startRec={startRec} stopRec={stopRec} cancelRec={cancelRec} />
        </div>
      ))}
    </div>
  )
}

function ExecutorConfig({ n, i, systems, setExec, recId, recCount, busy, startRec, stopRec, cancelRec }) {
  const t = n.executorType, ex = n.executor || {}
  if (t === 'browser_automation') {
    const recording = recId === n.id
    return (
      <div className="grid" style={{ gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label className="fl" style={{ margin: 0 }}>目标系统</label>
          <select style={{ width: 240 }} value={ex.systemId || (systems[0] && systems[0].id) || ''} onChange={e => setExec(i, { systemId: e.target.value })} disabled={recording}>
            {systems.length === 0 && <option value="">（管理端未配置业务系统）</option>}
            {systems.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <Tag kind={(ex.steps || []).length ? 'green' : 'gray'}>{(ex.steps || []).length ? `已录制 ${ex.steps.length} 步` : '未录制'}</Tag>
        </div>
        {recording ? (
          <div className="recbar" style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'rgba(239,68,68,.06)', border: '1px solid rgba(239,68,68,.2)', borderRadius: 8, padding: '10px 12px' }}>
            <span style={{ color: '#dc2626' }}>● 录制中</span>
            <span className="sec">已捕获 {recCount} 步 — 在 Chrome 中完成操作后点结束</span>
            <button className="primary" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => stopRec(i)}>结束录制</button>
            <button disabled={busy} onClick={cancelRec}>取消</button>
          </div>
        ) : (
          <div><button className="primary" disabled={busy || !!recId} onClick={() => startRec(i)}>● 录制操作（真实 Chrome）</button></div>
        )}
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
