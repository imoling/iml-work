const app = document.getElementById('app')
const LS = window.localStorage

let state = {
  phase: 'home',           // home | setup | recording | review
  adminBaseUrl: LS.getItem('adminBaseUrl') || 'http://localhost:8080',
  systems: [],
  systemId: '',
  name: '',
  keywords: '',
  liveSteps: [],
  steps: [],
  marked: {},              // i -> bool（是否作为用户确认填写的字段）
  labels: {},              // i -> 字段名
  types: {},               // i -> 'text' | 'select' | 'search'（回放方式）
  waits: {},               // i -> 回放前等待 ms
  err: '',
  ok: '',
  saving: false,
  dryParams: {},           // 试运行参数值 {fieldName: value}
  dryLog: [],              // 试运行步骤日志
  dryRunning: false,
  dryDone: null,           // 试运行结果摘要
  dsl: ''                  // 浏览器技能脚本（可编辑；试运行/同步以此为准）
}
let unsub = null
let dryUnsub = null

function set(p) { Object.assign(state, p); render() }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }
function sys() { return state.systems.find(s => s.id === state.systemId) }
function actClass(a) { return a === 'fill' ? 'fill' : a === 'select' ? 'select' : '' }
function actText(a) { return a === 'fill' ? '输入' : a === 'select' ? '选择' : '点击' }
function hasOptions(s) { return s && Array.isArray(s.options) && s.options.length > 0 }
// UI 类型只有 text / select / search；select 在保存时按 action 自动区分原生<select>与自定义下拉(kind:dropdown)
function defType(s) { return (s.action === 'select' || hasOptions(s)) ? 'select' : 'text' }
function fieldEligible(s) { return s && (s.action !== 'click' || hasOptions(s)) }
function isField(i) { const s = state.steps[i]; if (!fieldEligible(s)) return false; return state.marked[i] || (state.types[i] || defType(s)) === 'search' }

async function loadSystems() {
  const r = await window.api.invoke('admin:systems', { adminBaseUrl: state.adminBaseUrl })
  if (r && r.ok) { state.systems = r.systems; if (!state.systemId && r.systems[0]) state.systemId = r.systems[0].id; state.err = '' }
  else { state.systems = []; state.err = '无法连接管理端：' + ((r && r.error) || '未知错误') }
  render()
}

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
  const marked = {}, labels = {}, types = {}, waits = {}
  steps.forEach((s, i) => {
    types[i] = defType(s)
    if (fieldEligible(s)) { marked[i] = true; labels[i] = s.label || ('字段' + (i + 1)) }
  })
  Object.assign(state, { phase: 'review', steps, marked, labels, types, waits })
  state.dsl = buildArtifacts().dsl   // 生成可编辑的技能脚本（试运行/同步均以此为准）
  set({})
}

async function cancelRecording() {
  if (unsub) { unsub(); unsub = null }
  await window.api.invoke('recorder:cancel')
  set({ phase: 'setup', liveSteps: [] })
}

function deleteStep(i) {
  state.steps.splice(i, 1)
  // 删后重建默认标记（步骤通常不多，简单可靠）
  const marked = {}, labels = {}, types = {}, waits = {}
  state.steps.forEach((s, idx) => { types[idx] = defType(s); if (fieldEligible(s)) { marked[idx] = true; labels[idx] = s.label || ('字段' + (idx + 1)) } })
  set({ marked, labels, types, waits })
}

// 从复核状态构建产物：输出步骤 + 字段定义 + 语义脚本(DSL)
function buildArtifacts() {
  const drop = {}
  state.steps.forEach((s, i) => {
    if ((state.types[i] || defType(s)) === 'search') {
      const nx = state.steps[i + 1]
      if (nx && nx.action === 'click') drop[i + 1] = true
    }
  })
  const outSteps = []
  state.steps.forEach((s, i) => {
    if (drop[i]) return
    const type = state.types[i] || defType(s)
    const o = Object.assign({}, s)
    if (type === 'search') { o.kind = 'search'; const nx = state.steps[i + 1]; if (nx && nx.action === 'click') o.resultSelector = nx.selector }
    else if (type === 'select' && s.action !== 'select') { o.kind = 'dropdown' }
    const w = parseInt(state.waits[i], 10); if (w > 0) o.waitBefore = w
    if (isField(i)) o.fieldName = 'f' + i
    outSteps.push(o)
  })
  const fields = []
  state.steps.forEach((s, i) => {
    if (drop[i]) return
    if (isField(i)) {
      const type = state.types[i] || defType(s)
      const useSelect = type === 'select' && hasOptions(s)
      const ftype = useSelect ? 'select' : type === 'search' ? 'text' : (s.tag === 'textarea' ? 'textarea' : 'text')
      const f = { name: 'f' + i, label: state.labels[i] || s.label || ('字段' + (i + 1)), type: ftype }
      if (useSelect) f.options = s.options
      fields.push(f)
    }
  })
  return { outSteps, fields, dsl: buildDsl(outSteps) }
}

// 录制步骤 → 语义脚本 DSL（与后端 deterministicDsl 一致）
function buildDsl(outSteps) {
  const lines = []
  for (const s of outSteps) {
    const w = parseInt(s.waitBefore, 10); if (w > 0) lines.push('wait ' + w)
    const rhs = s.fieldName ? `{{${s.fieldName}}}` : `"${String(s.value || '').replace(/"/g, '')}"`
    if (s.kind === 'search') lines.push(`searchSelect "${s.label}" = ${rhs}`)
    else if (s.kind === 'dropdown') lines.push(`dropdown "${s.label}" = ${rhs}`)
    else if (s.action === 'select') lines.push(`select "${s.label}" = ${rhs}`)
    else if (s.action === 'fill') lines.push(`fill "${s.label}" = ${rhs}`)
    else if (s.action === 'hover') lines.push(`hover "${(s.label && s.label.trim()) ? s.label : (s.value || '')}"`)
    else if (s.action === 'click') lines.push(`click "${(s.label && s.label.trim()) ? s.label : (s.value || '')}"`)
  }
  return lines.join('\n')
}

// 从（可能被 FDE 编辑过的）脚本里解析出参数；字段元数据（选项/类型）尽量沿用步骤推导的同名字段
function paramsFromDsl(dsl) {
  const names = []; (dsl.match(/\{\{\s*[\w.]+\s*\}\}/g) || []).forEach(m => { const n = m.replace(/[{}]/g, '').trim(); if (!names.includes(n)) names.push(n) })
  const byName = {}; buildArtifacts().fields.forEach(f => { byName[f.name] = f })
  return names.map(n => byName[n] || { name: n, label: n, type: 'text' })
}

// 试运行：在可见浏览器里按脚本跑一遍，FDE 亲眼确认
async function dryRun() {
  const s = sys(); if (!s) { return set({ err: '未找到目标系统' }) }
  const dsl = state.dsl                       // 试运行的是当前（可编辑的）技能脚本，而非原始录制
  const fields = paramsFromDsl(dsl)
  if (!dsl.trim()) { return set({ err: '脚本为空，无法试运行' }) }
  state.err = ''; state.dryLog = []; state.dryRunning = true; state.dryDone = null
  // 默认参数：用录制时的值兜底
  fields.forEach((f, idx) => { if (state.dryParams[f.name] === undefined) state.dryParams[f.name] = '' })
  set({})
  if (dryUnsub) dryUnsub()
  dryUnsub = window.api.on('dryrun:step', (ev) => {
    if (ev.i === -1) { state.dryLog.push(`✗ ${ev.error || ev.desc}`); set({}); return }
    const tag = ev.running ? '▶' : (ev.ok ? '✓' : '✗')
    const line = `${tag} [${ev.i + 1}/${ev.total}] ${ev.desc}${ev.error ? ' — ' + ev.error : ''}`
    if (ev.running) state.dryLog.push(line)
    else state.dryLog[state.dryLog.length - 1] = line
    set({})
  })
  const r = await window.api.invoke('skill:dry-run', { systemId: state.systemId, baseUrl: s.baseUrl, systemName: s.name, dsl, fieldValues: state.dryParams })
  state.dryRunning = false
  if (!r || !r.ok) state.dryDone = { ok: false, msg: '试运行失败：' + ((r && r.error) || '未知错误') }
  else if (!r.loggedIn) state.dryDone = { ok: false, msg: `检测到未登录目标系统。请在弹出的试运行窗口中登录后重试。` }
  else if (r.failedAt >= 0) state.dryDone = { ok: false, msg: `执行到第 ${r.failedAt + 1} 步中断（${r.error || '未找到目标'}），可回到上面调整步骤/等待后重试。` }
  else state.dryDone = { ok: true, msg: `✓ 全部 ${r.done}/${r.total} 步执行成功。请在试运行窗口核对结果，确认无误后同步到管理平台。` }
  set({})
}

async function closeDryRun() { await window.api.invoke('skill:dry-run-close'); }

async function sync() {
  state.err = ''; state.ok = ''
  if (state.steps.length === 0) { return set({ err: '没有可同步的操作步骤' }) }
  set({ saving: true })
  const { outSteps } = buildArtifacts()
  const fields = paramsFromDsl(state.dsl)          // 字段以脚本里实际用到的参数为准
  const triggerKeywords = state.keywords.split(/[,，\s]+/).map(k => k.trim()).filter(Boolean)
  const r = await window.api.invoke('admin:save-skill', {
    adminBaseUrl: state.adminBaseUrl.trim(), name: state.name.trim(), triggerKeywords, targetSystemId: state.systemId, engine: 'browser', script: state.dsl, steps: outSteps, fields
  })
  state.saving = false
  if (!r || !r.ok) { return set({ err: '同步失败：' + ((r && r.error) || '未知错误') }) }
  await closeDryRun()
  set({ phase: 'home', ok: `技能「${state.name}」已同步至管理平台技能中心（${(r.skill && r.skill.id) || ''}）。`, name: '', keywords: '', steps: [], liveSteps: [], marked: {}, labels: {}, types: {}, waits: {}, dryParams: {}, dryLog: [], dryDone: null, dsl: '' })
}

// ===== 桌面自动化技能构建 =====
Object.assign(state, { deskNat: null, dSteps: [], dMarked: {}, dLabels: {}, dWaits: {} })

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
  const marked = {}, labels = {}
  steps.forEach((s, i) => { if (s.op === 'type') { marked[i] = false; labels[i] = '文本' + (i + 1) } })
  set({ phase: 'd-review', dSteps: steps, dMarked: marked, dLabels: labels, dWaits: {} })
}
async function deskCancel() {
  if (dryUnsub) { dryUnsub(); dryUnsub = null }
  await window.api.invoke('desktop:record-cancel')
  set({ phase: 'd-setup', dSteps: [] })
}
function deskDeleteStep(i) {
  state.dSteps.splice(i, 1)
  const marked = {}, labels = {}
  state.dSteps.forEach((s, idx) => { if (s.op === 'type') { marked[idx] = state.dMarked[idx] || false; labels[idx] = state.dLabels[idx] || ('文本' + (idx + 1)) } })
  set({ dMarked: marked, dLabels: labels })
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
  const outSteps = state.dSteps.map((s, i) => {
    const o = Object.assign({}, s)
    const w = parseInt(state.dWaits[i], 10); if (w > 0) o.waitBefore = w
    if (s.op === 'type' && state.dMarked[i]) o.fieldName = 'f' + i
    return o
  })
  const fields = []
  state.dSteps.forEach((s, i) => { if (s.op === 'type' && state.dMarked[i]) fields.push({ name: 'f' + i, label: state.dLabels[i] || ('文本' + (i + 1)), type: 'text' }) })
  return { outSteps, fields, dsl: buildDesktopDsl(outSteps) }
}

async function deskDryRun() {
  const { dsl } = buildDesktopArtifacts()
  if (!dsl.trim()) { return set({ err: '脚本为空，无法试运行' }) }
  state.err = ''; state.dryLog = []; state.dryRunning = true; state.dryDone = null; set({})
  if (dryUnsub) dryUnsub()
  dryUnsub = window.api.on('dryrun:step', (ev) => {
    const tag = ev.running ? '▶' : (ev.ok ? '✓' : '✗')
    const line = `${tag} [${ev.i + 1}/${ev.total}] ${ev.desc}${ev.error ? ' — ' + ev.error : ''}`
    if (ev.running) state.dryLog.push(line); else state.dryLog[state.dryLog.length - 1] = line
    set({})
  })
  const r = await window.api.invoke('desktop:dry-run', { dsl, fieldValues: state.dryParams })
  state.dryRunning = false
  if (!r || !r.ok) state.dryDone = { ok: false, msg: '试运行失败：' + ((r && r.error) || '未知错误') }
  else if (r.failedAt >= 0) state.dryDone = { ok: false, msg: `执行到第 ${r.failedAt + 1} 步中断（${r.error || '失败'}）。` }
  else state.dryDone = { ok: true, msg: `✓ 全部 ${r.done}/${r.total} 步执行成功。确认无误后同步到管理平台。` }
  set({})
}

async function deskSync() {
  state.err = ''; state.ok = ''
  if (state.dSteps.length === 0) { return set({ err: '没有可同步的操作步骤' }) }
  set({ saving: true })
  const { outSteps, fields, dsl } = buildDesktopArtifacts()
  const triggerKeywords = state.keywords.split(/[,，\s]+/).map(k => k.trim()).filter(Boolean)
  const r = await window.api.invoke('admin:save-skill', {
    adminBaseUrl: state.adminBaseUrl.trim(), name: state.name.trim(), triggerKeywords, targetSystemId: '', engine: 'desktop', script: dsl, steps: outSteps, fields
  })
  state.saving = false
  if (!r || !r.ok) { return set({ err: '同步失败：' + ((r && r.error) || '未知错误') }) }
  set({ phase: 'home', ok: `桌面技能「${state.name}」已同步至管理平台技能中心（${(r.skill && r.skill.id) || ''}）。`, name: '', keywords: '', dSteps: [], dMarked: {}, dLabels: {}, dWaits: {}, dryParams: {}, dryLog: [], dryDone: null })
}

const CAPS = [
  { id: 'browser', icon: '🌐', title: '浏览器自动化技能构建', on: true, desc: '录制业务系统(CRM/OA等)的网页操作，生成语义脚本，可见浏览器试运行后同步到管理平台。' },
  { id: 'desktop', icon: '🖥️', title: '桌面自动化技能构建', on: true, desc: '全局录制桌面应用的鼠标点击/键盘操作，生成桌面脚本，本机试运行确认后同步到管理平台。' },
  { id: 'terminal', icon: '⌨️', title: '终端 / 脚本能力', on: false, desc: '构建以命令行/脚本实现的自动化技能。' }
]

function render() {
  let h = ''
  if (state.phase === 'home') {
    h += `<div class="hint">选择要构建的技能类型。FDE 在本地录制/编排，生成标准语义脚本，确认无误后同步到管理平台技能中心，供各岗位工作分身按权限调用。</div>`
    if (state.ok) h += `<div class="ok">✅ ${esc(state.ok)}</div>`
    h += `<div class="home-grid">`
    CAPS.forEach(c => {
      h += `<div class="cap-card ${c.on ? '' : 'disabled'}" ${c.on ? `data-cap="${c.id}"` : ''}>
        <div class="cap-ic">${c.icon}</div>
        <div class="cap-title">${esc(c.title)} <span class="cap-badge ${c.on ? 'on' : 'soon'}">${c.on ? '可用' : '待开发'}</span></div>
        <div class="cap-desc">${esc(c.desc)}</div>
      </div>`
    })
    h += `</div>`
    app.innerHTML = h; bind(); return
  }
  // 非首页统一带返回首页面包屑
  const capName = state.phase.startsWith('d-') ? '桌面自动化技能构建' : '浏览器自动化技能构建'
  h += `<div class="crumb"><a id="goHome">← 首页</a><span>/</span><span>${capName}</span></div>`
  if (state.phase === 'setup') {
    h += `<div class="hint">选择目标业务系统并命名技能，点「开始录制」会打开一个浏览器窗口（请在其中正常登录并操作一遍）。平台只记录每一步的点击/输入与稳健定位，<b>不会保存任何登录态</b>，仅上传可回放的操作步骤。</div>`
    if (state.ok) h += `<div class="ok">✅ ${esc(state.ok)}</div>`
    h += `<div><label class="fl">管理端地址</label><input id="admin" value="${esc(state.adminBaseUrl)}" placeholder="http://localhost:8080" /></div>`
    h += `<div><label class="fl">目标业务系统</label><select id="sysSel">`
    if (state.systems.length === 0) h += `<option value="">（未获取到业务系统，确认管理端地址后点刷新）</option>`
    state.systems.forEach(s => { h += `<option value="${esc(s.id)}" ${s.id === state.systemId ? 'selected' : ''}>${esc(s.name)}（${esc(s.type)}）</option>` })
    h += `</select></div>`
    h += `<div class="row"><div><label class="fl">技能名称</label><input id="name" value="${esc(state.name)}" placeholder="例如：CRM 客户拜访记录录入" /></div>`
    h += `<div><label class="fl">触发关键词（逗号/空格分隔）</label><input id="kw" value="${esc(state.keywords)}" placeholder="拜访记录, 填写拜访" /></div></div>`
    if (state.err) h += `<div class="err">${esc(state.err)}</div>`
    h += `<div class="actions"><button id="refresh">刷新系统列表</button><button class="primary" id="start">● 开始录制</button></div>`
  } else if (state.phase === 'recording') {
    h += `<div class="recbar"><span class="dot"></span>正在录制 ·「${esc(sys() ? sys().name : '')}」· 请在弹出的浏览器窗口中登录并操作，完成后点「结束录制」</div>`
    h += `<div class="steps">`
    if (state.liveSteps.length === 0) h += `<div class="empty">等待操作…每次点击/输入都会出现在这里</div>`
    state.liveSteps.forEach((s) => { h += `<div class="step"><span class="act ${actClass(s.action)}">${actText(s.action)}</span><span class="lbl" title="${esc(s.selector)}">${esc(s.label || s.selector)}</span>${s.value ? `<span class="val">${esc(s.value)}</span>` : ''}</div>` })
    h += `</div>`
    h += `<div class="actions"><button id="cancel">取消</button><button class="primary" id="stop">■ 结束录制（${state.liveSteps.length} 步）</button></div>`
  } else if (state.phase === 'review') {
    h += `<div class="hint">核对步骤。<b>输入/选择</b>步骤可勾为「可填字段」（执行时先弹表单确认）。对纷享销客<b>带 + 的检索框</b>（客户/联系人），把对应的输入步骤类型改成「检索选择」——回放时会填入关键词、等结果出现、再点匹配项（其后录到的"点击结果"步骤可删，会自动当兜底）。需要等页面/异步渲染时，在「等待」里填毫秒数。</div>`
    h += `<div class="steps">`
    if (state.steps.length === 0) h += `<div class="empty">未捕获到操作步骤</div>`
    state.steps.forEach((s, i) => {
      const type = state.types[i] || defType(s)
      const optCount = hasOptions(s) ? s.options.length : 0
      h += `<div class="step"><span class="no">${i + 1}</span><span class="act ${actClass(s.action)}">${actText(s.action)}</span><span class="lbl" title="${esc(s.selector)}">${esc(s.label || s.selector)}</span>`
      if (fieldEligible(s)) {
        h += `<select class="ty" data-type="${i}">
          ${s.action === 'click' ? '' : `<option value="text" ${type === 'text' ? 'selected' : ''}>普通输入</option>`}
          <option value="select" ${type === 'select' ? 'selected' : ''}>下拉选择${optCount ? `(${optCount}项)` : ''}</option>
          <option value="search" ${type === 'search' ? 'selected' : ''}>检索选择(带+)</option>
        </select>`
        const fieldOn = isField(i)
        h += `<label class="mark"><input type="checkbox" data-mark="${i}" ${fieldOn ? 'checked' : ''} ${type === 'search' ? 'disabled' : ''}/>可填字段`
        if (fieldOn) h += `<input type="text" data-label="${i}" value="${esc(state.labels[i] || '')}" placeholder="字段名"/>`
        h += `</label>`
        if (optCount) h += `<span class="opts" title="${esc(s.options.join(' / '))}">选项:${optCount}</span>`
      } else { h += `<span class="val">${esc(s.value)}</span>` }
      h += `<input type="number" class="wait" data-wait="${i}" value="${esc(state.waits[i] || '')}" placeholder="等待ms" title="回放该步前等待的毫秒数"/>`
      h += `<button class="del" data-del="${i}">✕</button></div>`
    })
    h += `</div>`

    // —— 技能脚本（可编辑）+ 试运行：所测即所部署 ——
    const fields = paramsFromDsl(state.dsl)
    h += `<div class="build-sec"><div class="build-head" style="display:flex;align-items:center;justify-content:space-between">
      <span>技能脚本（语义 DSL · 可编辑，试运行/同步以此为准）</span>
      <a id="regenDsl" style="font-size:11px;color:var(--brand);cursor:pointer">↻ 由步骤重新生成</a>
    </div><textarea id="dslEdit" class="dsl-edit" spellcheck="false">${esc(state.dsl)}</textarea>
    <div style="font-size:11px;color:var(--muted);margin-top:4px">可手动增删/改写：如补 <code>hover "菜单"</code>、<code>wait 800</code>、<code>waitText "保存成功"</code>，或调整定位文本；用 <code>{{字段}}</code> 表示需用户确认的参数。</div></div>`
    if (fields.length) {
      h += `<div class="build-sec"><div class="build-head">试运行参数（FDE 填入测试值）</div><div class="param-grid">`
      fields.forEach(f => {
        const v = state.dryParams[f.name] !== undefined ? state.dryParams[f.name] : ''
        h += `<div class="param-row"><label>${esc(f.label)}</label>`
        if (f.type === 'select' && Array.isArray(f.options)) {
          h += `<select data-param="${f.name}"><option value="">（请选择）</option>${f.options.map(o => `<option value="${esc(o)}" ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
        } else {
          h += `<input data-param="${f.name}" value="${esc(v)}" placeholder="测试值"/>`
        }
        h += `</div>`
      })
      h += `</div></div>`
    }
    if (state.dryLog.length || state.dryRunning || state.dryDone) {
      h += `<div class="build-sec"><div class="build-head">试运行控制台 ${state.dryRunning ? '<span class="dry-run-tag">运行中…</span>' : ''}</div>`
      h += `<pre class="dry-console">${state.dryLog.map(esc).join('\n') || '...'}</pre>`
      if (state.dryDone) h += `<div class="${state.dryDone.ok ? 'ok' : 'err'}" style="margin-top:6px">${esc(state.dryDone.msg)}</div>`
      h += `</div>`
    }
    if (state.err) h += `<div class="err">${esc(state.err)}</div>`
    h += `<div class="actions">
      <button id="reset">重录</button>
      <div style="flex:1"></div>
      <button id="dryrun" ${state.dryRunning ? 'disabled' : ''}>${state.dryRunning ? '试运行中…' : '▶ 试运行（可见浏览器）'}</button>
      <button class="primary" id="sync" ${state.saving ? 'disabled' : ''} title="${state.dryDone && state.dryDone.ok ? '' : '建议先试运行确认无误'}">${state.saving ? '同步中…' : '⇧ 同步到管理平台'}</button>
    </div>`
  } else if (state.phase === 'd-setup') {
    const n = state.deskNat
    h += `<div class="hint">桌面自动化：开始录制后，平台会<b>全局捕获你的鼠标点击与键盘操作</b>（坐标 + 按键），生成可回放的桌面脚本。文本输入建议在复核时设为<b>可填字段</b>，由参数注入（支持中文）。</div>`
    if (state.ok) h += `<div class="ok">✅ ${esc(state.ok)}</div>`
    if (n) {
      const okRec = n.recordReady, okRep = n.replayReady
      h += `<div class="dep-box ${okRec && okRep ? 'ok' : 'warn'}">
        <div>原生录制(uiohook-napi)：${okRec ? '✓ 就绪' : '✗ 未安装'} · 桌面回放(nut-js)：${okRep ? '✓ 就绪' : '✗ 未安装'}</div>
        ${n.missing && n.missing.length ? `<div style="margin-top:4px">缺少：${esc(n.missing.join('、'))} —— 在工具目录执行 <code>npm install</code> 安装。</div>` : ''}
        ${n.permissionNote ? `<div style="margin-top:4px">${esc(n.permissionNote)}</div>` : ''}
      </div>`
    } else h += `<div class="dep-box warn">正在检测原生依赖…</div>`
    h += `<div><label class="fl">管理端地址</label><input id="admin" value="${esc(state.adminBaseUrl)}" placeholder="http://localhost:8080" /></div>`
    h += `<div class="row"><div><label class="fl">技能名称</label><input id="name" value="${esc(state.name)}" placeholder="例如：财务系统月结导出" /></div>`
    h += `<div><label class="fl">触发关键词（逗号/空格分隔）</label><input id="kw" value="${esc(state.keywords)}" placeholder="月结导出, 导出报表" /></div></div>`
    if (state.err) h += `<div class="err">${esc(state.err)}</div>`
    const canRec = state.deskNat && state.deskNat.recordReady
    h += `<div class="actions"><button id="recheck">重新检测依赖</button><button class="primary" id="dstart" ${canRec ? '' : 'disabled'} title="${canRec ? '' : '需先安装 uiohook-napi 并授予辅助功能权限'}">● 开始录制</button></div>`
  } else if (state.phase === 'd-record') {
    h += `<div class="recbar"><span class="dot"></span>正在全局录制桌面操作 · 请正常操作目标应用，完成后回到本窗口点「结束录制」</div>`
    h += `<div class="steps">`
    if (state.dSteps.length === 0) h += `<div class="empty">等待操作…每次点击/按键都会出现在这里</div>`
    state.dSteps.forEach((s) => { h += `<div class="step"><span class="act ${s.op === 'type' ? 'fill' : ''}">${dActText(s.op)}</span><span class="lbl">${s.x !== undefined ? s.x + ',' + s.y : esc(s.value || '')}</span></div>` })
    h += `</div>`
    h += `<div class="actions"><button id="dcancel">取消</button><button class="primary" id="dstop">■ 结束录制（${state.dSteps.length} 步）</button></div>`
  } else if (state.phase === 'd-review') {
    h += `<div class="hint">核对桌面操作步骤。<b>输入</b>类步骤可勾为「可填字段」（执行时由表单参数注入，支持中文）。需要等应用响应时在「等待」里填毫秒。坐标随屏幕分辨率/窗口位置变化，回放前请保持目标窗口位置一致。</div>`
    h += `<div class="steps">`
    if (state.dSteps.length === 0) h += `<div class="empty">未捕获到操作步骤</div>`
    state.dSteps.forEach((s, i) => {
      h += `<div class="step"><span class="no">${i + 1}</span><span class="act ${s.op === 'type' ? 'fill' : ''}">${dActText(s.op)}</span><span class="lbl">${s.x !== undefined ? s.x + ',' + s.y : esc(s.value || '')}</span>`
      if (s.op === 'type') {
        const on = !!state.dMarked[i]
        h += `<label class="mark"><input type="checkbox" data-dmark="${i}" ${on ? 'checked' : ''}/>可填字段`
        if (on) h += `<input type="text" data-dlabel="${i}" value="${esc(state.dLabels[i] || '')}" placeholder="字段名"/>`
        h += `</label>`
      }
      h += `<input type="number" class="wait" data-dwait="${i}" value="${esc(state.dWaits[i] || '')}" placeholder="等待ms"/>`
      h += `<button class="del" data-ddel="${i}">✕</button></div>`
    })
    h += `</div>`
    const da = buildDesktopArtifacts()
    h += `<div class="build-sec"><div class="build-head">生成的桌面脚本</div><pre class="dsl-box">${esc(da.dsl) || '（空）'}</pre></div>`
    if (da.fields.length) {
      h += `<div class="build-sec"><div class="build-head">试运行参数</div><div class="param-grid">`
      da.fields.forEach(f => { const v = state.dryParams[f.name] !== undefined ? state.dryParams[f.name] : ''; h += `<div class="param-row"><label>${esc(f.label)}</label><input data-param="${f.name}" value="${esc(v)}" placeholder="测试值"/></div>` })
      h += `</div></div>`
    }
    if (state.dryLog.length || state.dryRunning || state.dryDone) {
      h += `<div class="build-sec"><div class="build-head">试运行控制台 ${state.dryRunning ? '<span class="dry-run-tag">运行中…</span>' : ''}</div><pre class="dry-console">${state.dryLog.map(esc).join('\n') || '...'}</pre>`
      if (state.dryDone) h += `<div class="${state.dryDone.ok ? 'ok' : 'err'}" style="margin-top:6px">${esc(state.dryDone.msg)}</div>`
      h += `</div>`
    }
    if (state.err) h += `<div class="err">${esc(state.err)}</div>`
    h += `<div class="actions"><button id="dreset">重录</button><div style="flex:1"></div>
      <button id="ddryrun" ${state.dryRunning ? 'disabled' : ''}>${state.dryRunning ? '试运行中…' : '▶ 试运行（本机操作）'}</button>
      <button class="primary" id="dsync" ${state.saving ? 'disabled' : ''}>${state.saving ? '同步中…' : '⇧ 同步到管理平台'}</button></div>`
  }
  app.innerHTML = h
  bind()
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
    { const de = $('dslEdit'); if (de) de.oninput = e => { state.dsl = e.target.value } }
    { const rg = $('regenDsl'); if (rg) rg.onclick = () => { state.dsl = buildArtifacts().dsl; render() } }
    document.querySelectorAll('[data-type]').forEach(el => el.onchange = e => { state.types[+el.dataset.type] = e.target.value; state.dsl = buildArtifacts().dsl; render() })
    document.querySelectorAll('[data-mark]').forEach(el => el.onchange = e => { state.marked[+el.dataset.mark] = e.target.checked; state.dsl = buildArtifacts().dsl; render() })
    document.querySelectorAll('[data-label]').forEach(el => el.oninput = e => { state.labels[+el.dataset.label] = e.target.value })
    document.querySelectorAll('[data-wait]').forEach(el => { el.oninput = e => { state.waits[+el.dataset.wait] = e.target.value }; el.onchange = () => { state.dsl = buildArtifacts().dsl; render() } })
    document.querySelectorAll('[data-del]').forEach(el => el.onclick = () => { deleteStep(+el.dataset.del); state.dsl = buildArtifacts().dsl; render() })
    document.querySelectorAll('[data-param]').forEach(el => el.oninput = el.onchange = e => { state.dryParams[el.dataset.param] = e.target.value })
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
  }
}

render()
loadSystems()
