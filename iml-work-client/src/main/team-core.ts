// 跨岗位协作（agent teams）的纯逻辑：能力边界、配额、系统词、委派规则。
//
// 与 subagent-core 对称——agent-team.ts 要 import core-tools/llm（拉起 electron）跑不了单测，
// 而这里的规则错了同样是**不报错、只悄悄出事**：能力边界写宽了就是承诺做不到的事，
// 系统词漏了纪律就是拿别的岗位的名义编意见。
import type { CoreEvent } from '../shared/core-protocol'

/** 一次任务最多请教几个岗位。会诊通常 2~3 个（法务/财务/采购），4 个封顶足够。 */
export const MAX_CONSULTS = 3
/** 单次请教的墙钟上限。 */
export const CONSULT_BUDGET_MS = 120_000
/** 一轮任务里所有请教的**总**墙钟预算（按墙钟算，并行时不重复累加）。 */
export const CONSULT_TOTAL_MS = 240_000
/** 被请教岗位的推理轮数上限。 */
export const CONSULT_ITERATIONS = 8
const MIN_USEFUL_MS = 20_000

export type ConsultVerdict = { ok: true; budgetMs: number } | { ok: false; reason: string }

/** 配额闸。拒绝理由要带「那你该怎么办」，否则模型换个措辞再问一遍。 */
export function checkConsultQuota(used: number, elapsedMs: number): ConsultVerdict {
  if (used >= MAX_CONSULTS) {
    return {
      ok: false,
      reason: `本次任务最多请教 ${MAX_CONSULTS} 个岗位，已经用完。`
        + '请基于已收到的意见作答，或用你自己的知识与工具补齐剩下的部分。',
    }
  }
  const left = CONSULT_TOTAL_MS - elapsedMs
  if (left < MIN_USEFUL_MS) {
    return { ok: false, reason: '请教其他岗位的时间预算已用尽。请基于已收到的意见作答。' }
  }
  return { ok: true, budgetMs: Math.min(CONSULT_BUDGET_MS, left) }
}

/** 与小分身共用一条转发闸（理由同 subagent-core.shouldForwardSubEvent）。 */
export function shouldForwardConsultEvent(type: CoreEvent['type']): boolean {
  return type !== 'turn_start' && type !== 'turn_end' && type !== 'interrupted' && type !== 'todo_updated'
}

export interface ExpertProfile {
  id: string
  title?: string
  spec?: string
  description?: string
  principles?: string[]
  workStyle?: string[]
  webSearchEnabled?: boolean
}

/**
 * 被请教岗位的系统词。
 *
 * 【能力边界必须写实】跨岗位能借到的只有**知识库授权范围**与**专业视角**：
 * · 技能借不到——技能包是领用岗位时同步到本地的，销售员工的机器上没有法务的技能；
 * · 业务系统登录态借不到——那是当前用户本机 Electron 分区里的登录态，不是被请教岗位的。
 * 不把这条写进系统词，它就会张口答应"我去 OA 里查一下合同台账"，然后交回一份编的东西。
 */
export function buildConsultPrompt(p: ExpertProfile, question: string, context?: string): string {
  const soul = [
    p.principles?.length ? `【我的原则】\n${p.principles.map(x => `- ${x}`).join('\n')}` : '',
    p.workStyle?.length ? `【我的工作方式】\n${p.workStyle.map(x => `- ${x}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')

  return `你是「${p.title || p.id}」岗位的工作分身。另一个岗位的分身正在处理一件跨领域的任务，来请教你的专业意见。
${p.spec ? `\n【你的职责】${p.spec}` : ''}${p.description ? `\n【岗位背景】${p.description}` : ''}
${soul ? `\n${soul}\n` : ''}
【你能做什么、不能做什么 —— 说清楚很重要】
- 你**可以**检索本岗位授权范围内的企业知识库（这是你最大的价值：对方岗位查不到这些资料）${p.webSearchEnabled ? '，也可以联网查公开资料' : ''}，并做计算。
- 你**不能**执行本岗位的业务技能，也**不能**登录或操作任何业务系统——那些能力不在这次协作的范围内。
  需要查系统里的具体单据/台账才能下结论时，**明确说出来**："这一条需要在 X 系统里核对 Y，我这里查不到"，
  由发起方去处理。绝不要假装查过，更不要编一个单号或金额。

【回答纪律】
- 你的意见会被对方**直接引用**到给用户的答复里，所以：不要寒暄、不要复述问题，直接给判断与依据。
- 结构固定为三段：**结论**（能不能/有没有风险，一句话）→ **依据**（引用到的制度条款或事实，注明出处）→ **提示**（对方需要注意或补充核实的点）。
- 控制在 600 字以内。
- 拿不准就说拿不准，并说明缺什么信息才能判断。**在你的专业领域里给一个含糊的正确答案，比给一个确定的错答案有用得多。**

【真实性 · 红线】
只报工具真实返回的内容。严禁编造制度条款、金额、日期、单号、人名。
你编的东西会以「${p.title || p.id}的专业意见」的名义写进给用户的答复——比一般的胡说更危险。

【对方的问题】
${question}${context ? `\n\n【对方提供的背景】\n${context}` : ''}`
}

/**
 * 委派规则（每轮随 ephemeral 下发，只在本轮真的挂了 consult_expert 时）。
 *
 * 不抢「第一步」——那是 TODO_RULE 的位置（小分身规则抢过一次，实测导致模型跳过列计划、
 * 状态栏整片空白）。这里只说"什么时候该问"，不规定它在第几步。
 */
export function buildTeamRule(collaborators: { id: string; title: string }[]): string {
  if (!collaborators.length) return ''
  const list = collaborators.map(c => `${c.title}（${c.id}）`).join('、')
  return `【跨岗位协作 · 可请教的同事】
你可以用 consult_expert 请教这些岗位的分身：${list}。
**什么时候该问**：任务里有一块明显属于别人的专业领域（法务条款、财务口径、采购比价…），
而你的知识库里根本没有那类资料时——问他们比你自己猜准得多，因为他们能检索到你查不到的企业资料。
**什么时候不该问**：你自己的知识库或联网就能答的；对方岗位也没有的信息（他们同样查不到就别浪费一轮）。
拿到意见后由你负责汇总。**若几个岗位的意见有分歧，必须在答复里明确指出分歧点**——
那是用户最需要知道的东西，把它抹平成一句"综合来看没问题"是帮倒忙。`
}
