// 新内核的工具集组装——**能力全部复用存量实现**，这里只负责声明「风险档 + 人话标签」。
//
// 为什么不重写工具执行体：agent-tools.ts 里的 web_search/python/read_page/read_file 都是
// 调优过的（多引擎代理、信源分级、docling 解析、目录穿越防护），推倒重来只会丢掉这些经验。
// fromAgentTool() 把它们原样包进来，新增的只有 metadata——而 metadata 正是新架构的安全基石：
// 工具自己声明 risk='write'，权限闸就认它，不再依赖中文词表猜用户意图。
//
// 阶段 1 只装只读工具（不碰写路径），browse/技能/本体等写能力在阶段 2、4、5 依次接入。
import type { LlmConfig } from './llm'
import type { ToolSpec, ToolMetadata } from './tool-registry'
import { fromAgentTool } from './tool-registry'
import { makeTodoToolSpec } from './agent-core'
import {
  makeWebSearchTool, makePythonTool, makeReadPageTool, makeReadFileTool, makeFetchDocumentTool, workspaceFileList,
} from './agent-tools'
import { makeBrowseTool } from './agent-browse'
import { requestSignedConfirmation } from './confirm-token'
import { requestFormConfirmation, currentRun } from './automation-runtime'
import { emitToRenderer } from './window-ref'
import type { SendLog } from './types'

// 生成交付物的判断放 shared——渲染层决定走哪条链路时也要用同一份（见 shared/task-intent.ts）。
export { wantsGeneratedFile } from '../shared/task-intent'

/** 只读工具的通用档：可自动放行、可并发。 */
const READ: (label: string, category: string) => ToolMetadata = (label, category) => ({ label, risk: 'low', category })

/** 联网检索工具对（web_search + read_page）——「搜 → 读正文 → 不够再换词搜」的多轮闭环靠这两个。
 *  onSources：收集本轮引用的联网来源（结果卡「联网来源」列表用）。 */
export function webTools(cfg: LlmConfig, onSources?: import('./agent-tools').OnWebSources): ToolSpec[] {
  return [
    fromAgentTool(makeWebSearchTool(cfg, onSources), READ('联网检索', 'web')),
    fromAgentTool(makeReadPageTool(onSources), READ('读取网页正文', 'web')),
    // 归在 web 而不是 file：它解决的是"检索结果里的链接指向 PDF"这个断链，
    // 不依赖工作空间已有文件（fileTools 只在工作空间非空时才挂，那样纯检索任务就用不上了）。
    fromAgentTool(makeFetchDocumentTool(), READ('下载并读取网络文档', 'web')),
  ]
}

/** 沙箱计算：任何算术/计数/求和/日期差都该用它真算，不许心算硬报。
 *  onFiles：接住沙箱产出的文件（模型也可能用 python 直接生成交付物）。 */
export function computeTools(onFiles?: (files: { name: string; sizeBytes: number }[]) => void): ToolSpec[] {
  return [fromAgentTool(makePythonTool(onFiles), READ('沙箱计算', 'compute'))]
}

/** 工作空间文件读取。调用方先用 needsWorkspaceFiles 判定，别无条件挂。 */
export function fileTools(): ToolSpec[] {
  return workspaceFileList().length ? [fromAgentTool(makeReadFileTool(), READ('读取工作空间文件', 'file'))] : []
}

/**
 * 这次任务要不要碰工作空间文件。
 *
 * 为什么必须判——曾经只要工作空间非空就挂 read_file 并把文件清单塞进上下文，结果模型把它当成了
 * 万能素材库：问「我是谁」它去翻文件猜身份，问「我的待办」它从几份报告里**编**了一张待办清单出来
 * （实测，直接踩不虚构业务数据的红线）。文件是用来回答关于文件的问题的，不是用来回答一切的。
 */
export function needsWorkspaceFiles(content: string, files: string[]): boolean {
  if (!files.length) return false
  if (/【附件】/.test(content)) return true                       // 本轮真的带了附件
  const lower = content.toLowerCase()
  if (files.some(f => f && lower.includes(f.toLowerCase()))) return true   // 点名了某个文件
  // 明确在谈文件/资料这件事
  return /文件|文档|附件|表格|报表|工作空间|资料|材料|excel|xlsx|word|docx|ppt|pptx|pdf|csv/i.test(content)
}

/**
 * 阶段 1 的默认只读工具集：任务清单 + 检索 + 计算 + 文件。
 * 全 low 档，无写操作，因此不会弹任何确认卡——最小闭环验收用的就是这一套。
 */
export function defaultReadOnlyTools(cfg: LlmConfig, o?: { includeFiles?: boolean; includeWeb?: boolean; onFiles?: (f: { name: string; sizeBytes: number }[]) => void; onWebSources?: import('./agent-tools').OnWebSources }): ToolSpec[] {
  return [
    makeTodoToolSpec(),
    // includeWeb=false：命中已登记业务系统的轮次不给公网检索（防拿内部 URL 公网搜的实测教训）
    ...(o?.includeWeb === false ? [] : webTools(cfg, o?.onWebSources)),
    ...computeTools(o?.onFiles),
    ...(o?.includeFiles ? fileTools() : []),
  ]
}

/**
 * ask_user 工具（执行中途向用户提问）：任务缺关键信息时，
 * 模型中途向用户提问，**挂起本轮循环**等回答，回答作为工具观察回灌继续执行——
 * 而不是把问题写进最终答案变成"一问一答"。复用表单卡通道（渲染层已有卡片 UI + form-submit 回传）；
 * 等待时长计入工具耗时，从墙钟预算扣除，用户慢慢答不会导致回来就被收尾。
 */
export function askUserTool(o: { unattended?: boolean }): ToolSpec {
  return {
    name: 'ask_user',
    description: '任务缺少无法自行查到的关键信息时，向用户提问并等待回答。需要**多个**信息（如出发地/目的地/日期/席别）时用 fields 一次收集齐——每项一个输入框，不要把几个问题挤在一句话里，也不要连问多轮。单个问题则只传 question（能列候选就带 options 让用户点选）。绝不虚构用户没给的信息，也不要把问题留到最终答案里让任务落空。信息能靠工具查到的（如公司规定、网页内容）自己查，别问用户。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问题（单问）或这组信息的简短标题（多字段时，如「请补充行程信息」）' },
        fields: {
          type: 'array',
          description: '可选：要收集的多个字段，每项独立输入框；表单末尾会自动附一个「补充说明」框，无需自己加',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '字段名（如「出发地」「出发日期」）' },
              type: { type: 'string', enum: ['text', 'date', 'datetime', 'time'], description: '控件类型：日期选 date、日期+时刻选 datetime、时刻选 time，默认文本' },
              options: { type: 'array', items: { type: 'string' }, description: '可选：该字段的候选项（下拉选择，与 type 互斥）' },
            },
            required: ['label'],
          },
        },
        options: { type: 'array', items: { type: 'string' }, description: '可选：单问题时的候选项列表，用户可直接点选' },
      },
      required: ['question'],
    },
    metadata: { risk: 'low', category: 'interact', label: '向用户提问' },
    async run(args) {
      const question = String(args.question || '').trim()
      if (!question) return '问题为空，未向用户提问。'
      if (o.unattended) {
        return '用户不在场（定时/无人值守运行），无法提问。请基于已有信息与企业常规做出合理选择，并在最终答案中说明所做的假设。'
      }
      const strOpts = (v: unknown) => Array.isArray(v) ? (v as unknown[]).map(String).filter(Boolean).slice(0, 8) : []
      // 控件类型映射：渲染层 <input type=…> 直接透传，date/datetime-local/time 原生控件即刻可用；
      // 模型没标 type 但字段名一看就是日期的，兜底成日期控件（模型标注遵守率不稳）。
      const inputType = (f: Record<string, unknown>, label: string): string => {
        const t = String(f?.type || '')
        if (t === 'date') return 'date'
        if (t === 'datetime') return 'datetime-local'
        if (t === 'time') return 'time'
        return /日期|哪天|几号/.test(label) ? 'date' : 'text'
      }
      const rawFields = Array.isArray(args.fields) ? (args.fields as Record<string, unknown>[]).slice(0, 10) : []
      const fields = rawFields
        .map((f, i) => {
          const label = String(f?.label || '').trim()
          const fo = strOpts(f?.options)
          return label ? { name: `f${i}`, label, value: '', type: fo.length ? 'select' : inputType(f, label), options: fo.length ? fo : undefined } : null
        })
        .filter((f): f is NonNullable<typeof f> => !!f)

      if (fields.length) {
        // 多字段表单：question 作为卡片标题，各字段独立填写；末尾固定一个自由补充框，
        // 用户想说的没被字段覆盖时有处可写（不计入未填统计）。
        const formFields = [...fields, { name: '_extra', label: '补充说明（可选）', value: '', type: 'textarea' as string, options: undefined }]
        const ans = await requestFormConfirmation(formFields, { kind: 'ask', title: question.slice(0, 60), submitLabel: '回答并继续' })
        const get = (n: string) => String((ans as Record<string, string>)?.[n] || '').trim()
        const filled = fields
          .map(f => ({ label: f.label, val: get(f.name) }))
          .filter(x => x.val)
        const extra = get('_extra')
        if (!filled.length && !extra) return '用户取消了回答。若缺这些信息无法继续，请在答案中说明缺什么、用户补充后可继续。'
        const missing = fields.length - filled.length
        const parts = filled.map(x => `${x.label}=${x.val}`)
        if (extra) parts.push(`补充说明=${extra}`)
        return `用户回答：${parts.join('；')}${missing > 0 ? `（另有 ${missing} 项未填，如非必需就按常规默认处理）` : ''}`
      }

      const opts = strOpts(args.options)
      const ans = await requestFormConfirmation(
        [{ name: 'answer', label: question, value: '', type: opts.length ? 'select' : 'textarea', options: opts.length ? opts : undefined }],
        { kind: 'ask', title: '需要你补充一点信息', submitLabel: '回答并继续' },
      )
      const a = String((ans as Record<string, string>)?.answer || '').trim()
      return a ? `用户回答：${a}` : '用户取消了回答。若缺此信息无法继续，请在答案中说明缺什么、用户补充后可继续。'
    },
  }
}

/**
 * propose_actions 工具（讨论档的行动方案流转）：
 * 只读侦查做完后，把「接下来要做的写操作」整理成行动方案卡交给用户，
 * 用户点「按此执行」即自动切「先问再做」档并继续——不用自己组织指令重新下达。
 */
export function proposePlanTool(runId: string): ToolSpec {
  return {
    name: 'propose_actions',
    description: '当前是讨论档（只读）。任务需要写操作（提交/录入/下单/审批…）时：先把只读侦查全部做完（该查的页面、该确认的规定），然后用本工具向用户提交行动方案——summary 一句话说明要达成什么，steps 按顺序列出将执行的具体动作（含会写入哪个系统）。提交后在最终答案里简述方案即可，用户批准会自动继续，不要让用户自己组织指令。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一句话：方案要达成什么' },
        steps: { type: 'array', items: { type: 'string' }, description: '按执行顺序列出的具体步骤（写操作标明目标系统）' },
      },
      required: ['summary', 'steps'],
    },
    metadata: { risk: 'low', category: 'interact', label: '提交行动方案' },
    async run(args) {
      const summary = String(args.summary || '').trim()
      const steps = Array.isArray(args.steps) ? (args.steps as unknown[]).map(String).filter(Boolean).slice(0, 12) : []
      if (!summary || !steps.length) return 'summary 与 steps 都不能为空，方案未提交。'
      emitToRenderer('agent:plan-proposal', { runId, summary, steps })
      return '行动方案已作为卡片提交给用户。请在最终答案中用一两句话说明方案已给出、点「按此执行」即可开始，不要重复罗列步骤。'
    },
  }
}

export interface BrowseToolOptions {
  /** 命中已登记业务系统时传其登录态分区（persist:bizsys-<id>），开放网页不传。 */
  partition?: string
  systemName?: string
  permMode: 'readonly' | 'full'
  unattended?: boolean
  sendLog: SendLog
}

/**
 * browse 工具：在真实浏览器里多步操作网页。
 *
 * 风险档定成 low 是**有意**的——browse 的绝大多数动作（goto/observe/read/scroll）是只读导航，
 * 整体标成 write 会导致每次翻页都弹确认卡，用户很快就会疲劳到闭眼点确认，反而更不安全。
 * 真正的闸在**工具内部**：点击写按钮（提交/删除/审批…）时触发 onWriteConfirm，
 * 那里才是能看清"到底要点哪个按钮、页面上是哪张单据"的地方——比在外层猜用户意图准得多。
 */
export function browseTools(o: BrowseToolOptions): ToolSpec[] {
  const where = o.systemName ? `【${o.systemName}】` : '当前网页'
  const onWriteConfirm = async ({ actionLabel, pageText }: { actionLabel: string; pageText: string }) => {
    // 只读档：写按钮一律拒。与权限闸同一条规则，只是判定点在工具内部。
    if (o.permMode === 'readonly') {
      o.sendLog('acting', `🔒 只读模式：已拦截${where}的写动作「${actionLabel}」，未改动系统`)
      return false
    }
    // 无人值守：没有人在屏幕前核对单据，绝不替用户签字。
    if (o.unattended) {
      o.sendLog('acting', `⏸️ 无人值守：${where}的写动作「${actionLabel}」需人工确认，已跳过`)
      return false
    }
    // 批量授权（用户拍板 2026-07-31）：同类写动作（同分区+同按钮名）首次签名时可勾选
    // 「本任务内不再逐条确认」——50 条录入确认 50 次只会疲劳到闭眼点，反而更不安全。
    // 授权只存活在本任务的 RunContext 里，任务结束即失效；每次按批量放行都写审计日志。
    const batchKey = `${o.partition || 'open'}:${actionLabel}`
    const runCtx = currentRun()
    if (runCtx?.batchApproved.has(batchKey)) {
      o.sendLog('acting', `✅ 按本任务批量授权放行：${where}「${actionLabel}」（首次已人工签名确认）`)
      return true
    }
    o.sendLog('acting', `分身准备在${where}点击「${actionLabel}」——这是**写操作**，请在确认卡核对后签字…`)
    const sc = await requestSignedConfirmation([
      { name: '_sys', label: '业务系统', value: o.systemName || '网页', type: 'text' },
      { name: '_act', label: '将点击的写按钮（会改动数据，请确认）', value: actionLabel, type: 'text' },
      { name: '_page', label: '当前页面摘要（请核对目标单据）', value: (pageText || '').replace(/\s+/g, ' ').slice(0, 400), type: 'text' },
      { name: '_batch', label: '同类操作授权范围', value: '仅此一次', type: 'select', options: ['仅此一次', '本任务内同类操作不再逐条确认'] },
    ], { actionId: `browse-write:${o.partition || 'open'}` })
    if (sc.tokenState === 'rejected') {
      o.sendLog('acting', `🚫 安全闸拦截：确认令牌校验未通过（${sc.rejectReason || ''}），未点击`)
      return false
    }
    if (sc.values && String((sc.values as Record<string, string>)._batch || '').includes('不再逐条') && runCtx) {
      runCtx.batchApproved.add(batchKey)
      o.sendLog('acting', `📝 已记录批量授权：本任务内${where}「${actionLabel}」不再逐条确认（任务结束自动失效）`)
    }
    return !!sc.values
  }

  const tool = makeBrowseTool({ ...(o.partition ? { partition: o.partition } : {}), onWriteConfirm })
  return [fromAgentTool(tool, {
    label: o.systemName ? `操作${where}页面` : '操作网页',
    risk: 'low',
    category: 'browse',
  })]
}
