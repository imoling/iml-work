// 执行内核 AgentCore——「一个循环 + 一张工具表」，取代旧链路的硬编码决策树。
//
// 设计取自  AgentCore（coworker/engine.py），关键在于**它只有一条路**：
//   模型说话 → 要调工具就调 → 结果回灌 → 再想 → 直到不需要工具了，那句话就是答案。
// 普通问答＝第一轮就没调工具；企业系统操作＝注册了 browse 的同一个循环。
// 旧链路那 8 层正则（writeVerb/readIntent/entDomain/fileMentioned…）决定"走哪条路"，
// 在这里降级成"注册哪些工具"——判断错了顶多多给一个工具，而不是走错整条链路。
//
// 与旧 agent-loop.ts（文本 ReAct）的分工：
//   本模块走**原生 function-calling**（结构化 tool_calls，无需自解析 JSON）；
//   上游不认 tools 时由调用方降级到 agent-loop.ts。两者并存，agent-loop 不删。
//
// 叶子纪律（照搬 agent-loop.ts 的既有做法）：**不 import llm/db**——那会连带触发 electron 的
// app.getPath，让纯逻辑单测跑不起来。模型调用由调用方以 callModel 传入（生产传 callLlmTools，
// 单测传 mock），LlmConfig 仅 type-only 导入。
// 权限闸 authorizeToolCall 则**刻意不可注入**：安全闸是内核的一部分，可注入就意味着可绕过。
import type { LlmConfig } from './llm'
import { ToolRegistry, isParallelSafe, type ToolSpec } from './tool-registry'
import { authorizeToolCall, type AuthContext } from './permission-gate'
import { swallow } from './util'
import type { SendLog } from './types'
import {
  TOOL_PREVIEW_CAP,
  type CoreEvent, type CoreMessage, type CoreTodo, type CoreToolCall, type ToolStatus,
} from '../shared/core-protocol'

/** 模型一轮的返回（与 llm.ts 的 LlmTurnResult 同形；这里重声明以免 import 拉起 electron）。 */
export interface CoreModelResult {
  text: string
  toolCalls: CoreToolCall[]
  finishReason: string
  /** 思维模式模型的思维链；必须存进 assistant 消息并在下一轮原样回传，否则上游 400。 */
  reasoningContent?: string
}

/** 模型调用（生产传 llm.ts 的 callLlmTools，单测传 mock）。 */
export type CallModel = (
  messages: CoreMessage[],
  tools: ReturnType<ToolRegistry['schemas']>,
  cfg: LlmConfig,
  opts?: { temperature?: number; longRunning?: boolean; abort?: AbortSignal },
) => Promise<CoreModelResult>

export interface AgentCoreOptions {
  runId: string
  /** 会话历史（含本轮 user 消息）。引擎在其上追加，调用方拿回去落库。 */
  messages: CoreMessage[]
  registry: ToolRegistry
  cfg: LlmConfig
  /** 模型调用——必填，使本模块不依赖 llm/db（见文件头的叶子纪律）。 */
  callModel: CallModel
  sendLog: SendLog
  emit: (ev: CoreEvent) => void
  permMode: 'readonly' | 'full'
  unattended?: boolean
  /**
   * 每轮出站前生成的 ephemeral 上下文（日期/知识库命中/技能目录/权限档…）。
   * 追加到**最后一条 user 消息**而非插 system 消息——中途插 system 在各厂商表现不一致
   * （同款处理）。不写回 messages，所以不会被历史重放污染。
   */
  contextProvider?: () => string
  maxIterations?: number
  /** 墙钟预算（毫秒）：超预算主动收尾用已有观察作答，别被外层硬 timeout 砍成空答。 */
  budgetMs?: number
  /** 单条工具结果进 messages 前的截断上限，防提示词爆炸。 */
  obsCap?: number
  /** 技能 id → 显示名（微计划等用户可见文案用；缺省显示 id）。 */
  skillNameOf?: (id: string) => string | undefined
  isCancelled?: () => boolean
  /** 中止信号：透给模型请求，让"点停止"能真的掐断在途的那一次调用（而不是等它答完）。 */
  abortSignal?: () => AbortSignal | undefined
}

export interface CoreResult {
  answer: string
  messages: CoreMessage[]
  todos: CoreTodo[]
  status: 'completed' | 'max_iterations' | 'budget_exceeded' | 'interrupted' | 'error'
  iterations: number
  /** 本轮实际发生的工具调用次数（trace 与验收用）。 */
  toolCallCount: number
}

/** 任务清单是内核原语而非普通工具：它的产物要进事件流驱动对话框里的 progress。 */
export const TODO_TOOL_NAME = 'todo_write'

export function makeTodoToolSpec(): ToolSpec {
  return {
    name: TODO_TOOL_NAME,
    description: '维护本次任务的执行清单。任务需要多步完成时，先用它列出计划步骤；每完成一步就再调一次更新状态。'
      + '**每次都要传完整清单**（这是替换而非追加）。单步就能答的简单问题不要用。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整的任务清单，每项形如 {"content":"步骤描述","status":"pending|in_progress|done"}',
          items: {
            type: 'object',
            properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    metadata: { label: '更新任务清单', risk: 'low', category: 'planning' },
    // 真正的状态写入由内核拦截处理（见 handleToolCalls）；这里只是 schema 载体与兜底。
    run: async () => '任务清单已更新。',
  }
}

/** 规整模型给的清单：容忍 status 别名与纯字符串项，绝不因为一个字段不合规就丢掉整张清单。 */
export function normalizeTodos(raw: unknown): CoreTodo[] {
  if (!Array.isArray(raw)) return []
  const out: CoreTodo[] = []
  for (const entry of raw) {
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>
      const content = String(e.content ?? '').trim()
      if (!content) continue
      let status = String(e.status ?? 'pending')
      if (status === 'completed' || status === 'finished') status = 'done'   // 模型常用的别名
      if (status === 'doing' || status === 'active') status = 'in_progress'
      out.push({ content, status: (['pending', 'in_progress', 'done'].includes(status) ? status : 'pending') as CoreTodo['status'] })
    } else if (typeof entry === 'string' && entry.trim()) {
      out.push({ content: entry.trim(), status: 'pending' })
    }
  }
  return out
}

/** 出站消息：在最后一条 user 消息尾部追加 ephemeral 上下文。**不改动原数组**。 */
export function outboundMessages(messages: CoreMessage[], context: string): CoreMessage[] {
  if (!context.trim()) return messages
  const block = `\n\n<system-context>\n${context}\n</system-context>`
  const idx = messages.map(m => m.role).lastIndexOf('user')
  if (idx < 0) return messages
  const out = messages.slice()
  out[idx] = { ...out[idx], content: out[idx].content + block }
  return out
}

/**
 * 从助手文本里剥出「被当正文吐出来的 todo_write 参数」。
 *
 * 实测（deepseek 长对话）：模型想更新任务清单，却把参数 JSON 直接写进了 content——
 * `[{"content":"联网调研…","status":"done"},…]` 整段成了"最终答案"显示给用户，
 * 而那次状态更新也没真正发生（清单最后一项永远停在进行中）。两个症状同一根因。
 * 识别到就把它**当 todo_write 调用处理**（更新清单）并从文本中剥除。
 */
export function extractLeakedTodos(text: string): { todos: CoreTodo[]; rest: string } | null {
  // 全文扫描：四次实测泄漏位置各不相同（开头 / 键序变体 / 围栏包裹 / 叙述句之后）——
  // 按"出现在哪"打补丁永远追不上模型的花样，改为在**任意位置**识别 todos-JSON 块并全部剥除。
  const src = text || ''
  if (!src.includes('"content"')) return null
  let allTodos: CoreTodo[] | null = null
  const keep: string[] = []
  let cursor = 0
  while (cursor < src.length) {
    const start = src.indexOf('[', cursor)
    if (start < 0) { keep.push(src.slice(cursor)); break }
    // 带引号感知的括号匹配（todos 的 content 里可能出现 ]）
    let depth = 0, inStr = false, esc = false, end = -1
    for (let i = start; i < src.length; i++) {
      const c = src[i]
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (c === '[') depth++
      else if (c === ']') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end < 0) { keep.push(src.slice(cursor)); break }
    let parsed: unknown = null
    try { parsed = JSON.parse(src.slice(start, end + 1)) } catch { /* 非法 JSON → 原样保留 */ }
    const isTodos = Array.isArray(parsed) && parsed.length > 0
      && parsed.every(e => e && typeof e === 'object' && 'content' in (e as object))
    if (isTodos) {
      const todos = normalizeTodos(parsed)
      if (todos.length) {
        allTodos = todos   // 多块时取最后一块（最新状态）
        let head = src.slice(cursor, start)
        head = head.replace(/```(?:json)?\s*$/i, '')   // 剥掉包着它的开围栏
        keep.push(head)
        cursor = end + 1
        const tail = src.slice(cursor).match(/^\s*```\s*/)
        if (tail) cursor += tail[0].length              // 收围栏
        continue
      }
    }
    keep.push(src.slice(cursor, end + 1))
    cursor = end + 1
  }
  if (!allTodos) return null
  return { todos: allTodos, rest: keep.join('').replace(/\n{3,}/g, '\n\n').trim() }
}

/** 工具调用的去重键：连续两次完全相同的调用说明模型卡住了，该干预。 */
function callKey(call: CoreToolCall): string {
  return `${call.name}|${JSON.stringify(call.args)}`
}

function truncate(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) + `\n…（内容过长已截断，原文共 ${s.length} 字）` : s
}

/**
 * 跑完一轮完整任务：从当前 messages 出发，循环「模型决策 → 工具执行」直到模型给出最终答案。
 */
export async function runAgentCore(o: AgentCoreOptions): Promise<CoreResult> {
  try {
    return await runTurnInner(o)
  } finally {
    await o.registry.cleanup()
  }
}

async function runTurnInner(o: AgentCoreOptions): Promise<CoreResult> {
  const maxIterations = o.maxIterations ?? 14
  const budgetMs = o.budgetMs ?? 0
  const obsCap = o.obsCap ?? 4000
  const startMs = Date.now()
  // 预算只管「模型推理 + 空转」，工具的**有效工作时间要扣除**——deep-research 一次就跑十几分钟，
  // 计入预算的话回到循环顶必然 budget_exceeded，永远走低质量的收尾路径而非正常作答（实测连续复现）。
  let toolElapsedMs = 0
  const messages = o.messages
  const todos: CoreTodo[] = []
  let iterations = 0
  let toolCallCount = 0
  let lastKey = ''
  let repeat = 0

  const cancelled = () => !!o.isCancelled?.()

  /**
   * 运行时纠偏：跑到第二轮还没列执行计划，说明模型把提示词里的"第一步就列清单"当耳旁风了。
   * 实测静态提示词对这条的遵守率不高——用户看到的是任务跑了十几秒仍没有任何进度可看，
   * 计划要等它检索完几轮才补上。与其继续加强措辞，不如在上下文里当场提醒一次。
   */
  const planNudge = () =>
    (!todos.length && iterations >= 2)
      ? '\n\n【提醒】你已经调用了多次工具却还没有列执行计划。请**立刻**调用 todo_write 补上完整计划'
        + '（把已经做完的步骤标成 done），用户正等着看进度。'
      : ''

  o.emit({ type: 'turn_start', runId: o.runId })

  while (iterations < maxIterations) {
    if (cancelled()) return finish('interrupted', '')
    if (budgetMs > 0 && Date.now() - startMs - toolElapsedMs > budgetMs) {
      o.sendLog('observing', `接近时间预算（模型侧已用 ${Math.round((Date.now() - startMs - toolElapsedMs) / 1000)}s），提前收尾。`)
      return await wrapUp('budget_exceeded')
    }
    iterations++

    // —— ① 模型决策 ——
    let res: CoreModelResult
    try {
      res = await o.callModel(
        outboundMessages(messages, (o.contextProvider?.() || '') + planNudge()),
        o.registry.schemas(),
        o.cfg,
        { temperature: 0, longRunning: true, abort: o.abortSignal?.() },
      )
    } catch (e: any) {
      // ToolsUnsupportedError 由调用方接住降级；其余错误如实结束（绝不编个答案糊弄）。
      if (e?.name === 'ToolsUnsupportedError') throw e
      const msg = e?.message || String(e)
      messages.push({ role: 'notice', content: msg, noticeKind: 'error', ts: Date.now() })
      o.emit({ type: 'error', runId: o.runId, message: msg })
      return finish('error', '')
    }

    // 模型刚答完就复查一次：接下来是整个工具阶段（可能几十秒到几分钟），
    // 用户在模型思考期间点的停止，必须在这里生效，不能让它再往下跑一整轮工具。
    if (cancelled()) return finish('interrupted', '')

    // 泄漏兜底：todo_write 参数被当正文吐出来 → 照它的本意更新清单，并把 JSON 从文本里剥掉。
    const leaked = extractLeakedTodos(res.text)
    if (leaked) {
      todos.splice(0, todos.length, ...leaked.todos)
      o.emit({ type: 'todo_updated', runId: o.runId, todos: todos.map(t => ({ ...t })) })
      res = { ...res, text: leaked.rest }
      // 剥完全空且这轮没有工具调用：这轮实际上只是在更新清单，不能把空串当最终答案——
      // 追加提醒让模型给出真正面向用户的答复（循环有 maxIterations 兜底，不会死转）。
      if (!res.text && !res.toolCalls.length) {
        messages.push({ role: 'assistant', content: '（已更新任务清单）', ts: Date.now() })
        messages.push({
          role: 'user', ts: Date.now(),
          content: '任务清单已更新。请继续执行任务；若已全部完成，直接给出面向用户的最终答复（自然语言，不要输出 JSON 或工具参数）。',
        })
        continue
      }
    }

    messages.push({
      role: 'assistant', content: res.text, ts: Date.now(),
      ...(res.toolCalls.length ? { toolCalls: res.toolCalls } : {}),
      // 思维链随本轮 assistant 消息一起留存：下一轮出站时原样带回上游（协议硬要求，
      // 漏了就是 400 "reasoning_content must be passed back"）。不展示、不判分。
      ...(res.reasoningContent ? { reasoningContent: res.reasoningContent } : {}),
    })
    o.emit({ type: 'assistant_message', runId: o.runId, text: res.text, toolCalls: res.toolCalls.map(c => c.name) })

    // —— ② 没有工具调用 → 这句话就是最终答案 ——
    if (!res.toolCalls.length) {
      // 清单收尾：答案都给了，仍挂着 in_progress 的项就是模型忘了最后一次 todo_write——
      // 用户看到的是「任务已回复，计划最后一项还在转圈」（实测两次）。completed 才收，
      // 步数/预算耗尽不收（那是真没做完，如实保留）。pending 项同理不动。
      if (todos.some(t => t.status === 'in_progress')) {
        todos.forEach(t => { if (t.status === 'in_progress') t.status = 'done' })
        o.emit({ type: 'todo_updated', runId: o.runId, todos: todos.map(t => ({ ...t })) })
      }
      o.emit({ type: 'turn_end', runId: o.runId, status: 'completed', iterations })
      return { answer: res.text, messages, todos, status: 'completed', iterations, toolCallCount }
    }

    // 有工具调用时，助手的这段文本就是「叙述」——用户在对话框里读到的实时进度行。
    // 只发事件、不进日志流——叙述已经在对话流气泡里显示了，再 sendLog 一次会让
    // 「执行详情」里出现与对话流一字不差的重复行（实测反馈）。
    if (res.text.trim()) o.emit({ type: 'narration', runId: o.runId, text: res.text.trim() })

    // —— ③ 循环侦测：连续三次完全相同的调用判定卡死（国产模型实测会出现这种空转）——
    const key = res.toolCalls.map(callKey).join('||')
    repeat = key === lastKey ? repeat + 1 : 0
    lastKey = key
    if (repeat >= 2) {
      o.sendLog('observing', '连续重复同一批调用且无新进展，终止循环并收尾。')
      for (const call of res.toolCalls) {
        pushToolResult(call, '（检测到重复调用，已终止；请基于已有信息作答）', 'error')
      }
      return await wrapUp('max_iterations')
    }

    // —— ④ 执行工具 ——
    toolCallCount += res.toolCalls.length
    await handleToolCalls(res.toolCalls)
    o.emit({ type: 'iteration_end', runId: o.runId, iteration: iterations })
    if (cancelled()) return finish('interrupted', '')
  }

  return await wrapUp('max_iterations')

  // ————————————————————————————————————————————————————————

  function pushToolResult(call: CoreToolCall, content: string, status: ToolStatus): void {
    messages.push({
      role: 'tool', content: truncate(content, obsCap), toolCallId: call.id,
      toolName: call.name, status, ts: Date.now(),
    })
  }

  /**
   * 执行一批工具调用：**先逐个授权**（确认卡是交互式的，必须串行），再执行。
   * 低风险只读工具并发跑，写操作/browse 严格按调用顺序串行（防状态竞争）。
   */
  async function handleToolCalls(calls: CoreToolCall[]): Promise<void> {
    const authCtx: AuthContext = { permMode: o.permMode, unattended: o.unattended, sendLog: o.sendLog }
    const cleared: { call: CoreToolCall; spec: ToolSpec }[] = []

    // 技能是长动作（动辄几分钟）：模型没列清单就由内核补一份**确定性微计划**——
    // 提示词规则（TODO_RULE ②）实测遵守率不稳，用户不该对着空屏干等（连续三轮反馈）。
    const skillCall = calls.find(c => c.name === 'run_skill')
    if (skillCall && !todos.length) {
      const sid = String((skillCall.args as Record<string, unknown>).skillId || '技能')
      // 用户可见文案用显示名——「执行技能 skill-imp-fcde6655」没人看得懂（实测红线标注）
      const sk = o.skillNameOf?.(sid) || sid
      todos.push({ content: `执行技能 ${sk}`, status: 'in_progress' }, { content: '整理执行结果并作答', status: 'pending' })
      o.emit({ type: 'todo_updated', runId: o.runId, todos: todos.map(t => ({ ...t })) })
    }

    for (const call of calls) {
      if (cancelled()) {
        // 中断后**每个未执行的调用仍要补一条 tool 结果**：托管 chat 模板会拒绝孤儿 tool_calls，
        // 少一条下一轮整个历史就发不出去（ _interrupted_tool 同款处理）。
        pushToolResult(call, '（用户中止，未执行）', 'interrupted')
        o.emit({ type: 'tool_finished', runId: o.runId, callId: call.id, name: call.name, status: 'interrupted', preview: '已中止' })
        continue
      }
      o.emit({ type: 'tool_proposed', runId: o.runId, call })
      const spec = o.registry.get(call.name)

      // todo_write 由内核直接处理：它的产物要驱动对话框里的任务清单，不走普通执行路径。
      if (spec && call.name === TODO_TOOL_NAME) {
        const next = normalizeTodos(call.args.todos ?? (call.args as Record<string, unknown>).items)
        todos.splice(0, todos.length, ...next)
        o.emit({ type: 'todo_updated', runId: o.runId, todos: todos.map(t => ({ ...t })) })
        pushToolResult(call, `任务清单已更新，共 ${next.length} 项。`, 'ok')
        o.emit({ type: 'tool_finished', runId: o.runId, callId: call.id, name: call.name, status: 'ok', preview: `${next.length} 项` })
        continue
      }

      if (spec && (spec.metadata.risk === 'write' || spec.metadata.requiresApproval)) {
        o.emit({ type: 'permission_required', runId: o.runId, call, label: spec.metadata.label })
      }
      const decision = await authorizeToolCall(spec, call, authCtx)
      if (!decision.allowed) {
        pushToolResult(call, decision.reason, 'denied')
        o.emit({ type: 'tool_finished', runId: o.runId, callId: call.id, name: call.name, status: 'denied', preview: decision.reason, reason: decision.reason })
        continue
      }
      cleared.push({ call, spec: spec! })
    }

    const parallel = cleared.length > 1 ? cleared.filter(c => isParallelSafe(c.spec)) : []
    const serial = cleared.filter(c => !parallel.includes(c))

    if (parallel.length) {
      for (const { call } of parallel) o.emit({ type: 'tool_started', runId: o.runId, callId: call.id, name: call.name })
      const outcomes = await Promise.all(parallel.map(({ call, spec }) => execOne(call, spec)))
      for (let i = 0; i < parallel.length; i++) recordResult(parallel[i].call, outcomes[i])
    }
    for (const { call, spec } of serial) {
      if (cancelled()) {
        pushToolResult(call, '（用户中止，未执行）', 'interrupted')
        o.emit({ type: 'tool_finished', runId: o.runId, callId: call.id, name: call.name, status: 'interrupted', preview: '已中止' })
        continue
      }
      o.emit({ type: 'tool_started', runId: o.runId, callId: call.id, name: call.name })
      recordResult(call, await execOne(call, spec))
    }
  }

  async function execOne(call: CoreToolCall, spec: ToolSpec): Promise<{ text: string; status: ToolStatus }> {
    // 工具内部的 sendLog 流水**就是**这次调用的过程——直接以 tool_progress 事件挂到 call.id 上，
    // 渲染层不再用时间去猜归属（并行工具各持自己的闭包 id，归属精确）。日志流照旧转发（执行详情兜底）。
    const nestedLog: typeof o.sendLog = (type, text) => {
      o.sendLog(type, text)
      o.emit({ type: 'tool_progress', runId: o.runId, callId: call.id, log: { type, text, timestamp: new Date().toLocaleTimeString() } })
    }
    const t0 = Date.now()
    try {
      const text = await spec.run(call.args, { sendLog: nestedLog })
      return { text: text || '（工具没有返回任何内容）', status: 'ok' }
    } catch (e: any) {
      swallow(e, `turn-tool-${call.name}`)
      // 工具报错要如实回灌给模型，让它换个方式重试或如实告知用户——不能静默当成功。
      return { text: `工具执行出错：${e?.message || e}`, status: 'error' }
    } finally {
      toolElapsedMs += Date.now() - t0
    }
  }

  function recordResult(call: CoreToolCall, out: { text: string; status: ToolStatus }): void {
    pushToolResult(call, out.text, out.status)
    // 微计划推进：技能跑完 → 「执行技能」划掉、「整理结果」转起来（与真实进度同步，不靠模型）
    if (call.name === 'run_skill' && todos[0]?.content.startsWith('执行技能') && todos[0].status === 'in_progress') {
      todos[0].status = 'done'
      if (todos[1]?.status === 'pending') todos[1].status = 'in_progress'
      o.emit({ type: 'todo_updated', runId: o.runId, todos: todos.map(t => ({ ...t })) })
    }
    o.emit({
      type: 'tool_finished', runId: o.runId, callId: call.id, name: call.name,
      status: out.status, preview: out.text.slice(0, TOOL_PREVIEW_CAP),
    })
  }

  /** 步数/预算耗尽：让模型**只依据已有观察**给最终答案，不再给工具（防它又想调）。 */
  async function wrapUp(status: CoreResult['status']): Promise<CoreResult> {
    const WRAP_RULE = '你已达到本次任务的步数或时间上限。请**只依据上面真实观察到的工具结果**给出最终答案（自然语言，'
      + '绝不要输出任务清单 JSON 或工具参数）；若观察不足以确定答案，如实说明已确认到哪一步、还缺什么，绝不编造任何数据。'
    messages.push({ role: 'user', ts: Date.now(), content: WRAP_RULE })
    // 收尾输出同样要过泄漏剥离——主循环装了、这条路漏了，模型在收尾时照样把 todos JSON 当答案吐
    //（实测：预算耗尽 → 收尾 → 气泡开头整段 JSON）。剥出的状态是模型对各步的真实声明，顺带更新清单。
    const stripLeak = (raw: string): string => {
      const lk = extractLeakedTodos(raw)
      if (!lk) return raw
      todos.splice(0, todos.length, ...lk.todos)
      o.emit({ type: 'todo_updated', runId: o.runId, todos: todos.map(t => ({ ...t })) })
      return lk.rest
    }
    let answer = ''
    try {
      const res = await o.callModel(messages, [], o.cfg, { temperature: 0, longRunning: true })
      answer = stripLeak(res.text)
    } catch (e) { swallow(e, 'turn-wrapup') }

    // 精简重试：跑满上限的任务往往塞了十几次工具结果，全量收尾调用容易超上下文而失败——
    // 实测 432 秒收集了一堆素材，最后只落一句"未能在限定步数内完成"（收尾挂了走兜底），等于交白卷。
    // 只带 system + 用户任务 + 最近 5 条工具结果再试一次，通常就能把已有素材整理成像样的答案。
    if (!answer.trim()) {
      try {
        const sys = messages.find(m => m.role === 'system')
        const firstUser = messages.find(m => m.role === 'user')
        const recentTools = messages.filter(m => m.role === 'tool').slice(-5)
          .map(m => ({ role: 'user' as const, content: `【此前工具「${m.toolName}」的真实结果（节选）】\n${m.content.slice(0, 2500)}` }))
        const slim: CoreMessage[] = [
          ...(sys ? [sys] : []),
          ...(firstUser ? [{ role: 'user' as const, content: firstUser.content }] : []),
          ...recentTools,
          { role: 'user' as const, content: WRAP_RULE },
        ]
        const res2 = await o.callModel(slim, [], o.cfg, { temperature: 0, longRunning: true })
        answer = stripLeak(res2.text)
      } catch (e) { swallow(e, 'turn-wrapup-slim') }
    }
    if (answer.trim()) messages.push({ role: 'assistant', content: answer, ts: Date.now() })

    if (answer.trim() && todos.some(t => t.status === 'in_progress')) {
      todos.forEach(t => { if (t.status === 'in_progress') t.status = 'done' })
      o.emit({ type: 'todo_updated', runId: o.runId, todos: todos.map(t => ({ ...t })) })
    }
    o.emit({ type: 'turn_end', runId: o.runId, status: status === 'budget_exceeded' ? 'budget_exceeded' : 'max_iterations', iterations })
    // 兜底也要诚实有用：说清做了多少、素材在哪，别只甩一句"未能完成"
    const fallback = `本次执行 ${iterations} 轮、${toolCallCount} 次工具调用后达到上限，未能完成最终整理。`
      + '已检索到的素材见下方来源列表；建议缩小问题范围重试，或直接使用「深度调研」技能（它自带收敛与成稿）。'
    return { answer: answer.trim() || fallback, messages, todos, status, iterations, toolCallCount }
  }

  function finish(status: CoreResult['status'], answer: string): CoreResult {
    if (status === 'interrupted') {
      messages.push({ role: 'notice', content: '已中止', noticeKind: 'interrupted', ts: Date.now() })
      o.emit({ type: 'interrupted', runId: o.runId, iterations })
    }
    return { answer, messages, todos, status, iterations, toolCallCount }
  }
}
