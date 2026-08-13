// 新执行内核的展示件。三件各归其位（对话流只留最终答案，过程不占正文）：
// · CorePlanInline —— 执行计划，放状态栏跑马灯的位置（执行中最该被一眼看到的是"整体到哪了"）
// · CoreToolList   —— 工具调用轨迹，放「执行详情」里（想追溯才展开）
// · ThinkingDots   —— 分身名后的思考动效，表示它还在干活
//
// 数据源是结构化事件/轨迹而非文本日志，所以刷新回放和实时视图长得一模一样。
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, CircleDashed, Loader2, Ban, TriangleAlert } from 'lucide-react'
import type { CoreTodo, ToolStatus } from '../../../../shared/core-protocol'
import { streamLogId, isStreamDone, streamLogSummary } from '../../../../shared/stream-log'
import { humanizeTool, humanizeStep } from './humanize'
import { MarkdownRenderer } from './markdown'

/** 分身正在干活的动效（跟在名字后面）。 */
export function ThinkingDots() {
  return (
    <span className="turn-thinking" aria-label="正在思考">
      <i /><i /><i />
    </span>
  )
}

/** 紧凑执行计划：状态栏里替代跑马灯——比"最近一条日志"更有用，因为它给的是全局进度。 */
export function CorePlanInline({ todos }: { todos?: CoreTodo[] }) {
  if (!todos || !todos.length) return null
  const done = todos.filter(t => t.status === 'done').length
  return (
    <div className="turn-plan">
      <div className="turn-plan-head">
        <span className="turn-plan-title">执行计划</span>
        <span className="turn-plan-count">{done}/{todos.length}</span>
      </div>
      <ol className="turn-plan-list">
        {todos.map((t, i) => (
          <li key={i} className={`turn-plan-item is-${t.status}`}>
            <span className="turn-plan-icon">
              {t.status === 'done' ? <Check size={12} />
                : t.status === 'in_progress' ? <Loader2 size={12} className="turn-spin" />
                : <CircleDashed size={12} />}
            </span>
            <span className="turn-plan-text">{t.content}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * 子智能体协作条——状态栏里紧跟执行计划的一段，**不展开也能看到每一路在做什么**。
 *
 * 为什么需要：并行之后，三个子智能体各跑一两分钟，而它们的进度全埋在「执行详情」里。
 * 用户在状态栏能看到的只有执行计划那一项「分别派子智能体调查 A、B、C」在转圈——
 * 转了两分钟，一个字都没变。这条把三路的实时叙述提到面上。
 *
 * 少于 2 个不显示：单个子智能体的进度，执行计划那一行已经表达清楚了，再来一条是重复。
 */
export function CoreAgentsInline({ tools }: { tools?: ToolRowData[] }) {
  const agents = (tools || []).filter(isAgentRow)
  if (agents.length < 2) return null
  const finished = agents.filter(a => a.status !== 'running' && a.status !== 'queued').length
  // 标题跟着**派出去的是谁**走：把「请教法务专员」显示成"我的小分身"是错的——
  // 那不是你分出去的，是另一个岗位的分身。
  const kinds = new Set(agents.map(a => a.agentKind || 'sub'))
  const title = kinds.size > 1 ? '协作中' : kinds.has('expert') ? '请教其他岗位' : '我的小分身'
  // 全都回来了就收成一行：这时主分身在汇总，用户该看的是「进展到哪了」而不是三条已完成的旧账。
  // 明细不会丢——执行详情里那三行子分身卡一直在，点开还能看各自的结论。
  if (finished === agents.length) {
    return (
      <div className="turn-agents is-done">
        <div className="turn-plan-head">
          <span className="turn-plan-title">{title}</span>
          <span className="turn-plan-count">{agents.length} 个都回来了 · 正在汇总</span>
        </div>
      </div>
    )
  }

  return (
    <div className="turn-agents">
      <div className="turn-plan-head">
        <span className="turn-plan-title">{title}</span>
        <span className="turn-plan-count">{finished}/{agents.length} 已回</span>
      </div>
      <ol className="turn-plan-list">
        {agents.map(a => {
          const h = humanizeTool(a.name, a.args)
          const label = a.agentLabel || h.obj || '子任务'
          return (
            <li key={a.callId} className={`turn-plan-item turn-agents-item is-${a.status}`}>
              <span className="turn-plan-icon">
                {a.status === 'running' ? <Loader2 size={12} className="turn-spin" />
                  : a.status === 'queued' ? <CircleDashed size={12} />
                  : a.status === 'ok' ? <Check size={12} />
                  : <TriangleAlert size={12} />}
              </span>
              <span className="turn-agents-name">{label}</span>
              <span className="turn-agents-now">{agentNow(a)}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/**
 * 这一路此刻的一句人话。**每个分支都必须有话说**——一行空白比一行技术文案更让人发慌。
 * 措辞跟着「小分身」这套拟人语言走：它是被分出去干活的，所以是「出发 / 在跑 / 回来了」。
 */
function agentNow(a: ToolRowData): string {
  const steps = a.subTools?.length || 0
  const isExpert = a.agentKind === 'expert'
  if (a.status === 'queued') return '待命中'
  if (a.status === 'running') {
    if (a.subNarration) return humanizeStep(a.subNarration)
    if (steps) return `查了 ${steps} 步`
    return isExpert ? '刚问出去' : '刚出发'
  }
  if (a.status === 'ok') {
    const what = isExpert ? '已给出意见' : '带回结论'
    return steps ? `${what} · ${steps} 步` : what
  }
  if (a.status === 'denied') return '被拦下了'
  if (a.status === 'interrupted') return '被叫停了'
  return isExpert ? '没能给出意见' : '空手而归'
}

/** 这一行是不是"派出去的一路"（自己的小分身，或请教的另一个岗位）。 */
function isAgentRow(t: ToolRowData): boolean {
  return !!t.agentLabel || t.name === 'run_subagent' || t.name === 'consult_expert'
}

export interface ToolRowData {
  callId: string
  name: string
  args: unknown
  /**
   * 展示态。ToolStatus 是**结果**（协议里的 ok/error/denied/interrupted），
   * 'queued'/'running' 是只存在于渲染层的过程态：
   * · queued  —— 模型已提议、内核尚未开始执行（串行工具在排队，或写工具在等签字）
   * · running —— 已收到 tool_started，真的在跑
   * 从前两者都画成转圈，于是三个串行的子智能体看上去像在并行——实际是一个在跑两个在等。
   */
  status: ToolStatus | 'running' | 'queued'
  /** 工具返回的结果节选；展开时显示。 */
  preview?: string
  /** 工具执行期间的内部流水（tool_progress 事件，内核精确挂到本次调用）。 */
  progress?: ExecLogItem[]

  // ── 以下四项只有 run_subagent 行会有：子智能体跑的是同一个内核，事件带 agentId 回来后
  //    按「发起它的那次调用」归位到这里，于是它的轨迹嵌在这一行下面，而不是平铺进主轨迹。
  /** 子智能体显示名（"竞品B动向"）。 */
  agentLabel?: string
  /** 'sub'=自己分出去的小分身；'expert'=请教的另一个岗位。缺省按 sub。 */
  agentKind?: 'sub' | 'expert'
  /** 子智能体自己的工具调用轨迹（**只嵌一层**，子智能体不能再派子智能体）。 */
  subTools?: ToolRowData[]
  /** 子智能体当前在做什么（它的 narration）——不展开也能看到进度。 */
  subNarration?: string
  /** 子智能体交回主分身的结论节选。 */
  subSummary?: string
}

const STATUS_ICON: Record<string, JSX.Element> = {
  // 排队中用静止的虚线圈（与执行计划的 pending 同一套语义）——转圈表示"正在跑"，
  // 给一个一步都没开始的调用画转圈，就是在告诉用户三件事在并行，而实际只有一件在动。
  queued: <CircleDashed size={12} />,
  running: <Loader2 size={12} className="turn-spin" />,
  ok: <Check size={12} />,
  denied: <Ban size={12} />,
  error: <TriangleAlert size={12} />,
  interrupted: <Ban size={12} />,
}

/** 单次工具调用：一行人话 + 状态；点开看原始结果。 */
export function CoreToolRow({ tool, skillNames }: { tool: ToolRowData; skillNames?: Record<string, string> }) {
  const [open, setOpen] = useState(false)
  const h = humanizeTool(tool.name, tool.args, skillNames)
  const expandable = !!tool.preview && tool.status !== 'running'
  return (
    <div className={`turn-tool is-${tool.status}`}>
      <button
        type="button" className="turn-tool-head"
        onClick={() => expandable && setOpen(o => !o)}
        // 不可展开时不该显示成可点（没有结果的调用点了没反应，像坏了）
        style={{ cursor: expandable ? 'pointer' : 'default' }}
        title={expandable ? (open ? '收起结果' : '展开结果') : undefined}
      >
        <span className="turn-tool-status">{STATUS_ICON[tool.status] || STATUS_ICON.ok}</span>
        <span className="turn-tool-line">
          {h.pre}{h.obj && <b>{h.obj}</b>}{h.post}
        </span>
        {expandable && (
          <span className={`turn-tool-caret${open ? ' is-open' : ''}`}><ChevronRight size={12} /></span>
        )}
      </button>
      {open && tool.preview && <pre className="turn-tool-body">{tool.preview}</pre>}
    </div>
  )
}

/**
 * 工具调用轨迹（执行详情里的第一层）。
 *
 * todo_write 不列进来：执行计划已经在状态栏展示了，这里再报一行「更新任务清单 2/3」
 * 是同一件事说两遍，还会把真正的工具调用挤下去。
 */
export function CoreToolList({ tools, title, skillNames }: { tools?: ToolRowData[]; title?: string; skillNames?: Record<string, string> }) {
  const rows = tools?.filter(t => t.name !== 'todo_write')
  if (!rows?.length) return null
  return (
    <div className="turn-toollist">
      {title && <div className="turn-toollist-title">{title}</div>}
      <div className="turn-tools">
        {rows.map(t => <CoreToolRow key={t.callId} tool={t} skillNames={skillNames} />)}
      </div>
    </div>
  )
}

export interface ExecLogItem {
  type: string
  text: string
  timestamp: string
  callId?: string
}

const LOG_LABEL: Record<string, string> = { thinking: '思考', acting: '执行', observing: '观察', stdout: '输出', completed: '完成' }

/** 展开态最多渲染的尾部字符数：框是看实时进展的，不是读全文的，整段几十 KB 会拖垮渲染。 */
const STREAM_VIEW_TAIL = 4000

/**
 * 流式进度框（模型现场编写脚本等长生成步）：**默认折叠**，头部只报字数进度，
 * 点开实时看模型正在写什么（自动滚到底部）。同 id 的帧在 store 层已替换合并，
 * 这里拿到的永远是最新快照（约定见 shared/stream-log.ts）。
 */
function StreamLogRow({ log }: { log: ExecLogItem }) {
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLPreElement>(null)
  const done = isStreamDone(log.type)
  // 新帧到达自动滚到底：用户点开就是想看"正在写的那一行"
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [open, log.text])
  const tail = log.text.length > STREAM_VIEW_TAIL
    ? `…（前 ${log.text.length - STREAM_VIEW_TAIL} 字符已省略）\n${log.text.slice(-STREAM_VIEW_TAIL)}`
    : log.text
  return (
    <div className={`exec-stream ${done ? 'done' : 'running'}`}>
      <button type="button" className="exec-stream-head" onClick={() => setOpen(o => !o)} title={open ? '收起' : '展开实时查看'}>
        {done ? <Check size={13} /> : <Loader2 size={13} className="drawer-spin" />}
        <span className="exec-stream-title">{streamLogSummary(log.type, log.text)}</span>
        <span className="exec-time">{log.timestamp}</span>
        <span className={`turn-tool-caret${open ? ' is-open' : ''}`}><ChevronRight size={12} /></span>
      </button>
      {open && <pre className="exec-stream-body" ref={bodyRef}>{tail}</pre>}
    </div>
  )
}

function LogLines({ logs }: { logs: ExecLogItem[] }) {
  return (
    <div className="exec-timeline">
      {logs.map((log, i) => streamLogId(log.type) ? (
        <StreamLogRow key={i} log={log} />
      ) : (
        <div key={i} className={`exec-step ${log.type}`}>
          <span className="exec-dot" />
          <div className="exec-step-body">
            <div className="exec-step-head">
              <span className="exec-chip">{LOG_LABEL[log.type] || log.type}</span>
              <span className="exec-time">{log.timestamp}</span>
            </div>
            <div className={`exec-step-text ${log.type === 'stdout' || log.type === 'observing' ? 'mono' : ''}`}>{log.text}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * 工具行 + 嵌套的内部流水（点开工具行才看到，替代原先展开原始结果）。
 *
 * 子智能体的行多一层：展开后是**它自己的工具轨迹**（各行仍可再点开看内部流水），
 * 末尾是它交回主分身的结论。只嵌一层——子智能体不能再派子智能体，所以数据结构上
 * 也不会有第三层（约束在 agent-subagent 的工具表里，不是靠这里少渲染一层）。
 */
function CoreToolRowMerged({ tool, skillNames }: { tool: ToolRowData; skillNames?: Record<string, string> }) {
  const logs = tool.progress || []
  const subs = tool.subTools || []
  const isAgent = !!tool.agentLabel || subs.length > 0
  const [open, setOpen] = useState(false)
  const h = humanizeTool(tool.name, tool.args, skillNames)
  // 子智能体行**不展示自己的 progress**：它的 sendLog 会被内核原样转成本行的流水，
  // 而同一批日志已经按子工具精确归位到 subTools 各行里了——两边都渲染就是同一堆日志
  // 平铺一遍、再分组一遍，展开后又长又乱（而分组那份才是有结构、能读的）。
  const ownLogs = isAgent ? [] : logs
  const expandable = ownLogs.length > 0 || subs.length > 0 || !!tool.subSummary
    || (!!tool.preview && tool.status !== 'running')
  const count = tool.status === 'queued'
    ? '排队中'
    : isAgent
      ? (subs.length ? `跑了 ${subs.length} 步` : '')
      : (logs.length ? `${logs.length} 条过程` : '')
  return (
    <div className={`turn-tool is-${tool.status}${isAgent ? ' is-agent' : ''}`}>
      <button
        type="button" className="turn-tool-head"
        onClick={() => expandable && setOpen(o => !o)}
        style={{ cursor: expandable ? 'pointer' : 'default' }}
        title={expandable ? (open ? '收起' : `展开${count ? `（${count}）` : '结果'}`) : undefined}
      >
        <span className="turn-tool-status">{STATUS_ICON[tool.status] || STATUS_ICON.ok}</span>
        <span className="turn-tool-line">
          {h.pre}{h.obj && <b>{h.obj}</b>}{h.post}
          {/* 执行中的子智能体：把它当前在做什么直接显示在行上——不展开也看得到进度，
              否则一个跑两分钟的子智能体在界面上就是一行静止的转圈。 */}
          {tool.subNarration && <span className="turn-tool-now">{humanizeStep(tool.subNarration)}</span>}
          {count && <span className="turn-tool-count">{count}</span>}
        </span>
        {expandable && (
          <span className={`turn-tool-caret${open ? ' is-open' : ''}`}><ChevronRight size={12} /></span>
        )}
      </button>
      {open && (
        <div className="turn-tool-nest">
          {subs.length > 0 && (
            <div className="turn-subagent">
              {subs.map(s => <CoreToolRowMerged key={s.callId} tool={s} skillNames={skillNames} />)}
            </div>
          )}
          {ownLogs.length > 0 && <LogLines logs={ownLogs} />}
          {tool.subSummary && (
            <div className="turn-subagent-sum">
              <div className="turn-subagent-sum-title">小分身带回来的</div>
              {/* 子智能体被要求「能用列表就列表」，产出天然是 markdown——
                  按纯文本渲染就是满屏的 `- **XX**：`，反而比原文更难读。 */}
              <div className="turn-subagent-sum-body">
                <MarkdownRenderer content={tool.subSummary} />
              </div>
            </div>
          )}
          {/* 子智能体的 preview 就是那份结论的原文，已由上面的结论块展示，不再重复一遍 */}
          {tool.preview && !tool.subSummary && <pre className="turn-tool-body">{tool.preview}</pre>}
        </div>
      )}
    </div>
  )
}

/** 本轮子智能体的统计（执行详情标题用）。 */
function agentStats(rows: ToolRowData[]): string {
  const agents = rows.filter(isAgentRow)
  if (!agents.length) return ''
  const steps = agents.reduce((n, a) => n + (a.subTools?.length || 0), 0)
  const experts = agents.filter(a => a.agentKind === 'expert').length
  const subs = agents.length - experts
  const parts = [subs ? `分出了 ${subs} 个小分身` : '', experts ? `请教了 ${experts} 个岗位` : ''].filter(Boolean)
  return `${parts.join(' · ')}${steps ? ` · 共跑了 ${steps} 步` : ''}`
}

/**
 * 融合版执行详情：工具调用为骨架，各自的内部流水嵌在行下点开看。
 *
 * 数据是**单一来源**：内核在工具执行期间把流水以 tool_progress 事件挂到那次调用上
 * （每个调用持自己的闭包 id，并行也归属精确），行数据自带 progress——
 * 不再是"工具行一份、日志一份、渲染层按时间缝合"（第一版的做法，实测反馈太生硬）。
 * 归不到工具上的日志（任务理解/收尾）不展示：一句"正在理解你的任务"没有追溯价值。
 * 旧链路没有工具行 → 退回原时间线。
 */
export function CoreExecDetail({ tools, logs, skillNames }: { tools?: ToolRowData[]; logs?: ExecLogItem[]; skillNames?: Record<string, string> }) {
  const rows = (tools || []).filter(t => t.name !== 'todo_write')
  if (!rows.length) return logs?.length ? <LogLines logs={logs} /> : null
  return (
    <div className="turn-execdetail">
      <div className="turn-toollist-title">
        工具调用（点开看内部过程）
        {/* 子智能体是成本放大器（每个都是一整轮推理）——用了几个、各自跑了多少步要摆在明面上，
            而不是等用户点开三层才发现这一问背后跑了十几步。 */}
        {agentStats(rows) && <span className="turn-toollist-stat">{agentStats(rows)}</span>}
      </div>
      <div className="turn-tools">
        {rows.map(t => <CoreToolRowMerged key={t.callId} tool={t} skillNames={skillNames} />)}
      </div>
    </div>
  )
}
