import React, { useState, useEffect, useRef } from 'react'
import { Admin, Browser, SkillCenter, getBaseUrl } from '../services/api.js'
import { PageHeader, Tag } from '../components/ui.jsx'

// 快速建技能：录制 → 命名 → 试运行 → 提交技能中心，一步到位（不强制走完整场景生产线）
const ACT_LABEL = { click: '点击', fill: '填写', select: '选择', search: '搜索选择', pickOption: '选项', hover: '悬停' }

function readable(steps) {
  return (steps || []).map(s => {
    const v = s.value ? ` = "${String(s.value).replace(/"/g, '')}"` : ''
    return `${s.act} "${s.label || ''}"${v}`
  }).join('\n')
}

export default function QuickSkill() {
  const [systems, setSystems] = useState([])
  const [systemId, setSystemId] = useState('')
  const [recording, setRecording] = useState(false)
  const [recCount, setRecCount] = useState(0)
  const [steps, setSteps] = useState([])
  const [name, setName] = useState('')
  const [keywords, setKeywords] = useState('')
  const [sop, setSop] = useState('')
  const [lines, setLines] = useState([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const [skillId, setSkillId] = useState('')
  const stepUnsub = useRef(null), lineUnsub = useRef(null)
  const note = (m) => { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 3000) }
  const fail = (e) => setErr(typeof e === 'string' ? e : (e.message || '操作失败'))
  const sys = () => systems.find(s => s.id === systemId)

  useEffect(() => {
    Admin.integrations().then(s => { setSystems(s || []); if (s && s[0]) setSystemId(s[0].id) }).catch(() => {})
    return () => { if (stepUnsub.current) stepUnsub.current(); if (lineUnsub.current) lineUnsub.current() }
  }, [])

  async function startRec() {
    const s = sys(); if (!s) return fail('请先选择目标业务系统（管理端「业务系统连接」中配置）')
    if (!Browser.available()) return fail('录制需在桌面端运行')
    setBusy('rec'); setErr(''); setRecCount(0); setSkillId('')
    try {
      if (stepUnsub.current) stepUnsub.current()
      stepUnsub.current = Browser.onStep(() => setRecCount(c => c + 1))
      const r = await Browser.recorderStart({ systemId: s.id, baseUrl: s.baseUrl, systemName: s.name })
      if (!r || !r.ok) throw new Error((r && r.error) || '无法启动录制（需已装 Chrome）')
      setRecording(true); setSteps([])
      note('录制已开始：在弹出的 Chrome 中登录并完整操作一遍，然后回来点「结束录制」')
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  async function stopRec() {
    setBusy('rec')
    try {
      const r = await Browser.recorderStop()
      if (stepUnsub.current) { stepUnsub.current(); stepUnsub.current = null }
      setRecording(false)
      const st = (r && r.steps) || []
      setSteps(st)
      if (!name && sys()) setName(sys().name + ' 操作技能')
      note(`录制完成，捕获 ${st.length} 步`)
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  async function cancelRec() { try { await Browser.recorderCancel() } catch (_) {} if (stepUnsub.current) { stepUnsub.current(); stepUnsub.current = null } setRecording(false) }

  async function genSop() {
    if (!steps.length) return fail('请先录制')
    setBusy('sop'); setErr('')
    try {
      const r = await Browser.genSop({ adminBaseUrl: getBaseUrl(), name: name || '录制技能', script: readable(steps), fields: [], engine: 'browser' })
      if (!r || !r.ok) throw new Error((r && r.error) || 'SOP 生成失败')
      setSop(r.sop || ''); note('已生成 SOP，可编辑')
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  async function dryRun() {
    if (!steps.length) return fail('请先录制')
    const s = sys(); setBusy('dry'); setErr(''); setLines([])
    try {
      if (lineUnsub.current) lineUnsub.current()
      lineUnsub.current = Browser.onLine(l => setLines(prev => [...prev, l]))
      const r = await Browser.dryRun({ systemId: s.id, baseUrl: s.baseUrl, systemName: s.name, steps, fieldValues: {}, sop, adminBaseUrl: getBaseUrl() })
      if (lineUnsub.current) { lineUnsub.current(); lineUnsub.current = null }
      if (r && r.loggedIn === false) note('试运行窗口未登录，请登录后重试')
      else if (!r || r.failedAt >= 0) fail(`试运行中断于第 ${(r?.failedAt ?? 0) + 1} 步：${(r && (r.failLabel || r.error)) || '未完成'}`)
      else note(`试运行通过：${r.done}/${r.total} 步`)
    } catch (e) { fail(e) } finally { setBusy(''); if (Browser.available()) Browser.dryRunClose().catch(() => {}) }
  }

  async function submit() {
    if (!steps.length) return fail('请先录制')
    if (!name.trim()) return fail('请填写技能名称')
    setBusy('submit'); setErr('')
    try {
      const res = await SkillCenter.fromRecording({
        name: name.trim(),
        triggerKeywords: keywords.split(/[，,\s]+/).map(s => s.trim()).filter(Boolean),
        targetSystemId: systemId, steps, fields: [], engine: 'browser', sop
      })
      const id = res?.id || res?.skill?.id || ''
      setSkillId(id); note('已提交到企业技能中心' + (id ? `（技能 ${id}）` : ''))
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  return (
    <>
      <PageHeader title="快速建技能" desc="录制目标系统操作，直接构建并上架技能（适合简单技能；复杂场景走完整生产线）" />
      <div className="content grid" style={{ gap: 16, maxWidth: 920 }}>
        <div className="hint">简单模式：一次录制直接产出一条整脚本技能（不拆分可复用连接器动作）。适合规则简单、单系统的技能；涉及增删改、需复用、需治理的复杂场景，请走「场景库」完整生产线。</div>
        {(msg || err) && <div className={err ? 'err' : 'ok'}>{err || msg}</div>}

        {/* 1. 录制 */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <b>1 · 录制操作</b>
            <Tag kind={steps.length ? 'green' : 'gray'}>{steps.length ? `已录制 ${steps.length} 步` : '未录制'}</Tag>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label className="fl" style={{ margin: 0 }}>目标系统</label>
            <select style={{ width: 280 }} value={systemId} onChange={e => setSystemId(e.target.value)} disabled={recording}>
              {systems.length === 0 && <option value="">（管理端未配置业务系统）</option>}
              {systems.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {!recording
              ? <button className="primary" disabled={busy} onClick={startRec}>开始录制（真实 Chrome）</button>
              : <>
                <span style={{ color: '#dc2626', display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#dc2626', display: 'inline-block' }} />录制中 · {recCount} 步</span>
                <button className="primary" disabled={busy} onClick={stopRec}>结束录制</button>
                <button disabled={busy} onClick={cancelRec}>取消</button>
              </>}
          </div>
          {steps.length > 0 && (
            <div style={{ marginTop: 12, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
              {steps.map((s, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0' }}>
                  <span className="muted" style={{ width: 18 }}>{i + 1}</span>
                  <span className="tag gray" style={{ minWidth: 44, textAlign: 'center' }}>{ACT_LABEL[s.act] || s.act}</span>
                  <span>{s.label}{s.value ? <span className="sec"> = {s.value}</span> : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 2. 命名 + SOP */}
        <div className="card grid" style={{ gap: 4 }}>
          <b style={{ marginBottom: 8 }}>2 · 技能信息</b>
          <div className="row">
            <div><label className="fl">技能名称</label><input value={name} onChange={e => setName(e.target.value)} placeholder="如：纷享销客客户拜访录入" /></div>
            <div><label className="fl">触发词（逗号分隔）</label><input value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="客户拜访, 拜访录入" /></div>
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label className="fl" style={{ margin: 0 }}>SOP（可选，提交时随技能保存）</label>
              <button className="ghost" disabled={busy || !steps.length} onClick={genSop}>{busy === 'sop' ? '生成中…' : 'AI 生成 SOP'}</button>
            </div>
            <textarea rows={6} value={sop} onChange={e => setSop(e.target.value)} placeholder="可留空，提交时后端会按录制步骤自动生成" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }} />
          </div>
        </div>

        {/* 3. 试运行 + 提交 */}
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: lines.length ? 12 : 0 }}>
            <b>3 · 试运行 & 上架</b>
            <div style={{ display: 'flex', gap: 8 }}>
              <button disabled={busy || !steps.length} onClick={dryRun}>{busy === 'dry' ? '运行中…' : '试运行（可见浏览器）'}</button>
              <button className="primary" disabled={busy || !steps.length} onClick={submit}>{busy === 'submit' ? '提交中…' : '提交到企业技能中心'}</button>
            </div>
          </div>
          {lines.length > 0 && (
            <div style={{ maxHeight: 240, overflowY: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, lineHeight: 1.8, color: 'var(--sec)' }}>
              {lines.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
          {skillId && <div className="ok" style={{ marginTop: 10 }}>✓ 已上架，技能中心 ID：{skillId}</div>}
        </div>

        {!Browser.available() && <div className="hint">当前为浏览器预览，录制/试运行需在桌面端运行。</div>}
      </div>
    </>
  )
}
