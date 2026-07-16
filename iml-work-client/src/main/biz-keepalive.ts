// 业务系统登录保活心跳：定时离屏打开已登录系统的会话分区并访问其地址——
// 访问即触发服务端刷新会话有效期（滑动过期），同时检测在线状态、掉线则标记需重新登录。
// 会话只在本地分区，绝不上传。共享状态 hbState 封装在本模块，IPC 经访问器读写。
import { BrowserWindow } from 'electron'
import { configGet, configSet } from './db'
import { getAdminBaseUrl, afetch } from './http'
import { emitToRenderer } from './window-ref'
import { swallow, sleep } from './util'

/** 业务系统的本地会话分区（凭证/登录态只存这里，按系统隔离）。 */
export const bizPartition = (systemId: string) => `persist:bizsys-${systemId}`

const HB_KEY = 'bizsys-hb'
let hbBusy = false
let hbTimer: NodeJS.Timeout | null = null
const hbState = { enabled: configGet(HB_KEY) !== '0', busy: false, lastAt: '', online: 0, total: 0 }

function emitHb() { emitToRenderer('systems:heartbeat', hbState) }

export function getHbState() { return hbState }

export function setHbEnabled(enabled: boolean) {
  hbState.enabled = !!enabled
  configSet(HB_KEY, enabled ? '1' : '0')
  emitHb()
  if (enabled) void runBizHeartbeat()
  return hbState
}

async function pingBizSystem(systemId: string, baseUrl: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { partition: bizPartition(systemId), offscreen: true } })
    let settled = false
    const done = (v: boolean) => { if (settled) return; settled = true; try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }; resolve(v) }
    win.webContents.once('did-finish-load', async () => {
      try {
        await sleep(2500)
        const text: string = await win.webContents.executeJavaScript(`(function(){return (document.body?document.body.innerText:'').slice(0,600)})()`)
        const t = (text || '').trim()
        const loginish = t.length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password|认证|扫码)/i.test(t)
        done(!loginish)
      } catch (_) { done(false) }
    })
    win.webContents.once('did-fail-load', () => done(false))
    win.loadURL(baseUrl).catch(() => {})
    setTimeout(() => done(false), 20000)
  })
}

export async function runBizHeartbeat() {
  if (hbBusy) return
  hbBusy = true; hbState.busy = true; emitHb()
  try {
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`).catch(() => null)
    const list: any = res && res.ok ? await res.json() : []
    const linked = (Array.isArray(list) ? list : []).filter((s: any) => s && s.baseUrl && configGet('bizsys-linked:' + s.id) === '1')
    let online = 0
    for (const s of linked) {
      try {
        const ok = await pingBizSystem(s.id, s.baseUrl)
        if (ok) online++; else configSet('bizsys-linked:' + s.id, '0')   // 掉线 → 标记需重新登录
      } catch (e) { swallow(e) }
    }
    const now = new Date()
    hbState.lastAt = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    hbState.online = online; hbState.total = linked.length
  } catch (e) { swallow(e) }
  finally { hbBusy = false; hbState.busy = false; emitHb() }
}

export function startBizKeepAlive() {
  if (hbTimer) return
  hbTimer = setInterval(() => { if (hbState.enabled) void runBizHeartbeat() }, 4 * 60 * 1000)
}

// ── 系统预检（技能执行前置闸 + systems:check 共用）─────────────────────────────

/** 判定页面是否仍为登录页（内容很少且含登录字样）。 */
export function isBizLoginPage(text: string): boolean {
  const t = (text || '').trim()
  return t.length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password|认证|扫码|验证码)/i.test(t)
}

/**
 * 离屏探测业务系统：可达性（服务是否响应）+ 登录态（复用本地会话分区）。
 * 技能执行前的预检入口——先问"系统活着吗、登录了吗"，再决定要不要跑自动化。
 */
export async function probeSystem(systemId: string, baseUrl: string): Promise<{ reachable: boolean; loggedIn: boolean; error?: string }> {
  const { BrowserWindow } = await import('electron')
  return await new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false, width: 1100, height: 760,
      webPreferences: { partition: bizPartition(systemId), offscreen: true }
    })
    let settled = false
    const done = (reachable: boolean, loggedIn: boolean, error?: string) => {
      if (settled) return
      settled = true
      try { if (!win.isDestroyed()) win.close() } catch (_) { /* 已销毁 */ }
      resolve({ reachable, loggedIn, error })
    }
    win.webContents.once('did-finish-load', async () => {
      try {
        await new Promise(r => setTimeout(r, 2800))   // SPA 渲染等待
        const text: string = await win.webContents.executeJavaScript(
          `(function(){return (document.body ? document.body.innerText : '').slice(0, 800)})()`
        )
        done(true, !isBizLoginPage(text))
      } catch (e: any) { done(true, false, e.message) }
    })
    win.webContents.once('did-fail-load', (_e, code, desc) => done(false, false, `页面加载失败(${code}): ${desc}`))
    win.loadURL(baseUrl).catch(() => {})
    setTimeout(() => done(false, false, '连接超时（服务可能未启动）'), 22000)
  })
}
