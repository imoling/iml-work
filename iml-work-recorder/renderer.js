const app = document.getElementById('app')
const LS = window.localStorage

let state = {
  phase: 'setup',          // setup | recording | review
  adminBaseUrl: LS.getItem('adminBaseUrl') || 'http://localhost:8080',
  systems: [],
  systemId: '',
  name: '',
  keywords: '',
  liveSteps: [],
  steps: [],
  marked: {},
  labels: {},
  err: '',
  ok: '',
  saving: false
}
let unsub = null

function set(p) { Object.assign(state, p); render() }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }
function sys() { return state.systems.find(s => s.id === state.systemId) }
function actClass(a) { return a === 'fill' ? 'fill' : a === 'select' ? 'select' : '' }
function actText(a) { return a === 'fill' ? '输入' : a === 'select' ? '选择' : '点击' }

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
  const marked = {}, labels = {}
  steps.forEach((s, i) => { if (s.action !== 'click') { marked[i] = true; labels[i] = s.label || ('字段' + (i + 1)) } })
  set({ phase: 'review', steps, marked, labels })
}

async function cancelRecording() {
  if (unsub) { unsub(); unsub = null }
  await window.api.invoke('recorder:cancel')
  set({ phase: 'setup', liveSteps: [] })
}

function deleteStep(i) {
  state.steps.splice(i, 1)
  const nm = {}, nl = {}
  state.steps.forEach((_, idx) => {})
  // 重新索引标记
  const oldMarked = state.marked, oldLabels = state.labels
  state.marked = {}; state.labels = {}
  // 简化：删后清空标记，让用户重勾（步骤通常不多）
  state.steps.forEach((s, idx) => { if (s.action !== 'click') { state.marked[idx] = true; state.labels[idx] = s.label || ('字段' + (idx + 1)) } })
  render()
}

async function save() {
  state.err = ''; state.ok = ''
  if (state.steps.length === 0) { return set({ err: '没有可保存的操作步骤' }) }
  set({ saving: true })
  const outSteps = state.steps.map((s, i) => state.marked[i] ? Object.assign({}, s, { fieldName: 'f' + i }) : s)
  const fields = state.steps.map((s, i) => state.marked[i]
    ? { name: 'f' + i, label: state.labels[i] || s.label || ('字段' + (i + 1)), type: s.tag === 'textarea' ? 'textarea' : 'text' }
    : null).filter(Boolean)
  const actionScript = JSON.stringify({ steps: outSteps, fields })
  const triggerKeywords = state.keywords.split(/[,，\s]+/).map(k => k.trim()).filter(Boolean)
  const r = await window.api.invoke('admin:save-skill', {
    adminBaseUrl: state.adminBaseUrl.trim(), name: state.name.trim(), triggerKeywords, targetSystemId: state.systemId, actionScript
  })
  state.saving = false
  if (!r || !r.ok) { return set({ err: '保存失败：' + ((r && r.error) || '未知错误') }) }
  set({ phase: 'setup', ok: `技能「${state.name}」已上传至管理端技能中心（${(r.skill && r.skill.id) || ''}）。`, name: '', keywords: '', steps: [], liveSteps: [], marked: {}, labels: {} })
}

function render() {
  let h = ''
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
    h += `<div class="hint">核对录制的操作步骤。把需要每次让用户确认填写的「输入/选择」步骤勾为<b>可填字段</b>并起个名字——执行时会先弹表单让用户确认这些值，再确定性回放全部步骤。</div>`
    h += `<div class="steps">`
    if (state.steps.length === 0) h += `<div class="empty">未捕获到操作步骤</div>`
    state.steps.forEach((s, i) => {
      h += `<div class="step"><span class="no">${i + 1}</span><span class="act ${actClass(s.action)}">${actText(s.action)}</span><span class="lbl" title="${esc(s.selector)}">${esc(s.label || s.selector)}</span>`
      if (s.action !== 'click') {
        h += `<label class="mark"><input type="checkbox" data-mark="${i}" ${state.marked[i] ? 'checked' : ''}/>可填字段`
        if (state.marked[i]) h += `<input type="text" data-label="${i}" value="${esc(state.labels[i] || '')}" placeholder="字段名"/>`
        h += `</label>`
      } else { h += `<span class="val">${esc(s.value)}</span>` }
      h += `<button class="del" data-del="${i}">✕</button></div>`
    })
    h += `</div>`
    if (state.err) h += `<div class="err">${esc(state.err)}</div>`
    h += `<div class="actions"><button id="reset">重录</button><button class="primary" id="save" ${state.saving ? 'disabled' : ''}>${state.saving ? '保存中…' : '保存并上传技能'}</button></div>`
  }
  app.innerHTML = h
  bind()
}

function bind() {
  const $ = id => document.getElementById(id)
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
    $('reset').onclick = () => set({ phase: 'setup' })
    $('save').onclick = save
    document.querySelectorAll('[data-mark]').forEach(el => el.onchange = e => { state.marked[+el.dataset.mark] = e.target.checked; render() })
    document.querySelectorAll('[data-label]').forEach(el => el.oninput = e => { state.labels[+el.dataset.label] = e.target.value })
    document.querySelectorAll('[data-del]').forEach(el => el.onclick = () => deleteStep(+el.dataset.del))
  }
}

render()
loadSystems()
