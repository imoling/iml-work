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
  marked: {},              // i -> bool（是否作为用户确认填写的字段）
  labels: {},              // i -> 字段名
  types: {},               // i -> 'text' | 'select' | 'search'（回放方式）
  waits: {},               // i -> 回放前等待 ms
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
  set({ phase: 'review', steps, marked, labels, types, waits })
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

async function save() {
  state.err = ''; state.ok = ''
  if (state.steps.length === 0) { return set({ err: '没有可保存的操作步骤' }) }
  set({ saving: true })

  // 检索选择(带+)：把紧随其后的"点击结果"步骤折叠成 resultSelector 兜底，并从输出里丢弃该点击步骤
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
    else if (type === 'select' && s.action !== 'select') { o.kind = 'dropdown' } // 自定义下拉（点选式），原生<select>保持 select 动作
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

  const triggerKeywords = state.keywords.split(/[,，\s]+/).map(k => k.trim()).filter(Boolean)
  const r = await window.api.invoke('admin:save-skill', {
    adminBaseUrl: state.adminBaseUrl.trim(), name: state.name.trim(), triggerKeywords, targetSystemId: state.systemId, steps: outSteps, fields
  })
  state.saving = false
  if (!r || !r.ok) { return set({ err: '保存失败：' + ((r && r.error) || '未知错误') }) }
  set({ phase: 'setup', ok: `技能「${state.name}」已转换为语义脚本并上传至技能中心（${(r.skill && r.skill.id) || ''}）。可在管理端「技能中心」查看/编辑脚本。`, name: '', keywords: '', steps: [], liveSteps: [], marked: {}, labels: {}, types: {}, waits: {} })
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
    document.querySelectorAll('[data-type]').forEach(el => el.onchange = e => { state.types[+el.dataset.type] = e.target.value; render() })
    document.querySelectorAll('[data-mark]').forEach(el => el.onchange = e => { state.marked[+el.dataset.mark] = e.target.checked; render() })
    document.querySelectorAll('[data-label]').forEach(el => el.oninput = e => { state.labels[+el.dataset.label] = e.target.value })
    document.querySelectorAll('[data-wait]').forEach(el => el.oninput = e => { state.waits[+el.dataset.wait] = e.target.value })
    document.querySelectorAll('[data-del]').forEach(el => el.onclick = () => deleteStep(+el.dataset.del))
  }
}

render()
loadSystems()
