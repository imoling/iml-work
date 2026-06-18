import React, { useState } from 'react'
import { Scenarios } from '../../services/api.js'
import { Tag } from '../../components/ui.jsx'
import { safeParse, SCENARIO_STATUS, NODE_TYPES, EXECUTOR_TYPES } from '../../lib/constants.js'
import { generateFlow } from '../../lib/ai.js'

export default function FlowModel({ scenario, reload }) {
  const init = safeParse(scenario.contentJson, {})
  const facts = init.facts
  const [nodes, setNodes] = useState((init.flow && init.flow.nodes) || [])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const note = (m) => { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 2500) }
  const fail = (e) => setErr(typeof e === 'string' ? e : (e.message || '操作失败'))

  const upd = (i, k, v) => setNodes(nodes.map((n, j) => j === i ? { ...n, [k]: v } : n))
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= nodes.length) return; const a = [...nodes];[a[i], a[j]] = [a[j], a[i]]; setNodes(a) }
  const remove = (i) => setNodes(nodes.filter((_, j) => j !== i))
  const add = () => setNodes([...nodes, { id: 'n' + (nodes.length + 1), type: 'system_action', title: '新节点', goal: '', executorType: 'browser_automation', requiresHumanConfirmation: false, isSensitiveAction: false }])

  async function onGen() {
    if (!facts) return fail('请先在「素材采集」完成场景要素抽取')
    setBusy('gen'); setErr('')
    try { const ns = await generateFlow(scenario, facts); if (!ns) throw new Error('AI 未返回有效流程'); setNodes(ns); note('已生成流程，请核对调整') }
    catch (e) { fail(e) } finally { setBusy('') }
  }
  async function save() {
    setBusy('save'); setErr('')
    try {
      const content = { ...init, flow: { nodes } }
      const cur = SCENARIO_STATUS[scenario.status]?.step ?? 0
      const status = (SCENARIO_STATUS.modeled.step > cur) ? 'modeled' : scenario.status
      await Scenarios.update(scenario.id, { ...scenario, contentJson: JSON.stringify(content), status })
      await reload(); note('流程已保存，状态 → 已建模')
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  const checks = qualityChecks(nodes)

  return (
    <div className="grid" style={{ gap: 16 }}>
      {(msg || err) && <div className={err ? 'err' : 'ok'}>{err || msg}</div>}
      {!facts && <div className="hint">建议先到「① 素材采集」完成要素抽取，AI 才能据此生成流程。</div>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <b>流程节点（{nodes.length}）</b>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="primary" disabled={busy} onClick={onGen}>{busy === 'gen' ? 'AI 生成中…' : 'AI 生成流程'}</button>
            <button disabled={busy} onClick={add}>+ 节点</button>
            <button disabled={busy || !nodes.length} onClick={save}>{busy === 'save' ? '保存中…' : '保存流程'}</button>
          </div>
        </div>
        {nodes.length === 0 ? <div className="empty">还没有流程节点。点「AI 生成流程」从场景要素自动拆解，或手动添加。</div> : (
          <div className="grid" style={{ gap: 10 }}>
            {nodes.map((n, i) => (
              <NodeCard key={n.id || i} n={n} i={i} last={i === nodes.length - 1} upd={upd} move={move} remove={remove} />
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <b>流程质量检查</b>
        <div style={{ marginTop: 10 }}>
          {checks.length === 0 ? <div className="ok">✓ 未发现明显问题（起止完整、敏感动作均有人工确认、系统操作均已指定执行器）。</div> : (
            <div className="grid" style={{ gap: 6 }}>
              {checks.map((c, i) => <div key={i} className="sec">⚠ {c}</div>)}
            </div>
          )}
        </div>
      </div>

      {nodes.length > 0 && <div className="hint">流程就绪后到「③ SKILL 蓝图」生成技能蓝图与 SKILL.md 草案。</div>}
    </div>
  )
}

function NodeCard({ n, i, last, upd, move, remove }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <span className="tag gray">{i + 1}</span>
        <input style={{ flex: 2 }} value={n.title || ''} onChange={e => upd(i, 'title', e.target.value)} placeholder="节点名称" />
        <select style={{ flex: 1 }} value={n.type} onChange={e => upd(i, 'type', e.target.value)}>
          {Object.entries(NODE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select style={{ flex: 1 }} value={n.executorType || ''} onChange={e => upd(i, 'executorType', e.target.value)}>
          <option value="">（无执行器）</option>
          {Object.entries(EXECUTOR_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <button className="ghost" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
        <button className="ghost" disabled={last} onClick={() => move(i, 1)}>↓</button>
        <button className="ghost danger" onClick={() => remove(i)}>×</button>
      </div>
      <input value={n.goal || ''} onChange={e => upd(i, 'goal', e.target.value)} placeholder="该步目标" style={{ marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
        <label style={{ display: 'flex', gap: 5, alignItems: 'center', color: 'var(--sec)' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!n.isSensitiveAction} onChange={e => upd(i, 'isSensitiveAction', e.target.checked)} />风险动作
        </label>
        <label style={{ display: 'flex', gap: 5, alignItems: 'center', color: 'var(--sec)' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={!!n.requiresHumanConfirmation} onChange={e => upd(i, 'requiresHumanConfirmation', e.target.checked)} />需人工确认
        </label>
        {n.executorType && <Tag kind={EXECUTOR_TYPES[n.executorType]?.real ? 'green' : 'gray'}>{EXECUTOR_TYPES[n.executorType]?.real ? '真执行' : '打桩'}</Tag>}
      </div>
    </div>
  )
}

function qualityChecks(nodes) {
  const w = []
  if (!nodes.length) return w
  if (!nodes.some(n => n.type === 'start')) w.push('缺少开始节点（start）')
  if (!nodes.some(n => n.type === 'end')) w.push('缺少结束节点（end）')
  nodes.forEach((n, i) => {
    if (n.isSensitiveAction) {
      const selfOk = n.requiresHumanConfirmation || n.type === 'human_confirm'
      const nextOk = nodes[i + 1] && nodes[i + 1].type === 'human_confirm'
      if (!selfOk && !nextOk) w.push(`「${n.title}」是风险动作，但缺少人工确认`)
    }
    if (['system_action', 'data_extract', 'file_generate'].includes(n.type) && !n.executorType) w.push(`「${n.title}」未指定执行器`)
  })
  if (!nodes.some(n => n.type === 'exception')) w.push('未定义异常处理分支（建议补充 exception 节点）')
  return w
}
