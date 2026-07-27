// 业务系统登录保活心跳：定时离屏打开已登录系统的会话分区并访问其地址——
// 访问即触发服务端刷新会话有效期（滑动过期），同时检测在线状态、掉线则标记需重新登录。
// 会话只在本地分区，绝不上传。共享状态 hbState 封装在本模块，IPC 经访问器读写。
import { BrowserWindow } from 'electron'
import { configGet, configSet } from './db'
import { getAdminBaseUrl, afetch } from './http'
import { emitToRenderer } from './window-ref'
import { swallow, sleep } from './util'
import { usePwEngine, hasState, newSystemContext, captureState } from './pw-runtime'

/** 业务系统的本地会话分区（凭证/登录态只存这里，按系统隔离）。 */
export const bizPartition = (systemId: string) => `persist:bizsys-${systemId}`

const HB_KEY = 'bizsys-hb'
let hbBusy = false
let hbTimer: NodeJS.Timeout | null = null
// log：最近若干次心跳的明细（时间 + 各系统在线/掉线）——展示在「系统连接」页的「保活记录」里，
// 让用户直接看到保活在不在跑、哪个系统多久掉一次（讯飞这类固定 TTL 的 SSO 靠它就能看出被动保活续不上）。
type HbLog = { at: string; items: { name: string; online: boolean }[] }
const hbState: { enabled: boolean; busy: boolean; lastAt: string; online: number; total: number; log: HbLog[] } =
  { enabled: configGet(HB_KEY) !== '0', busy: false, lastAt: '', online: 0, total: 0, log: [] }

function emitHb() { emitToRenderer('systems:heartbeat', hbState) }

export function getHbState() { return hbState }

export function setHbEnabled(enabled: boolean) {
  hbState.enabled = !!enabled
  configSet(HB_KEY, enabled ? '1' : '0')
  emitHb()
  if (enabled) void runBizHeartbeat()
  return hbState
}

// Playwright 引擎心跳探测：注入 storageState 无头访问系统地址——**访问即触发服务端会话滑动续期**（真保活），
// 在线则把（可能已续期的）会话回写仓库保鲜；无登录态直接离线。newContext 互不冲突（无 profile 锁），随开随关。
async function pwPingBizSystem(systemId: string, baseUrl: string): Promise<boolean> {
  if (!hasState(systemId)) return false
  let ctx: any = null
  try {
    ctx = await newSystemContext(systemId, false)
    const page = ctx.pages()[0] || await ctx.newPage()
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(2000)
    const text: string = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 600)).catch(() => '')
    let url = ''; try { url = page.url() } catch (_) { /* noop */ }
    const loginish = (text || '').trim().length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password|认证|扫码)/i.test(text)
    const onLoginUrl = /\/(sso\/)?login|passport|\/authorize|sso\.[a-z]/i.test(url)
    const ok = !(loginish || onLoginUrl)
    if (ok) await captureState(ctx, systemId)   // 会话续期回写保鲜
    return ok
  } catch (_) {
    return true   // 探测异常（起浏览器失败等）≠ 掉线：保持原状不误踢
  } finally { if (ctx) { try { await ctx.close() } catch (_) { /* noop */ } } }
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
    const items: { name: string; online: boolean }[] = []
    for (const s of linked) {
      let ok = false
      try {
        // pw 引擎：storageState 无头探测+续期保鲜；Electron：离屏探分区。掉线→标记需重新登录。
        ok = usePwEngine() ? await pwPingBizSystem(s.id, s.baseUrl) : await pingBizSystem(s.id, s.baseUrl)
        if (!ok) configSet('bizsys-linked:' + s.id, '0')
        if (ok) online++
      } catch (e) { swallow(e) }
      items.push({ name: s.name || s.id, online: ok })
    }
    const now = new Date()
    const p2 = (n: number) => String(n).padStart(2, '0')
    const at = `${p2(now.getHours())}:${p2(now.getMinutes())}`
    const atFull = `${at}:${p2(now.getSeconds())}`
    hbState.lastAt = at
    hbState.online = online; hbState.total = linked.length
    // 保活记录（保留最近 12 次）：展示在「系统连接」页；顺带打一份到终端（深挖用）。
    hbState.log = [{ at: atFull, items }, ...hbState.log].slice(0, 12)
    console.log('[bizsys-hb]', atFull, linked.length ? items.map(i => `${i.name}:${i.online ? '在线' : '掉线'}`).join('  ') : '（无已登录系统）')
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
  // pw 引擎：登录态在 storageState 仓库，**绝不能**探 Electron 分区（空会话永远判未登录——真机踩过的坑）。
  if (usePwEngine()) {
    if (!hasState(systemId)) return { reachable: true, loggedIn: false }   // 无登录态 → 如实出登录卡
    let ctx: any = null
    try {
      ctx = await newSystemContext(systemId, false)
      const page = ctx.pages()[0] || await ctx.newPage()
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
      await page.waitForTimeout(2200)   // SSO 跳转/SPA 渲染
      const text: string = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 800)).catch(() => '')
      let url = ''; try { url = page.url() } catch (_) { /* noop */ }
      if (!text && (!url || url === 'about:blank')) return { reachable: false, loggedIn: false, error: '页面无响应（服务可能未启动）' }
      const onLoginUrl = /\/(sso\/)?login|\/signin|passport|\/authorize|sso\.[a-z]/i.test(url)
      const loggedIn = !onLoginUrl && !isBizLoginPage(text)
      if (loggedIn) await captureState(ctx, systemId)   // 会话续期回写保鲜
      console.log(`[pw-preflight] ${systemId} 落地=${url.slice(0, 70)} onLoginUrl=${onLoginUrl} bodyLen=${text.length} → ${loggedIn ? '已登录' : '未登录'}`)
      return { reachable: true, loggedIn }
    } catch (e: any) {
      return { reachable: false, loggedIn: false, error: e.message }
    } finally { if (ctx) { try { await ctx.close() } catch (_) { /* noop */ } } }
  }
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
