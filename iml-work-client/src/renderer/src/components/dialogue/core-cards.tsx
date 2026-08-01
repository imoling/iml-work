// 新执行内核的展示件。三件各归其位（对话流只留最终答案，过程不占正文）：
// · CorePlanInline —— 执行计划，放状态栏跑马灯的位置（执行中最该被一眼看到的是"整体到哪了"）
// · CoreToolList   —— 工具调用轨迹，放「执行详情」里（想追溯才展开）
// · ThinkingDots   —— 分身名后的思考动效，表示它还在干活
//
// 数据源是结构化事件/轨迹而非文本日志，所以刷新回放和实时视图长得一模一样。
import { useState } from 'react'
import { Check, ChevronRight, CircleDashed, Loader2, Ban, TriangleAlert } from 'lucide-react'
import type { CoreTodo, ToolStatus } from '../../../../shared/core-protocol'
import { humanizeTool } from './humanize'

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

export interface ToolRowData {
  callId: string
  name: string
  args: unknown
  status: ToolStatus | 'running'
  /** 工具返回的结果节选；展开时显示。 */
  preview?: string
  /** 工具执行期间的内部流水（tool_progress 事件，内核精确挂到本次调用）。 */
  progress?: ExecLogItem[]
}

const STATUS_ICON: Record<string, JSX.Element> = {
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

function LogLines({ logs }: { logs: ExecLogItem[] }) {
  return (
    <div className="exec-timeline">
      {logs.map((log, i) => (
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

/** 工具行 + 嵌套的内部流水（点开工具行才看到，替代原先展开原始结果）。 */
function CoreToolRowMerged({ tool, skillNames }: { tool: ToolRowData; skillNames?: Record<string, string> }) {
  const logs = tool.progress || []
  const [open, setOpen] = useState(false)
  const h = humanizeTool(tool.name, tool.args, skillNames)
  const expandable = logs.length > 0 || (!!tool.preview && tool.status !== 'running')
  return (
    <div className={`turn-tool is-${tool.status}`}>
      <button
        type="button" className="turn-tool-head"
        onClick={() => expandable && setOpen(o => !o)}
        style={{ cursor: expandable ? 'pointer' : 'default' }}
        title={expandable ? (open ? '收起' : `展开${logs.length ? `（${logs.length} 条过程）` : '结果'}`) : undefined}
      >
        <span className="turn-tool-status">{STATUS_ICON[tool.status] || STATUS_ICON.ok}</span>
        <span className="turn-tool-line">
          {h.pre}{h.obj && <b>{h.obj}</b>}{h.post}
          {logs.length > 0 && <span className="turn-tool-count">{logs.length} 条过程</span>}
        </span>
        {expandable && (
          <span className={`turn-tool-caret${open ? ' is-open' : ''}`}><ChevronRight size={12} /></span>
        )}
      </button>
      {open && (
        <div className="turn-tool-nest">
          {logs.length > 0 && <LogLines logs={logs} />}
          {tool.preview && <pre className="turn-tool-body">{tool.preview}</pre>}
        </div>
      )}
    </div>
  )
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
      <div className="turn-toollist-title">工具调用（点开看内部过程）</div>
      <div className="turn-tools">
        {rows.map(t => <CoreToolRowMerged key={t.callId} tool={t} skillNames={skillNames} />)}
      </div>
    </div>
  )
}
