// 前置澄清闸（通用，不限单个技能）：生成/调研类执行动辄几分钟，开跑前用一次轻量模型判定
// 检查任务是否缺少会**实质改变产出**的关键要素（「这个行业/那家公司」指代悬空、调研对象或
// 时间范围完全未指明），缺则弹澄清卡（候选选项 + 自定义输入）阻塞等用户补充，补充并入任务后继续。
// 实锤：「帮我全面摸一下这个行业的竞争格局」无任何上下文，深度调研引擎随机选了保险业跑了全程。
// 复用写确认的表单卡机制（requestFormConfirmation 阻塞等回传；取消走 agent:abort 置 aborted）。
import { callLlm } from './llm'
import { swallow } from './util'
import { requestFormConfirmation, currentRun, type FormField } from './automation-runtime'
import { formatRouterContext } from './skill-router-core'
import type { AgentTaskData } from './agent-types'
import type { AgentTrace } from './agent-trace'
import type { SendLog } from './types'

interface ClarifyJudge { need: boolean; question?: string; options?: string[] }

/**
 * 返回补充后的任务文本；无需澄清 / 用户跳过 → 返回原文本；用户取消任务 → 返回 null（调用方终止执行）。
 * 只问一次、最多一个问题；判定失败静默放行（澄清是增强，绝不能把主链路卡死）。
 */
export async function clarifyTaskIfNeeded(data: AgentTaskData, skillNames: string[], sendLog: SendLog, trace: AgentTrace): Promise<string | null> {
  const cfg = data.llmConfig
  if (!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)) return data.content
  // 无人值守来源（定时任务等）：没人在屏幕前点卡片，弹卡=任务无限挂起（体检 P2-13）。
  // 整个闸（含判定调用）直接放行，按任务原文的最常见理解执行。
  if (data.unattended) return data.content
  let judge: ClarifyJudge | null = null
  const span = trace.beginSpan('model', '前置澄清判定')
  try {
    const ctx = formatRouterContext(data.history)
    const resp = await callLlm(
      `你是任务前置检查器。下面的任务即将进入联网调研/生成交付物执行（耗时数分钟），判断它是否缺少会**实质改变产出内容**的关键信息。\n判定规则：\n- 典型缺失：任务用「这个/那个/该/我们 + 行业/公司/产品/项目」等指代，而【最近对话】里解析不出所指；或调研/写作对象、时间范围完全未指明且没有合理默认。\n- 【最近对话】能解析出所指就不问；信息略糊但有惯例默认（输出格式/篇幅/语言）不问；**宁可不问**，最多一个问题。\n- 需要提问时，按任务语境给 2-5 个最可能的候选选项（写具体名称，不要"其他/以上都不是"），用户还可以自行输入。\n只输出严格 JSON（不要解释）：{"need":false} 或 {"need":true,"question":"一句话问题","options":["候选1","候选2"]}\n\n【将执行的技能】${skillNames.join('、') || '（无）'}\n【最近对话】\n${ctx || '（无）'}\n【任务】\n${data.content.slice(0, 500)}`,
      cfg, { temperature: 0 })
    const m = (resp || '').match(/\{[\s\S]*\}/)
    if (m) judge = JSON.parse(m[0]) as ClarifyJudge
  } catch (e) { swallow(e, 'clarify-judge') }
  if (!judge?.need || !judge.question) { span.end('ok', '任务要素齐备，无需澄清'); return data.content }
  span.end('ok', `需澄清：${judge.question}`)

  sendLog('acting', `任务关键信息不明确，先向你确认：${judge.question}`)
  const opts = (judge.options || []).map(s => String(s).trim()).filter(Boolean).slice(0, 5)
  const fields: FormField[] = []
  if (opts.length) fields.push({ name: 'choice', label: judge.question, value: '', type: 'text', options: opts })
  fields.push({ name: 'custom', label: opts.length ? '或自行补充说明（选填，优先于上面的选择）' : judge.question, value: '', type: 'text' })
  const ans = await requestFormConfirmation(fields, { kind: 'clarify', title: '需要补充任务信息', submitLabel: '确认并继续' })
  if (currentRun()?.aborted) return null   // 用户点了取消（agent:abort 已置位）→ 终止本次执行
  const supplement = (String(ans.custom || '').trim() || String(ans.choice || '').trim())
  if (!supplement) {
    sendLog('observing', '未补充信息，按原任务继续（将按最常见理解执行）。')
    return data.content
  }
  sendLog('thinking', `收到补充：「${supplement}」，按此继续执行。`)
  trace.attachIo(span.id, '任务澄清', judge.question, supplement)
  return `${data.content}\n补充说明：${supplement}`
}
