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

/** 本次任务的真实模型用量（网关回传的 usage + 真正服务请求的上游）。
 *  以前 AgentTrace.tokens 声明了却从没人赋值，于是审计里的 token 一直是「内容字符数 ÷ 2」的估算，
 *  而 provider/model 记的是 GATEWAY/corp-default —— 与按厂商配置的单价永远匹配不上，
 *  计费覆盖恒为 0%、费用恒为 ¥0.00。这里按 run 累加真实用量。 */
export interface RunUsage { prompt: number; completion: number; calls: number; vendor: string; model: string }

export interface RunContext {
  runId: string   // ≡ convId
  usage: RunUsage
  aborted: boolean
  /** 真正能掐断在途请求的信号。光有 aborted 布尔位只能在"两步之间"被读到——
   *  卡在一个 90s 的模型请求里时没人去读它，用户点了停止还得干等。 */
  abortCtl: AbortController
  isFormPending: boolean
  formResolve: ((value: any) => void) | null
  isDeletePending: boolean
  deleteResolve: ((value: boolean) => void) | null
  permChoiceResolve: ((value: string) => void) | null
  /** 挂起中的表单/权限卡载荷（发给渲染层的原样 payload）。渲染层刷新会弄丢已弹出的卡——
   *  留底后经 turn:running 重放，任务不再死等在确认闸前；卡被应答/取消/中止即清空。 */
  pendingFormReq: Record<string, unknown> | null
  pendingPermReq: Record<string, unknown> | null
  /** 本任务内已批量授权的同类写动作（键=分区:按钮名）；任务结束随上下文销毁，授权自然失效。 */
  batchApproved: Set<string>
}

const als = new AsyncLocalStorage<RunContext>()
// runId → ctx：供 IPC 回调（渲染层带 runId 回传）精确定位目标任务，不再假设队头。
const contexts = new Map<string, RunContext>()

export function currentRun(): RunContext | undefined { return als.getStore() }

/** 模型调用完成后登记真实用量（由 llm.ts 调用；不在任务上下文里时静默丢弃，不报错）。 */
// composer Token 用量显示的真值：**按会话（convId）分桶**累计——切会话各看各的，新会话从零。
// runId ≡ convId（见 RunContext），两条执行链路都以 runInContext 包裹整个任务，
// 故此处从 ALS 拿 runId 即会话 ID；极少数不在任务里的调用（如标题自动命名）不入桶，只进任务 ALS 之外无处可记，直接丢弃。
export interface ConvUsage {
  prompt: number
  completion: number
  byModel: Record<string, { prompt: number; completion: number }>
  last: { prompt: number; completion: number; model: string }
  /** 进行中的调用（字符口径，显示层换算估算 token）：真实 usage 要等调用完成才有，
   *  而用户看上下文圆环的时机恰恰是长调用进行中——0/128k·0% 看着像坏了（2026-08-14 实锤）。
   *  完成后 recordLlmUsage 置空并以真值校准；失败残留无妨（渲染层仅在生成中展示）。 */
  live: { promptChars: number; outChars: number } | null
}
const usageByConv = new Map<string, ConvUsage>()
export function getConvUsage(convId: string): ConvUsage | undefined { return usageByConv.get(convId) }

function ensureBucket(runId: string): ConvUsage {
  let bucket = usageByConv.get(runId)
  if (!bucket) {
    bucket = { prompt: 0, completion: 0, byModel: {}, last: { prompt: 0, completion: 0, model: '' }, live: null }
    usageByConv.set(runId, bucket)
    // 桶数封顶：只为界面显示服务，老会话的桶淘汰掉（Map 迭代序 = 插入序）
    if (usageByConv.size > 64) usageByConv.delete(usageByConv.keys().next().value as string)
  }
  return bucket
}

/** 一次模型调用发出时登记请求侧字符量（含全部历史+系统词，≈当前上下文占用的估算源）。 */
export function noteLlmCallStart(promptChars: number): void {
  const c = als.getStore()
  if (c) ensureBucket(c.runId).live = { promptChars: Math.max(0, promptChars), outChars: 0 }
}

/** 流式增量到达时累计输出字符（llm.ts 的 SSE 消费处调用；非流式路径没有增量，估算只含请求侧）。 */
export function noteLlmStreamDelta(chars: number): void {
  const c = als.getStore()
  const live = c && usageByConv.get(c.runId)?.live
  if (live) live.outChars += Math.max(0, chars)
}

export function recordLlmUsage(u: { prompt?: number; completion?: number; vendor?: string; model?: string }): void {
  const c = als.getStore()
  const p = Math.max(0, u.prompt || 0), q = Math.max(0, u.completion || 0)
  if (c) {
    const bucket = ensureBucket(c.runId)
    bucket.live = null   // 调用已完成：估算退场，下面的真值接管
    const mk = [u.vendor, u.model].filter(Boolean).join(' · ') || '中转站'
    bucket.prompt += p
    bucket.completion += q
    ;(bucket.byModel[mk] ||= { prompt: 0, completion: 0 })
    bucket.byModel[mk].prompt += p
    bucket.byModel[mk].completion += q
    // 「最近一次请求的 prompt」≈ 该会话当前上下文占用（prompt 含全部历史+系统词）
    if (p > 0 || q > 0) bucket.last = { prompt: p, completion: q, model: mk }
  }
  if (!c) return
  c.usage.prompt += Math.max(0, u.prompt || 0)
  c.usage.completion += Math.max(0, u.completion || 0)
  c.usage.calls += 1
  // 一次任务里可能多次调模型、甚至被网关故障转移到不同上游——记**最后一次实际服务的**那个。
  if (u.vendor) c.usage.vendor = u.vendor
  if (u.model) c.usage.model = u.model
}

/** 当前任务累计的真实用量（AgentTrace 提交审计时取用）。 */
export function currentUsage(): RunUsage | undefined { return als.getStore()?.usage }
export function getRunContext(runId: string): RunContext | undefined { return contexts.get(runId) }

/** 仍在执行中的 run 列表（runId ≡ convId）＋挂起中的确认/权限卡载荷。
 *  渲染层刷新/重开后据此重挂任务视图并**重放卡片**（turn:running）——不重放的话，
 *  生成类任务会永远停在前置澄清/写确认闸前（Web 刷新实锤）。 */
export function listActiveRuns(): Array<{ runId: string; pendingForm?: unknown; pendingPerm?: unknown }> {
  return [...contexts.values()].map(c => ({
    runId: c.runId,
    ...(c.pendingFormReq ? { pendingForm: c.pendingFormReq } : {}),
    ...(c.pendingPermReq ? { pendingPerm: c.pendingPermReq } : {}),
  }))
}

/**
 * 兼容旧代码的 runningState：读 aborted / 各 pending 标志时代理到「当前 async 上下文」的 RunContext。
 * 让 agent-ontology / ontology-runtime 里的 `runningState.aborted` 等读取点零改动仍正确隔离。
 */
export const runningState = {
  get aborted(): boolean { return als.getStore()?.aborted ?? false },
  set aborted(v: boolean) { const c = als.getStore(); if (c) c.aborted = v },
  /** 当前任务的中止信号（无上下文时给一个永不触发的）。 */
  get abortSignal(): AbortSignal { return als.getStore()?.abortCtl.signal ?? new AbortController().signal },
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
    runId, aborted: false, abortCtl: new AbortController(), isFormPending: false, formResolve: null,
    isDeletePending: false, deleteResolve: null, permChoiceResolve: null,
    pendingFormReq: null, pendingPermReq: null,
    batchApproved: new Set(),
    usage: { prompt: 0, completion: 0, calls: 0, vendor: '', model: '' },
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
    const payload = { runId: ctx?.runId, writeLabels }
    if (ctx) { ctx.permChoiceResolve = (v: string) => resolve(v === 'switch' ? 'switch' : 'continue'); ctx.pendingPermReq = payload }
    emitToRenderer('agent:perm-gate', payload)
  })
}

// 表单确认卡片的字段形状（与 main 的 VisitField 结构兼容）。
export interface FormField {
  name: string; label: string; value: string; type: string; options?: string[]
  /** 只读展示行（核对用的信息，不是要用户填的）——渲染层已支持，改了也不会有任何效果的字段务必标上。 */
  readonly?: boolean
}

// 表单卡用途选项：不同用途换标题/按钮文案（kind 'confirm'=业务写确认(默认)，'clarify'=任务前置澄清）。
export interface FormCardOpts { kind?: string; title?: string; submitLabel?: string }

// 向渲染层弹出表单确认卡片，并阻塞等待用户在对话框中确认后回传的参数（带 runId 定位）。
export function requestFormConfirmation(fields: FormField[], opts?: FormCardOpts): Promise<Record<string, string>> {
  const ctx = als.getStore()
  return new Promise((resolve) => {
    const payload = { runId: ctx?.runId, fields, ...(opts || {}) }
    if (ctx) { ctx.isFormPending = true; ctx.formResolve = (val: any) => resolve(val && typeof val === 'object' ? val : {}); ctx.pendingFormReq = payload }
    emitToRenderer('agent:form-request', payload)
  })
}

// ── IPC 回调侧：渲染层带 runId 回传，定位到对应 RunContext（找不到时退回当前上下文，兼容旧渲染层） ──
export function resolveForm(runId: string | undefined, formData: any): void {
  const ctx = (runId && contexts.get(runId)) || als.getStore()
  if (ctx?.isFormPending && ctx.formResolve) { ctx.isFormPending = false; ctx.pendingFormReq = null; ctx.formResolve(formData) }
}
export function cancelForm(runId: string | undefined): void {
  const ctx = (runId && contexts.get(runId)) || undefined
  const targets = ctx ? [ctx] : [...contexts.values()]   // 无 runId（旧渲染层）时对所有挂起任务生效
  for (const c of targets) {
    if (c.isFormPending && c.formResolve) { c.isFormPending = false; c.pendingFormReq = null; c.formResolve({}) }
    if (c.isDeletePending && c.deleteResolve) { c.isDeletePending = false; c.deleteResolve(false) }
  }
}
export function abortRun(runId: string | undefined): void {
  const targets = runId && contexts.get(runId) ? [contexts.get(runId)!] : [...contexts.values()]
  for (const c of targets) {
    c.aborted = true
    try { c.abortCtl.abort() } catch (e) { /* 已 abort 过是正常的 */ void e }
    if (c.isFormPending && c.formResolve) { c.isFormPending = false; c.pendingFormReq = null; c.formResolve({}) }
    if (c.isDeletePending && c.deleteResolve) { c.isDeletePending = false; c.deleteResolve(false) }
    if (c.permChoiceResolve) { const r = c.permChoiceResolve; c.permChoiceResolve = null; c.pendingPermReq = null; r('continue') }
  }
}
export function resolveDelete(runId: string | undefined, authorized: boolean): void {
  const ctx = (runId && contexts.get(runId)) || als.getStore()
  if (ctx?.isDeletePending && ctx.deleteResolve) { ctx.isDeletePending = false; ctx.deleteResolve(authorized) }
}
export function resolvePermChoice(runId: string | undefined, choice: string): void {
  const ctx = (runId && contexts.get(runId)) || als.getStore()
  if (ctx?.permChoiceResolve) { const r = ctx.permChoiceResolve; ctx.permChoiceResolve = null; ctx.pendingPermReq = null; r(choice === 'switch' ? 'switch' : 'continue') }
}
