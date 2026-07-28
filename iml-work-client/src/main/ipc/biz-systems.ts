// 企业业务系统连接：清单 / 本地登录窗 / 检测 / 退出 / 保活 + 录制技能落库 IPC。纯搬迁自 main.ts。
import { ipcMain, session, BrowserWindow } from 'electron'
import { configGet, configSet } from '../db'
import { getAdminBaseUrl, afetch } from '../http'
import { swallow, sleep } from '../util'
import { bizPartition, getHbState, setHbEnabled, runBizHeartbeat, isBizLoginPage } from '../biz-keepalive'
import { isLoginUrl } from '../login-detect-core'
import { emitToRenderer } from '../window-ref'
import { LOGIN_MONITOR_FN } from '../browser-scripts'
import { transpileRecording } from '../skill-transpile'
import { callLlm, type LlmConfig } from '../llm'
import type { RecStep } from '../types'
import { usePwEngine, newSystemContext, captureState, hasState, clearState } from '../pw-runtime'

// ── Playwright 引擎登录（IML_ENGINE=playwright）：开有头 Chrome 让用户登录，轮询到登录成功的**瞬间**
// `captureState` 把会话（cookies+localStorage）捕获进 storageState 仓库（内存+加密落盘），然后关登录窗——
// 之后任何执行/检测都 newContext 注入这份登录态，关没关窗都无所谓（会话在数据里，不在窗口里）。
// 判据同 Electron isBizLoginPage。凭证只在本地，绝不上传（安全红线）。
const pwLoginCtxs = new Map<string, any>()
async function pwLogin(systemId: string, baseUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const exist = pwLoginCtxs.get(systemId)
    if (exist) { try { const p = exist.pages()[0]; if (p) await p.bringToFront() } catch (e) { swallow(e, 'pw-login') } return { ok: true } }
    const ctx = await newSystemContext(systemId, true)   // 有头登录窗（带上已有登录态，已登录则秒过）
    pwLoginCtxs.set(systemId, ctx)
    ctx.on('close', () => { if (pwLoginCtxs.get(systemId) === ctx) pwLoginCtxs.delete(systemId) })   // 用户手关=取消，轮询随之停
    const page = ctx.pages()[0] || await ctx.newPage()
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    // 后台轮询登录完成——**双判据**：离开登录/SSO 域（URL 信号，最稳）+ 正文不再是登录页。最多 10 分钟。
    ;(async () => {
      const deadline = Date.now() + 10 * 60 * 1000
      while (Date.now() < deadline && pwLoginCtxs.get(systemId) === ctx) {
        try {
          const url: string = (() => { try { return page.url() } catch (_) { return '' } })()
          const txt: string = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 1500)).catch(() => '')
          const leftLogin = !!url && !isLoginUrl(url)   // 单一来源（login-detect-core，体检 P2-9）
          const bodyOk = !!txt && !isBizLoginPage(txt)
          console.log(`[pw-login] ${systemId} url=${url.slice(0, 60)} leftLogin=${leftLogin} bodyLen=${txt.length} bodyOk=${bodyOk}`)
          if (leftLogin && bodyOk) {
            await captureState(ctx, systemId)   // ← 登录态入仓库（关键一步：此后会话跟窗口解耦）
            configSet('bizsys-linked:' + systemId, '1')
            pwLoginCtxs.delete(systemId)
            try { await ctx.close() } catch (e) { swallow(e, 'txt') }   // 关登录窗（干净 UX）；登录态已在仓库
            console.log(`[pw-login] ${systemId} ✓ storageState 已捕获，关登录窗，广播重试`)
            emitToRenderer('systems:logged-in', { systemId })
            return
          }
        } catch (e) { swallow(e, 'pw-login-poll') }
        await sleep(2500)
      }
    })()
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

// Playwright 引擎「检测」：登录窗开着→读它；否则有 storageState→无头探测（顺带触发服务端会话续期+回写保鲜）；无态→未登录。
async function pwCheck(systemId: string, baseUrl: string): Promise<{ ok: boolean; loggedIn?: boolean; error?: string }> {
  const readTxt = async (page: any): Promise<{ txt: string; url: string }> => {
    const txt: string = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 1500)).catch(() => '')
    let url = ''; try { url = page.url() } catch (_) { /* noop */ }
    return { txt, url }
  }
  const judge = (txt: string, url: string) => !!txt && !isBizLoginPage(txt) && (!url || !isLoginUrl(url))
  // 登录窗开着 → 直接读它当前页（用户可能刚登完没等轮询）
  const lc = pwLoginCtxs.get(systemId)
  if (lc) {
    try {
      const page = lc.pages()[0]
      if (page) {
        const { txt, url } = await readTxt(page)
        const loggedIn = judge(txt, url)
        if (loggedIn) {
          await captureState(lc, systemId)
          configSet('bizsys-linked:' + systemId, '1')
          pwLoginCtxs.delete(systemId)
          try { await lc.close() } catch (e) { swallow(e, 'judge') }
          emitToRenderer('systems:logged-in', { systemId })
        }
        return { ok: true, loggedIn }
      }
    } catch (e) { swallow(e, 'pw-check-loginwin') }
  }
  if (!hasState(systemId)) { configSet('bizsys-linked:' + systemId, '0'); return { ok: true, loggedIn: false } }
  let ctx: any = null
  try {
    ctx = await newSystemContext(systemId, false)   // 无头，注入 storageState
    const page = ctx.pages()[0] || await ctx.newPage()
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(1800)
    const { txt, url } = await readTxt(page)
    const loggedIn = judge(txt, url)
    if (loggedIn) await captureState(ctx, systemId)   // 会话续期回写
    configSet('bizsys-linked:' + systemId, loggedIn ? '1' : '0')
    if (loggedIn) emitToRenderer('systems:logged-in', { systemId })
    return { ok: true, loggedIn }
  } catch (e: any) { return { ok: false, error: e.message } }
  finally { if (ctx) { try { await ctx.close() } catch (_) { /* noop */ } } }
}

export function registerBizSystemsHandlers(): void {

// =====================================================================
// 企业业务系统连接：系统由管理端定义，客户端在此完成员工个人登录。
// 登录会话按系统隔离持久保存（persist:bizsys-<id>，bizPartition 见 biz-keepalive.ts），与技能执行器共用。
// =====================================================================

// 列出管理端定义的业务系统，并附带本地登录态标记。
ipcMain.handle('systems:list', async () => {
  try {
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
    if (!res.ok) return { ok: false, systems: [], error: `HTTP ${res.status}` }
    const list: any = await res.json()
    const systems = (Array.isArray(list) ? list : []).map((s: any) => ({
      id: s.id, type: s.type, name: s.name, baseUrl: s.baseUrl, status: s.status,
      linked: configGet('bizsys-linked:' + s.id) === '1'
    }))
    return { ok: true, adminBaseUrl: getAdminBaseUrl(), systems }
  } catch (e: any) {
    return { ok: false, systems: [], error: e.message }
  }
})

// 保存浏览器实操录制生成的技能为「私有技能」：归属登录员工、经 /skills/mine 下发到本人客户端
// （不进中央/岗位技能池）。走 /creator/save-recorded（CLIENT_SKILL_CREATE 权限闸），**不是**管理端发布路
// POST /skills（那条需 SKILL_MANAGE，普通员工没有 → 之前一直被后端 403、又被 afetch 误报成"登录过期"）。
// 类型/归属/状态一律由后端按登录态设定，客户端不自证身份、不传 status/ownerUserId。
ipcMain.handle('skill:save-recorded', async (_event, payload: { id?: string; name: string; triggerKeywords: string[]; targetSystemId: string; actionScript: string; skillKind?: string; sopContent?: string; description?: string }) => {
  try {
    const body = {
      id: payload.id || '',   // 带 id = 更新既有录制技能（后端 owner 校验）；空 = 新建
      name: payload.name,
      triggerKeywords: payload.triggerKeywords || [],
      targetSystemId: payload.targetSystemId || '',
      actionScript: payload.actionScript,
      // 语义层：读/写判定（写入类执行前强制确认+签名）+ SOP（browse 分步执行的可控计划）+ 意图描述（路由语义匹配）。
      skillKind: payload.skillKind || '',
      sopContent: payload.sopContent || '',
      description: payload.description || ''
    }
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/skills/creator/save-recorded`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    // 403 = 权限不足（非登录过期）：给人话，别让用户白白重登（afetch 已按本地 exp 判定不再误踢）。
    if (res.status === 403) return { ok: false, error: '当前账号无「创建技能」权限，无法保存录制技能——请联系管理员为你的角色开通「客户端-创建技能（client.skill.create）」。' }
    if (!res.ok) return { ok: false, error: `保存失败（HTTP ${res.status}）` }
    const created: any = await res.json()
    return { ok: true, skill: created }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

// 删除自己录制的私有技能（owner 校验在后端）——经 /creator/{id}（CLIENT_SKILL_CREATE 闸），员工可用。
ipcMain.handle('skill:delete-recorded', async (_event, { id }: { id: string }) => {
  try {
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/skills/creator/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (res.status === 403) return { ok: false, error: '只能删除自己录制的技能' }
    if (!res.ok) return { ok: false, error: `删除失败（HTTP ${res.status}）` }
    return { ok: true }
  } catch (e: any) { return { ok: false, error: e.message } }
})

// 录制演示 → 语义 SKILL 转译（结束录制后渲染层调用；模型失败返回 ok:false，评审区退回规则版兜底）。
ipcMain.handle('skill:transpile-recording', async (_event, payload: { steps: RecStep[]; name: string; systemName: string; llmConfig: LlmConfig }) => {
  try {
    const r = await transpileRecording(payload.steps || [], payload.name || '录制技能', payload.systemName || '业务系统', payload.llmConfig, callLlm)
    return r ? { ok: true, skill: r } : { ok: false, error: '转译失败' }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

// 当前打开的登录窗口（按系统隔离）；"我已登录，检测"直接读这个窗口的真实内容。
const bizLoginWins = new Map<string, BrowserWindow>()

// 打开系统登录窗口。登录成功会「自动关窗」：每次页面导航完成后自检，一旦不再是登录页
// 即标记已连接、关闭窗口并广播 systems:logged-in（登录卡/设置页据此刷新，无需用户再点「检测」）。
ipcMain.handle('systems:login', async (_event, { systemId, baseUrl }: { systemId: string; baseUrl: string }) => {
  if (usePwEngine()) return pwLogin(systemId, baseUrl)   // 灰度：Playwright 引擎走持久化 Chrome 登录
  const exist = bizLoginWins.get(systemId)
  if (exist && !exist.isDestroyed()) { try { exist.focus() } catch (e) { swallow(e, 'systems-login') } return { ok: true } }
  const win = new BrowserWindow({
    show: true, width: 1200, height: 820,
    title: 'iML 工作分身 · 登录企业系统',
    webPreferences: { partition: bizPartition(systemId) }
  })
  bizLoginWins.set(systemId, win)
  win.on('closed', () => { if (bizLoginWins.get(systemId) === win) bizLoginWins.delete(systemId) })

  // 登录成功自动收工：登录后系统必然跳转/重渲染 → 导航完成时探测正文，已离开登录页即视为登录成功。
  let settled = false
  const autoCheck = async () => {
    if (settled || win.isDestroyed()) return
    try {
      await sleep(1200)   // 等跳转后的首屏渲染完
      if (settled || win.isDestroyed()) return
      const text: string = await win.webContents.executeJavaScript(
        `(function(){return (document.body ? document.body.innerText : '').slice(0, 800)})()`
      )
      if (isBizLoginPage(text)) return   // 还在登录页（或密码错了）→ 继续等下一次导航
      settled = true
      configSet('bizsys-linked:' + systemId, '1')
      emitToRenderer('systems:logged-in', { systemId })
      try { win.close() } catch (e) { swallow(e, 'auto-check') }
      bizLoginWins.delete(systemId)
    } catch (e) { swallow(e, 'login-autocheck') }
  }
  // 登录窗浮层：一句提示 +「我已登录，检测」+「取消」，登完在窗口里点检测/取消，不用切回设置页。
  const injectLoginBar = () => { if (!win.isDestroyed()) win.webContents.executeJavaScript(LOGIN_MONITOR_FN).catch(() => {}) }
  const onLoginMsg = async (_e: any, _l: any, message: string) => {
    if (typeof message !== 'string' || win.isDestroyed()) return
    if (message === '__LOGIN_CANCEL__') { settled = true; try { win.close() } catch (e) { swallow(e, 'on-login-msg') }; bizLoginWins.delete(systemId); return }
    if (message === '__LOGIN_CHECK__') {
      if (settled) return
      try {
        const text: string = await win.webContents.executeJavaScript(`(function(){return (document.body?document.body.innerText:'').slice(0,800)})()`)
        if (isBizLoginPage(text)) { win.webContents.executeJavaScript(`window.__imlLoginStatus&&window.__imlLoginStatus('似乎还没登录——请先在此窗口完成登录，再点检测')`).catch(() => {}); return }
        settled = true
        configSet('bizsys-linked:' + systemId, '1')
        emitToRenderer('systems:logged-in', { systemId })
        try { win.close() } catch (e) { swallow(e, 'text') }
        bizLoginWins.delete(systemId)
      } catch (e) { swallow(e, 'login-manual-check') }
    }
  }
  win.webContents.on('console-message', onLoginMsg)
  win.webContents.on('did-navigate', autoCheck)              // 整页跳转（表单提交型登录）
  win.webContents.on('did-navigate', injectLoginBar)
  win.webContents.on('did-navigate-in-page', autoCheck)      // SPA 路由（前后端分离型登录）
  win.webContents.on('did-finish-load', autoCheck)           // 首屏/重载：已登录过的直接进主页也能自动关
  win.webContents.on('did-finish-load', injectLoginBar)

  win.loadURL(baseUrl).catch(() => {})
  return { ok: true }
})

// 关闭某系统的登录窗口（取消验证）。
ipcMain.handle('systems:login-close', async (_event, { systemId }: { systemId: string }) => {
  if (usePwEngine()) {   // 只关登录窗（=取消登录）；已捕获的登录态在仓库，不受影响
    const c = pwLoginCtxs.get(systemId)
    if (c) { try { await c.close() } catch (e) { swallow(e, 'systems-login-close') } pwLoginCtxs.delete(systemId) }
    return { ok: true }
  }
  const win = bizLoginWins.get(systemId)
  if (win && !win.isDestroyed()) { try { win.close() } catch (e) { swallow(e, 'systems-login-close') } }
  bizLoginWins.delete(systemId)
  return { ok: true }
})

// 检测登录态：优先读"当前打开的登录窗口"（有现成会话，最准）；无打开窗口时离屏探测。登录成功则关窗。
ipcMain.handle('systems:check', async (_event, { systemId, baseUrl }: { systemId: string; baseUrl: string }) => {
  if (usePwEngine()) return await pwCheck(systemId, baseUrl)   // 灰度：storageState 登录态检测（顺带续期保鲜）
  const openWin = bizLoginWins.get(systemId)
  if (openWin && !openWin.isDestroyed()) {
    try {
      const text: string = await openWin.webContents.executeJavaScript(
        `(function(){return (document.body ? document.body.innerText : '').slice(0, 800)})()`
      )
      const loggedIn = !isBizLoginPage(text)
      configSet('bizsys-linked:' + systemId, loggedIn ? '1' : '0')
      if (loggedIn) { try { openWin.close() } catch (e) { swallow(e, 'systems-check') }; bizLoginWins.delete(systemId) }
      return { ok: true, loggedIn }
    } catch (e: any) { return { ok: false, error: e.message } }
  }
  // 无打开的登录窗口 → 离屏探测系统地址
  return await new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false, width: 1100, height: 760,
      webPreferences: { partition: bizPartition(systemId), offscreen: true }
    })
    let settled = false
    const done = (loggedIn: boolean, error?: string) => {
      if (settled) return
      settled = true
      try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e, 'biz-systems-done') }
      if (!error) configSet('bizsys-linked:' + systemId, loggedIn ? '1' : '0')
      resolve({ ok: !error, loggedIn, error })
    }
    win.webContents.once('did-finish-load', async () => {
      try {
        await sleep(2800)
        const text: string = await win.webContents.executeJavaScript(
          `(function(){return (document.body ? document.body.innerText : '').slice(0, 800)})()`
        )
        done(!isBizLoginPage(text))
      } catch (e: any) { done(false, e.message) }
    })
    win.webContents.once('did-fail-load', (_e, code, desc) => done(false, `加载失败(${code}): ${desc}`))
    win.loadURL(baseUrl).catch(() => {})
    setTimeout(() => done(false, '检测超时'), 22000)
  })
})

// 退出登录：pw 引擎关常驻上下文（销毁内存会话）；Electron 清分区存储。
ipcMain.handle('systems:logout', async (_event, { systemId }: { systemId: string }) => {
  try {
    if (usePwEngine()) {
      const c = pwLoginCtxs.get(systemId)
      if (c) { try { await c.close() } catch (e) { swallow(e, 'systems-logout') } pwLoginCtxs.delete(systemId) }
      clearState(systemId)   // 清 storageState 仓库（内存+加密盘）=真正退出登录
    }
    else { await session.fromPartition(bizPartition(systemId)).clearStorageData() }
    configSet('bizsys-linked:' + systemId, '0')
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

// 业务系统登录保活心跳已拆至 biz-keepalive.ts，此处只留 IPC 编排。
ipcMain.handle('systems:heartbeat-get', () => getHbState())
ipcMain.handle('systems:heartbeat-set', (_e, enabled: boolean) => setHbEnabled(enabled))
ipcMain.handle('systems:heartbeat-now', async () => { await runBizHeartbeat(); return getHbState() })
}
