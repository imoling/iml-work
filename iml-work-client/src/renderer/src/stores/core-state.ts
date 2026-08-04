// 新执行内核事件流 → 展示态的归约（纯函数，可单测）。
//
// 单独成模块的原因：这是「实时视图」与「刷新回放」共用的同一套推导规则。
// 放进 chatStore 里就只能靠跑整个 app 才能验证，而事件顺序的边界情况（工具被拒、
// 中途中断、同一 callId 重复到达）恰恰是最容易出错、也最该被单测钉住的地方。
import type { CoreEvent, CoreTodo } from '../../../shared/core-protocol'
import type { ToolRowData } from '../components/dialogue/core-cards'

/** 一轮任务的过程快照（随消息落库回放）。 */
export interface CoreRunSnapshot {
  todos: CoreTodo[]
  tools: ToolRowData[]
  /** 模型推理轮数（turn_end 带回）。用于状态栏的真实口径统计。 */
  iterations?: number
  /**
   * agentId → 发起该子智能体的父工具行 callId。
   *
   * 子智能体的事件只带 agentId（它不知道自己被挂在哪一行），归位靠这张表——
   * 由 agent_started 建立。落进快照是必要的：刷新回放时事件会重放一遍，
   * 表没了的话子智能体的工具行就全找不到家、只能丢弃。
   */
  agents?: Record<string, string>
}

/** 执行中的实时态：比快照多一个"当前叙述"（任务结束后不再需要）。 */
export interface CoreRunState extends CoreRunSnapshot {
  narration: string
}

export const EMPTY_TURN_RUN: CoreRunState = { todos: [], tools: [], narration: '' }

/**
 * 改写某个子智能体所属父工具行的 subTools。
 *
 * 找不到归属（agent_started 没到、或那一行还没上屏）时**原样返回**——宁可丢一条子事件，
 * 也不要为它在主轨迹里凭空造一行：那会让用户看到一堆没有归属、来路不明的工具调用。
 */
function withSubTools(
  cur: CoreRunState, agentId: string,
  fn: (subs: ToolRowData[]) => ToolRowData[],
): CoreRunState {
  const parentCallId = cur.agents?.[agentId]
  if (!parentCallId) return cur
  const idx = cur.tools.findIndex(t => t.callId === parentCallId)
  if (idx < 0) return cur
  const prev = cur.tools[idx].subTools || []
  const next = fn(prev)
  if (next === prev) return cur
  const tools = cur.tools.slice()
  tools[idx] = { ...tools[idx], subTools: next }
  return { ...cur, tools }
}

/** 改写父工具行本身的字段（子智能体的叙述/结论标注到发起它的那一行上）。 */
function patchAgentRow(
  cur: CoreRunState, agentId: string, patch: Partial<ToolRowData>,
): CoreRunState {
  const parentCallId = cur.agents?.[agentId]
  if (!parentCallId) return cur
  const idx = cur.tools.findIndex(t => t.callId === parentCallId)
  if (idx < 0) return cur
  const tools = cur.tools.slice()
  tools[idx] = { ...tools[idx], ...patch }
  return { ...cur, tools }
}

/**
 * 把一个事件并进展示态。**返回原对象表示无变化**，调用方据此跳过 set（避免无谓重渲染）。
 */
export function applyTurnEvent(cur: CoreRunState, ev: CoreEvent): CoreRunState {
  switch (ev.type) {
    case 'turn_start':
      return EMPTY_TURN_RUN

    case 'narration':
      // 子智能体的叙述**绝不能**抢主分身的进度行：那一行说的是"主分身正在做什么"，
      // 被子智能体的「我正在读某篇网页」顶掉后，用户会以为主分身自己钻进了细节。
      // 它归到发起它的那一行上，在子卡里显示。
      if (ev.agentId) return patchAgentRow(cur, ev.agentId, { subNarration: ev.text })
      return { ...cur, narration: ev.text }

    case 'todo_updated':
      return { ...cur, todos: ev.todos }

    case 'agent_started': {
      // 先登记归属表，再把标题标到父行上——顺序无所谓，但两件事必须一起做完：
      // 只登记不标题，子卡就没有名字；只标题不登记，后续子事件全部无处归位。
      const agents = { ...(cur.agents || {}), [ev.agentId]: ev.parentCallId }
      const idx = cur.tools.findIndex(t => t.callId === ev.parentCallId)
      if (idx < 0) return { ...cur, agents }
      const tools = cur.tools.slice()
      tools[idx] = { ...tools[idx], agentLabel: ev.label, agentKind: ev.kind || 'sub', subTools: tools[idx].subTools || [] }
      return { ...cur, agents, tools }
    }

    case 'agent_finished':
      // 结论落到父行；叙述撤掉（它说的是"正在做什么"，已经做完了）。
      return patchAgentRow(cur, ev.agentId, { subSummary: ev.summary, subNarration: '' })

    case 'tool_proposed': {
      // 在**提议**时就上屏（而非等 tool_started）：写工具要等用户签字，这段等待期间
      // 用户必须看得见"分身正卡在哪一步"，否则界面像是无故卡住了。
      // 但状态是 queued 而非 running——它此刻确实一步都没开始（见 ToolRowData.status 注释）。
      const row: ToolRowData = { callId: ev.call.id, name: ev.call.name, args: ev.call.args, status: 'queued' }
      if (ev.agentId) {
        return withSubTools(cur, ev.agentId, subs =>
          subs.some(t => t.callId === ev.call.id) ? subs : [...subs, row])
      }
      if (cur.tools.some(t => t.callId === ev.call.id)) return cur
      return { ...cur, tools: [...cur.tools, row] }
    }

    case 'tool_started': {
      // 内核真正开始执行这次调用了 —— 排队态转运行态。
      // 这个事件此前**从未被处理**，所以所有工具从提议那一刻起就画成转圈，
      // 串行排队的调用与真正在跑的调用长得一模一样。
      const toRunning = (t: ToolRowData) => t.status === 'queued' ? { ...t, status: 'running' as const } : t
      if (ev.agentId) {
        return withSubTools(cur, ev.agentId, subs => {
          const i = subs.findIndex(t => t.callId === ev.callId)
          if (i < 0 || subs[i].status !== 'queued') return subs
          const next = subs.slice()
          next[i] = toRunning(subs[i])
          return next
        })
      }
      const idx = cur.tools.findIndex(t => t.callId === ev.callId)
      if (idx < 0 || cur.tools[idx].status !== 'queued') return cur
      const tools = cur.tools.slice()
      tools[idx] = toRunning(cur.tools[idx])
      return { ...cur, tools }
    }

    case 'tool_progress': {
      // 工具内部流水由内核精确挂到 call.id——单一数据源，渲染层不再按时间猜归属。
      if (ev.agentId) {
        return withSubTools(cur, ev.agentId, subs => {
          const i = subs.findIndex(t => t.callId === ev.callId)
          if (i < 0) return subs
          const next = subs.slice()
          next[i] = { ...next[i], progress: [...(next[i].progress || []), ev.log] }
          return next
        })
      }
      const idx = cur.tools.findIndex(t => t.callId === ev.callId)
      if (idx < 0) return cur   // 行还没上屏（事件乱序）就丢弃这条流水，别为它凭空造行
      const tools = cur.tools.slice()
      tools[idx] = { ...tools[idx], progress: [...(tools[idx].progress || []), ev.log] }
      return { ...cur, tools }
    }

    case 'tool_finished': {
      if (ev.agentId) {
        return withSubTools(cur, ev.agentId, subs => {
          const i = subs.findIndex(t => t.callId === ev.callId)
          if (i < 0) return [...subs, { callId: ev.callId, name: ev.name, args: {}, status: ev.status, preview: ev.preview }]
          const next = subs.slice()
          next[i] = { ...next[i], status: ev.status, preview: ev.preview }
          return next
        })
      }
      const idx = cur.tools.findIndex(t => t.callId === ev.callId)
      if (idx < 0) {
        // 没见过 proposed 就来了 finished（事件丢失/乱序）——补一行，别把这次调用整个吞掉。
        return { ...cur, tools: [...cur.tools, { callId: ev.callId, name: ev.name, args: {}, status: ev.status, preview: ev.preview }] }
      }
      const tools = cur.tools.slice()
      tools[idx] = { ...tools[idx], status: ev.status, preview: ev.preview }
      return { ...cur, tools }
    }

    case 'turn_end':
    case 'interrupted':
      // 收尾：叙述是"正在做什么"，任务已结束就该撤掉，只留清单与工具轨迹。
      // 同时记下真实轮数——状态栏原先显示的「共 N 步」是执行日志条数（工具内部也在写日志，
      // 实测一次任务 76 条），跟「7 轮 · 9 次工具调用」摆在一起自相矛盾。
      return { ...cur, narration: '', iterations: ev.iterations }

    case 'error':
      return cur.narration ? { ...cur, narration: '' } : cur

    default:
      return cur
  }
}

/** 取出可落库的快照（丢掉只在执行期有意义的叙述）。 */
export function toSnapshot(s: CoreRunState | undefined): CoreRunSnapshot | undefined {
  if (!s || (!s.todos.length && !s.tools.length)) return undefined
  return {
    todos: s.todos,
    tools: s.tools.map(slimForStore),
    ...(s.iterations ? { iterations: s.iterations } : {}),
    // 归属表随快照落库：刷新回放会重放事件，表丢了子智能体的工具行就全都无处归位。
    ...(s.agents && Object.keys(s.agents).length ? { agents: s.agents } : {}),
  }
}

/**
 * 落库前给工具行瘦身：**丢掉子分身内部每一步的实时流水**。
 *
 * 快照是整个 JSON 塞进 assistant 消息的 metadata 的。三个小分身各跑 8 步、每步几条 progress，
 * 一条消息就能到 20KB+，而历史会话是整列表加载的——翻旧会话会越来越沉。
 *
 * 丢 progress 是因为它**只在执行当时有意义**（"我正在细读《…》"），事后回看没有追溯价值；
 * 真正要留的是：跑了哪几步（工具名+参数）、结果节选、以及小分身带回的结论。这些都保留。
 * 主分身自己那层的 progress 不动——那是「执行详情」点开就要看的东西。
 */
function slimForStore(t: ToolRowData): ToolRowData {
  if (!t.subTools?.length) return t
  return {
    ...t,
    subTools: t.subTools.map(({ progress, ...rest }) => rest),
    // 执行期的实时叙述同理，事后无意义
    ...(t.subNarration ? { subNarration: '' } : {}),
  }
}

/**
 * 真实口径的执行统计：轮数 + 工具调用次数（todo_write 是清单维护，不计入"调用了几次工具"）。
 *
 * subSteps = 小分身们各自跑的步数，**单独一项、不并进 toolCalls**：
 * toolCalls 是主分身的口径（要与后端审计对得上，一次 run_subagent 就是 1 次调用），
 * 但只报这个数，用户会看到「3 次工具调用」跑了两分多钟——而实际连小分身一共动了十几步。
 * 两个数各自成立，摆在一起才说得清这一轮到底干了多少活。
 */
export function turnStats(s: CoreRunSnapshot | undefined): { iterations: number; toolCalls: number; subSteps: number } | null {
  if (!s) return null
  const rows = s.tools.filter(t => t.name !== 'todo_write')
  return {
    iterations: s.iterations || 0,
    toolCalls: rows.length,
    subSteps: rows.reduce((n, t) => n + (t.subTools?.length || 0), 0),
  }
}
