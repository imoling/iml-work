// SkillStepper：语义 SKILL 的**SOP 分步推进**执行器（设计 docs/design-recording-to-semantic-skill.md ⑤）。
//
// 与 runBrowseExecutor（一口气自主）的区别：SOP 按编号行拆成 N 个子任务，**同一个离屏 browse 窗口跨步复用**，
// 每步一个小步数的 agent 循环——完成即 ✓ 汇报、失败停在该步如实报告（含当页快照），绝不硬闯后续步骤。
// 提交步由 onWriteConfirm 写前签字钩子拦（读真实单据给用户签），执行完回读页面作为完成凭据。
//
// 叶子纪律：只 import agent-browse / agent-loop / util / types（LlmConfig type-only，callModel 注入），绝不 import main / llm 本体。
import { makeBrowseTool } from './agent-browse'
import type { WriteConfirm } from './agent-browse'
import { runAgentLoop } from './agent-loop'
import type { AgentTool } from './agent-loop'
import { swallow } from './util'
import type { LlmConfig } from './llm'
import type { SendLog } from './types'

export interface StepperOpts {
  systemId: string
  systemName: string
  entryUrl: string
  sop: string                            // 编号步骤 + {{参数}} 占位（占位在调用前已由 fieldValues 替换或随任务给出）
  task: string                           // 用户原始需求（每步作为总目标上下文）
  fieldValues?: Record<string, string>   // 确认后的参数值
  hint?: string                          // 录制轨迹参考（当时的操作顺序/控件名，供定位提效；页面以实际为准）
  cfg: LlmConfig
  callModel: (prompt: string, cfg: LlmConfig, opts?: { temperature?: number; longRunning?: boolean }) => Promise<string>
  sendLog: SendLog
  onWriteConfirm?: WriteConfirm          // 写前签字（提交步触发）
  /** 人工接管兜底（attended mode）：某步自动化确实搞不定时，请用户在可视化窗口里手动完成那一步，
   *  返回 true=用户已完成（该步标 ✓ 继续后续自动化）；false/未接=按失败终止。95%自动+5%人点一下=100%可靠。 */
  onHumanAssist?: (ctx: { stepIndex: number; stepText: string; reason: string }) => Promise<boolean>
  visible?: boolean                      // 可视化执行窗（默认开：分步执行就是给人看的）
  perStepMaxSteps?: number               // 每个 SOP 步的 agent 小循环步数上限
  perStepBudgetMs?: number
}

export interface StepperResult {
  ok: boolean
  loggedIn: boolean
  done: number                // 完成的 SOP 步数
  total: number
  failedAt: number            // -1=未失败
  failLabel: string           // 失败步的 SOP 文本
  outcome: string             // 汇总结论（含失败时的当页快照摘要）
  verifyText: string          // 执行完回读的页面正文（完成凭据，调用方如实转述）
  cancelled: boolean          // 用户在写前签字时取消
}

const LOGIN_RE = /(登录|登陆|login|sign in|账号|帐号|密码|password)/i

/** 把 SOP 拆成编号步骤行（"1. xxx"）；无编号则按非空行拆。跳过标题/反馈要求等非操作段。 */
export function parseSopSteps(sop: string): string[] {
  const lines = String(sop || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const numbered = lines.map(l => { const m = l.match(/^(\d{1,2})[.、)]\s*(.+)$/); return m ? m[2].trim() : null }).filter(Boolean) as string[]
  if (numbered.length) return numbered
  // 无编号：取"看起来是操作"的行（排除 #标题、-列表的反馈要求段）
  return lines.filter(l => !/^#|^[-*]/.test(l))
}

/** {{参数}} 注入：有值替换，无值保留占位（步任务里另附字段值清单兜底）。 */
function fillParams(text: string, values?: Record<string, string>): string {
  if (!values) return text
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, k) => {
    const v = values[String(k).trim()]
    return v !== undefined && v !== '' ? v : m
  })
}

export async function runSkillStepper(o: StepperOpts): Promise<StepperResult> {
  const sopSteps = parseSopSteps(o.sop)
  const total = sopSteps.length
  const fail = (r: Partial<StepperResult>): StepperResult => ({ ok: false, loggedIn: true, done: 0, total, failedAt: -1, failLabel: '', outcome: '', verifyText: '', cancelled: false, ...r })
  if (!total) return fail({ outcome: 'SOP 为空，无法分步执行' })

  let cancelled = false
  const onWriteConfirm: WriteConfirm | undefined = o.onWriteConfirm
    ? async (ctx) => { const okSign = await o.onWriteConfirm!(ctx); if (!okSign) cancelled = true; return okSign }
    : undefined
  const tool = makeBrowseTool({ partition: `persist:bizsys-${o.systemId}`, onWriteConfirm, visible: o.visible !== false })
  // 跨步复用同一窗口：小循环里给 no-op cleanup（runAgentLoop finally 会调），真正的关窗由本函数最后统一做。
  const sharedTool: AgentTool = { ...tool, cleanup: async () => {} }

  const fieldsBlock = o.fieldValues && Object.keys(o.fieldValues).length
    ? `\n【本次参数值（只用这里给的，勿臆造/勿用演示旧值）】\n${Object.entries(o.fieldValues).map(([k, v]) => `- ${k}：${v}`).join('\n')}\n`
    : ''
  const hintBlock = o.hint && o.hint.trim()
    ? `\n【录制轨迹参考（当时的操作顺序与控件名，供定位提效；流程里的具体值是演示旧样例，一律以参数值为准）】\n${o.hint.trim().slice(0, 1600)}\n`
    : ''

  try {
    // ── 预检：进入口 + 登录态 ────────────────────────────────────────────────
    if (o.entryUrl) {
      try {
        const landing = await tool.run({ action: 'goto', url: o.entryUrl }, o.sendLog)
        const landedUrl = (/\|\s*(https?:\/\/[^\s]+)/.exec(landing || '') || [])[1] || ''
        const read = await tool.run({ action: 'read' }, o.sendLog)
        const body = (read || '').replace(/^【页面正文】\s*/, '')
        if (/\/(sso\/)?login|signin|passport|casLogin|authserver|\/cas\b|\/auth\//i.test(landedUrl) || (body.length < 500 && LOGIN_RE.test(body))) {
          await tool.cleanup?.()
          return fail({ loggedIn: false, outcome: `尚未登录【${o.systemName}】` })
        }
      } catch (e) { swallow(e, 'stepper-preflight') }
    }

    // ── SOP 分步推进 ────────────────────────────────────────────────────────
    let done = 0
    for (let i = 0; i < sopSteps.length; i++) {
      if (cancelled) break
      const stepText = fillParams(sopSteps[i], o.fieldValues)
      o.sendLog('acting', `[分步 ${i + 1}/${total}] ${stepText}`)
      const task = `你是企业员工的工作分身，正在【${o.systemName}】里按 SOP 分步办理：「${o.task}」。
【总计划】\n${sopSteps.map((s, k) => `${k + 1}. ${k < i ? '✓ ' : ''}${fillParams(s, o.fieldValues)}`).join('\n')}${fieldsBlock}${hintBlock}
【本步任务（只做这一步，做完就 finish）】第 ${i + 1} 步：${stepText}
规则：浏览器已停在上一步完成后的页面（无需重新进系统/重复前面的步骤）。先 observe/inspect 看清当前页面，只完成本步；字段值严格用【本次参数值】。企业系统的页面标题常与入口名不同（如「考勤维护」入口打开的表单叫「未打卡原因维护申请」）——只要当前页面能继续办理就**继续**，绝不因标题不同而退回。**带放大镜图标的检索控件**（直接打字留不住/rowset 报"未能留在该格"）必须用 picker 点开检索弹窗 → 弹窗里 search(value=要选的值) 搜索并**点中结果**（不点中结果值不会落，search 会自动点）→ observe 核实值已落 → 如有「确定」再点。录制轨迹里的 [sel=…] 是当时的精确选择器——对应步骤可把它原样作为 sel 参数传给 browse（如 click/fill/picker 带 sel），定位最稳。
汇报协议（必须遵守）：本步**真正完成并在页面确认生效** → finish，answer 以「DONE:」开头+一句"做了什么、页面现在什么状态"；**无法完成**（缺按钮/找不到目标/页面不符本步前提/报错）→ 不要蛮干，finish，answer 以「STUCK:」开头+原因。绝不把没做成说成做成。`
      const r = await runAgentLoop({
        task, tools: [sharedTool], cfg: o.cfg, sendLog: o.sendLog, callModel: o.callModel,
        maxSteps: o.perStepMaxSteps ?? 10, budgetMs: o.perStepBudgetMs ?? 240000,   // 真机单步模型调用 25~47s，150s 会被掐在收尾中途
      })
      if (cancelled) break
      // 完成判定（宁信"没做成"）：优先显式协议 DONE:/STUCK: 前缀；模型没守协议时退回**全文**失败词扫描
      //（血泪：曾只扫前 60 字，"…未找到相关待办任务，无法执行第1步"的"无法"落在 60 字外被误判成功）。
      const ans = (r.answer || '').trim()
      const okMark = /^DONE[:：]/i.test(ans)
      const stuckMark = /^STUCK[:：]/i.test(ans)
      const failWords = /未找到|找不到|无法|没有|未能|失败|不存在|报错|停留在|尚未|没能|未完成|不符合/
      const failed = !r.finished || stuckMark || (!okMark && failWords.test(ans))
      if (failed) {
        // 人工接管兜底（attended mode）：自动化确实搞不定的步骤，请用户在可视化窗口手动完成那一下，
        // 完成后本步标 ✓、后续步骤继续自动——比让 agent 死磕/整单报废可靠得多。
        if (o.onHumanAssist) {
          o.sendLog('acting', `[分步 ${i + 1}/${total}] 自动化未完成，请求人工协助…`)
          let helped = false
          try { helped = await o.onHumanAssist({ stepIndex: i, stepText, reason: ans || '步数耗尽' }) } catch (e) { swallow(e, 'human-assist') }
          if (helped) {
            done++
            o.sendLog('completed', `✓ [${i + 1}/${total}]（人工协助完成）${stepText}`)
            continue
          }
        }
        let snap = ''
        try { snap = ((await tool.run({ action: 'read' }, o.sendLog)) || '').replace(/^【页面正文】\s*/, '').slice(0, 400) } catch (e) { swallow(e) }
        await tool.cleanup?.()
        return fail({ done, failedAt: i, failLabel: sopSteps[i], outcome: `第 ${i + 1} 步「${stepText}」未完成：${ans || '步数耗尽'}`, verifyText: snap })
      }
      done++
      o.sendLog('completed', `✓ [${i + 1}/${total}] ${ans.replace(/^DONE[:：]\s*/i, '').slice(0, 80) || stepText}`)
    }

    if (cancelled) {
      await tool.cleanup?.()
      return fail({ done, cancelled: true, outcome: '已在写前签字时取消，未提交，未改动系统' })
    }

    // ── 回读验证：执行完读当前页作为完成凭据（如实转述，绝不吹牛）────────────
    let verifyText = ''
    try { verifyText = ((await tool.run({ action: 'read' }, o.sendLog)) || '').replace(/^【页面正文】\s*/, '').slice(0, 1200) } catch (e) { swallow(e) }
    await tool.cleanup?.()
    return { ok: true, loggedIn: true, done, total, failedAt: -1, failLabel: '', outcome: `已按 SOP 完成全部 ${done}/${total} 步`, verifyText, cancelled: false }
  } catch (e: any) {
    try { await tool.cleanup?.() } catch (e2) { swallow(e2, 'stepper-cleanup') }
    return fail({ outcome: `分步执行出错：${e?.message || e}` })
  }
}
