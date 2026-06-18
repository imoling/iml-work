const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { RECORDER_JS, PAGE_JS, runAgentic, stepsToReadable, sleep } = require('./automation')

let toolWin = null
let recorderWin = null
let recorderSteps = []
let dryRunWin = null

function toolSend(channel, payload) { if (toolWin && !toolWin.isDestroyed()) toolWin.webContents.send(channel, payload) }

function createWindow() {
  toolWin = new BrowserWindow({
    width: 820, height: 860, title: 'iML Work · FDE 工作台',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  toolWin.loadFile('index.html')
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

// ===== 浏览器自动化：录制（automation 引擎）=====
function injectRecorder(wc) { wc.executeJavaScript(RECORDER_JS).catch(() => {}) }

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
  return res
}

ipcMain.handle('recorder:start', async (_e, { systemId, baseUrl, systemName }) => {
  try {
    if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (_) {} }
    recorderSteps = []
    const win = new BrowserWindow({ show: true, width: 1280, height: 860, title: `实操录制 · ${systemName || ''}`, webPreferences: { partition: `persist:rec-${systemId}` } })
    recorderWin = win
    win.webContents.on('console-message', (_ev, _lvl, message) => {
      if (typeof message === 'string' && message.startsWith('__IMLREC__')) {
        try {
          const step = JSON.parse(message.slice('__IMLREC__'.length))
          const last = recorderSteps[recorderSteps.length - 1]
          if (step.act === 'fill' && last && last.act === 'fill' && last.fp && step.fp && last.fp.sel === step.fp.sel) last.value = step.value
          else recorderSteps.push(step)
          toolSend('recorder:step', { act: step.act, label: step.label, value: step.value })
        } catch (_) {}
      }
    })
    win.webContents.on('did-finish-load', () => injectRecorder(win.webContents))
    win.webContents.on('did-frame-navigate', () => injectRecorder(win.webContents))
    win.on('closed', () => { recorderWin = null })
    await win.loadURL(baseUrl)
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('recorder:stop', async () => {
  const steps = refineSteps(recorderSteps.slice())
  if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (_) {} }
  recorderWin = null
  return { ok: true, steps }
})

ipcMain.handle('recorder:cancel', async () => {
  recorderSteps = []
  if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (_) {} }
  recorderWin = null
  return { ok: true }
})

// ===== 浏览器自动化：试运行（agent 主驱动引擎，可见浏览器）=====
ipcMain.handle('skill:dry-run', async (_e, { systemId, baseUrl, systemName, steps, fieldValues, sop, adminBaseUrl }) => {
  return new Promise((resolve) => {
    if (dryRunWin && !dryRunWin.isDestroyed()) { try { dryRunWin.close() } catch (_) {} }
    const win = new BrowserWindow({ show: true, width: 1366, height: 900, title: `试运行 · ${systemName || ''}`, webPreferences: { partition: `persist:rec-${systemId}` } })
    dryRunWin = win
    let settled = false
    const finish = (r) => { if (settled) return; settled = true; resolve(r) }  // 不关窗，FDE 自行查看结果
    const adapter = {
      exec: (js) => win.webContents.executeJavaScript(js),
      input: (evt) => { try { win.webContents.sendInputEvent(evt) } catch (_) {} },
      llm: (prompt) => callRelay(adminBaseUrl, prompt),
      log: (msg) => toolSend('dryrun:line', msg)
    }
    win.webContents.once('did-finish-load', async () => {
      try {
        await win.webContents.executeJavaScript(PAGE_JS).catch(() => {})
        await win.webContents.executeJavaScript(`window.__iml.settle(8000)`).catch(() => {})
        // 登录态检查
        const pre = await win.webContents.executeJavaScript(`(function(){return {text:(document.body?document.body.innerText:'').slice(0,1500)}})()`)
        const lower = (pre.text || '').toLowerCase()
        if ((pre.text || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test(lower)) {
          toolSend('dryrun:line', '检测到未登录目标系统，请在试运行窗口登录后重试。')
          finish({ ok: true, loggedIn: false, done: 0, total: (steps || []).length }); return
        }
        const r = await runAgentic(adapter, steps || [], fieldValues || {}, sop || '')
        finish({ ...r, loggedIn: true })
      } catch (e) { finish({ ok: false, error: e.message }) }
    })
    win.webContents.once('did-fail-load', (_e, c, d) => finish({ ok: false, error: `页面加载失败(${c}): ${d}` }))
    win.loadURL(baseUrl).catch(() => {})
    setTimeout(() => finish({ ok: false, error: '试运行总超时（180秒）' }), 180000)
  })
})

ipcMain.handle('skill:dry-run-close', async () => {
  if (dryRunWin && !dryRunWin.isDestroyed()) { try { dryRunWin.close() } catch (_) {} }
  dryRunWin = null
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
