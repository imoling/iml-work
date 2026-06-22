import React, { useState, useEffect, useRef } from 'react'
import { Admin, Browser, SkillCenter, Connections, getBaseUrl } from '../services/api.js'
import { PageHeader, Tag } from '../components/ui.jsx'
import { setDraft, getDraft } from '../lib/draftStore.js'
import { stepsToSop } from '../lib/sop.js'

// 快速建技能：录制 → 命名 → 试运行 → 提交技能中心，一步到位（不强制走完整场景生产线）
const ACT_LABEL = { click: '点击', fill: '填写', select: '选择', search: '搜索选择', pickOption: '选项', hover: '悬停', fxPick: '选择' }
const WRITE_ACTS = ['fill', 'select', 'search', 'pickOption', 'fxPick']
// 可填字段动作（运行时可由用户参数注入；pickOption 通常是 search 的子步，不单独成字段）
const FILL_ACTS = ['fill', 'select', 'search', 'fxPick']
const actToType = (a) => a === 'select' ? 'select' : a === 'search' ? 'search' : 'text'
// 读取类/写入类、导航直达路由：从步骤派生（删除/编辑步骤后自动重算）
const deriveKind = (steps) => (steps || []).some(s => WRITE_ACTS.includes(s.act)) ? 'write' : 'read'
const deriveNav = (steps) => { const c = (steps || []).find(s => s.act === 'click' && s.nav); return c ? c.nav : '' }
// 字段 schema：从「标记为参数」的填写/选择/搜索步骤派生（step.param 为运行时字段键，label 为语义名）
const deriveFields = (steps) => {
  const out = []
  for (const s of (steps || [])) {
    if (s.param && !out.find(f => f.name === s.param)) out.push({ name: s.param, label: s.label || s.param, type: actToType(s.act) })
  }
  return out
}

// 可读脚本：标记为参数的步骤输出 {{语义名}} 占位（供后端按 schema 生成 SOP），常量步骤输出录制值
function readable(steps) {
  return (steps || []).map(s => {
    const v = s.param ? ` = {{${s.label || s.param}}}` : (s.value ? ` = "${String(s.value).replace(/"/g, '')}"` : '')
    return `${s.act} "${s.label || ''}"${v}`
  }).join('\n')
}

export default function QuickSkill() {
  // 挂载时从持久化草稿读回，返回页面不丢（避免空白覆盖）
  const d0 = getDraft() || {}
  const [systems, setSystems] = useState([])
  const [systemId, setSystemId] = useState(d0.systemId || '')
  const [recording, setRecording] = useState(false)
  const [recCount, setRecCount] = useState(0)
  const [steps, setSteps] = useState(Array.isArray(d0.steps) ? d0.steps : [])
  const [name, setName] = useState(d0.name && d0.name !== '草稿技能' ? d0.name : '')
  const [keywords, setKeywords] = useState((d0.triggerKeywords || []).join(', '))
  const [sop, setSop] = useState(d0.sop || '')
  const [directNav, setDirectNav] = useState(d0.navHash || '')
  const [lines, setLines] = useState([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('')
  const [skillId, setSkillId] = useState('')
  // 内嵌技能测试状态
  const [testPara, setTestPara] = useState('')
  const [testLines, setTestLines] = useState([])
  const [testBusy, setTestBusy] = useState(false)
  const [testVerdict, setTestVerdict] = useState(null)
  const [testErr, setTestErr] = useState('')
  const [headless, setHeadless] = useState(false)  // 无头浏览器：开=后台不弹窗
  const stepUnsub = useRef(null), lineUnsub = useRef(null), testUnsub = useRef(null)
  // SOP 是否被人工改过：改过就不再自动覆盖（草稿里已有 SOP 视为已定）
  const sopDirty = useRef(!!(d0.sop && d0.sop.trim()))
  // 从当前步骤派生（删除/标参数后实时更新）
  const skillKind = deriveKind(steps)
  const navHash = deriveNav(steps)
  const fields = deriveFields(steps)
  const fillSteps = steps.filter(s => FILL_ACTS.includes(s.act))
  const warnings = []
  if (steps.length) {
    if (skillKind === 'read' && !navHash) warnings.push('未录到「直达路由」：回放时将退回抓取系统首页。请确认录制时点到了真正的菜单项（避免占位/纯 JS 菜单）。')
    if (fillSteps.length && fields.length === 0) warnings.push(`录到 ${fillSteps.length} 个可填字段，但没有任何字段标记为「参数」。这样回放会原样重填录制时的值（如「${fillSteps[0].value || ''}」），换一条数据就失效——请把每次要变的字段切到「参数」。`)
    const unnamed = fields.filter(f => !f.label || !f.label.trim()).length
    if (unnamed) warnings.push(`有 ${unnamed} 个参数还没填「语义名」。请补全（如 拜访纪要、下一步计划），运行时会按它提炼用户的话并弹表单确认。`)
    const hovers = steps.filter(s => s.act === 'hover').length
    if (hovers) warnings.push(`含 ${hovers} 个「悬停」步骤（多为展开菜单的手势），可删除以精简、提升回放稳定性。`)
    if (steps.length === 1) warnings.push('仅录到 1 步，请确认操作是否完整。')
  }
  const deleteStep = (i) => setSteps(prev => prev.filter((_, idx) => idx !== i))
  const patchStep = (i, patch) => setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s))
  // 切换「参数 ↔ 常量」：标为参数时分配稳定字段键 p1/p2…（runAgentic 据此用 fieldValues[param] 注入）
  // 参数键用字段真实标签（与 SOP {{标签}} / 运行时提炼一致）
  const toggleParam = (i) => setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, param: s.param ? '' : (s.label || ('p' + idx)) } : s))
  const buildDraft = () => {
    const s = systems.find(x => x.id === systemId)
    // 参数清单 = 录制标注的参数 ∪ SOP 里的 {{占位}}（手写 SOP 也能定义参数，无需录制）
    const sopParams = Array.from(new Set((sop.match(/\{\{\s*([^}]+?)\s*\}\}/g) || []).map(m => m.replace(/[{}]/g, '').trim()).filter(Boolean)))
    const allFields = [...fields]
    sopParams.forEach((p, i) => { if (!allFields.find(f => (f.label || f.name) === p)) allFields.push({ name: 'sp' + i, label: p, type: 'text', required: true }) })
    return {
      name: name.trim() || (s ? s.name + ' 操作技能' : '草稿技能'),
      systemId, baseUrl: s ? s.baseUrl : '', sysName: s ? s.name : '',
      sop, fields: allFields, navHash: navHash || directNav.trim(), skillKind,
      triggerKeywords: keywords.split(/[，,、；;\s]+/).map(x => x.trim()).filter(Boolean),
      steps, stepCount: steps.length
    }
  }
  // 草稿实时自动同步到共享存储（持久化），「技能测试」页随时可测
  useEffect(() => { setDraft(buildDraft()) }, [name, keywords, systemId, sop, steps, directNav, systems])
  // 录制信息 → 自动生成 SOP（无需手点 AI）；人工改过 SOP 后不再覆盖
  useEffect(() => { if (steps.length && !sopDirty.current) setSop(stepsToSop(steps, name || (sys() ? sys().name + ' 操作技能' : '录制技能'))) }, [steps, name])

  const note = (m) => { setMsg(m); setErr(''); setTimeout(() => setMsg(''), 3000) }
  const saveDraft = () => { setDraft(buildDraft()); note('已保存草稿 → 去左侧「技能测试」发一段话测链路（无需发布）') }
  const regenSop = () => { sopDirty.current = false; setSop(stepsToSop(steps, name || (sys() ? sys().name + ' 操作技能' : '录制技能'))); note('已按录制步骤重新生成 SOP') }
  async function runTest() {
    const d = buildDraft()
    if (!Browser.available()) return setTestErr('技能测试需在桌面端运行')
    if (!d.baseUrl) return setTestErr('该技能未绑定可访问的业务系统地址，无法测试')
    if (!testPara.trim()) return setTestErr('请输入一段话（模拟用户对分身说的需求）')
    setTestBusy(true); setTestErr(''); setTestLines([]); setTestVerdict(null)
    try {
      if (testUnsub.current) testUnsub.current()
      testUnsub.current = Browser.onLine(l => setTestLines(prev => [...prev, l]))
      const r = await Browser.testSkill({ systemId: d.systemId, baseUrl: d.baseUrl, sop: d.sop, fields: d.fields, navHash: d.navHash, paragraph: testPara, adminBaseUrl: getBaseUrl(), headless })
      if (testUnsub.current) { testUnsub.current(); testUnsub.current = null }
      if (!r || r.ok === false) setTestErr((r && r.error) || '测试出错')
      else if (r.loggedIn === false) setTestVerdict({ info: '窗口未登录，请在弹出的浏览器登录后重试' })
      else setTestVerdict({ passed: r.passed, reason: r.reason, fieldValues: r.fieldValues || {}, needInput: r.needInput })
    } catch (e) { setTestErr(e.message || '测试出错') } finally { setTestBusy(false); if (Browser.available()) Browser.dryRunClose().catch(() => {}) }
  }
  const fail = (e) => setErr(typeof e === 'string' ? e : (e.message || '操作失败'))
  const sys = () => systems.find(s => s.id === systemId)

  useEffect(() => {
    // 只允许在已验证连接的系统上录制（连接器/SKILL 文档 §7.5 预检）
    Promise.all([Admin.integrations(), Connections.list()]).then(([s, c]) => {
      const verified = new Set((c || []).filter(x => x.status === 'verified' && x.ownerUserId === 'fde-local').map(x => x.systemId))
      const avail = (s || []).filter(x => verified.has(x.id))
      setSystems(avail); setSystemId(prev => prev || (avail[0] ? avail[0].id : ''))
    }).catch(() => {})
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
      // 文本/检索字段默认设为参数（不把录制的测试值焊死）；下拉默认保留录制选中的有效值
      const st = ((r && r.steps) || []).map(s => {
        const wantParam = s.act === 'fill' || s.act === 'search' || (s.act === 'fxPick' && s.kind === 'object_reference')
        return wantParam && (s.label || s.value) ? { ...s, param: s.label || s.value } : s
      })
      sopDirty.current = false   // 新录制 → 允许自动重新生成 SOP
      setSteps(st)
      const kind = (r && r.skillKind) || deriveKind(st)
      if (!name && sys()) setName(sys().name + (kind === 'read' ? ' 查看技能' : ' 操作技能'))
      note(`录制完成，捕获 ${st.length} 步（${kind === 'read' ? '读取类' : '写入类'}）`)
    } catch (e) { fail(e) } finally { setBusy('') }
  }
  async function cancelRec() { try { await Browser.recorderCancel() } catch (_) {} if (stepUnsub.current) { stepUnsub.current(); stepUnsub.current = null } setRecording(false) }

  async function genSop() {
    if (!steps.length) return fail('请先录制')
    setBusy('sop'); setErr('')
    try {
      const r = await Browser.genSop({ adminBaseUrl: getBaseUrl(), name: name || '录制技能', script: readable(steps), fields, engine: 'browser' })
      if (!r || !r.ok) throw new Error((r && r.error) || 'SOP 生成失败')
      setSop(r.sop || ''); note('已生成 SOP，可编辑')
    } catch (e) { fail(e) } finally { setBusy('') }
  }

  async function probe(mode, key, doneMsg) {
    const s = sys(); if (!s) return fail('请先选择目标业务系统')
    setBusy(key); setErr(''); setLines([])
    try {
      if (lineUnsub.current) lineUnsub.current()
      lineUnsub.current = Browser.onLine(l => setLines(prev => [...prev, l]))
      const useNav = steps.length ? navHash : directNav.trim()
      const r = await Browser.dryRun({ systemId: s.id, baseUrl: s.baseUrl, systemName: s.name, steps: [], fieldValues: {}, sop: '', adminBaseUrl: getBaseUrl(), mode, navHash: useNav, headless })
      if (lineUnsub.current) { lineUnsub.current(); lineUnsub.current = null }
      if (r && r.loggedIn === false) note('窗口未登录，请在弹出的浏览器登录后重试')
      else note(doneMsg)
    } catch (e) { fail(e) } finally { setBusy(''); if (Browser.available()) Browser.dryRunClose().catch(() => {}) }
  }
  const ariaProbe = () => probe('aria-probe', 'probe', 'ARIA 体检完成，请把日志贴给我')
  const actuateProbe = () => probe('actuate-probe', 'aprobe', '操作体检完成，请把 ①②③ 结果贴给我')
  const schemaProbe = () => probe('schema-probe', 'sprobe', '字段&选项读取完成，照"可选"锁定 SOP 取值')

  async function dryRun(mode) {
    const agent = mode === 'agentic-sop'
    if (!agent && !steps.length) return fail('请先录制')
    if (agent && !steps.length && !sop.trim()) return fail('SOP·Agent 直跑：请在 SOP 框粘贴可执行的 SOP（含具体值），并填直达路由')
    const s = sys(); if (!s) return fail('请先选择目标业务系统')
    setBusy(agent ? 'dryAgent' : 'dry'); setErr(''); setLines([])
    try {
      if (lineUnsub.current) lineUnsub.current()
      lineUnsub.current = Browser.onLine(l => setLines(prev => [...prev, l]))
      // 回放引擎按 param 键取值；SOP-Agent 引擎按字段语义名取值（SOP 里用的是 {{语义名}}）
      const fieldValues = {}
      steps.forEach(s2 => { if (s2.param) fieldValues[agent ? (s2.label || s2.param) : s2.param] = s2.value || '' })
      // 有录制步骤用派生 navHash；直跑(无步骤)用手填的直达路由
      const useNav = steps.length ? navHash : directNav.trim()
      const r = await Browser.dryRun({ systemId: s.id, baseUrl: s.baseUrl, systemName: s.name, steps, fieldValues, sop, adminBaseUrl: getBaseUrl(), mode: agent ? 'agentic-sop' : undefined, navHash: useNav })
      if (lineUnsub.current) { lineUnsub.current(); lineUnsub.current = null }
      if (r && r.loggedIn === false) note('试运行窗口未登录，请登录后重试')
      else if (!r || r.failedAt >= 0) fail(agent ? `SOP·Agent 未走通：${(r && (r.failLabel || r.error)) || '未完成'}` : `试运行中断于第 ${(r?.failedAt ?? 0) + 1} 步：${(r && (r.failLabel || r.error)) || '未完成'}`)
      else note(agent ? `SOP·Agent 走通：模型完成 ${r.done} 步操作` : `试运行通过：${r.done}/${r.total} 步`)
    } catch (e) { fail(e) } finally { setBusy(''); if (Browser.available()) Browser.dryRunClose().catch(() => {}) }
  }

  async function submit() {
    if (!steps.length) return fail('请先录制')
    if (!name.trim()) return fail('请填写技能名称')
    const kws = keywords.split(/[，,\s]+/).map(s => s.trim()).filter(Boolean)
    if (!kws.length) return fail('请填写至少一个触发词——客户端靠它匹配技能，留空会导致技能无法被对话框调用。')
    if (fields.some(f => !f.label || !f.label.trim())) return fail('有参数未填语义名，请在步骤列表中补全后再提交。')
    setBusy('submit'); setErr('')
    try {
      const res = await SkillCenter.fromRecording({
        name: name.trim(),
        triggerKeywords: kws,
        targetSystemId: systemId, steps, fields, engine: 'browser', sop, script: readable(steps),
        skillKind, navHash
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
        {systems.length === 0 && <div className="hint" style={{ background: '#FEF3E2', borderColor: '#FCD9A8', color: '#B45309' }}>没有已验证连接的业务系统。请先到「系统连接」完成本地登录验证，再来录制。</div>}
        {(msg || err) && <div className={err ? 'err' : 'ok'}>{err || msg}</div>}

        {/* 1. 录制 */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <b>1 · 录制操作</b>
            <Tag kind={steps.length ? 'green' : 'gray'}>{steps.length ? `已录制 ${steps.length} 步` : '未录制'}</Tag>
            {steps.length > 0 && <Tag kind={skillKind === 'read' ? 'blue' : 'amber'}>{skillKind === 'read' ? '读取类（打开+抓取，更稳）' : '写入类（确认+回放）'}</Tag>}
            {steps.length > 0 && navHash && <Tag kind="gray">直达 {navHash}</Tag>}
            {fields.length > 0 && <Tag kind="green">{fields.length} 个参数</Tag>}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label className="fl" style={{ margin: 0 }}>目标系统</label>
            <select style={{ width: 280 }} value={systemId} onChange={e => setSystemId(e.target.value)} disabled={recording}>
              {systems.length === 0 && <option value="">（无已验证连接的系统）</option>}
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
            <div style={{ marginTop: 12, maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 6 }}>
              {steps.map((s, i) => {
                const isFill = FILL_ACTS.includes(s.act)
                const kindCls = s.act === 'hover' ? 'gray' : WRITE_ACTS.includes(s.act) ? 'amber' : 'blue'
                return (
                  <div key={i} className="qs-step">
                    <span className="muted" style={{ width: 18, textAlign: 'right' }}>{i + 1}</span>
                    <span className={'tag ' + kindCls} style={{ minWidth: 52, textAlign: 'center' }}>{ACT_LABEL[s.act] || s.act}</span>
                    {isFill ? (
                      <>
                        <input
                          className="qs-field-name"
                          value={s.label || ''}
                          onChange={e => patchStep(i, { label: e.target.value })}
                          placeholder="字段语义名，如 拜访纪要"
                          title="这个字段叫什么（运行时按它提炼用户的话并弹表单确认）"
                        />
                        <button
                          type="button"
                          className={'qs-param-toggle' + (s.param ? ' on' : '')}
                          title={s.param ? '参数：运行时由用户填写' : '常量：回放时原样填入录制值'}
                          onClick={() => toggleParam(i)}
                        >{s.param ? '参数' : '常量'}</button>
                        <span className="sec qs-step-val" title={s.value || ''}>{s.param ? '运行时填' : (s.value ? '＝' + s.value : '')}</span>
                      </>
                    ) : (
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.label || <span className="muted">（无标签）</span>}{s.value ? <span className="sec"> = {s.value}</span> : ''}
                      </span>
                    )}
                    {s.nav && <span className="tag green" title={'直达 ' + s.nav}>直达</span>}
                    <button type="button" className="qs-step-del" title="删除此步" onClick={() => deleteStep(i)}>×</button>
                  </div>
                )
              })}
            </div>
          )}
          {warnings.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {warnings.map((w, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, color: '#B45309', background: '#FEF3E2', border: '1px solid #FCD9A8', borderRadius: 8, padding: '7px 10px' }}>
                  <span>⚠️</span><span style={{ flex: 1 }}>{w}</span>
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
              <label className="fl" style={{ margin: 0 }}>SOP（录制后自动生成，可编辑；标了参数会同步更新）</label>
              <button className="ghost" disabled={busy || !steps.length} onClick={regenSop}>按录制重新生成</button>
            </div>
            <textarea rows={6} value={sop} onChange={e => { sopDirty.current = true; setSop(e.target.value) }} placeholder="录制后这里会自动生成 SOP；也可手动编辑" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }} />
          </div>
        </div>

        {/* 3. 调试与上架 */}
        <div className="card grid" style={{ gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <b>3 · 调试与上架</b>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--sec)', cursor: 'pointer', marginRight: 4 }} title="开=后台运行不弹浏览器窗口；调试时建议关闭以便观察">
                <input type="checkbox" checked={headless} onChange={e => setHeadless(e.target.checked)} style={{ width: 'auto' }} />无头浏览器
              </label>
              <button disabled={busy} title="读出表单字段类型 + 下拉真实可选项，照它锁定 SOP 取值" onClick={schemaProbe}>{busy === 'sprobe' ? '读取中…' : '读字段选项'}</button>
              <button disabled={busy || (!steps.length && !sop.trim())} title="把当前调试中的技能存为草稿（持久化）" onClick={saveDraft}>保存草稿</button>
              <button className="primary" disabled={busy || !steps.length} onClick={submit}>{busy === 'submit' ? '提交中…' : '提交上架'}</button>
            </div>
          </div>

          {!steps.length && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label className="fl" style={{ margin: 0, whiteSpace: 'nowrap' }}>直达路由</label>
              <input value={directNav} onChange={e => setDirectNav(e.target.value)} placeholder="#crm/list/=/object_sNh9h__c" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
              <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>无需录制时手填直达路由</span>
            </div>
          )}

          {/* 内嵌技能测试：用一段话测整条链路 */}
          <div className="qs-test-box">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
              <b style={{ fontSize: 13 }}>用一段话测整条链路</b>
              <span className="muted">提炼字段 → 真实执行 → 通过/失败</span>
              <span style={{ flex: 1 }} />
              <Tag kind={skillKind === 'read' ? 'blue' : 'amber'}>{skillKind === 'read' ? '读取类' : '写入类'}</Tag>
              {(navHash || directNav.trim()) ? <Tag kind="green">直达</Tag> : <Tag kind="gray">无直达</Tag>}
              <Tag kind="gray">{fields.length} 个参数</Tag>
            </div>
            {fields.length > 0 && <div className="sec" style={{ fontSize: 12 }}>参数：{fields.map(f => f.label || f.name).join('、')}</div>}
            {!sop.trim() && <div className="err" style={{ fontSize: 12 }}>当前还没有 SOP，agent 没有执行依据。请先录制或写 SOP。</div>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <textarea rows={2} value={testPara} onChange={e => setTestPara(e.target.value)} placeholder="像用户那样说一句，例：我今天拜访了中国石油的李主任，当前进展是聊了Q3合作方案，下一步计划是下周二再回访。" style={{ fontSize: 13 }} />
              <button className="primary" disabled={testBusy} style={{ whiteSpace: 'nowrap' }} onClick={runTest}>{testBusy ? '测试中…' : '发送并测试'}</button>
            </div>
            {testErr && <div className="err">{testErr}</div>}
            {testVerdict && (testVerdict.info
              ? <div className="hint">{testVerdict.info}</div>
              : testVerdict.needInput
                ? <div style={{ fontSize: 13, fontWeight: 600, color: '#B45309', background: '#FEF3E2', border: '1px solid #FCD9A8', borderRadius: 8, padding: '8px 12px' }}>🟡 需补充参数：{testVerdict.needInput.join('、')}（已暂停，未操作业务系统）</div>
                : <div className={testVerdict.passed ? 'ok' : 'err'} style={{ fontSize: 13, fontWeight: 600 }}>{testVerdict.passed ? '✅ 链路测试通过' : `❌ 未通过：${testVerdict.reason || '未完成'}`}</div>
            )}
            {testVerdict && testVerdict.fieldValues && Object.keys(testVerdict.fieldValues).length > 0 && (
              <div style={{ fontSize: 12 }}>
                <span className="sec">提炼到的字段：</span>{Object.entries(testVerdict.fieldValues).map(([k, v]) => `${k}=${v || '空'}`).join('｜')}
              </div>
            )}
            {testLines.length > 0 && (
              <div style={{ maxHeight: 280, overflowY: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, lineHeight: 1.75, color: 'var(--sec)', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                {testLines.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            )}
          </div>

          {lines.length > 0 && (
            <div style={{ maxHeight: 220, overflowY: 'auto', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, lineHeight: 1.8, color: 'var(--sec)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              {lines.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          )}
          {skillId && <div className="ok">✓ 已上架，技能中心 ID：{skillId}</div>}
        </div>

        {!Browser.available() && <div className="hint">当前为浏览器预览，录制/试运行需在桌面端运行。</div>}
      </div>
    </>
  )
}
