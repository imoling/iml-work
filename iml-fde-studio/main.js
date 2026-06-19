const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { RECORDER_JS, SNAPSHOT_FN, runAgentic, stepsToReadable, sleep } = require('./automation')

let toolWin = null
let recorderCtx = null      // Playwright 录制持久化上下文
let recorderSteps = []
let dryCtx = null           // Playwright 试运行持久化上下文
let verifyCtx = null        // Playwright 连接验证持久化上下文

function chromium() { return require('playwright').chromium }
// 每个业务系统一个持久化 Chrome 用户目录（录制/试运行共享 → 登录态保留；绝不上传）
function profileDir(systemId) { return path.join(app.getPath('userData'), 'pwprofile-' + (systemId || 'default')) }

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

// ===== 通用后端代理（React 端所有 /api/v1/** 调用走这里，规避 CORS、复用主进程网络）=====
ipcMain.handle('fde:api', async (_e, { baseUrl, method, path: p, body }) => {
  try {
    const url = (baseUrl || 'http://localhost:8080').replace(/\/$/, '') + p
    const res = await fetch(url, {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-corp-default-key' },
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
// 录制后清洗：fill+紧随的 pickOption 合并为 search(带+检索框)；丢冗余 hover；去连续重复
function refineSteps(raw) {
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
  return out
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
  return { ok: true, steps }
})

ipcMain.handle('recorder:cancel', async () => {
  recorderSteps = []
  if (recorderCtx) { try { await recorderCtx.close() } catch (_) {} recorderCtx = null }
  return { ok: true }
})

// ===== 浏览器自动化：试运行（Playwright 真实 Chrome，agent 主驱动）=====
ipcMain.handle('skill:dry-run', async (_e, { systemId, baseUrl, systemName, steps, fieldValues, sop, adminBaseUrl }) => {
  try {
    if (dryCtx) { try { await dryCtx.close() } catch (_) {} dryCtx = null }
    const ctx = await chromium().launchPersistentContext(profileDir(systemId), { channel: 'chrome', headless: false, viewport: null, args: ['--no-first-run'] })
    dryCtx = ctx
    const page = ctx.pages()[0] || await ctx.newPage()
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    // 登录态检查
    const txt = await page.evaluate(`(document.body?document.body.innerText:'').slice(0,1500)`).catch(() => '')
    if ((txt || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test((txt || '').toLowerCase())) {
      toolSend('dryrun:line', '检测到未登录目标系统，请在试运行窗口登录后重试（登录态会本地保留）。')
      return { ok: true, loggedIn: false, done: 0, total: (steps || []).length }
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
