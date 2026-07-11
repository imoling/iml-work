// 桌面自动化技能构建：uiohook-napi 全局录制 + nut-js 回放（原生可选依赖，惰性 require）。
import { ipcMain } from 'electron'
import { rt, toolSend } from './runtime'
import { sleep } from '../automation'

function loadDesktopNative(): { uiohook: any; nut: any; errors: string[] } {
  const res: { uiohook: any; nut: any; errors: string[] } = { uiohook: null, nut: null, errors: [] }
  try { res.uiohook = require('uiohook-napi') } catch (e) { res.errors.push('uiohook-napi（全局输入录制）') }
  try { res.nut = require('@nut-tree-fork/nut-js') } catch (e) { res.errors.push('@nut-tree-fork/nut-js（桌面回放）') }
  return res
}

function parseDesktopDsl(code: any): any[] {
  const out: any[] = []
  for (const raw of (code || '').split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue
    let m
    if ((m = line.match(/^(move|click|doubleClick|rightClick)\s+(-?\d+)[ ,]+(-?\d+)/))) { out.push({ op: m[1], x: +m[2], y: +m[3] }); continue }
    if ((m = line.match(/^(type|key|hotkey)\s+"([^"]*)"/))) { out.push({ op: m[1], value: m[2] }); continue }
    if ((m = line.match(/^wait\s+(\d+)/))) { out.push({ op: 'wait', value: m[1] }); continue }
  }
  return out
}
function resolveDesktopValue(v: any, fv: any): string {
  // 参数键含中文，勿用 \w（\w 只含 ASCII，中文占位会漏替换）
  return String(v || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_: any, n: string) => (fv && fv[n] !== undefined ? fv[n] : ''))
}

export function register(): void {
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
      const KEYNAME: any = {}; Object.keys(UiohookKey || {}).forEach(k => { KEYNAME[(UiohookKey as any)[k]] = k })
      rt.deskSteps = []; rt.deskHookOn = true
      let typeBuf = ''; let shift = false; const mod = { Meta: false, Ctrl: false, Alt: false }
      const push = (st: any) => { rt.deskSteps.push(st); toolSend('desktop:step', st) }
      const flush = () => { if (typeBuf) { push({ op: 'type', value: typeBuf }); typeBuf = '' } }
      const PRINTABLE = /^[A-Za-z0-9]$/
      const SPECIAL: any = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Space: 'Space', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }

      uIOhook.removeAllListeners && uIOhook.removeAllListeners()
      uIOhook.on('mousedown', (e: any) => { flush(); const op = e.button === 2 ? 'rightClick' : (e.clicks === 2 ? 'doubleClick' : 'click'); push({ op, x: e.x, y: e.y }) })
      uIOhook.on('keydown', (e: any) => {
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
      uIOhook.on('keyup', (e: any) => {
        const name = KEYNAME[e.keycode] || ''
        if (/^(Shift)/.test(name)) shift = false
        else if (/^(Meta|Cmd)/.test(name)) mod.Meta = false
        else if (/^(Ctrl|Control)/.test(name)) mod.Ctrl = false
        else if (/^(Alt|Option)/.test(name)) mod.Alt = false
      })
      uIOhook.start()
      return { ok: true }
    } catch (e: any) { rt.deskHookOn = false; return { ok: false, error: e.message } }
  })

  ipcMain.handle('desktop:record-stop', async () => {
    const nat = loadDesktopNative()
    try { if (nat.uiohook && rt.deskHookOn) { nat.uiohook.uIOhook.stop() } } catch (_) {}
    rt.deskHookOn = false
    return { ok: true, steps: rt.deskSteps.slice() }
  })

  ipcMain.handle('desktop:record-cancel', async () => {
    const nat = loadDesktopNative()
    try { if (nat.uiohook && rt.deskHookOn) { nat.uiohook.uIOhook.stop() } } catch (_) {}
    rt.deskHookOn = false; rt.deskSteps = []
    return { ok: true }
  })

  ipcMain.handle('desktop:dry-run', async (_e, { dsl, fieldValues }: any) => {
    const nat = loadDesktopNative()
    if (!nat.nut) return { ok: false, error: '未安装 ' + (nat.errors.join('、') || '@nut-tree-fork/nut-js') + '。请在工具目录执行 npm install 后重试。' }
    const { mouse, keyboard, Point, Button, Key } = nat.nut
    try { mouse.config.autoDelayMs = 80; keyboard.config.autoDelayMs = 8 } catch (_) {}
    const mapKey = (tok: string) => {
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
        else if (s.op === 'hotkey') { const ks = s.value.split('+').map(mapKey).filter((k: any) => k !== undefined); if (!ks.length) throw new Error('无法解析组合键 ' + s.value); await keyboard.pressKey(...ks); await keyboard.releaseKey(...ks.reverse()) }
        done++
      } catch (err: any) {
        toolSend('dryrun:line', `✗ 第 ${i + 1} 步失败：${err.message}`)
        return { ok: true, ran: true, done, total: steps.length, failedAt: i, error: err.message }
      }
      await sleep(250)
    }
    return { ok: true, ran: true, done, total: steps.length, failedAt: -1 }
  })
}
