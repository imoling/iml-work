// Playwright 执行引擎运行时（端口自 FDE ipc/runtime.ts，后重造为 storageState 架构）。
//
// 登录态架构（血泪迭代的终点）：**storageState（cookies+localStorage）是唯一登录态载体**。
// 为什么：企业 SSO 多用会话 cookie——关浏览器即失、Chromium 磁盘 profile 不持久化；
//  ①「登录后关窗、执行开新 profile」→ 会话丢（第一版败因）；
//  ②「上下文常驻不关」→ 用户随手关掉登录留下的窗口，会话照样丢，且窗口永远杵着（第二版败因）。
// 正解：登录成功瞬间 `ctx.storageState()` 把会话捕获成**数据**（内存 + safeStorage 加密落盘 userData），
// 执行/检测/心跳/录制各自 `newContext({storageState})` 注入复用、用完即关——无 profile 锁、无常驻窗口、并发互不冲突。
// 凭证/登录态只在本地（内存 + userData 加密文件），绝不上传（安全红线）。叶子纪律：不 import main.ts。
import { app, safeStorage } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { looksLikeLoginPage } from './login-detect-core'

// playwright 惰性 require（不静态 import，避免打进包/影响启动；bench 里对它 external）。
export function chromium(): any { return require('playwright').chromium }

// ── 执行引擎灰度开关（Electron browse → Playwright 迁移）──────────────────────
// IML_ENGINE=playwright → 登录/执行/录制走 Playwright；否则（默认）→ Electron 分区 browse（旧，可回滚）。
export function usePwEngine(): boolean { return (process.env.IML_ENGINE || '').toLowerCase() === 'playwright' }

// 每系统持久化 Chrome 目录——**仅 bench 一次性上下文用**（真系统登录态走 storageState，不依赖磁盘 profile）。
export function profileDir(systemId: string): string {
  return path.join(app.getPath('userData'), 'pwprofile-' + (systemId || 'default'))
}

/** bench 专用：持久化上下文（profileDirOverride='' 即临时目录）。真系统一律走 newSystemContext。 */
export async function launchCtx(systemId: string, headless: boolean, profileDirOverride?: string): Promise<any> {
  const dir = profileDirOverride != null ? profileDirOverride : profileDir(systemId)
  console.log(`[pw-ctx] launch(persistent) systemId=${systemId} headless=${headless} dir=${dir}`)
  const ctx = await chromium().launchPersistentContext(dir, {
    channel: 'chrome', headless: !!headless,
    viewport: headless ? { width: 1366, height: 900 } : null,
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled', ...(headless ? ['--window-size=1366,900'] : [])],
  })
  await ctx.addInitScript(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => false }) } catch (_) { /* noop */ } }).catch(() => {})
  if (headless) {
    const page = ctx.pages()[0] || await ctx.newPage()
    try {
      const ua: string = await page.evaluate(() => navigator.userAgent)
      if (/Headless/i.test(ua)) {
        const cdp = await ctx.newCDPSession(page)
        await cdp.send('Network.setUserAgentOverride', { userAgent: ua.replace(/Headless/gi, '') })
      }
    } catch (_) { /* UA 覆盖失败非致命 */ }
  }
  return ctx
}

// ── storageState 登录态仓库（内存 + safeStorage 加密落盘，app 重启也能复用——服务端会话没过期即免重登）──
const states = new Map<string, unknown>()
const stateFile = (systemId: string) => path.join(app.getPath('userData'), `pw-state-${systemId || 'default'}.bin`)

export function loadState(systemId: string): unknown | null {
  if (states.has(systemId)) return states.get(systemId) ?? null
  try {
    const buf = fs.readFileSync(stateFile(systemId))
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
    const st = JSON.parse(json)
    states.set(systemId, st)
    return st
  } catch { return null }   // 无文件/解密失败 = 无登录态
}
export function saveState(systemId: string, state: unknown): void {
  states.set(systemId, state)
  try {
    const json = JSON.stringify(state)
    const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8')
    fs.writeFileSync(stateFile(systemId), buf)
  } catch (e) { console.error('[pw-state] 落盘失败（仅内存态可用）', e) }
}
export function hasState(systemId: string): boolean { return loadState(systemId) != null }
export function clearState(systemId: string): void {
  states.delete(systemId)
  try { fs.unlinkSync(stateFile(systemId)) } catch { /* 不存在即无需删 */ }
}
/** 从上下文捕获登录态入仓库（登录成功时/执行收尾时——服务端可能已续期会话，回写保鲜）。 */
export async function captureState(ctx: any, systemId: string): Promise<void> {
  try { saveState(systemId, await ctx.storageState()) } catch (e) { console.error('[pw-state] 捕获失败', e) }
}

// ── 浏览器与上下文工厂（有头/无头各一个懒启动 Browser，上下文随用随建随关）────
const browsers: Record<string, any> = {}
let realUA: string | null = null

export async function getBrowser(headed: boolean): Promise<any> {
  const key = headed ? 'headed' : 'headless'
  const b = browsers[key]
  if (b && b.isConnected()) return b
  const br = await chromium().launch({
    channel: 'chrome', headless: !headed,
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
  })
  browsers[key] = br
  return br
}

// 无头 UA 抹「Headless」指纹（企业 SSO 会当爬虫拒会话）：探一次缓存，之后 newContext 直接带 userAgent。
async function headlessUA(browser: any): Promise<string | undefined> {
  if (realUA) return realUA
  try {
    const c = await browser.newContext()
    const p = await c.newPage()
    const ua: string = await p.evaluate(() => navigator.userAgent)
    await c.close()
    realUA = /Headless/i.test(ua) ? ua.replace(/Headless/gi, '') : ua
    return realUA
  } catch { return undefined }
}

/** 开一个带该系统登录态的新上下文（登录态来自 storageState 仓库；无登录态则裸开）。用完调 ctx.close()。 */
export async function newSystemContext(systemId: string, headed: boolean): Promise<any> {
  const browser = await getBrowser(headed)
  const st = loadState(systemId)
  console.log(`[pw-ctx] newContext systemId=${systemId} headed=${headed} state=${st ? '有' : '无'}`)
  const opts: Record<string, unknown> = { viewport: headed ? null : { width: 1366, height: 900 } }
  if (st) opts.storageState = st
  if (!headed) { const ua = await headlessUA(browser); if (ua) opts.userAgent = ua }
  const ctx = await browser.newContext(opts)
  await ctx.addInitScript(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => false }) } catch (_) { /* noop */ } }).catch(() => {})
  return ctx
}

// 登录态判定（端口自 FDE connection.ts isLoggedIn）：实现收敛到 login-detect-core（单一来源，体检 P2-9）。
export function isLoggedIn(txt: string, url: string): boolean {
  return !looksLikeLoginPage(txt || '', url || '')
}
