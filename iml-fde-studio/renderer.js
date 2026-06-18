const app = document.getElementById('app')
const LS = window.localStorage

let state = {
  phase: 'home',           // home | setup | recording | review | d-setup | d-record | d-review
  adminBaseUrl: LS.getItem('adminBaseUrl') || 'http://localhost:8080',
  systems: [],
  systemId: '',
  name: '',
  keywords: '',
  liveSteps: [],
  steps: [],               // 录制步骤(rich: act/label/value/fp/options)
  param: {},               // i -> 是否作为用户确认填写的字段
  paramName: {},           // i -> 字段名
  err: '',
  ok: '',
  saving: false,
  dryParams: {},
  dryLog: [],
  dryRunning: false,
  dryDone: null,
  sop: '',
  sopGenerating: false,
  // 桌面
  deskNat: null, dSteps: [], dMarked: {}, dLabels: {}, dWaits: {}
}
let unsub = null
let dryUnsub = null

function set(p) { Object.assign(state, p); render() }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }
function sys() { return state.systems.find(s => s.id === state.systemId) }
const ACT_TEXT = { click: '点击', fill: '输入', select: '下拉', search: '检索选择', pickOption: '选项', hover: '悬停', wait: '等待', waitText: '等文本' }
function actText(a) { return ACT_TEXT[a] || a }
function actClass(a) { return (a === 'fill' || a === 'select' || a === 'search') ? 'fill' : '' }
function fieldEligible(s) { return s && (s.act === 'fill' || s.act === 'select' || s.act === 'search') }

async function loadSystems() {
  const r = await window.api.invoke('admin:systems', { adminBaseUrl: state.adminBaseUrl })
  if (r && r.ok) { state.systems = r.systems; if (!state.systemId && r.systems[0]) state.systemId = r.systems[0].id; state.err = '' }
  else { state.systems = []; state.err = '无法连接管理端：' + ((r && r.error) || '未知错误') }
  render()
}

// ===== 浏览器录制 =====
async function startRecording() {
  state.err = ''
  const s = sys()
  if (!state.adminBaseUrl.trim()) { return set({ err: '请填写管理端地址' }) }
  if (!s) { return set({ err: '请选择要操作的业务系统' }) }
  if (!state.name.trim()) { return set({ err: '请填写技能名称' }) }
  LS.setItem('adminBaseUrl', state.adminBaseUrl.trim())
  state.liveSteps = []
  unsub = window.api.on('recorder:step', step => { state.liveSteps.push(step); render() })
  const r = await window.api.invoke('recorder:start', { systemId: s.id, baseUrl: s.baseUrl, systemName: s.name })
  if (!r || !r.ok) { if (unsub) unsub(); return set({ err: '无法启动录制：' + ((r && r.error) || '未知错误') }) }
  set({ phase: 'recording' })
}

async function stopRecording() {
  if (unsub) { unsub(); unsub = null }
  const r = await window.api.invoke('recorder:stop')
  const steps = (r && r.steps) || []
  const param = {}, paramName = {}
  steps.forEach((s, i) => { if (fieldEligible(s)) { param[i] = true; paramName[i] = 'f' + i } })
  set({ phase: 'review', steps, param, paramName, sop: '', dryLog: [], dryDone: null, dryParams: {} })
}

async function cancelRecording() {
  if (unsub) { unsub(); unsub = null }
  await window.api.invoke('recorder:cancel')
  set({ phase: 'setup', liveSteps: [] })
}

function deleteStep(i) {
  state.steps.splice(i, 1)
  const param = {}, paramName = {}
  state.steps.forEach((s, idx) => { if (fieldEligible(s) && state.param[idx + (idx >= i ? 1 : 0)] !== undefined) {} })
  // 简单重建：删后按默认重标（步骤通常不多）
  state.steps.forEach((s, idx) => { if (fieldEligible(s)) { param[idx] = true; paramName[idx] = 'f' + idx } })
  set({ param, paramName })
}

// 复核状态 → 输出步骤(执行用) + 字段定义
function buildBrowserSteps() {
  return state.steps.map((s, i) => {
    const o = Object.assign({}, s)
    if (fieldEligible(s) && state.param[i]) o.param = state.paramName[i] || ('f' + i)
    return o
  })
}
function buildBrowserParams() {
  const out = []
  state.steps.forEach((s, i) => { if (fieldEligible(s) && state.param[i]) out.push({ name: state.paramName[i] || ('f' + i), label: s.label || ('字段' + (i + 1)), type: s.act === 'select' ? 'select' : 'text', options: s.options }) })
  return out
}
// 人类可读脚本（仅展示 / 供 SOP 生成）
function readable(steps) {
  return steps.map(s => {
    const t = s.param ? `{{${s.param}}}` : (s.value ? `"${String(s.value).replace(/"/g, '')}"` : '')
    if (s.act === 'fill') return `fill "${s.label}" = ${t}`
    if (s.act === 'select') return `select "${s.label}" = ${t}`
    if (s.act === 'search') return `searchSelect "${s.label}" = ${t}`
    if (s.act === 'hover') return `hover "${s.label}"`
    if (s.act === 'pickOption') return `pick "${s.label}"`
    return `click "${s.label}"`
  }).join('\n')
}

async function dryRun() {
  const s = sys(); if (!s) { return set({ err: '未找到目标系统' }) }
  const steps = buildBrowserSteps()
  if (!steps.length) { return set({ err: '没有可执行的步骤' }) }
  state.err = ''; state.dryLog = []; state.dryRunning = true; state.dryDone = null; set({})
  if (dryUnsub) dryUnsub()
  dryUnsub = window.api.on('dryrun:line', (line) => { state.dryLog.push(line); set({}) })
  const r = await window.api.invoke('skill:dry-run', { systemId: state.systemId, baseUrl: s.baseUrl, systemName: s.name, steps, fieldValues: state.dryParams, sop: state.sop, adminBaseUrl: state.adminBaseUrl.trim() })
  state.dryRunning = false
  state.dryDone = summarizeRun(r)
  set({})
}
function summarizeRun(r) {
  if (!r || !r.ok) return { ok: false, msg: '试运行失败：' + ((r && r.error) || '未知错误') }
  if (r.loggedIn === false) return { ok: false, msg: '检测到未登录目标系统。请在试运行窗口登录后重试。' }
  if (r.failedAt >= 0) return { ok: false, msg: `执行到第 ${r.failedAt + 1} 步中断（${r.error || '未完成'}），可回到上面调整或重试。` }
  return { ok: true, msg: `✓ 全部 ${r.done}/${r.total} 步执行成功。请在试运行窗口核对结果，确认无误后同步到管理平台。` }
}

async function closeDryRun() { await window.api.invoke('skill:dry-run-close') }

async function genSop(engine) {
  const isDesktop = engine === 'desktop'
  const script = isDesktop ? buildDesktopArtifacts().dsl : readable(buildBrowserSteps())
  const fields = isDesktop ? buildDesktopArtifacts().fields : buildBrowserParams()
  if (!script || !script.trim()) { return set({ err: '脚本为空，无法生成 SOP' }) }
  state.err = ''; state.sopGenerating = true; set({})
  const r = await window.api.invoke('skill:gen-sop', { adminBaseUrl: state.adminBaseUrl.trim(), name: state.name.trim() || '录制技能', script, fields, engine: engine || 'browser' })
  state.sopGenerating = false
  if (r && r.ok) state.sop = r.sop || ''
  else state.err = '生成 SOP 失败：' + ((r && r.error) || '未知错误')
  set({})
}

async function sync() {
  state.err = ''; state.ok = ''
  if (state.steps.length === 0) { return set({ err: '没有可同步的步骤' }) }
  set({ saving: true })
  const steps = buildBrowserSteps()
  const triggerKeywords = state.keywords.split(/[,，\s]+/).map(k => k.trim()).filter(Boolean)
  const r = await window.api.invoke('admin:save-skill', {
    adminBaseUrl: state.adminBaseUrl.trim(), name: state.name.trim(), triggerKeywords, targetSystemId: state.systemId,
    engine: 'browser', steps, fields: buildBrowserParams(), sop: state.sop
  })
  state.saving = false
  if (!r || !r.ok) { return set({ err: '同步失败：' + ((r && r.error) || '未知错误') }) }
  await closeDryRun()
  set({ phase: 'home', ok: `技能「${state.name}」已同步至管理平台技能中心（${(r.skill && r.skill.id) || ''}）。`, name: '', keywords: '', steps: [], liveSteps: [], param: {}, paramName: {}, dryParams: {}, dryLog: [], dryDone: null, sop: '' })
}

// ===== 桌面自动化（保留）=====
async function deskCheck() { state.deskNat = await window.api.invoke('desktop:check'); set({}) }
const dActText = (op) => ({ click: '点击', doubleClick: '双击', rightClick: '右键', move: '移动', type: '输入', key: '按键', hotkey: '组合键' }[op] || op)
async function deskStart() {
  state.err = ''
  if (!state.name.trim()) { return set({ err: '请填写技能名称' }) }
  state.dSteps = []
  if (dryUnsub) dryUnsub()
  dryUnsub = window.api.on('desktop:step', (st) => { state.dSteps.push(st); set({}) })
  const r = await window.api.invoke('desktop:record-start')
  if (!r || !r.ok) { if (dryUnsub) dryUnsub(); return set({ err: r && r.error || '无法启动录制（缺少原生模块或未授权）' }) }
  set({ phase: 'd-record' })
}
async function deskStop() {
  if (dryUnsub) { dryUnsub(); dryUnsub = null }
  const r = await window.api.invoke('desktop:record-stop')
  const steps = (r && r.steps) || []
  const dMarked = {}, dLabels = {}
  steps.forEach((s, i) => { if (s.op === 'type') { dMarked[i] = false; dLabels[i] = '文本' + (i + 1) } })
  set({ phase: 'd-review', dSteps: steps, dMarked, dLabels, dWaits: {}, sop: '', dryLog: [], dryDone: null })
}
async function deskCancel() { if (dryUnsub) { dryUnsub(); dryUnsub = null } await window.api.invoke('desktop:record-cancel'); set({ phase: 'd-setup', dSteps: [] }) }
function deskDeleteStep(i) {
  state.dSteps.splice(i, 1)
  const dMarked = {}, dLabels = {}
  state.dSteps.forEach((s, idx) => { if (s.op === 'type') { dMarked[idx] = state.dMarked[idx] || false; dLabels[idx] = state.dLabels[idx] || ('文本' + (idx + 1)) } })
  set({ dMarked, dLabels })
}
function buildDesktopDsl(outSteps) {
  const lines = []
  for (const s of outSteps) {
    const w = parseInt(s.waitBefore, 10); if (w > 0) lines.push('wait ' + w)
    if (['click', 'doubleClick', 'rightClick', 'move'].includes(s.op)) lines.push(`${s.op} ${s.x} ${s.y}`)
    else if (s.op === 'type') { const rhs = s.fieldName ? `{{${s.fieldName}}}` : String(s.value || '').replace(/"/g, ''); lines.push(`type "${rhs}"`) }
    else if (s.op === 'key') lines.push(`key "${s.value}"`)
    else if (s.op === 'hotkey') lines.push(`hotkey "${s.value}"`)
  }
  return lines.join('\n')
}
function buildDesktopArtifacts() {
  const outSteps = state.dSteps.map((s, i) => { const o = Object.assign({}, s); const w = parseInt(state.dWaits[i], 10); if (w > 0) o.waitBefore = w; if (s.op === 'type' && state.dMarked[i]) o.fieldName = 'f' + i; return o })
  const fields = []
  state.dSteps.forEach((s, i) => { if (s.op === 'type' && state.dMarked[i]) fields.push({ name: 'f' + i, label: state.dLabels[i] || ('文本' + (i + 1)), type: 'text' }) })
  return { outSteps, fields, dsl: buildDesktopDsl(outSteps) }
}
async function deskDryRun() {
  const { dsl } = buildDesktopArtifacts()
  if (!dsl.trim()) { return set({ err: '脚本为空，无法试运行' }) }
  state.err = ''; state.dryLog = []; state.dryRunning = true; state.dryDone = null; set({})
  if (dryUnsub) dryUnsub()
  dryUnsub = window.api.on('dryrun:line', (line) => { state.dryLog.push(line); set({}) })
  const r = await window.api.invoke('desktop:dry-run', { dsl, fieldValues: state.dryParams })
  state.dryRunning = false
  state.dryDone = summarizeRun(r)
  set({})
}
async function deskSync() {
  state.err = ''; state.ok = ''
  if (state.dSteps.length === 0) { return set({ err: '没有可同步的步骤' }) }
  set({ saving: true })
  const { outSteps, fields, dsl } = buildDesktopArtifacts()
  const triggerKeywords = state.keywords.split(/[,，\s]+/).map(k => k.trim()).filter(Boolean)
  const r = await window.api.invoke('admin:save-skill', { adminBaseUrl: state.adminBaseUrl.trim(), name: state.name.trim(), triggerKeywords, targetSystemId: '', engine: 'desktop', script: dsl, steps: outSteps, fields, sop: state.sop })
  state.saving = false
  if (!r || !r.ok) { return set({ err: '同步失败：' + ((r && r.error) || '未知错误') }) }
  set({ phase: 'home', ok: `桌面技能「${state.name}」已同步至管理平台技能中心（${(r.skill && r.skill.id) || ''}）。`, name: '', keywords: '', dSteps: [], dMarked: {}, dLabels: {}, dWaits: {}, dryParams: {}, dryLog: [], dryDone: null, sop: '' })
}

const CAPS = [
  { id: 'browser', icon: '🌐', title: '浏览器自动化技能构建', on: true, desc: '录制业务系统(CRM/OA等)网页操作 → SOP + 步骤指纹 → 可见浏览器 agent 试运行 → 同步管理平台。' },
  { id: 'desktop', icon: '🖥️', title: '桌面自动化技能构建', on: true, desc: '全局录制桌面应用鼠标/键盘操作，生成桌面脚本，本机试运行确认后同步。' },
  { id: 'terminal', icon: '⌨️', title: '终端 / 脚本能力', on: false, desc: '构建以命令行/脚本实现的自动化技能。' }
]

function sopSectionHtml(engine) {
  let h = `<div class="build-sec"><div class="build-head" style="display:flex;align-items:center;justify-content:space-between">
    <span>标准作业流程 SOP（转换结果 · 可编辑，同步以此为准）</span>
    <a id="genSop" data-engine="${engine}" style="font-size:11px;color:var(--brand);cursor:pointer">${state.sopGenerating ? '生成中…' : (state.sop ? '↻ 重新生成' : '✦ 生成 SOP')}</a>
  </div>`
  h += `<textarea id="sopEdit" class="dsl-edit" style="color:#cbd5e1;min-height:130px" spellcheck="false" placeholder="点右上角「生成 SOP」按录制内容自动生成详细 SOP（# 执行步骤 / 反馈要求），可在此编辑后随技能同步。">${esc(state.sop)}</textarea></div>`
  return h
}
function consoleHtml() {
  if (!(state.dryLog.length || state.dryRunning || state.dryDone)) return ''
  let h = `<div class="build-sec"><div class="build-head">试运行控制台 ${state.dryRunning ? '<span class="dry-run-tag">运行中…</span>' : ''}</div>`
  h += `<pre class="dry-console">${state.dryLog.map(esc).join('\n') || '...'}</pre>`
  if (state.dryDone) h += `<div class="${state.dryDone.ok ? 'ok' : 'err'}" style="margin-top:6px">${esc(state.dryDone.msg)}</div>`
  return h + `</div>`
}

function render() {
  let h = ''
  if (state.phase === 'home') {
    h += `<div class="hint">选择要构建的技能类型。FDE 在本地录制/编排，生成标准 SOP + 步骤指纹，agent 主驱动执行（以当前页面为准定位），确认无误后同步到管理平台技能中心。</div>`
    if (state.ok) h += `<div class="ok">✅ ${esc(state.ok)}</div>`
    h += `<div class="home-grid">`
    CAPS.forEach(c => { h += `<div class="cap-card ${c.on ? '' : 'disabled'}" ${c.on ? `data-cap="${c.id}"` : ''}><div class="cap-ic">${c.icon}</div><div class="cap-title">${esc(c.title)} <span class="cap-badge ${c.on ? 'on' : 'soon'}">${c.on ? '可用' : '待开发'}</span></div><div class="cap-desc">${esc(c.desc)}</div></div>` })
    h += `</div>`; app.innerHTML = h; bind(); return
  }
  const capName = state.phase.startsWith('d-') ? '桌面自动化技能构建' : '浏览器自动化技能构建'
  h += `<div class="crumb"><a id="goHome">← 首页</a><span>/</span><span>${capName}</span></div>`

  if (state.phase === 'setup') {
    h += `<div class="hint">选择目标业务系统并命名技能，点「开始录制」打开浏览器窗口（请正常登录并操作一遍）。只记录每步操作与元素指纹，<b>不保存任何登录态</b>。</div>`
    if (state.ok) h += `<div class="ok">✅ ${esc(state.ok)}</div>`
    h += `<div><label class="fl">管理端地址</label><input id="admin" value="${esc(state.adminBaseUrl)}" placeholder="http://localhost:8080" /></div>`
    h += `<div><label class="fl">目标业务系统</label><select id="sysSel">`
    if (state.systems.length === 0) h += `<option value="">（未获取到业务系统，确认地址后点刷新）</option>`
    state.systems.forEach(s => { h += `<option value="${esc(s.id)}" ${s.id === state.systemId ? 'selected' : ''}>${esc(s.name)}（${esc(s.type)}）</option>` })
    h += `</select></div>`
    h += `<div class="row"><div><label class="fl">技能名称</label><input id="name" value="${esc(state.name)}" placeholder="例如：CRM 客户拜访记录录入" /></div>`
    h += `<div><label class="fl">触发关键词（逗号/空格分隔）</label><input id="kw" value="${esc(state.keywords)}" placeholder="拜访记录, 填写拜访" /></div></div>`
    if (state.err) h += `<div class="err">${esc(state.err)}</div>`
    h += `<div class="actions"><button id="refresh">刷新系统列表</button><button class="primary" id="start">● 开始录制</button></div>`
  } else if (state.phase === 'recording') {
    h += `<div class="recbar"><span class="dot"></span>正在录制 ·「${esc(sys() ? sys().name : '')}」· 请在弹出窗口中登录并操作，完成后点「结束录制」</div>`
    h += `<div class="steps">`
    if (state.liveSteps.length === 0) h += `<div class="empty">等待操作…每次点击/输入/悬停菜单都会出现在这里</div>`
    state.liveSteps.forEach(s => { h += `<div class="step"><span class="act ${actClass(s.act)}">${actText(s.act)}</span><span class="lbl">${esc(s.label || '')}</span>${s.value ? `<span class="val">${esc(s.value)}</span>` : ''}</div>` })
    h += `</div><div class="actions"><button id="cancel">取消</button><button class="primary" id="stop">■ 结束录制（${state.liveSteps.length} 步）</button></div>`
  } else if (state.phase === 'review') {
    h += `<div class="hint">核对录制步骤。<b>输入/下拉/检索</b>类步骤可勾为「可填字段」（执行时先弹表单确认，由参数注入）。执行时 agent 以当前页面为准定位，会自动悬停展开菜单/关弹窗/等加载——这里不需要你纠结选择器。</div>`
    h += `<div class="steps">`
    if (state.steps.length === 0) h += `<div class="empty">未捕获到步骤</div>`
    state.steps.forEach((s, i) => {
      h += `<div class="step"><span class="no">${i + 1}</span><span class="act ${actClass(s.act)}">${actText(s.act)}</span><span class="lbl" title="${esc(s.fp && s.fp.sel || '')}">${esc(s.label || '')}</span>`
      if (fieldEligible(s)) {
        const on = !!state.param[i]
        h += `<label class="mark"><input type="checkbox" data-mark="${i}" ${on ? 'checked' : ''}/>可填字段`
        if (on) h += `<input type="text" data-pname="${i}" value="${esc(state.paramName[i] || '')}" placeholder="字段名"/>`
        h += `</label>`
      } else if (s.value) { h += `<span class="val">${esc(s.value)}</span>` }
      h += `<button class="del" data-del="${i}">✕</button></div>`
    })
    h += `</div>`
    h += sopSectionHtml('browser')
    const params = buildBrowserParams()
    if (params.length) {
      h += `<div class="build-sec"><div class="build-head">试运行参数（FDE 填入测试值）</div><div class="param-grid">`
      params.forEach(f => {
        const v = state.dryParams[f.name] !== undefined ? state.dryParams[f.name] : ''
        h += `<div class="param-row"><label>${esc(f.label)}</label>`
        if (f.type === 'select' && Array.isArray(f.options)) h += `<select data-param="${f.name}"><option value="">（请选择）</option>${f.options.map(o => `<option value="${esc(o)}" ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
        else h += `<input data-param="${f.name}" value="${esc(v)}" placeholder="测试值"/>`
        h += `</div>`
      })
      h += `</div></div>`
    }
    h += consoleHtml()
    if (state.err) h += `<div class="err">${esc(state.err)}</div>`
    h += `<div class="actions"><button id="reset">重录</button><div style="flex:1"></div>
      <button id="dryrun" ${state.dryRunning ? 'disabled' : ''}>${state.dryRunning ? '试运行中…' : '▶ 试运行（可见浏览器）'}</button>
      <button class="primary" id="sync" ${state.saving ? 'disabled' : ''}>${state.saving ? '同步中…' : '⇧ 同步到管理平台'}</button></div>`
  } else if (state.phase === 'd-setup') {
    const n = state.deskNat
    h += `<div class="hint">桌面自动化：开始录制后<b>全局捕获鼠标点击与键盘</b>，生成可回放桌面脚本。文本建议设为可填字段由参数注入（支持中文）。</div>`
    if (state.ok) h += `<div class="ok">✅ ${esc(state.ok)}</div>`
    if (n) {
      h += `<div class="dep-box ${n.recordReady && n.replayReady ? 'ok' : 'warn'}"><div>原生录制(uiohook-napi)：${n.recordReady ? '✓ 就绪' : '✗ 未安装'} · 桌面回放(nut-js)：${n.replayReady ? '✓ 就绪' : '✗ 未安装'}</div>${n.missing && n.missing.length ? `<div style="margin-top:4px">缺少：${esc(n.missing.join('、'))} —— 工具目录执行 <code>npm install</code>。</div>` : ''}${n.permissionNote ? `<div style="margin-top:4px">${esc(n.permissionNote)}</div>` : ''}</div>`
    } else h += `<div class="dep-box warn">正在检测原生依赖…</div>`
    h += `<div><label class="fl">管理端地址</label><input id="admin" value="${esc(state.adminBaseUrl)}" placeholder="http://localhost:8080" /></div>`
    h += `<div class="row"><div><label class="fl">技能名称</label><input id="name" value="${esc(state.name)}" placeholder="例如：财务系统月结导出" /></div>`
    h += `<div><label class="fl">触发关键词</label><input id="kw" value="${esc(state.keywords)}" placeholder="月结导出, 导出报表" /></div></div>`
    if (state.err) h += `<div class="err">${esc(state.err)}</div>`
    const canRec = n && n.recordReady
    h += `<div class="actions"><button id="recheck">重新检测依赖</button><button class="primary" id="dstart" ${canRec ? '' : 'disabled'}>● 开始录制</button></div>`
  } else if (state.phase === 'd-record') {
    h += `<div class="recbar"><span class="dot"></span>正在全局录制桌面操作 · 正常操作目标应用，完成后点「结束录制」</div>`
    h += `<div class="steps">`
    if (state.dSteps.length === 0) h += `<div class="empty">等待操作…每次点击/按键都会出现在这里</div>`
    state.dSteps.forEach(s => { h += `<div class="step"><span class="act ${s.op === 'type' ? 'fill' : ''}">${dActText(s.op)}</span><span class="lbl">${s.x !== undefined ? s.x + ',' + s.y : esc(s.value || '')}</span></div>` })
    h += `</div><div class="actions"><button id="dcancel">取消</button><button class="primary" id="dstop">■ 结束录制（${state.dSteps.length} 步）</button></div>`
  } else if (state.phase === 'd-review') {
    h += `<div class="hint">核对桌面步骤。<b>输入</b>步骤可勾为可填字段（参数注入，支持中文）。坐标随分辨率/窗口位置变化，回放前请保持窗口位置一致。</div>`
    h += `<div class="steps">`
    if (state.dSteps.length === 0) h += `<div class="empty">未捕获到步骤</div>`
    state.dSteps.forEach((s, i) => {
      h += `<div class="step"><span class="no">${i + 1}</span><span class="act ${s.op === 'type' ? 'fill' : ''}">${dActText(s.op)}</span><span class="lbl">${s.x !== undefined ? s.x + ',' + s.y : esc(s.value || '')}</span>`
      if (s.op === 'type') { const on = !!state.dMarked[i]; h += `<label class="mark"><input type="checkbox" data-dmark="${i}" ${on ? 'checked' : ''}/>可填字段`; if (on) h += `<input type="text" data-dlabel="${i}" value="${esc(state.dLabels[i] || '')}" placeholder="字段名"/>`; h += `</label>` }
      h += `<input type="number" class="wait" data-dwait="${i}" value="${esc(state.dWaits[i] || '')}" placeholder="等待ms"/><button class="del" data-ddel="${i}">✕</button></div>`
    })
    h += `</div>`
    const da = buildDesktopArtifacts()
    h += `<div class="build-sec"><div class="build-head">生成的桌面脚本</div><pre class="dsl-box">${esc(da.dsl) || '（空）'}</pre></div>`
    h += sopSectionHtml('desktop')
    if (da.fields.length) { h += `<div class="build-sec"><div class="build-head">试运行参数</div><div class="param-grid">`; da.fields.forEach(f => { const v = state.dryParams[f.name] !== undefined ? state.dryParams[f.name] : ''; h += `<div class="param-row"><label>${esc(f.label)}</label><input data-param="${f.name}" value="${esc(v)}" placeholder="测试值"/></div>` }); h += `</div></div>` }
    h += consoleHtml()
    if (state.err) h += `<div class="err">${esc(state.err)}</div>`
    h += `<div class="actions"><button id="dreset">重录</button><div style="flex:1"></div><button id="ddryrun" ${state.dryRunning ? 'disabled' : ''}>${state.dryRunning ? '试运行中…' : '▶ 试运行（本机操作）'}</button><button class="primary" id="dsync" ${state.saving ? 'disabled' : ''}>${state.saving ? '同步中…' : '⇧ 同步到管理平台'}</button></div>`
  }
  app.innerHTML = h
  bind()
}

function bindSop() {
  const se = document.getElementById('sopEdit'); if (se) se.oninput = e => { state.sop = e.target.value }
  const gs = document.getElementById('genSop'); if (gs) gs.onclick = () => genSop(gs.dataset.engine)
}

function bind() {
  const $ = id => document.getElementById(id)
  if (state.phase === 'home') {
    document.querySelectorAll('[data-cap]').forEach(el => el.onclick = () => {
      if (el.dataset.cap === 'browser') set({ phase: 'setup', err: '', ok: '' })
      else if (el.dataset.cap === 'desktop') { set({ phase: 'd-setup', err: '', ok: '' }); deskCheck() }
    })
    return
  }
  const home = $('goHome'); if (home) home.onclick = () => { closeDryRun(); set({ phase: 'home', err: '' }) }
  if (state.phase === 'setup') {
    $('admin').oninput = e => { state.adminBaseUrl = e.target.value }
    $('sysSel').onchange = e => { state.systemId = e.target.value }
    $('name').oninput = e => { state.name = e.target.value }
    $('kw').oninput = e => { state.keywords = e.target.value }
    $('refresh').onclick = loadSystems
    $('start').onclick = startRecording
  } else if (state.phase === 'recording') {
    $('cancel').onclick = cancelRecording
    $('stop').onclick = stopRecording
  } else if (state.phase === 'review') {
    $('reset').onclick = () => { closeDryRun(); set({ phase: 'setup' }) }
    $('dryrun').onclick = dryRun
    $('sync').onclick = sync
    document.querySelectorAll('[data-mark]').forEach(el => el.onchange = e => { state.param[+el.dataset.mark] = e.target.checked; render() })
    document.querySelectorAll('[data-pname]').forEach(el => el.oninput = e => { state.paramName[+el.dataset.pname] = e.target.value })
    document.querySelectorAll('[data-del]').forEach(el => el.onclick = () => deleteStep(+el.dataset.del))
    document.querySelectorAll('[data-param]').forEach(el => el.oninput = el.onchange = e => { state.dryParams[el.dataset.param] = e.target.value })
    bindSop()
  } else if (state.phase === 'd-setup') {
    $('admin').oninput = e => { state.adminBaseUrl = e.target.value }
    $('name').oninput = e => { state.name = e.target.value }
    $('kw').oninput = e => { state.keywords = e.target.value }
    $('recheck').onclick = deskCheck
    $('dstart').onclick = deskStart
  } else if (state.phase === 'd-record') {
    $('dcancel').onclick = deskCancel
    $('dstop').onclick = deskStop
  } else if (state.phase === 'd-review') {
    $('dreset').onclick = () => set({ phase: 'd-setup', dSteps: [] })
    $('ddryrun').onclick = deskDryRun
    $('dsync').onclick = deskSync
    document.querySelectorAll('[data-dmark]').forEach(el => el.onchange = e => { state.dMarked[+el.dataset.dmark] = e.target.checked; render() })
    document.querySelectorAll('[data-dlabel]').forEach(el => el.oninput = e => { state.dLabels[+el.dataset.dlabel] = e.target.value })
    document.querySelectorAll('[data-dwait]').forEach(el => el.oninput = e => { state.dWaits[+el.dataset.dwait] = e.target.value })
    document.querySelectorAll('[data-ddel]').forEach(el => el.onclick = () => deskDeleteStep(+el.dataset.ddel))
    document.querySelectorAll('[data-param]').forEach(el => el.oninput = el.onchange = e => { state.dryParams[el.dataset.param] = e.target.value })
    bindSop()
  }
}

render()
loadSystems()
