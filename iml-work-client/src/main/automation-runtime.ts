// 自动化运行时：Agent 任务的 per-run 隔离状态 + 并发调度 + 表单/权限确认。
//
// 【per-run 隔离】以前是全局单例 runningState + runExclusive 串行——多任务并发会践踏同一份
// 确认回调/中止标志。现在每个任务一个 RunContext（runId ≡ convId，一个会话同时只有一个任务），
// 经 AsyncLocalStorage 沿异步调用链隐式传递：深层技能/本体代码里的 `runningState.aborted`、
// `requestFormConfirmation(...)` 自动作用于当前任务的上下文，无需改它们的签名。
//
// 【并发与安全】纯 LLM/沙箱/不同业务系统的任务真并发；对同一业务系统的浏览器自动化按 systemId
// 串行（物理资源：登录态窗口 + 安全——避免两个任务同时操作同一个 OA 窗口互相践踏、错授权）。
import { AsyncLocalStorage } from 'async_hooks'
import { emitToRenderer } from './window-ref'

export interface RunContext {
  runId: string   // ≡ convId
  aborted: boolean
  isFormPending: boolean
  formResolve: ((value: any) => void) | null
  isDeletePending: boolean
  deleteResolve: ((value: boolean) => void) | null
  permChoiceResolve: ((value: string) => void) | null
}

const als = new AsyncLocalStorage<RunContext>()
// runId → ctx：供 IPC 回调（渲染层带 runId 回传）精确定位目标任务，不再假设队头。
const contexts = new Map<string, RunContext>()

export function currentRun(): RunContext | undefined { return als.getStore() }
export function getRunContext(runId: string): RunContext | undefined { return contexts.get(runId) }

/**
 * 兼容旧代码的 runningState：读 aborted / 各 pending 标志时代理到「当前 async 上下文」的 RunContext。
 * 让 agent-ontology / ontology-runtime 里的 `runningState.aborted` 等读取点零改动仍正确隔离。
 */
export const runningState = {
  get aborted(): boolean { return als.getStore()?.aborted ?? false },
  set aborted(v: boolean) { const c = als.getStore(); if (c) c.aborted = v },
  get isFormPending(): boolean { return als.getStore()?.isFormPending ?? false },
  get isDeletePending(): boolean { return als.getStore()?.isDeletePending ?? false },
}

// ── 并发调度：per-run 上下文 + 按业务系统的浏览器互斥 ─────────────────────────
// systemId → 该系统上一个浏览器操作的尾指针；同系统操作串行，跨系统/无系统并发。
const systemTails = new Map<string, Promise<unknown>>()

/**
 * 在独立 RunContext 中执行一个 agent 任务（真并发：不同任务的上下文彼此隔离）。
 * runId ≡ convId；结束后清理上下文映射。
 */
export function runInContext<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const ctx: RunContext = {
    runId, aborted: false, isFormPending: false, formResolve: null,
    isDeletePending: false, deleteResolve: null, permChoiceResolve: null,
  }
  contexts.set(runId, ctx)
  return als.run(ctx, fn).finally(() => { contexts.delete(runId) })
}

/**
 * 同一业务系统上的浏览器操作串行化（物理资源保护）：不同 systemId 的操作并发，
 * 同一 systemId 排队。供浏览器自动化引擎在真正驱动登录态窗口前包裹。
 */
export function withSystemLock<T>(systemId: string, fn: () => Promise<T>): Promise<T> {
  const key = systemId || '__default__'
  const prev = systemTails.get(key) || Promise.resolve()
  const result = prev.then(fn, fn)
  systemTails.set(key, result.then(() => {}, () => {}))
  return result
}

// 先决权限闸：只读模式下任务含写操作 → 开跑前弹卡让用户选择「继续（跳过写）/ 切到允许操作重跑」。
// 阻塞等待渲染层回传选择（'continue' | 'switch'），带 runId 定位当前任务。
export function requestPermissionChoice(writeLabels: string[]): Promise<string> {
  const ctx = als.getStore()
  return new Promise((resolve) => {
    if (ctx) ctx.permChoiceResolve = (v: string) => resolve(v === 'switch' ? 'switch' : 'continue')
    emitToRenderer('agent:perm-gate', { runId: ctx?.runId, writeLabels })
  })
}

// 表单确认卡片的字段形状（与 main 的 VisitField 结构兼容）。
export interface FormField { name: string; label: string; value: string; type: string; options?: string[] }

// 向渲染层弹出表单确认卡片，并阻塞等待用户在对话框中确认后回传的参数（带 runId 定位）。
export function requestFormConfirmation(fields: FormField[]): Promise<Record<string, string>> {
  const ctx = als.getStore()
  return new Promise((resolve) => {
    if (ctx) { ctx.isFormPending = true; ctx.formResolve = (val: any) => resolve(val && typeof val === 'object' ? val : {}) }
    emitToRenderer('agent:form-request', { runId: ctx?.runId, fields })
  })
}

// ── IPC 回调侧：渲染层带 runId 回传，定位到对应 RunContext（找不到时退回当前上下文，兼容旧渲染层） ──
export function resolveForm(runId: string | undefined, formData: any): void {
  const ctx = (runId && contexts.get(runId)) || als.getStore()
  if (ctx?.isFormPending && ctx.formResolve) { ctx.isFormPending = false; ctx.formResolve(formData) }
}
export function cancelForm(runId: string | undefined): void {
  const ctx = (runId && contexts.get(runId)) || undefined
  const targets = ctx ? [ctx] : [...contexts.values()]   // 无 runId（旧渲染层）时对所有挂起任务生效
  for (const c of targets) {
    if (c.isFormPending && c.formResolve) { c.isFormPending = false; c.formResolve({}) }
    if (c.isDeletePending && c.deleteResolve) { c.isDeletePending = false; c.deleteResolve(false) }
  }
}
export function abortRun(runId: string | undefined): void {
  const targets = runId && contexts.get(runId) ? [contexts.get(runId)!] : [...contexts.values()]
  for (const c of targets) {
    c.aborted = true
    if (c.isFormPending && c.formResolve) { c.isFormPending = false; c.formResolve({}) }
    if (c.isDeletePending && c.deleteResolve) { c.isDeletePending = false; c.deleteResolve(false) }
    if (c.permChoiceResolve) { const r = c.permChoiceResolve; c.permChoiceResolve = null; r('continue') }
  }
}
export function resolveDelete(runId: string | undefined, authorized: boolean): void {
  const ctx = (runId && contexts.get(runId)) || als.getStore()
  if (ctx?.isDeletePending && ctx.deleteResolve) { ctx.isDeletePending = false; ctx.deleteResolve(authorized) }
}
export function resolvePermChoice(runId: string | undefined, choice: string): void {
  const ctx = (runId && contexts.get(runId)) || als.getStore()
  if (ctx?.permChoiceResolve) { const r = ctx.permChoiceResolve; ctx.permChoiceResolve = null; r(choice === 'switch' ? 'switch' : 'continue') }
}
