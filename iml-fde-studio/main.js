const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { RECORDER_JS, SNAPSHOT_FN, runAgentic, runAgenticSop, stepsToReadable, sleep } = require('./automation')

let toolWin = null
let recorderCtx = null      // Playwright 录制持久化上下文
let recorderSteps = []
let dryCtx = null           // Playwright 试运行持久化上下文
let verifyCtx = null        // Playwright 连接验证持久化上下文

function chromium() { return require('playwright').chromium }
// 每个业务系统一个持久化 Chrome 用户目录（录制/试运行共享 → 登录态保留；绝不上传）
function profileDir(systemId) { return path.join(app.getPath('userData'), 'pwprofile-' + (systemId || 'default')) }

// 统一启动持久化上下文。无头模式下抹掉「自动化/无头」指纹（HeadlessChrome UA、navigator.webdriver、
// AutomationControlled），否则企业 SSO 会把它当成爬虫、拒绝复用 Profile 里的登录会话 → 误报"未登录"。
async function launchCtx(systemId, headless) {
  const ctx = await chromium().launchPersistentContext(profileDir(systemId), {
    channel: 'chrome', headless: !!headless,
    // 有头：用真实窗口尺寸（viewport:null）；无头：必须给真实视口，否则 SPA 不渲染、body 近乎空 → 误判未登录、agent 也看不到页面
    viewport: headless ? { width: 1366, height: 900 } : null,
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled', ...(headless ? ['--window-size=1366,900'] : [])]
  })
  // 所有页面：隐藏 webdriver 标记（登录态由 Profile 携带，不上传任何凭证）
  await ctx.addInitScript(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => false }) } catch (_) {} }).catch(() => {})
  if (headless) {
    const page = ctx.pages()[0] || await ctx.newPage()
    try {
      const ua = await page.evaluate(() => navigator.userAgent)
      if (/Headless/i.test(ua)) {
        const fixed = ua.replace(/Headless/gi, '')   // HeadlessChrome → Chrome，与登录时同一浏览器指纹
        const cdp = await ctx.newCDPSession(page)
        await cdp.send('Network.setUserAgentOverride', { userAgent: fixed })
      }
    } catch (_) {}
  }
  return ctx
}

function toolSend(channel, payload) { if (toolWin && !toolWin.isDestroyed()) toolWin.webContents.send(channel, payload) }

function createWindow() {
  toolWin = new BrowserWindow({
    width: 1320, height: 900, minWidth: 1080, minHeight: 680, title: 'iML Work · FDE 工作台',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  // dev: Vite 开发服务器（热更新）；prod: 构建产物 dist/index.html
  const devUrl = process.env.FDE_DEV_URL
  if (devUrl) { toolWin.loadURL(devUrl) }
  else if (fs.existsSync(path.join(__dirname, 'dist', 'index.html'))) { toolWin.loadFile(path.join(__dirname, 'dist', 'index.html')) }
  else { toolWin.loadURL('data:text/html,<body style="font-family:sans-serif;padding:40px;color:%23374151"><h2>FDE 工作台未构建</h2><p>请先运行 <code>npm run build</code>（或开发模式 <code>npm run dev</code> + <code>npm run app</code>）。</p></body>') }
}
app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

// 经企业模型中转站做一次决策（自愈智能体用）
async function callRelay(adminBaseUrl, prompt) {
  const base = (adminBaseUrl || '').replace(/\/$/, '')
  const res = await fetch(`${base}/api/v1/model/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-corp-default-key' },
    body: JSON.stringify({ model: 'corp-default', messages: [{ role: 'user', content: prompt }] })
  })
  if (!res.ok) throw new Error('relay ' + res.status)
  const data = await res.json()
  return data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : ''
}

// 工具调用版中转：返回模型完整 message（含 tool_calls），供 SOP-Agent 引擎用
async function callRelayTools(adminBaseUrl, messages, tools) {
  const base = (adminBaseUrl || '').replace(/\/$/, '')
  const res = await fetch(`${base}/api/v1/model/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-corp-default-key' },
    body: JSON.stringify({ model: 'corp-default', messages, tools, tool_choice: 'auto', temperature: 0 })
  })
  if (!res.ok) throw new Error('relay ' + res.status)
  const data = await res.json()
  return data && data.choices && data.choices[0] ? data.choices[0].message : null
}

// ===== 通用后端代理（React 端所有 /api/v1/** 调用走这里，规避 CORS、复用主进程网络）=====
ipcMain.handle('fde:api', async (_e, { baseUrl, method, path: p, body, token }) => {
  try {
    const url = (baseUrl || 'http://localhost:8080').replace(/\/$/, '') + p
    // 模型推理端点用服务间共享密钥（网关会把非 corp 的 Bearer 当作上游 provider key 转发）；
    // 其余业务端点用登录用户 token（缺失回退共享密钥）。
    const isModelChat = (p || '').startsWith('/api/v1/model/chat')
    const authz = isModelChat ? 'Bearer sk-corp-default-key' : (token ? `Bearer ${token}` : 'Bearer sk-corp-default-key')
    const res = await fetch(url, {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json', 'Authorization': authz, 'X-Client': 'fde' },
      body: body != null ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let data; try { data = text ? JSON.parse(text) : null } catch (_) { data = text }
    return { ok: res.ok, status: res.status, data }
  } catch (e) { return { ok: false, status: 0, error: e.message } }
})

// ===== 管理端对接 =====
ipcMain.handle('admin:systems', async (_e, { adminBaseUrl }) => {
  try {
    const base = (adminBaseUrl || '').replace(/\/$/, '')
    const res = await fetch(`${base}/api/v1/integrations`)
    if (!res.ok) return { ok: false, systems: [], error: `HTTP ${res.status}` }
    const list = await res.json()
    const systems = (Array.isArray(list) ? list : []).map(s => ({ id: s.id, type: s.type, name: s.name, baseUrl: s.baseUrl }))
    return { ok: true, systems }
  } catch (e) { return { ok: false, systems: [], error: e.message } }
})

// 上传技能：rich steps(带指纹) + 可读脚本 + SOP；后端原样存。仅含步骤/指纹，绝不含登录态。
ipcMain.handle('admin:save-skill', async (_e, { adminBaseUrl, name, triggerKeywords, targetSystemId, steps, fields, engine, script, sop }) => {
  try {
    const base = (adminBaseUrl || '').replace(/\/$/, '')
    const body = {
      name, triggerKeywords: triggerKeywords || [], targetSystemId: targetSystemId || '',
      steps: steps || [], fields: fields || [], engine: engine || 'browser',
      script: script || (engine === 'desktop' ? '' : stepsToReadable(steps || [])), sop: sop || ''
    }
    const res = await fetch(`${base}/api/v1/skills/from-recording`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, skill: await res.json() }
  } catch (e) { return { ok: false, error: e.message } }
})

// 试运行阶段：根据脚本生成 SOP（经管理端模型中转站），供 FDE 编辑后随技能同步。
ipcMain.handle('skill:gen-sop', async (_e, { adminBaseUrl, name, script, fields, engine }) => {
  try {
    const base = (adminBaseUrl || '').replace(/\/$/, '')
    const res = await fetch(`${base}/api/v1/skills/gen-sop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, script: script || '', fields: fields || [], engine: engine || 'browser' })
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const d = await res.json()
    return { ok: true, sop: d.sop || '' }
  } catch (e) { return { ok: false, error: e.message } }
})

// ===== 浏览器自动化：录制（Playwright 真实 Chrome）=====
// 空标签 = 没有自身文字（开下拉/搜索框/级联标题的触发器），或纯字符计数(0/2000)
function isBlankLabel(l) {
  const t = String(l || '').trim()
  return !t || /^\d+\s*\/\s*\d+$/.test(t)
}
// 结果项文字清洗：去「最近使用」前缀、压空白、截断
function cleanPick(l) {
  return String(l || '').replace(/^最近使用\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 40)
}
// 归并「开下拉的空标签 click + 紧随的有标签 click(结果项)」→ 一个可参数化的 search 字段。
// 讯飞/纷享的客户/联系人/部门等关联对象是"点开搜索框→点结果项"两步 click，
// 不归并就会焊死成 click 的具体值（中石油/李主任），审阅区也够不着、无法参数化。
// 归并后它们成为可命名、可标「参数」的字段，SOP 也写成「填入{{拜访客户}}」而非具体值。
function mergeSelections(steps) {
  const isOpener = (s) => s && s.act === 'click' && !s.nav && isBlankLabel(s.label)
  const out = []
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i], nx = steps[i + 1]
    // 开下拉空 click 紧接 fill：丢弃这个聚焦 click（fill 本身已能定位输入框）
    if (isOpener(s) && nx && nx.act === 'fill') continue
    // 开下拉空 click + 有标签且无导航的 click(结果项) → 合并成一个 search 字段
    if (isOpener(s) && nx && nx.act === 'click' && !nx.nav && !isBlankLabel(nx.label)) {
      out.push({ act: 'search', label: '', value: cleanPick(nx.label), fp: s.fp, result: nx.fp, menu: true })
      i++
      continue
    }
    out.push(s)
  }
  return out
}
// 录制后清洗：fill+紧随的 pickOption 合并为 search(带+检索框)；丢冗余 hover；去连续重复
function refineSteps(raw) {
  // 先把"点击后实际导航"(navResult) 合并进其前一个 click，覆盖 href 占位(#/000)抓不到的真实路由
  const merged = []
  for (const s of raw) {
    if (s.act === 'navResult') {
      for (let k = merged.length - 1; k >= 0; k--) {
        if (merged[k].act === 'click') { merged[k].nav = s.nav; break }
      }
      continue
    }
    merged.push(s)
  }
  raw = merged
  const a = []
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i], nx = raw[i + 1]
    if (s.act === 'fill' && nx && nx.act === 'pickOption') { a.push({ act: 'search', label: s.label, value: nx.value, fp: s.fp }); i++; continue }
    a.push(s)
  }
  const res = []
  for (let j = 0; j < a.length; j++) {
    const s = a[j], nx = a[j + 1]
    const ssel = s.fp && s.fp.sel
    if (s.act === 'hover' && nx && nx.fp && ssel && nx.fp.sel === ssel) continue
    const prev = res[res.length - 1]
    if (prev && prev.act === s.act && prev.fp && ssel && prev.fp.sel === ssel && prev.value === s.value) continue
    res.push(s)
  }
  // 折叠"为展开折叠菜单而做的 hover / 菜单点击"：哈希导航点击自带跳转，前面的展开手势可丢弃
  const out = []
  for (const s of res) {
    if (s.act === 'click' && s.nav) {
      while (out.length) {
        const p = out[out.length - 1]
        if (p.act === 'hover' || (p.act === 'click' && p.menu && !p.nav)) out.pop()
        else break
      }
    }
    out.push(s)
  }
  // 最后归并点选关联对象（开下拉+选结果 → 可参数化字段）
  return mergeSelections(out)
}

function attachRecorder(ctx) {
  const onConsole = (msg) => {
    let t = ''
    try { t = msg.text() } catch (_) { return }
    if (typeof t !== 'string' || !t.startsWith('__IMLREC__')) return
    try {
      const step = JSON.parse(t.slice('__IMLREC__'.length))
      const last = recorderSteps[recorderSteps.length - 1]
      if (step.act === 'fill' && last && last.act === 'fill' && last.fp && step.fp && last.fp.sel === step.fp.sel) last.value = step.value
      else recorderSteps.push(step)
      toolSend('recorder:step', { act: step.act, label: step.label, value: step.value })
    } catch (_) {}
  }
  ctx.on('page', (p) => p.on('console', onConsole))
  ctx.pages().forEach(p => p.on('console', onConsole))
}

ipcMain.handle('recorder:start', async (_e, { systemId, baseUrl, systemName }) => {
  try {
    if (recorderCtx) { try { await recorderCtx.close() } catch (_) {} recorderCtx = null }
    recorderSteps = []
    const ctx = await chromium().launchPersistentContext(profileDir(systemId), { channel: 'chrome', headless: false, viewport: null, args: ['--no-first-run'] })
    recorderCtx = ctx
    await ctx.addInitScript(RECORDER_JS)
    attachRecorder(ctx)
    const page = ctx.pages()[0] || await ctx.newPage()
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('recorder:stop', async () => {
  const steps = refineSteps(recorderSteps.slice())
  if (recorderCtx) { try { await recorderCtx.close() } catch (_) {} recorderCtx = null }
  // 读取/写入分流：含填写/选择/检索即为写入类，否则为读取类（纯导航/查看）。
  // 读取类技能在客户端走"SOP 打开页面+按导航直达+抓取"，不必脆弱回放，更稳。
  const isWrite = steps.some(s => ['fill', 'select', 'search', 'pickOption'].includes(s.act))
  const navHash = (steps.find(s => s.act === 'click' && s.nav) || {}).nav || ''
  return { ok: true, steps, skillKind: isWrite ? 'write' : 'read', navHash }
})

ipcMain.handle('recorder:cancel', async () => {
  recorderSteps = []
  if (recorderCtx) { try { await recorderCtx.close() } catch (_) {} recorderCtx = null }
  return { ok: true }
})

// ===== 浏览器自动化：试运行（Playwright 真实 Chrome，agent 主驱动）=====
ipcMain.handle('skill:dry-run', async (_e, { systemId, baseUrl, systemName, steps, fieldValues, sop, adminBaseUrl, mode, navHash, headless }) => {
  try {
    if (dryCtx) { try { await dryCtx.close() } catch (_) {} dryCtx = null }
    const ctx = await launchCtx(systemId, headless)
    dryCtx = ctx
    const page = ctx.pages()[0] || await ctx.newPage()
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    // 登录态检查
    const txt = await page.evaluate(`(document.body?document.body.innerText:'').slice(0,1500)`).catch(() => '')
    if ((txt || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test((txt || '').toLowerCase())) {
      toolSend('dryrun:line', headless ? '无头模式下检测到未登录：请先关掉「无头浏览器」、在弹出窗口登录一次（登录态会本地保留），之后再开无头跑。' : '检测到未登录目标系统，请在试运行窗口登录后重试（登录态会本地保留）。')
      return { ok: true, loggedIn: false, done: 0, total: (steps || []).length }
    }
    // ARIA 体检：navHash 直达后 dump 无障碍树，评估"语义感知"够不够（决定 ARIA 树 vs Stagehand）
    if (mode === 'aria-probe') {
      const ACTIONABLE = ['button', 'textbox', 'searchbox', 'combobox', 'menuitem', 'menuitemcheckbox', 'link', 'checkbox', 'radio', 'option', 'tab', 'listbox', 'spinbutton', 'switch', 'treeitem']
      const dump = async (label) => {
        let ax = null
        try { ax = await page.accessibility.snapshot({ interestingOnly: false }) } catch (e) { toolSend('dryrun:line', `── ${label}：AX 快照失败 ${e.message}`); return }
        const flat = []
        ;(function walk(n) { if (!n) return; flat.push({ role: n.role, name: n.name || '' }); (n.children || []).forEach(walk) })(ax)
        const FIELD = ['textbox', 'combobox', 'searchbox', 'spinbutton', 'checkbox', 'radio', 'listbox', 'switch', 'slider']
        const fields = flat.filter(n => FIELD.includes(n.role))
        const labels = flat.filter(n => n.role === 'LabelText' && n.name).map(n => n.name)
        const btns = flat.filter(n => n.role === 'button' && n.name)
        const counts = {}; flat.forEach(n => { counts[n.role] = (counts[n.role] || 0) + 1 })
        const topRoles = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => k + '=' + v).join(' ')
        toolSend('dryrun:line', `── ${label}：AX 节点 ${flat.length}；角色 ${topRoles}`)
        toolSend('dryrun:line', `   ▶ 表单字段(${fields.length})：` + (fields.slice(0, 30).map(n => `${n.role}"${n.name}"`).join('  ') || '无'))
        toolSend('dryrun:line', `   ▶ 字段标签 LabelText(${labels.length})：` + (labels.slice(0, 30).join(' / ') || '无'))
        toolSend('dryrun:line', `   ▶ 命名按钮(${btns.length})：` + (btns.slice(0, 20).map(n => `"${n.name}"`).join(' ') || '无'))
      }
      toolSend('dryrun:line', '【ARIA 体检】评估页面无障碍树是否够 agent 看懂…')
      if (navHash) { try { await page.evaluate((h) => { if (location.hash !== h) location.hash = h }, navHash) } catch (_) {}; await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await sleep(2800) }
      await dump('当前页(列表)')
      try {
        const nb = page.getByText('新建', { exact: true }).first()
        if (await nb.count()) { toolSend('dryrun:line', '→ 用文本「新建」找到入口，点击打开表单…'); await nb.click({ timeout: 6000 }); await sleep(2800); await dump('新建表单') }
        else { toolSend('dryrun:line', '⚠️ 列表页用文本「新建」未定位到按钮（可能 a11y 偏弱或在 iframe）') }
      } catch (e) { toolSend('dryrun:line', '打开表单失败：' + e.message) }
      // dump「销售平台归属」自定义控件的真实 DOM 结构（不再靠猜）
      try {
        const struct = await page.evaluate(() => {
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
          const all = Array.from(document.querySelectorAll('*'))
          let el = null
          for (const e of all) {
            const t = norm(e.textContent), ph = e.getAttribute && (e.getAttribute('placeholder') || '')
            if (((t === '请先选择销售平台归属' || (t.indexOf('销售平台归属') >= 0 && t.length < 16)) || (ph && ph.indexOf('销售平台') >= 0)) && e.children.length <= 2) { el = e; break }
          }
          if (!el) return '未找到「销售平台归属」元素'
          const desc = (n) => { if (!n) return ''; const c = (n.getAttribute && n.getAttribute('class')) || ''; const role = n.getAttribute && n.getAttribute('role'); return n.tagName.toLowerCase() + (typeof c === 'string' && c ? '.' + c.trim().split(/\s+/).slice(0, 4).join('.') : '') + (role ? '[role=' + role + ']' : '') }
          const chain = []; let p = el; for (let i = 0; i < 6 && p && p.tagName !== 'BODY'; i++) { chain.push(desc(p)); p = p.parentElement }
          const box = el.closest('[class*=form-item],[class*=formItem],[class*=field],[class*=form_item],tr,li') || el.parentElement
          return '命中元素链(内→外)：\n  ' + chain.join('\n  ↑ ') + '\n容器 HTML(截断)：\n' + (box ? norm(box.outerHTML).slice(0, 700) : '(无)')
        })
        toolSend('dryrun:line', '—— 销售平台归属 控件结构 ——')
        String(struct).split('\n').forEach(l => toolSend('dryrun:line', l))
      } catch (e) { toolSend('dryrun:line', '控件结构 dump 失败：' + e.message) }
      return { ok: true, loggedIn: true, done: 1, total: 1, failedAt: -1 }
    }
    // 操作体检：一锤定音——程序能否真正操作纷享控件（下拉开不开、fill 写不写得进）
    if (mode === 'actuate-probe') {
      const sleepP = (ms) => new Promise(r => setTimeout(r, ms))
      toolSend('dryrun:line', '【操作体检】测试程序能否真正驱动纷享控件')
      if (navHash) { try { await page.evaluate((h) => { if (location.hash !== h) location.hash = h }, navHash) } catch (_) {}; await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await sleepP(2500) }
      try { const nb = page.getByText('新建', { exact: true }).first(); if (await nb.count()) { await nb.click({ timeout: 6000 }); await sleepP(2800); toolSend('dryrun:line', '已点「新建」打开表单') } } catch (e) { toolSend('dryrun:line', '点新建失败：' + e.message) }
      let ff = page.mainFrame()
      for (const f of page.frames()) { try { if (await f.locator('.f-item-inner.j-comp-wrap, .crm-widget').count()) { ff = f; break } } catch (_) {} }
      toolSend('dryrun:line', `表单 frame：${ff === page.mainFrame() ? '主框架' : 'iframe'}（共 ${page.frames().length} 个 frame）`)
      const tag = async (label, sub) => { try { return await ff.evaluate(({ lab, sub }) => { document.querySelectorAll('[data-iml-pb]').forEach(e => e.removeAttribute('data-iml-pb')); const norm = s => (s || '').replace(/\s+/g, ' ').trim(); for (const w of document.querySelectorAll('.f-g-item,[class*=f-item-wrap]')) { const t = w.querySelector('.f-g-item-tit,[class*=item-tit]'); if (t && norm(t.textContent).indexOf(lab) >= 0) { const el = w.querySelector(sub); if (el) { el.setAttribute('data-iml-pb', '1'); return true } } } return false }, { lab: label, sub }) } catch (_) { return false } }
      const visOpts = async () => { try { return await ff.evaluate(() => { const vis = n => { try { const r = n.getBoundingClientRect(); return n.offsetParent !== null && r.width > 1 && r.height > 1 } catch (e) { return false } }; const out = []; document.querySelectorAll('.j-search-item,.crm-w-select li,[class*=select-list] li,[class*=options] li,[role=option],.ant-select-dropdown li,li[class*=item]').forEach(n => { if (vis(n)) { const t = (n.innerText || '').replace(/\s+/g, ' ').trim(); if (t && t.length < 24) out.push(t) } }); return out }) } catch (_) { return [] } }
      // ① select_one：销售平台归属 —— 点 .select-tit 看下拉开不开
      try {
        const before = (await visOpts()).length
        if (await tag('销售平台归属', '.select-tit,.j-select-input,.tit-con')) {
          await ff.locator('[data-iml-pb="1"]').first().click({ timeout: 5000 }); await sleepP(1300)
          const after = await visOpts()
          toolSend('dryrun:line', `① 销售平台归属(下拉)：点 .select-tit 后 可见选项 ${before}→${after.length} ${after.length > before ? '✅ 下拉打开了' : '❌ 没反应'}`)
          if (after.length) toolSend('dryrun:line', '   选项样例：' + after.slice(0, 8).join(' | '))
        } else toolSend('dryrun:line', '① 销售平台归属：未按标签找到 .select-tit')
      } catch (e) { toolSend('dryrun:line', '① 失败：' + e.message) }
      // ② object_reference：客户名称 —— fill 检索框看结果
      try {
        if (await tag('客户名称', '.j-search-ipt,input.search-ipt,input[type=text],input')) {
          const ipt = ff.locator('[data-iml-pb="1"]').first()
          await ipt.click({ timeout: 4000 }).catch(() => {}); await ipt.fill('中国石油', { timeout: 4000 }); await sleepP(1600)
          const val = await ipt.inputValue().catch(() => '')
          const results = await ff.evaluate(() => { const out = []; document.querySelectorAll('.j-search-list li,.result-wrap li').forEach(n => { const t = (n.innerText || '').replace(/\s+/g, ' ').trim(); if (t) out.push(t) }); return out })
          toolSend('dryrun:line', `② 客户名称(检索)：fill「中国石油」后 输入框值="${val}" ${val ? '✅' : '❌没填进'}，检索结果 ${results.length} 条 ${results.length ? '✅' : '❌没出结果'}`)
          if (results.length) toolSend('dryrun:line', '   结果样例：' + results.slice(0, 5).join(' | '))
        } else toolSend('dryrun:line', '② 客户名称：未找到 .j-search-ipt')
      } catch (e) { toolSend('dryrun:line', '② 失败：' + e.message) }
      // ③ 文本：当前进展 —— fill textarea 看值写没写进
      try {
        if (await tag('当前进展', 'textarea,input[type=text]')) {
          const ta = ff.locator('[data-iml-pb="1"]').first()
          await ta.fill('测试录入内容', { timeout: 4000 }); await sleepP(500)
          const val = await ta.inputValue().catch(() => '')
          toolSend('dryrun:line', `③ 当前进展(文本)：fill 后值="${val}" ${val === '测试录入内容' ? '✅ 写入成功' : '❌ 没写进去'}`)
        } else toolSend('dryrun:line', '③ 当前进展：未找到 textarea')
      } catch (e) { toolSend('dryrun:line', '③ 失败：' + e.message) }
      toolSend('dryrun:line', '【体检完成】把以上 ①②③ 结果贴回，即可判定 DOM 操作能否走通。')
      return { ok: true, loggedIn: true, done: 1, total: 1, failedAt: -1 }
    }
    // 字段&选项快照：读出表单每个字段的类型，下拉读出真实可选项 → SOP 阶段锁定取值
    if (mode === 'schema-probe') {
      const sleepP = (ms) => new Promise(r => setTimeout(r, ms))
      toolSend('dryrun:line', '【字段&选项】读取表单字段类型 + 下拉真实可选项')
      if (navHash) { try { await page.evaluate((h) => { if (location.hash !== h) location.hash = h }, navHash) } catch (_) {}; await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); await sleepP(2500) }
      try { const nb = page.getByText('新建', { exact: true }).first(); if (await nb.count()) { await nb.click({ timeout: 6000 }); await sleepP(2800) } } catch (_) {}
      let ff = page.mainFrame()
      for (const f of page.frames()) { try { if (await f.locator('.f-item-inner.j-comp-wrap, .crm-widget').count()) { ff = f; break } } catch (_) {} }
      const fields = await ff.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const vis = (n) => { try { const r = n.getBoundingClientRect(); return n.offsetParent !== null && r.width > 1 && r.height > 1 } catch (e) { return false } }
        const out = []
        document.querySelectorAll('.f-g-item, [class*=f-item-wrap]').forEach((w) => {
          const titEl = w.querySelector('.f-g-item-tit, .f-item-tit, [class*=item-tit]')
          const label = norm(titEl ? titEl.textContent : '').replace(/^[*\s]+/, '').replace(/[?？*\s]+$/, '')
          if (!label || label.length > 20) return
          const inner = w.querySelector('.f-item-inner.j-comp-wrap, .crm-a-field-selectone, .crm-action-field-lookup, [data-type]')
          if (!inner || !vis(inner)) return
          let dtype = (inner.getAttribute && inner.getAttribute('data-type')) || ''
          if (!dtype) { const c = (inner.className || '') + ''; dtype = c.indexOf('selectone') >= 0 ? 'select_one' : c.indexOf('lookup') >= 0 ? 'object_reference' : w.querySelector('.select-tit,.j-select-input') ? 'select_one' : w.querySelector('.j-search-ipt') ? 'object_reference' : w.querySelector('textarea') ? 'long_text' : 'text' }
          const req = !!(w.className.indexOf('required') >= 0 || (titEl && titEl.querySelector('[class*=required],.required')) || (titEl && /[*＊]/.test(titEl.textContent)))
          if (!out.find(o => o.label === label)) out.push({ label, dtype, req })
        })
        return out
      })
      toolSend('dryrun:line', `共 ${fields.length} 个字段：`)
      for (const f of fields) {
        const tname = f.dtype === 'select_one' ? '下拉' : f.dtype === 'object_reference' ? '检索' : (f.dtype === 'long_text' || f.dtype === 'text') ? '文本' : f.dtype
        if (f.dtype !== 'select_one') { toolSend('dryrun:line', `· ${f.label}${f.req ? '*' : ''} [${tname}]`); continue }
        // 下拉：先关掉上一个可能没关的浮层，再检查是否被锁，再打开读选项、读完即关
        try {
          await page.keyboard.press('Escape').catch(() => {}); await sleepP(250)
          const state = await ff.evaluate((lab) => {
            document.querySelectorAll('[data-iml-pb]').forEach(e => e.removeAttribute('data-iml-pb'))
            const norm = s => (s || '').replace(/\s+/g, ' ').trim()
            for (const w of document.querySelectorAll('.f-g-item,[class*=f-item-wrap]')) {
              const t = w.querySelector('.f-g-item-tit,[class*=item-tit]')
              if (t && norm(t.textContent).indexOf(lab) >= 0) {
                if (w.querySelector('.f-disable') || w.className.indexOf('disable') >= 0) return 'disabled'
                const el = w.querySelector('.select-tit,.j-select-input,.select-icon'); if (el) { el.setAttribute('data-iml-pb', '1'); return 'ok' }
              }
            }
            return 'notfound'
          }, f.label)
          if (state === 'disabled') { toolSend('dryrun:line', `· ${f.label}${f.req ? '*' : ''} [下拉] （被前置项锁定，需先选上级字段才能读/填）`); continue }
          if (state !== 'ok') { toolSend('dryrun:line', `· ${f.label}${f.req ? '*' : ''} [下拉] （打不开，跳过）`); continue }
          await ff.locator('[data-iml-pb="1"]').first().click({ timeout: 2500 }); await sleepP(800)
          const opts = await ff.evaluate(() => { const vis = n => { try { const r = n.getBoundingClientRect(); return n.offsetParent !== null && r.width > 1 && r.height > 1 } catch (e) { return false } }; const out = []; document.querySelectorAll('.j-search-item,.crm-w-select li,[class*=select-list] li,[class*=options] li,[role=option],li[class*=item],dd').forEach(n => { if (vis(n)) { const t = (n.innerText || '').replace(/\s+/g, ' ').trim(); if (t && t.length < 24 && out.indexOf(t) < 0) out.push(t) } }); return out.slice(0, 40) })
          toolSend('dryrun:line', `· ${f.label}${f.req ? '*' : ''} [下拉] 可选(${opts.length})：${opts.join(' / ') || '（没读到，可能结构特殊）'}`)
          // 读完关闭：再点一次开关 toggle + Escape，避免浮层挡住下一个字段
          await ff.locator('[data-iml-pb="1"]').first().click({ timeout: 2000 }).catch(() => {})
          await page.keyboard.press('Escape').catch(() => {}); await sleepP(450)
        } catch (e) { toolSend('dryrun:line', `· ${f.label} [下拉] 读取失败：${String(e.message).split('Call log')[0].trim()}`) }
      }
      toolSend('dryrun:line', '【完成】固化下拉请用上面"可选"里的真实文字锁定 SOP 值；检索/文本字段用 {{参数}}。')
      return { ok: true, loggedIn: true, done: 1, total: 1, failedAt: -1 }
    }
    // SOP-Agent 引擎：不回放选择器，读 SOP + 真实页面快照，模型用 tool calling 逐步决策执行
    if (mode === 'agentic-sop') {
      toolSend('dryrun:line', '【SOP·Agent 引擎】读 SOP + 实时页面，模型工具调用驱动…')
      const r = await runAgenticSop(page, { sop: sop || '', fieldValues: fieldValues || {}, navHash: navHash || '' }, {
        chat: (messages, tools) => callRelayTools(adminBaseUrl, messages, tools),
        log: (msg) => toolSend('dryrun:line', msg)
      })
      return { ok: true, loggedIn: true, done: r.done || 0, total: r.done || 0, failedAt: r.ok ? -1 : (r.done || 0), failLabel: r.reason, error: r.reason }
    }
    const r = await runAgentic(page, steps || [], fieldValues || {}, sop || '', {
      llm: (prompt) => callRelay(adminBaseUrl, prompt),
      log: (msg) => toolSend('dryrun:line', msg),
      // 失败时落盘诊断：截图 + 当时页面可交互元素清单，便于精准定位（不再瞎改）
      diag: async (idx, desc, reason) => {
        try {
          const dir = path.join(app.getPath('userData'), 'dryrun-diag')
          fs.mkdirSync(dir, { recursive: true })
          const shot = path.join(dir, `fail-step${idx + 1}.png`)
          await page.screenshot({ path: shot, fullPage: false }).catch(() => {})
          let els = []
          try { els = await page.evaluate('(' + SNAPSHOT_FN + ')()') } catch (_) {}
          toolSend('dryrun:line', `✗ 第 ${idx + 1} 步「${desc}」未完成：${reason || '未知'}`)
          toolSend('dryrun:line', `  截图：${shot}`)
          toolSend('dryrun:line', `  当时页面可交互元素（${els.length}）：` + els.slice(0, 30).map(e => `[${e.tag}]${e.text || ''}`).join(' / '))
        } catch (_) {}
      }
    })
    return { ...r, loggedIn: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('skill:dry-run-close', async () => {
  if (dryCtx) { try { await dryCtx.close() } catch (_) {} dryCtx = null }
  return { ok: true }
})

// ===== 技能测试：一段话 → 模型提炼字段 → agentic 执行整条链路 → 通过/失败 =====
ipcMain.handle('skill:test', async (_e, { systemId, baseUrl, sop, fields, navHash, paragraph, adminBaseUrl, headless }) => {
  try {
    // ① 解析客户需求 vs 技能参数规范：先展示"技能要录入的参数 ↔ 从需求提取的值"，再决定是否操作
    const fieldValues = {}
    const labels = (fields || []).map(f => f.label || f.name)
    if (!labels.length) {
      toolSend('dryrun:line', '① 参数映射：该技能未定义任何参数。')
      toolSend('dryrun:line', '   提示：在 SOP 里把变量写成 {{拜访客户}} 这样的占位，或录制时把字段标为「参数」，系统才能解析需求并映射。无参数则只能按 SOP 内联值执行。')
    } else {
      toolSend('dryrun:line', '① 解析需求 → 参数映射')
      toolSend('dryrun:line', '   技能需录入参数：' + labels.join('、'))
      const schema = labels.map(l => `- ${l}`).join('\n')
      const prompt = `你是表单字段提炼器。从下面用户的话里，按"字段清单"提炼每个字段对应的值。\n只输出一个 JSON 对象：key 用字段的中文名（与清单完全一致），value 为从话里提炼到的内容；提炼不到的字段值给空字符串。不要输出任何额外文字。\n\n字段清单：\n${schema}\n\n用户的话：\n"""${paragraph}"""\n\n只输出 JSON：`
      try {
        const out = await callRelay(adminBaseUrl, prompt)
        const a = (out || '').indexOf('{'), b = (out || '').lastIndexOf('}')
        if (a >= 0 && b > a) { const obj = JSON.parse(out.slice(a, b + 1)); for (const l of labels) { if (obj[l] != null && String(obj[l]).trim()) fieldValues[l] = String(obj[l]).trim() } }
      } catch (e) { toolSend('dryrun:line', '   字段提炼失败：' + e.message) }
      toolSend('dryrun:line', '   从你的需求提取：' + labels.map(l => `${l}=${fieldValues[l] || '（缺）'}`).join('｜'))
      // 参数校验：必填缺失 → 追问/提醒，绝不带缺参操作业务系统
      const missing = labels.filter(l => !fieldValues[l])
      if (missing.length) {
        toolSend('dryrun:line', '⚠️ 缺少参数：' + missing.join('、') + ' —— 已暂停，未对业务系统做任何操作。请把这些信息补进需求里再测。')
        return { ok: true, loggedIn: true, passed: false, needInput: missing, fieldValues, reason: '参数缺失，需要补充：' + missing.join('、') }
      }
      toolSend('dryrun:line', '   ✓ 参数齐全，继续执行业务操作。')
    }
    // ② 启动浏览器（复用登录态）+ 登录检查
    if (dryCtx) { try { await dryCtx.close() } catch (_) {} dryCtx = null }
    const ctx = await launchCtx(systemId, headless)
    dryCtx = ctx
    const page = ctx.pages()[0] || await ctx.newPage()
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    const txt = await page.evaluate(`(document.body?document.body.innerText:'').slice(0,1500)`).catch(() => '')
    if ((txt || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test((txt || '').toLowerCase())) {
      toolSend('dryrun:line', headless ? '无头模式下检测到未登录：请先关掉「无头浏览器」、在弹出窗口登录一次（登录态本地保留），之后再开无头测试。' : '检测到未登录目标系统，请在弹出窗口登录后重试。')
      return { ok: true, loggedIn: false, fieldValues }
    }
    // ③ agentic 执行整条链路
    toolSend('dryrun:line', '② 执行技能链路（navHash 直达 + AX 感知 + 工具调用）…')
    const r = await runAgenticSop(page, { sop: sop || '', fieldValues, navHash: navHash || '' }, {
      chat: (m, t) => callRelayTools(adminBaseUrl, m, t),
      log: (msg) => toolSend('dryrun:line', msg)
    })
    return { ok: true, loggedIn: true, fieldValues, done: r.done || 0, passed: !!r.ok, reason: r.reason, result: r.result || '' }
  } catch (e) { return { ok: false, error: e.message } }
})

// =====================================================================
// 业务系统连接 — 本地登录验证（凭证只在本地受管浏览器 Profile，绝不上传）
// =====================================================================
function isLoggedIn(txt, url) {
  const u = (url || '').toLowerCase()
  // 仍停留在登录/SSO/单点页 → 未登录
  if (/\/(sso\/)?login(\?|$|#|\/)|\/signin|account\/login|\/cas\/login|passport|\/authorize/.test(u)) return false
  const t = (txt || '')
  // 文本极少 + 含登录字样 → 判为未登录
  return !(t.length < 400 && /(登录|登陆|log\s?in|sign in|账号|帐号|密码|password|扫码登录|验证码)/.test(t.toLowerCase()))
}

ipcMain.handle('connection:verify-start', async (_e, { systemId, baseUrl }) => {
  try {
    if (verifyCtx) { try { await verifyCtx.close() } catch (_) {} verifyCtx = null }
    verifyCtx = await chromium().launchPersistentContext(profileDir(systemId), { channel: 'chrome', headless: false, viewport: null, args: ['--no-first-run'] })
    const page = verifyCtx.pages()[0] || await verifyCtx.newPage()
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    return { ok: true, profileRef: 'pwprofile-' + (systemId || 'default') }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('connection:verify-check', async () => {
  try {
    if (!verifyCtx) return { ok: false, error: '验证窗口未打开' }
    const page = verifyCtx.pages()[0]
    if (!page) return { ok: false, error: '验证窗口已关闭' }
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
    const txt = await page.evaluate(`(document.body?document.body.innerText:'').slice(0,1500)`).catch(() => '')
    const url = page.url()
    return { ok: true, loggedIn: isLoggedIn(txt, url), url }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('connection:verify-close', async () => {
  if (verifyCtx) { try { await verifyCtx.close() } catch (_) {} verifyCtx = null }
  return { ok: true }
})

// 登录保活心跳：在已登录的本地 Profile 里无头静默访问目标系统 —— 访问即触发服务端刷新会话有效期（滑动过期），
// 同时检测是否仍登录。短开短闭，绝不长期占用 Profile（与录制/验证/试运行共享同一目录，不可并发）。凭证只在本地，不上传。
ipcMain.handle('connection:ping', async (_e, { systemId, baseUrl }) => {
  if (recorderCtx || verifyCtx || dryCtx) return { ok: true, skipped: true }   // 有其它浏览器任务占用同一 Profile，本轮跳过
  let ctx = null
  try {
    ctx = await launchCtx(systemId, true)
    const page = ctx.pages()[0] || await ctx.newPage()
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
    const txt = await page.evaluate(`(document.body?document.body.innerText:'').slice(0,1500)`).catch(() => '')
    return { ok: true, loggedIn: isLoggedIn(txt, page.url()) }
  } catch (e) { return { ok: false, error: e.message } }
  finally { if (ctx) { try { await ctx.close() } catch (_) {} } }
})

// =====================================================================
// 桌面自动化技能构建：uiohook-napi 全局录制 + nut-js 回放（原生可选依赖，懒加载）
// =====================================================================
let deskSteps = []
let deskHookOn = false

function loadDesktopNative() {
  const res = { uiohook: null, nut: null, errors: [] }
  try { res.uiohook = require('uiohook-napi') } catch (e) { res.errors.push('uiohook-napi（全局输入录制）') }
  try { res.nut = require('@nut-tree-fork/nut-js') } catch (e) { res.errors.push('@nut-tree-fork/nut-js（桌面回放）') }
  return res
}

ipcMain.handle('desktop:check', async () => {
  const nat = loadDesktopNative()
  return {
    recordReady: !!nat.uiohook,
    replayReady: !!nat.nut,
    platform: process.platform,
    missing: nat.errors,
    permissionNote: process.platform === 'darwin'
      ? 'macOS 需在「系统设置 → 隐私与安全性 → 辅助功能」中授权本应用，才能录制全局输入与模拟操作。'
      : ''
  }
})

ipcMain.handle('desktop:record-start', async () => {
  const nat = loadDesktopNative()
  if (!nat.uiohook) return { ok: false, error: '未安装 ' + nat.errors.join('、') + '。请在工具目录执行 npm install 后重试。' }
  try {
    const { uIOhook, UiohookKey } = nat.uiohook
    const KEYNAME = {}; Object.keys(UiohookKey || {}).forEach(k => { KEYNAME[UiohookKey[k]] = k })
    deskSteps = []; deskHookOn = true
    let typeBuf = ''; let shift = false; const mod = { Meta: false, Ctrl: false, Alt: false }
    const push = (st) => { deskSteps.push(st); toolSend('desktop:step', st) }
    const flush = () => { if (typeBuf) { push({ op: 'type', value: typeBuf }); typeBuf = '' } }
    const PRINTABLE = /^[A-Za-z0-9]$/
    const SPECIAL = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Space: 'Space', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }

    uIOhook.removeAllListeners && uIOhook.removeAllListeners()
    uIOhook.on('mousedown', (e) => { flush(); const op = e.button === 2 ? 'rightClick' : (e.clicks === 2 ? 'doubleClick' : 'click'); push({ op, x: e.x, y: e.y }) })
    uIOhook.on('keydown', (e) => {
      const name = KEYNAME[e.keycode] || ''
      if (/^(Shift)/.test(name)) { shift = true; return }
      if (/^(Meta|Cmd)/.test(name)) { mod.Meta = true; return }
      if (/^(Ctrl|Control)/.test(name)) { mod.Ctrl = true; return }
      if (/^(Alt|Option)/.test(name)) { mod.Alt = true; return }
      const activeMod = mod.Meta ? 'cmd' : mod.Ctrl ? 'ctrl' : mod.Alt ? 'alt' : ''
      if (activeMod && PRINTABLE.test(name)) { flush(); push({ op: 'hotkey', value: `${activeMod}+${name.toLowerCase()}` }); return }
      if (SPECIAL[name]) { flush(); push({ op: 'key', value: SPECIAL[name] }); return }
      if (PRINTABLE.test(name)) { typeBuf += shift ? name.toUpperCase() : name.toLowerCase(); return }
    })
    uIOhook.on('keyup', (e) => {
      const name = KEYNAME[e.keycode] || ''
      if (/^(Shift)/.test(name)) shift = false
      else if (/^(Meta|Cmd)/.test(name)) mod.Meta = false
      else if (/^(Ctrl|Control)/.test(name)) mod.Ctrl = false
      else if (/^(Alt|Option)/.test(name)) mod.Alt = false
    })
    uIOhook.start()
    return { ok: true }
  } catch (e) { deskHookOn = false; return { ok: false, error: e.message } }
})

ipcMain.handle('desktop:record-stop', async () => {
  const nat = loadDesktopNative()
  try { if (nat.uiohook && deskHookOn) { nat.uiohook.uIOhook.stop() } } catch (_) {}
  deskHookOn = false
  return { ok: true, steps: deskSteps.slice() }
})

ipcMain.handle('desktop:record-cancel', async () => {
  const nat = loadDesktopNative()
  try { if (nat.uiohook && deskHookOn) { nat.uiohook.uIOhook.stop() } } catch (_) {}
  deskHookOn = false; deskSteps = []
  return { ok: true }
})

function parseDesktopDsl(code) {
  const out = []
  for (const raw of (code || '').split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue
    let m
    if ((m = line.match(/^(move|click|doubleClick|rightClick)\s+(-?\d+)[ ,]+(-?\d+)/))) { out.push({ op: m[1], x: +m[2], y: +m[3] }); continue }
    if ((m = line.match(/^(type|key|hotkey)\s+"([^"]*)"/))) { out.push({ op: m[1], value: m[2] }); continue }
    if ((m = line.match(/^wait\s+(\d+)/))) { out.push({ op: 'wait', value: m[1] }); continue }
  }
  return out
}
function resolveDesktopValue(v, fv) {
  return String(v || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, n) => (fv && fv[n] !== undefined ? fv[n] : ''))
}

ipcMain.handle('desktop:dry-run', async (_e, { dsl, fieldValues }) => {
  const nat = loadDesktopNative()
  if (!nat.nut) return { ok: false, error: '未安装 ' + (nat.errors.join('、') || '@nut-tree-fork/nut-js') + '。请在工具目录执行 npm install 后重试。' }
  const { mouse, keyboard, Point, Button, Key } = nat.nut
  try { mouse.config.autoDelayMs = 80; keyboard.config.autoDelayMs = 8 } catch (_) {}
  const mapKey = (tok) => {
    const t = tok.trim().toLowerCase()
    if (t === 'cmd' || t === 'meta' || t === 'win') return Key.LeftSuper !== undefined ? Key.LeftSuper : Key.LeftCmd
    if (t === 'ctrl' || t === 'control') return Key.LeftControl
    if (t === 'alt' || t === 'option') return Key.LeftAlt
    if (t === 'shift') return Key.LeftShift
    return Key[t.toUpperCase()]
  }
  const steps = parseDesktopDsl(dsl)
  let done = 0
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const desc = s.op + (s.x !== undefined ? ` ${s.x},${s.y}` : s.value ? ` "${resolveDesktopValue(s.value, fieldValues)}"` : '')
    toolSend('dryrun:line', `[${i + 1}/${steps.length}] ${desc}`)
    try {
      if (s.op === 'wait') { await sleep(parseInt(s.value, 10) || 500) }
      else if (s.op === 'move') { await mouse.setPosition(new Point(s.x, s.y)) }
      else if (s.op === 'click') { await mouse.setPosition(new Point(s.x, s.y)); await mouse.leftClick() }
      else if (s.op === 'doubleClick') { await mouse.setPosition(new Point(s.x, s.y)); await mouse.doubleClick(Button.LEFT) }
      else if (s.op === 'rightClick') { await mouse.setPosition(new Point(s.x, s.y)); await mouse.rightClick() }
      else if (s.op === 'type') { await keyboard.type(resolveDesktopValue(s.value, fieldValues)) }
      else if (s.op === 'key') { const k = Key[s.value]; if (k === undefined) throw new Error('未知按键 ' + s.value); await keyboard.pressKey(k); await keyboard.releaseKey(k) }
      else if (s.op === 'hotkey') { const ks = s.value.split('+').map(mapKey).filter(k => k !== undefined); if (!ks.length) throw new Error('无法解析组合键 ' + s.value); await keyboard.pressKey(...ks); await keyboard.releaseKey(...ks.reverse()) }
      done++
    } catch (err) {
      toolSend('dryrun:line', `✗ 第 ${i + 1} 步失败：${err.message}`)
      return { ok: true, ran: true, done, total: steps.length, failedAt: i, error: err.message }
    }
    await sleep(250)
  }
  return { ok: true, ran: true, done, total: steps.length, failedAt: -1 }
})
