import React, { useState, useEffect, useRef } from 'react'
import { Scenarios, Blueprints, TestRuns, Admin, Browser, Connections, Confirmations, formDataHash } from '../../services/api.js'
import { Tag, Modal } from '../../components/ui.jsx'

const OWNER = 'fde-local'
import { safeParse, SCENARIO_STATUS, EXECUTOR_TYPES } from '../../lib/constants.js'

const STATUS_TAG = { passed: 'green', test_passed: 'green', failed: 'red', test_failed: 'red', warning: 'amber', interrupted: 'amber', needs_confirmation: 'amber' }

export default function TestRunStage({ scenario, reload }) {
  const init = safeParse(scenario.contentJson, {})
  const nodes = (init.flow && init.flow.nodes) || []
  const [blueprint, setBlueprint] = useState(null)
  const [systems, setSystems] = useState([])
  const [conns, setConns] = useState([])
  const [params, setParams] = useState({})
  const [timeline, setTimeline] = useState([])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [history, setHistory] = useState([])
  const [err, setErr] = useState('')
  const [confirm, setConfirm] = useState(null)   // 增删改人工确认闸
  const unsubRef = useRef(null)

  // 返回 Promise：false=取消；{values:{idx:val}, edited}=确认
  function askConfirm(title, capability, fields) {
    return new Promise(resolve => setConfirm({ title, capability, fields, resolve }))
  }

  useEffect(() => {
    Admin.integrations().then(s => setSystems(s || [])).catch(() => {})
    Connections.list().then(c => setConns(c || [])).catch(() => {})
    Blueprints.list(scenario.id).then(l => { const b = (l || [])[0]; if (b) { setBlueprint(b); const ps = safeParse(b.contentJson, {}).inputParams || []; const init = {}; ps.forEach(p => init[p.name] = ''); setParams(init) } }).catch(() => {})
    TestRuns.list(scenario.id).then(l => setHistory(l || [])).catch(() => {})
    return () => { if (unsubRef.current) unsubRef.current() }
  }, [scenario.id])

  const inputParams = safeParse(blueprint?.contentJson, {}).inputParams || []
  const sop = blueprint?.markdownDraft || ''
  function add(ev) { setTimeline(t => [...t, ev]) }

  async function run() {
    setRunning(true); setErr(''); setTimeline([]); setResult(null)
    const events = [], diagnostics = [], tokenIds = []
    const push = (level, title, detail) => { const ev = { level, title, detail: detail || '' }; events.push(ev); add(ev) }
    let failed = false, warned = false, interrupted = false
    try {
      push('info', '开始试运行', `${nodes.length} 个节点 · 环境：本地真实执行`)
      // 浏览器执行器：实时日志流
      if (unsubRef.current) unsubRef.current()
      unsubRef.current = Browser.available() ? Browser.onLine(line => add({ level: 'info', title: '·', detail: line })) : null

      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i], t = n.executorType, ex = n.executor || {}
        if (interrupted) { push('warning', `跳过 ${n.title}`, '前序节点中断'); continue }
        if (!t) { push('info', `${n.title}`, '无执行器，跳过'); continue }
        push('info', `▶ ${n.title}`, EXECUTOR_TYPES[t]?.label || t)

        if (t === 'browser_automation') {
          const steps = ex.steps || []
          if (!steps.length) { push('warning', `${n.title} 未绑定动作`, '该浏览器节点未引用连接器动作，跳过'); warned = true; continue }
          if (!Browser.available()) { push('warning', `${n.title}`, '浏览器执行器需桌面端，跳过'); warned = true; continue }
          // 连接预检（§7.5）：只允许 verified 连接执行
          if (ex.connectionId) {
            const conn = conns.find(c => c.id === ex.connectionId)
            if (!conn || conn.status !== 'verified') { push('warning', `${n.title} 连接未验证`, '绑定连接非 verified 状态，跳过；请到系统连接重新验证'); warned = true; interrupted = true; continue }
          }
          // 增删改人工确认闸（§12）+ 一次性签名确认令牌（§12.6）
          let runSteps = steps
          if (['create', 'update', 'delete', 'batch'].includes(ex.capability)) {
            const fields = steps.map((s, idx) => ({ idx, act: s.act, label: s.label, value: s.value })).filter(f => ['fill', 'select', 'search'].includes(f.act))
            push('warning', `${n.title} 待人工确认`, `写操作（${ex.capability}）需确认表单并签发令牌后提交`)
            const res = await askConfirm(n.title, ex.capability, fields)
            if (!res) { push('warning', `${n.title} 已取消`, '用户取消了写操作'); warned = true; interrupted = true; continue }
            if (res.edited) runSteps = steps.map((s, idx) => res.values[idx] !== undefined ? { ...s, value: res.values[idx] } : s)
            // 计算最终表单摘要（明文不出本地）→ 策略服务签发一次性令牌 → 执行前校验并消费
            const formObj = {}; fields.forEach(f => { formObj[f.label || ('f' + f.idx)] = res.values[f.idx] !== undefined ? res.values[f.idx] : f.value })
            try {
              const fdh = await formDataHash(formObj)
              const token = await Confirmations.issue({ userId: OWNER, connectionId: ex.connectionId, actionId: ex.actionId, skillId: blueprint?.id || '', capability: ex.capability, formDataHash: fdh })
              const cr = await Confirmations.consume(token.id, { userId: OWNER, connectionId: ex.connectionId, actionId: ex.actionId, formDataHash: fdh })
              if (!cr || !cr.ok) { push('error', `${n.title} 令牌校验失败`, (cr && cr.reason) || '令牌无效'); failed = true; interrupted = true; continue }
              tokenIds.push(token.id)
              push('success', `${n.title} 确认令牌已校验消费`, `令牌 ${token.id} · 一次性 · 5 分钟有效`)
            } catch (e) { push('error', `${n.title} 令牌签发/校验异常`, e.message); failed = true; interrupted = true; continue }
          }
          const sys = systems.find(s => s.id === ex.systemId) || {}
          const r = await Browser.dryRun({ systemId: ex.systemId, baseUrl: sys.baseUrl, systemName: sys.name, steps: runSteps, fieldValues: params, sop, adminBaseUrl: undefined })
          if (r && r.loggedIn === false) { push('warning', `${n.title} 需登录`, '请在试运行窗口登录目标系统后重试'); warned = true; interrupted = true; continue }
          if (!r || r.failedAt >= 0) {
            failed = true; interrupted = true
            const d = { category: 'selector_failure', severity: 'high', title: `${n.title} 第 ${(r?.failedAt ?? 0) + 1} 步失败`, detail: (r && (r.failLabel || r.error)) || '执行未完成', suggestion: '检查录制是否最新、目标控件是否变化，或在执行编排重新录制。' }
            diagnostics.push(d); push('error', d.title, d.detail)
          } else { push('success', `${n.title} 完成`, `执行 ${r.done}/${r.total} 步`) }
        } else if (t === 'knowledge_lookup') {
          try { const res = await Admin.knowledgeQuery(ex.query || scenario.name); const hits = Array.isArray(res) ? res.length : (res?.results?.length ?? res?.documents?.length ?? 0); push('success', `${n.title} 完成`, `知识检索命中 ${hits} 条`) }
          catch (e) { push('warning', `${n.title}`, '知识检索失败：' + e.message); warned = true }
        } else if (t === 'human_confirmation') {
          push('success', `${n.title}（人工确认）`, '试运行环境模拟确认通过：' + (ex.confirmPrompt || '确认无误'))
        } else if (t === 'notification') {
          push('success', `${n.title}（通知）`, '模拟发送：' + (ex.message || '通知内容'))
        } else {
          push('success', `${n.title}（模拟）`, `${EXECUTOR_TYPES[t]?.label || t} 执行器第一版以模拟方式通过`)
        }
      }
      const status = failed ? 'failed' : (warned ? 'warning' : 'passed')
      push(status === 'passed' ? 'success' : (status === 'failed' ? 'error' : 'warning'), '试运行结束', status === 'passed' ? '全部节点通过' : (status === 'failed' ? '存在失败节点' : '存在告警/跳过'))

      // 落库试运行记录 + 推进场景状态
      const run = await TestRuns.create({ scenarioId: scenario.id, blueprintId: blueprint?.id || '', status, environment: 'local', contentJson: JSON.stringify({ events, diagnostics, params, confirmationTokens: tokenIds }) })
      setResult({ status, diagnostics })
      setHistory(h => [run, ...h])
      const scStatus = status === 'passed' ? 'test_passed' : (status === 'failed' ? 'test_failed' : scenario.status)
      const cur = SCENARIO_STATUS[scenario.status]?.step ?? 0
      const next = (SCENARIO_STATUS[scStatus]?.step ?? 0) >= cur ? scStatus : scenario.status
      await Scenarios.update(scenario.id, { ...scenario, status: next })
      await reload()
    } catch (e) { setErr(e.message || '试运行异常'); push('error', '试运行异常', e.message) }
    finally {
      if (unsubRef.current) { unsubRef.current(); unsubRef.current = null }
      if (Browser.available()) Browser.dryRunClose().catch(() => {})
      setRunning(false)
    }
  }

  if (!nodes.length) return <div className="hint">请先完成「② 流程建模」与「④ 执行编排」，再进行试运行。</div>
  const hasBrowser = nodes.some(n => n.executorType === 'browser_automation' && (n.executor?.steps || []).length)

  return (
    <div className="grid" style={{ gap: 16 }}>
      {err && <div className="err">{err}</div>}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: inputParams.length ? 12 : 0 }}>
          <b>试运行（样例数据 · 真实执行）</b>
          <button className="primary" disabled={running} onClick={run}>{running ? '运行中…' : '开始试运行'}</button>
        </div>
        {inputParams.length > 0 && (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 10 }}>
            {inputParams.map(p => (
              <div key={p.name}><label className="fl">{p.label || p.name}</label>
                <input value={params[p.name] || ''} onChange={e => setParams({ ...params, [p.name]: e.target.value })} placeholder={p.description || ''} /></div>
            ))}
          </div>
        )}
        {!hasBrowser && <div className="hint" style={{ marginTop: 10 }}>当前没有已录制的浏览器节点；非浏览器执行器第一版以模拟方式参与。要跑真实浏览器，请到「④ 执行编排」为浏览器节点录制操作。</div>}
      </div>

      {(timeline.length > 0 || result) && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <b>执行时间线</b>
            {result && <Tag kind={STATUS_TAG[result.status]}>{result.status === 'passed' ? '通过' : result.status === 'failed' ? '失败' : '告警'}</Tag>}
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, lineHeight: 1.8 }}>
            {timeline.map((e, i) => (
              <div key={i} style={{ color: e.level === 'error' ? '#dc2626' : e.level === 'success' ? 'var(--brand-d)' : e.level === 'warning' ? '#d97706' : 'var(--sec)' }}>
                {e.title === '·' ? <span className="muted">{e.detail}</span> : <><b>{e.title}</b>{e.detail ? ' — ' + e.detail : ''}</>}
              </div>
            ))}
          </div>
        </div>
      )}

      {result && result.diagnostics.length > 0 && (
        <div className="card">
          <b>诊断与修正建议</b>
          <div className="grid" style={{ gap: 8, marginTop: 10 }}>
            {result.diagnostics.map((d, i) => (
              <div key={i} style={{ border: '1px solid #fecaca', background: '#fef2f2', borderRadius: 8, padding: 10 }}>
                <div style={{ fontWeight: 600, color: '#dc2626' }}>⚠ {d.title}</div>
                <div className="sec" style={{ margin: '4px 0' }}>{d.detail}</div>
                <div style={{ fontSize: 12 }}>建议：{d.suggestion}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="card">
          <b>试运行历史（{history.length}）</b>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>时间</th><th>环境</th><th>结果</th></tr></thead>
            <tbody>{history.map(h => (
              <tr key={h.id}><td className="sec">{(h.startedAt || h.createdAt || '').replace('T', ' ').slice(0, 19)}</td><td className="sec">{h.environment}</td>
                <td><Tag kind={STATUS_TAG[h.status]}>{h.status}</Tag></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {result && result.status === 'passed' && <div className="hint">试运行通过！下一步到「⑥ 交付上架」生成交付包并提交到企业技能中心。</div>}

      {confirm && <ConfirmGate confirm={confirm} onClose={(r) => { confirm.resolve(r); setConfirm(null) }} />}
    </div>
  )
}

const CAP_NAME = { create: '新增', update: '修改', delete: '删除', batch: '批量' }

// 增删改人工确认闸：回显可编辑表单，确认后才提交（编辑会覆盖回放值）
function ConfirmGate({ confirm, onClose }) {
  const [vals, setVals] = useState({})
  const { title, capability, fields } = confirm
  const dangerous = capability === 'delete' || capability === 'batch'
  return (
    <Modal title={`人工确认 · ${CAP_NAME[capability] || capability}操作`} onClose={() => onClose(false)}>
      <div className="hint" style={dangerous ? { background: '#FEF2F2', borderColor: '#FCA5A5', color: '#DC2626' } : null}>
        即将在目标系统执行「{title}」（{CAP_NAME[capability] || capability}）。请核对下列内容，可修改后再确认提交。{dangerous ? '该操作风险较高，请谨慎。' : ''}
      </div>
      <div className="grid" style={{ gap: 10, margin: '14px 0' }}>
        {fields.length === 0 ? <div className="sec">该动作无表单字段，确认即提交。</div> : fields.map(f => (
          <div key={f.idx}>
            <label className="fl">{f.label || '字段'}</label>
            <input value={vals[f.idx] !== undefined ? vals[f.idx] : (f.value || '')} onChange={e => setVals({ ...vals, [f.idx]: e.target.value })} />
          </div>
        ))}
      </div>
      <div className="actions">
        <button onClick={() => onClose(false)}>取消</button>
        <button className="primary" onClick={() => onClose({ values: vals, edited: Object.keys(vals).length > 0 })}>确认并提交</button>
      </div>
    </Modal>
  )
}
