// 执行内核（TurnEngine）的跨端协议——主进程与渲染层的**唯一契约**。
//
// 为什么单独成文件：消息形状既要落库、又要出站给模型、还要给渲染层回放，三处各写一份必然漂移
//（CLAUDE.md：跨端接口的路径与 DTO 形状要有单一来源）。这里只放**形状**，不放任何实现，
// 因此可被主进程（Node）与渲染层（浏览器）同时 import，不引入 electron/fs 依赖。
//
// 设计取自  TurnEngine：
// · 消息保留**结构化**的 tool_calls / tool_result，不压成文本块——多轮追问时模型能看见
//   自己上一轮到底调了什么工具、拿到了什么（我们旧的 buildHistoryBlock 把这层轨迹压没了）。
// · 事件是「实时流」与「刷新回放」的同一套数据源：tool_call_id 把调用与结果串起来，
//   刷新后每张工具卡仍能显示它当时的输出。

/** 工具调用（模型发起）。id 由上游给出，是关联调用与结果的唯一键。 */
export interface TurnToolCall {
  id: string
  name: string
  /** 已解析的参数；上游给的是 JSON 字符串，解析失败时为 {} 并在 argsRaw 保留原文。 */
  args: Record<string, unknown>
  argsRaw?: string
}

/** 一条对话消息。role 决定哪些字段有意义。 */
export interface TurnMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'notice'
  /** assistant 只调工具不说话时为空串。 */
  content: string
  /** assistant 专用：本轮发起的工具调用。 */
  toolCalls?: TurnToolCall[]
  /** tool 专用：回答哪一次调用。 */
  toolCallId?: string
  /** tool 专用：工具名（渲染卡片用，省得回查 assistant 消息）。 */
  toolName?: string
  /** tool 专用：执行状态。 */
  status?: ToolStatus
  /** notice 专用：标记类型（中断/错误/换模型），只用于展示，绝不回灌给模型。 */
  noticeKind?: 'error' | 'interrupted' | 'model_switch'
  /** 追加时间戳（毫秒）。展示用，出站前剥除。 */
  ts?: number
  /**
   * 展示专用附带信息（如知识来源、被过滤的命中数）——模型从未看见。
   * 出站前整体剥除；命名照搬  `_display` 语义。
   */
  display?: Record<string, unknown>
}

export type ToolStatus = 'ok' | 'error' | 'denied' | 'interrupted'

/** 任务清单单项（todo_write 工具的产物，对话框内 progress 的数据源）。 */
export interface TurnTodo {
  content: string
  status: 'pending' | 'in_progress' | 'done'
}

/** 风险档：low=只读/只算，可并发自动放行；write=会改动外部系统，必须过确认闸。 */
export type ToolRisk = 'low' | 'write'

// ————————————————————————————————————————————————————————————————
// 事件流：主进程 → 渲染层（IPC 频道 `turn:event`）
// ————————————————————————————————————————————————————————————————

export type TurnEvent =
  | { type: 'turn_start'; runId: string }
  /** 模型在每批工具调用前写的一句人话（"在做什么、为什么"）——对话框里的实时进度行。 */
  | { type: 'narration'; runId: string; text: string }
  /** 助手一轮的完整文本（无工具调用时即最终答案）。 */
  | { type: 'assistant_message'; runId: string; text: string; toolCalls: string[] }
  | { type: 'tool_proposed'; runId: string; call: TurnToolCall }
  /** 写工具等待用户签字确认；渲染层据此提示"等待确认"。 */
  | { type: 'permission_required'; runId: string; call: TurnToolCall; label: string }
  | { type: 'tool_started'; runId: string; callId: string; name: string }
  /** 工具执行期间的内部流水（技能拉定义/写脚本/沙箱执行…），由内核挂到发起它的那次调用上。 */
  | { type: 'tool_progress'; runId: string; callId: string; log: { type: string; text: string; timestamp: string } }
  | { type: 'tool_finished'; runId: string; callId: string; name: string; status: ToolStatus; preview: string; reason?: string }
  | { type: 'todo_updated'; runId: string; todos: TurnTodo[] }
  | { type: 'iteration_end'; runId: string; iteration: number }
  | { type: 'turn_end'; runId: string; status: 'completed' | 'max_iterations' | 'budget_exceeded'; iterations: number }
  | { type: 'error'; runId: string; message: string }
  | { type: 'interrupted'; runId: string; iterations: number }

/** 工具结果预览的截断长度（事件里只带节选，全文在 messages 里）。 */
export const TOOL_PREVIEW_CAP = 500
