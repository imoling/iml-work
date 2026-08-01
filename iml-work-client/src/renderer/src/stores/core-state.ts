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
}

/** 执行中的实时态：比快照多一个"当前叙述"（任务结束后不再需要）。 */
export interface CoreRunState extends CoreRunSnapshot {
  narration: string
}

export const EMPTY_TURN_RUN: CoreRunState = { todos: [], tools: [], narration: '' }

/**
 * 把一个事件并进展示态。**返回原对象表示无变化**，调用方据此跳过 set（避免无谓重渲染）。
 */
export function applyTurnEvent(cur: CoreRunState, ev: CoreEvent): CoreRunState {
  switch (ev.type) {
    case 'turn_start':
      return EMPTY_TURN_RUN

    case 'narration':
      return { ...cur, narration: ev.text }

    case 'todo_updated':
      return { ...cur, todos: ev.todos }

    case 'tool_proposed': {
      // 在**提议**时就上屏（而非等 tool_started）：写工具要等用户签字，这段等待期间
      // 用户必须看得见"分身正卡在哪一步"，否则界面像是无故卡住了。
      if (cur.tools.some(t => t.callId === ev.call.id)) return cur
      const row: ToolRowData = { callId: ev.call.id, name: ev.call.name, args: ev.call.args, status: 'running' }
      return { ...cur, tools: [...cur.tools, row] }
    }

    case 'tool_progress': {
      // 工具内部流水由内核精确挂到 call.id——单一数据源，渲染层不再按时间猜归属。
      const idx = cur.tools.findIndex(t => t.callId === ev.callId)
      if (idx < 0) return cur   // 行还没上屏（事件乱序）就丢弃这条流水，别为它凭空造行
      const tools = cur.tools.slice()
      tools[idx] = { ...tools[idx], progress: [...(tools[idx].progress || []), ev.log] }
      return { ...cur, tools }
    }

    case 'tool_finished': {
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
  return { todos: s.todos, tools: s.tools, ...(s.iterations ? { iterations: s.iterations } : {}) }
}

/** 真实口径的执行统计：轮数 + 工具调用次数（todo_write 是清单维护，不计入"调用了几次工具"）。 */
export function turnStats(s: CoreRunSnapshot | undefined): { iterations: number; toolCalls: number } | null {
  if (!s) return null
  return { iterations: s.iterations || 0, toolCalls: s.tools.filter(t => t.name !== 'todo_write').length }
}
