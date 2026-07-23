// FDE 主进程共享运行时：浏览器持久化上下文 + 模型中转 + 跨域可变状态。
// 各 ipc/*.ts 域模块只依赖本模块与 automation，绝不反向 import main.ts（依赖单向，避免成环）。
import { app } from 'electron'
import path from 'path'

// 共享可变状态封装成单一对象（与客户端 runningState 同思路）：
// recorderCtx/dryCtx/verifyCtx 跨域共享——connection:ping 会读三者判断 Profile 是否被占用。
// 字段用 any：Playwright 上下文/窗口类型随外部依赖演进，运行期取用即可。
export const rt: {
  toolWin: any
  recorderCtx: any
  recorderSteps: any[]
  dryCtx: any
  verifyCtx: any
  deskSteps: any[]
  deskHookOn: boolean
  verifyWin: any        // Electron 引擎：登录验证窗（BrowserWindow），与 verifyCtx（Playwright）二选一
  recorderWins: any[]   // Electron 引擎：录制窗 + 录制中弹出的子窗（全要监听+注入+收尾），与 recorderCtx（Playwright）二选一
} = {
  toolWin: null,
  recorderCtx: null,
  recorderSteps: [],
  dryCtx: null,
  verifyCtx: null,
  deskSteps: [],
  deskHookOn: false,
  verifyWin: null,
  recorderWins: [],
}

// playwright 是外部化的可选运行时依赖，惰性 require（不静态 import，避免打进包/影响启动）。
export function chromium(): any { return require('playwright').chromium }

// ── 引擎灰度开关（Playwright → Electron+browse 迁移）───────────────────────────
// FDE_ENGINE=electron → 登录/录制/执行走 Electron BrowserWindow 分区（新，与客户端 iml-work-client 共用 browse 底座）；
// 否则（默认 playwright）→ 走 pwprofile 持久化上下文（旧）。**两种介质的登录态互不相通**（Electron 分区 cookie ↔
// pwprofile 目录），切到 electron 后每个业务系统需在 FDE 里重登一次。各 handler 顶部据此分流，旧引擎并存可回滚。
export function useElectronEngine(): boolean { return (process.env.FDE_ENGINE || '').toLowerCase() === 'electron' }

// 业务系统本地会话分区（Electron 引擎）：凭证/登录态只存这里、按系统隔离，**与客户端同名** persist:bizsys-<id>
// ——将来 FDE 与客户端在同机可复用彼此登录态。凭证只在本地、绝不上传（安全红线）。
export const bizPartition = (systemId: string) => 'persist:bizsys-' + (systemId || 'default')

// 每个业务系统一个持久化 Chrome 用户目录（录制/试运行共享 → 登录态保留；绝不上传）
export function profileDir(systemId: string): string { return path.join(app.getPath('userData'), 'pwprofile-' + (systemId || 'default')) }

// 统一启动持久化上下文。无头模式下抹掉「自动化/无头」指纹（HeadlessChrome UA、navigator.webdriver、
// AutomationControlled），否则企业 SSO 会把它当成爬虫、拒绝复用 Profile 里的登录会话 → 误报"未登录"。
export async function launchCtx(systemId: string, headless: boolean): Promise<any> {
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

// 主 → 渲染 事件推送（录制步骤、试运行日志等）。窗口引用在 rt.toolWin（createWindow 时写入）。
export function toolSend(channel: string, payload: any): void { if (rt.toolWin && !rt.toolWin.isDestroyed()) rt.toolWin.webContents.send(channel, payload) }

// 经企业模型中转站做一次决策（自愈智能体用）
export async function callRelay(adminBaseUrl: string, prompt: string): Promise<string> {
  const base = (adminBaseUrl || '').replace(/\/$/, '')
  const res = await fetch(`${base}/api/v1/model/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-corp-default-key' },
    body: JSON.stringify({ model: 'corp-default', messages: [{ role: 'user', content: prompt }] })
  })
  if (!res.ok) throw new Error('relay ' + res.status)
  const data: any = await res.json()
  return data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : ''
}

// 工具调用版中转：返回模型完整 message（含 tool_calls），供 SOP-Agent 引擎用
export async function callRelayTools(adminBaseUrl: string, messages: any[], tools: any[]): Promise<any> {
  const base = (adminBaseUrl || '').replace(/\/$/, '')
  const res = await fetch(`${base}/api/v1/model/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-corp-default-key' },
    body: JSON.stringify({ model: 'corp-default', messages, tools, tool_choice: 'auto', temperature: 0 })
  })
  if (!res.ok) throw new Error('relay ' + res.status)
  const data: any = await res.json()
  return data && data.choices && data.choices[0] ? data.choices[0].message : null
}
