// 企业业务系统连接：清单 / 本地登录窗 / 检测 / 退出 / 保活 + 录制技能落库 IPC。纯搬迁自 main.ts。
import { ipcMain, session, BrowserWindow } from 'electron'
import { configGet, configSet } from '../db'
import { getAdminBaseUrl, afetch } from '../http'
import { swallow, sleep } from '../util'
import { bizPartition, getHbState, setHbEnabled, runBizHeartbeat, isBizLoginPage } from '../biz-keepalive'
import { emitToRenderer } from '../window-ref'
import { LOGIN_MONITOR_FN } from '../browser-scripts'
import { transpileRecording } from '../skill-transpile'
import { callLlm, type LlmConfig } from '../llm'
import type { RecStep } from '../types'

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
ipcMain.handle('skill:save-recorded', async (_event, payload: { name: string; triggerKeywords: string[]; targetSystemId: string; actionScript: string; skillKind?: string; sopContent?: string; description?: string }) => {
  try {
    const body = {
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
  const exist = bizLoginWins.get(systemId)
  if (exist && !exist.isDestroyed()) { try { exist.focus() } catch (e) { swallow(e) } return { ok: true } }
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
      try { win.close() } catch (e) { swallow(e) }
      bizLoginWins.delete(systemId)
    } catch (e) { swallow(e, 'login-autocheck') }
  }
  // 登录窗浮层：一句提示 +「我已登录，检测」+「取消」，登完在窗口里点检测/取消，不用切回设置页。
  const injectLoginBar = () => { if (!win.isDestroyed()) win.webContents.executeJavaScript(LOGIN_MONITOR_FN).catch(() => {}) }
  const onLoginMsg = async (_e: any, _l: any, message: string) => {
    if (typeof message !== 'string' || win.isDestroyed()) return
    if (message === '__LOGIN_CANCEL__') { settled = true; try { win.close() } catch (e) { swallow(e) }; bizLoginWins.delete(systemId); return }
    if (message === '__LOGIN_CHECK__') {
      if (settled) return
      try {
        const text: string = await win.webContents.executeJavaScript(`(function(){return (document.body?document.body.innerText:'').slice(0,800)})()`)
        if (isBizLoginPage(text)) { win.webContents.executeJavaScript(`window.__imlLoginStatus&&window.__imlLoginStatus('似乎还没登录——请先在此窗口完成登录，再点检测')`).catch(() => {}); return }
        settled = true
        configSet('bizsys-linked:' + systemId, '1')
        emitToRenderer('systems:logged-in', { systemId })
        try { win.close() } catch (e) { swallow(e) }
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
  const win = bizLoginWins.get(systemId)
  if (win && !win.isDestroyed()) { try { win.close() } catch (e) { swallow(e) } }
  bizLoginWins.delete(systemId)
  return { ok: true }
})

// 检测登录态：优先读"当前打开的登录窗口"（有现成会话，最准）；无打开窗口时离屏探测。登录成功则关窗。
ipcMain.handle('systems:check', async (_event, { systemId, baseUrl }: { systemId: string; baseUrl: string }) => {
  const openWin = bizLoginWins.get(systemId)
  if (openWin && !openWin.isDestroyed()) {
    try {
      const text: string = await openWin.webContents.executeJavaScript(
        `(function(){return (document.body ? document.body.innerText : '').slice(0, 800)})()`
      )
      const loggedIn = !isBizLoginPage(text)
      configSet('bizsys-linked:' + systemId, loggedIn ? '1' : '0')
      if (loggedIn) { try { openWin.close() } catch (e) { swallow(e) }; bizLoginWins.delete(systemId) }
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
      try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
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

// 退出登录：清空该系统的本地会话分区。
ipcMain.handle('systems:logout', async (_event, { systemId }: { systemId: string }) => {
  try {
    await session.fromPartition(bizPartition(systemId)).clearStorageData()
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
