// 业务系统连接 — 本地登录验证 + 登录保活心跳（凭证只在本地受管浏览器 Profile/分区，绝不上传）。
// 引擎灰度（FDE_ENGINE）：electron → Electron BrowserWindow 分区 persist:bizsys-<id>（新，与客户端 iml-work-client 共用 browse 底座）；
// 否则（默认）→ Playwright pwprofile 持久化上下文（旧）。两种介质登录态互不相通，切 electron 后各系统需重登一次。
import { ipcMain, BrowserWindow } from 'electron'
import { rt, chromium, profileDir, launchCtx, useElectronEngine, bizPartition } from './runtime'

function isLoggedIn(txt: any, url: any): boolean {
  const u = (url || '').toLowerCase()
  // 仍停留在登录/SSO/单点页 → 未登录
  if (/\/(sso\/)?login(\?|$|#|\/)|\/signin|account\/login|\/cas\/login|passport|\/authorize/.test(u)) return false
  const t = (txt || '')
  // 文本极少 + 含登录字样 → 判为未登录
  return !(t.length < 400 && /(登录|登陆|log\s?in|sign in|账号|帐号|密码|password|扫码登录|验证码)/.test(t.toLowerCase()))
}

// Electron 引擎：读一个业务系统分区窗口的登录态判定用正文 + URL（导航中执行 JS 可能抛，吞掉退空）。
async function readWinLogin(win: any): Promise<{ txt: string; url: string }> {
  const txt: string = await win.webContents.executeJavaScript(`(document.body?document.body.innerText:'').slice(0,1500)`).catch(() => '')
  return { txt: txt || '', url: win.webContents.getURL() }
}

export function register(): void {
  ipcMain.handle('connection:verify-start', async (_e, { systemId, baseUrl }: any) => {
    try {
      if (useElectronEngine()) {
        // Electron：开可见分区窗，用户在此登录（登录态存 persist:bizsys-<id>，与客户端同名）
        if (rt.verifyWin && !rt.verifyWin.isDestroyed()) { try { rt.verifyWin.close() } catch (_) {} }
        const vw = new BrowserWindow({ show: true, width: 1200, height: 820, title: 'iML FDE · 登录企业系统', webPreferences: { partition: bizPartition(systemId) } })
        rt.verifyWin = vw
        vw.on('closed', () => { if (rt.verifyWin === vw) rt.verifyWin = null })
        vw.loadURL(baseUrl).catch(() => {})   // 重定向到 SSO 会让 loadURL reject，非致命，忽略
        return { ok: true, profileRef: bizPartition(systemId) }
      }
      if (rt.verifyCtx) { try { await rt.verifyCtx.close() } catch (_) {} rt.verifyCtx = null }
      rt.verifyCtx = await chromium().launchPersistentContext(profileDir(systemId), { channel: 'chrome', headless: false, viewport: null, args: ['--no-first-run'] })
      const page = rt.verifyCtx.pages()[0] || await rt.verifyCtx.newPage()
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
      return { ok: true, profileRef: 'pwprofile-' + (systemId || 'default') }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('connection:verify-check', async () => {
    try {
      if (useElectronEngine()) {
        if (!rt.verifyWin || rt.verifyWin.isDestroyed()) return { ok: false, error: '验证窗口未打开' }
        const { txt, url } = await readWinLogin(rt.verifyWin)
        return { ok: true, loggedIn: isLoggedIn(txt, url), url }
      }
      if (!rt.verifyCtx) return { ok: false, error: '验证窗口未打开' }
      const page = rt.verifyCtx.pages()[0]
      if (!page) return { ok: false, error: '验证窗口已关闭' }
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
      const txt = await page.evaluate(`(document.body?document.body.innerText:'').slice(0,1500)`).catch(() => '')
      const url = page.url()
      return { ok: true, loggedIn: isLoggedIn(txt, url), url }
    } catch (e: any) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('connection:verify-close', async () => {
    if (useElectronEngine()) {
      if (rt.verifyWin && !rt.verifyWin.isDestroyed()) { try { rt.verifyWin.close() } catch (_) {} }
      rt.verifyWin = null
      return { ok: true }
    }
    if (rt.verifyCtx) { try { await rt.verifyCtx.close() } catch (_) {} rt.verifyCtx = null }
    return { ok: true }
  })

  // 登录保活心跳：在已登录的本地 Profile/分区里静默访问目标系统 —— 访问即触发服务端刷新会话有效期（滑动过期），
  // 同时检测是否仍登录。凭证只在本地，不上传。
  ipcMain.handle('connection:ping', async (_e, { systemId, baseUrl }: any) => {
    if (useElectronEngine()) {
      // Electron 分区可并发共享 session，无需"忙则跳过"。离屏短开短闭访问触发会话滑动续期 + 检测登录态。
      return await new Promise((resolve) => {
        let win: any = null, settled = false
        const done = (r: any) => { if (settled) return; settled = true; try { if (win && !win.isDestroyed()) win.close() } catch (_) {}; resolve(r) }
        try {
          win = new BrowserWindow({ show: false, width: 1200, height: 820, webPreferences: { partition: bizPartition(systemId), offscreen: true } })
          win.webContents.once('did-finish-load', async () => {
            try { await new Promise(r => setTimeout(r, 2500)); const { txt, url } = await readWinLogin(win); done({ ok: true, loggedIn: isLoggedIn(txt, url) }) }
            catch (e: any) { done({ ok: false, error: e.message }) }
          })
          win.webContents.once('did-fail-load', (_ev: any, code: number, desc: string) => { if (code !== -3) done({ ok: false, error: `加载失败(${code}): ${desc}` }) })
          win.loadURL(baseUrl).catch(() => {})
          setTimeout(() => done({ ok: false, error: '心跳超时' }), 20000)
        } catch (e: any) { done({ ok: false, error: e.message }) }
      })
    }
    if (rt.recorderCtx || rt.verifyCtx || rt.dryCtx) return { ok: true, skipped: true }   // Playwright：同 Profile 不可并发，占用则跳过
    let ctx: any = null
    try {
      ctx = await launchCtx(systemId, true)
      const page = ctx.pages()[0] || await ctx.newPage()
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
      const txt = await page.evaluate(`(document.body?document.body.innerText:'').slice(0,1500)`).catch(() => '')
      return { ok: true, loggedIn: isLoggedIn(txt, page.url()) }
    } catch (e: any) { return { ok: false, error: e.message } }
    finally { if (ctx) { try { await ctx.close() } catch (_) {} } }
  })
}

export { isLoggedIn }
