// 执行内核（AgentCore）的跨端协议——主进程与渲染层的**唯一契约**。
//
// 为什么单独成文件：消息形状既要落库、又要出站给模型、还要给渲染层回放，三处各写一份必然漂移
//（CLAUDE.md：跨端接口的路径与 DTO 形状要有单一来源）。这里只放**形状**，不放任何实现，
// 因此可被主进程（Node）与渲染层（浏览器）同时 import，不引入 electron/fs 依赖。
//
// 设计取自  AgentCore：
// · 消息保留**结构化**的 tool_calls / tool_result，不压成文本块——多轮追问时模型能看见
//   自己上一轮到底调了什么工具、拿到了什么（我们旧的 buildHistoryBlock 把这层轨迹压没了）。
// · 事件是「实时流」与「刷新回放」的同一套数据源：tool_call_id 把调用与结果串起来，
//   刷新后每张工具卡仍能显示它当时的输出。

/** 工具调用（模型发起）。id 由上游给出，是关联调用与结果的唯一键。 */
export interface CoreToolCall {
  id: string
  name: string
  /** 已解析的参数；上游给的是 JSON 字符串，解析失败时为 {} 并在 argsRaw 保留原文。 */
  args: Record<string, unknown>
  argsRaw?: string
}

/** 一条对话消息。role 决定哪些字段有意义。 */
export interface CoreMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'notice'
  /** assistant 只调工具不说话时为空串。 */
  content: string
  /** assistant 专用：本轮发起的工具调用。 */
  toolCalls?: CoreToolCall[]
  /**
   * assistant 专用：思维模式模型（DeepSeek V4 全系、部分 GLM/Qwen thinking 档）在回复里带回的思维链。
   *
   * **必须原样回传**：这类模型要求多轮对话把上一轮的 reasoning_content 带回去，否则下一轮直接
   * 400 `The reasoning_content in the thinking mode must be passed back to the API`。
   * 多轮 function-calling 首当其冲——企业系统操作动辄十几轮，第一次工具调用后就断。
   * 不展示给用户、不参与判分，只为满足上游协议。
   */
  reasoningContent?: string
  /** tool 专用：回答哪一次调用。 */
  toolCallId?: string
  /** tool 专用：工具名（渲染卡片用，省得回查 assistant 消息）。 */
  toolName?: string
  /** tool 专用：执行状态。 */
  status?: ToolStatus
  /** notice 专用：标记类型（中断/错误/换模型），只用于展示，绝不回灌给模型。 */
  noticeKind?: 'error' | 'interrupted' | 'model_switch'
  /**
   * user 专用：随本条消息一起给模型看的图片（**工作空间内的绝对路径**，不是 base64）。
   *
   * 为什么存路径而不是内容：图片 base64 动辄几百 KB，存进轨迹表会让库和上下文一起膨胀；
   * 出站时才按需读文件转 data URL（见 llm.ts 的 toOpenAiMessages）。
   *
   * 为什么不把 content 改成结构化数组：content 有 8+ 处消费端（内核/持久化/渲染/技能链路），
   * 改成 union 类型意味着每处都要分支处理两种形态。加一个可选字段，现有消费端零改动。
   */
  imagePaths?: string[]

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
export interface CoreTodo {
  content: string
  status: 'pending' | 'in_progress' | 'done'
}

/** 风险档：low=只读/只算，可并发自动放行；write=会改动外部系统，必须过确认闸。 */
export type ToolRisk = 'low' | 'write'

// ————————————————————————————————————————————————————————————————
// 事件流：主进程 → 渲染层（IPC 频道 `turn:event`）
// ————————————————————————————————————————————————————————————————

/**
 * 子智能体标记——带 agentId 的事件来自**子智能体**，缺省即主分身。
 *
 * 为什么做成横切字段而不是给每种事件单独开一套：子智能体跑的是**同一个内核**，
 * 发的就是同一批事件（tool_proposed/tool_finished/…）。为它们再造一套平行事件类型，
 * 等于把内核的每处 emit 都改成二选一，而渲染层还要维护两份几乎一样的归约逻辑。
 * 加一个可选标记，内核侧只在转发处包一层，渲染层按 agentId 分组即可。
 *
 * 向后兼容：老渲染层读不到这两个字段，行为与从前完全一致（子智能体的工具行会平铺在主轨迹里，
 * 不会崩、也不会丢事件），只是没有嵌套分组。
 */
export interface AgentScoped {
  /** 子智能体实例 id（`${parentCallId}-sub{n}`）。缺省 = 主分身。 */
  agentId?: string
  /** 子智能体的显示名（"竞品B动向"）。 */
  agentLabel?: string
}

export type CoreEvent = CoreEventBody & AgentScoped

type CoreEventBody =
  | { type: 'turn_start'; runId: string }
  /** 模型在每批工具调用前写的一句人话（"在做什么、为什么"）——对话框里的实时进度行。 */
  | { type: 'narration'; runId: string; text: string }
  /** 助手一轮的完整文本（无工具调用时即最终答案）。 */
  | { type: 'assistant_message'; runId: string; text: string; toolCalls: string[] }
  | { type: 'tool_proposed'; runId: string; call: CoreToolCall }
  /** 写工具等待用户签字确认；渲染层据此提示"等待确认"。 */
  | { type: 'permission_required'; runId: string; call: CoreToolCall; label: string }
  | { type: 'tool_started'; runId: string; callId: string; name: string }
  /** 工具执行期间的内部流水（技能拉定义/写脚本/沙箱执行…），由内核挂到发起它的那次调用上。 */
  | { type: 'tool_progress'; runId: string; callId: string; log: { type: string; text: string; timestamp: string } }
  | { type: 'tool_finished'; runId: string; callId: string; name: string; status: ToolStatus; preview: string; reason?: string }
  | { type: 'todo_updated'; runId: string; todos: CoreTodo[] }
  | { type: 'iteration_end'; runId: string; iteration: number }
  | { type: 'turn_end'; runId: string; status: 'completed' | 'max_iterations' | 'budget_exceeded'; iterations: number }
  | { type: 'error'; runId: string; message: string }
  | { type: 'interrupted'; runId: string; iterations: number }
  /**
   * 子智能体开跑。parentCallId 把它挂到发起它的那次 run_subagent 调用上——
   * 渲染层据此把子智能体的工具行嵌进那一行下面，而不是平铺进主轨迹。
   */
  | {
      type: 'agent_started'; runId: string; agentId: string; label: string; parentCallId: string
      /**
       * 派出去的是什么。缺省 'sub' —— 老事件不带这个字段时按小分身处理，行为不变。
       * · sub    = 分身自己分出去的小分身（用的是本岗位的知识库与权限）
       * · expert = 另一个岗位的分身（用的是**对方**的知识库授权与专业视角）
       * 界面必须分清：把"请教法务专员"显示成"我的小分身"是错的，那不是你分出去的。
       */
      kind?: 'sub' | 'expert'
    }
  /** 子智能体收尾。summary=回给主分身的结论节选（展开子卡时显示在工具行之后）。 */
  | { type: 'agent_finished'; runId: string; agentId: string; status: ToolStatus; summary: string }

/** 工具结果预览的截断长度（事件里只带节选，全文在 messages 里）。 */
export const TOOL_PREVIEW_CAP = 500
