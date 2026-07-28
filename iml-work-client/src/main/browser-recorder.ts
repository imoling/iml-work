// 浏览器实操录制引擎（从 browser-automation 拆出——体检 P2-17：原文件 816 行九职责混装，
// 且 recorder:* 的 ipcMain.handle 写在业务模块顶层＝import 即产生注册副作用）。
// 本模块只管"录"：Electron 与 Playwright 两条录制引擎共享同一份 RECORDER_BOOTSTRAP、
// 同一 RecStep schema、同一 __REC__/__REC_STOP__ 控制台通道；IPC 注册已归位到 ipc/recorder.ts。
import { BrowserWindow } from 'electron'
import { RECORDER_BOOTSTRAP } from './browser-scripts'
import { type RecStep } from './types'
import { swallow } from './util'
import { emitToRenderer } from './window-ref'
import { newSystemContext, captureState } from './pw-runtime'

// =====================================================================
// 浏览器实操录制（Record & Replay）：用户在监控下操作业务系统，捕获稳健选择器与步骤，
// 生成可确定性回放的技能脚本。录制复用 persist:bizsys-<id> 登录态，所见即所录。
// =====================================================================


let recorderWins: BrowserWindow[] = []   // 主窗口 + 录制中弹出的新窗口（讯飞/泛微开表单弹新窗）——全部要监听+注入+收尾
let recorderSteps: RecStep[] = []

/** 开录前清空累计步骤（IPC 层调用；不导出可变绑定，避免跨模块直接赋值）。 */
export function resetRecorderSteps(): void { recorderSteps = [] }

// 注入录制脚本到**所有 frame**（主 frame + 各 iframe）——讯飞 iBPMS/泛微把表单/列表嵌在 iframe 里，
// executeJavaScript 只跑主 frame，只注主 frame 会录不到 iframe 内的点/填/选（实测步数不动的主因之一）。
function injectRecorder(wc: Electron.WebContents) {
  try {
    const frames = wc.mainFrame?.framesInSubtree
    if (frames && frames.length) { for (const f of frames) { try { f.executeJavaScript(RECORDER_BOOTSTRAP).catch(() => {}) } catch (e) { swallow(e, 'rec-inject-frame') } } return }
  } catch (e) { swallow(e, 'rec-inject-frames') }
  wc.executeJavaScript(RECORDER_BOOTSTRAP).catch(() => {})
}

// 把真实累计步数推给**所有**录制窗的浮层（用户可能在新窗口里操作）。
function pushRecCount(): void {
  for (const w of recorderWins) { try { if (w && !w.isDestroyed()) w.webContents.executeJavaScript('window.__imlRecTick&&window.__imlRecTick(' + recorderSteps.length + ')').catch(() => {}) } catch (e) { swallow(e, 'rec-count') } }
}

// 录制步骤处理（主窗口 + 新窗口 + 各 iframe 的 console 通道共用一条）。
function onRecStep(_event: any, _level: any, message: string): void {
  if (typeof message !== 'string') return
  // 录制窗浮层的「结束录制/取消」按钮（页面内经 console 通道通知主进程）→ 收尾并让主窗口进入评审
  if (message === '__REC_STOP__') { emitToRenderer('recorder:stopped', { cancelled: false, steps: finishRecording(false) }); return }
  if (message === '__REC_CANCEL__') { finishRecording(true); emitToRenderer('recorder:stopped', { cancelled: true, steps: [] }); return }
  if (!message.startsWith('__REC__')) return
  try {
    const step: RecStep = JSON.parse(message.slice('__REC__'.length))
    // 合并连续对同一控件的 fill（取最后值），避免重复步骤
    const last = recorderSteps[recorderSteps.length - 1]
    if (step.action === 'fill' && last && last.action === 'fill' && last.selector === step.selector) last.value = step.value
    else recorderSteps.push(step)
    emitToRenderer('recorder:step', step)
    pushRecCount()
  } catch (e) { swallow(e, 'rec-step') }
}

// 给一个录制窗口装配：console 监听 + 全帧注入 + **新窗口递归装配**（讯飞开表单弹新窗也录得到）。
export function instrumentRecorderWindow(win: BrowserWindow): void {
  recorderWins.push(win)
  const wc = win.webContents
  wc.on('console-message', onRecStep)
  wc.on('dom-ready', () => injectRecorder(wc))
  wc.on('did-finish-load', () => injectRecorder(wc))
  wc.on('did-frame-navigate', () => injectRecorder(wc))
  wc.on('did-create-window', (child: BrowserWindow) => { try { instrumentRecorderWindow(child); child.webContents.once('dom-ready', () => injectRecorder(child.webContents)) } catch (e) { swallow(e, 'rec-child') } })
  win.on('closed', () => { recorderWins = recorderWins.filter(w => w !== win) })
}

// 收尾录制（关**所有**录制窗 + 取步骤/清空）——IPC 的 recorder:stop/cancel 与录制窗浮层的结束/取消按钮共用一条。
export function finishRecording(cancel: boolean): RecStep[] {
  const steps = cancel ? [] : recorderSteps.slice()
  if (cancel) recorderSteps = []
  for (const w of recorderWins.slice()) { try { if (w && !w.isDestroyed()) w.close() } catch (e) { swallow(e, 'rec-close') } }
  recorderWins = []
  return steps
}

// ── Playwright 引擎录制（IML_ENGINE=playwright）：复用**同一份 RECORDER_BOOTSTRAP**（同 RecStep schema、同 __REC__/__REC_STOP__ 控制台通道），
// 只把传输层换成 Playwright（addInitScript 注入所有帧/页 + page.on('console') 收集）。登录态由 pw profile 携带，所见即所录。
let pwRecCtx: any = null
let pwRecSysId = ''   // 录制中系统 id（收尾 captureState 回写会话用）
async function pwPushRecCount(): Promise<void> {
  if (!pwRecCtx) return
  for (const p of pwRecCtx.pages()) { try { await p.evaluate('window.__imlRecTick&&window.__imlRecTick(' + recorderSteps.length + ')') } catch (e) { swallow(e, 'pw-rec-count') } }
}
export async function pwFinishRecording(cancel: boolean): Promise<RecStep[]> {
  const steps = cancel ? [] : recorderSteps.slice()
  if (cancel) recorderSteps = []
  if (pwRecCtx) {
    if (pwRecSysId) await captureState(pwRecCtx, pwRecSysId)   // 录制期间会话可能续期 → 回写仓库
    try { await pwRecCtx.close() } catch (e) { swallow(e, 'pw-rec-close') }
    pwRecCtx = null
  }
  return steps
}
// Playwright console 处理：与 Electron onRecStep 同逻辑，签名不同（msg 对象取 text()）。
function onPwRecConsole(msg: any): void {
  let message = ''
  try { message = msg.text() } catch (_) { return }
  if (typeof message !== 'string') return
  if (message === '__REC_STOP__') { pwFinishRecording(false).then(steps => emitToRenderer('recorder:stopped', { cancelled: false, steps })); return }
  if (message === '__REC_CANCEL__') { pwFinishRecording(true).then(() => emitToRenderer('recorder:stopped', { cancelled: true, steps: [] })); return }
  if (!message.startsWith('__REC__')) return
  try {
    const step: RecStep = JSON.parse(message.slice('__REC__'.length))
    const last = recorderSteps[recorderSteps.length - 1]
    if (step.action === 'fill' && last && last.action === 'fill' && last.selector === step.selector) last.value = step.value
    else recorderSteps.push(step)
    emitToRenderer('recorder:step', step)
    pwPushRecCount()
  } catch (e) { swallow(e, 'pw-rec-step') }
}
// 启动 pw 录制：有头持久化 Chrome（复用 pw profile 登录态）+ addInitScript 注入所有帧/页 + 监听所有页 console（含新窗口）。
export async function startPwRecorder(systemId: string, baseUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (pwRecCtx) { try { await pwRecCtx.close() } catch (e) { swallow(e, 'start-pw-recorder') } pwRecCtx = null }
    recorderSteps = []
    pwRecSysId = systemId
    const ctx = await newSystemContext(systemId, true)   // 有头 + 注入 storageState 登录态（所见即所录，无 profile 锁）
    pwRecCtx = ctx
    await ctx.addInitScript(RECORDER_BOOTSTRAP)     // 所有帧/页（含后开的新页）都自动注入
    ctx.on('page', (p: any) => { try { p.on('console', onPwRecConsole) } catch (e) { swallow(e, 'start-pw-recorder') } })
    for (const p of ctx.pages()) { try { p.on('console', onPwRecConsole) } catch (e) { swallow(e, 'start-pw-recorder') } }
    const page = ctx.pages()[0] || await ctx.newPage()
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    return { ok: true }
  } catch (e: any) {
    if (pwRecCtx) { try { await pwRecCtx.close() } catch (_) { /* noop */ } pwRecCtx = null }
    return { ok: false, error: e.message }
  }
}
