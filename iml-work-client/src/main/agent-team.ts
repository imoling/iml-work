// 跨岗位协作（agent teams）——把一件属于别人专业领域的事，交给那个岗位的分身出意见。
//
// 【与小分身的区别】小分身是"我自己分出去的手"，用的是我的知识库、我的权限；
// consult_expert 是"叫上别的岗位"，用的是**对方的**知识库授权范围与专业视角。
// 真正解决的问题：知识库是按岗位授权的（Expert.knowledgeCategories），销售分身**查不到**
// 法务的合同审查指引——这不是提示词能绕过的，是后端的授权边界。
//
// 【能力边界（实测约束，不是保守）】跨岗位能借到的只有两样：
// · 知识库授权范围 —— refreshKnowledgeScope(expertId) 直接从后端拉那个岗位的 categories，跨岗位可行 ✓
// · 专业视角      —— title/spec/description/principles/workStyle 从后端拉 ✓
// 借不到的：
// · 技能 —— scopedSkillsFor 读的是本地 config `boundSkills:<expertId>`，那是**领用岗位时**才同步的。
//           销售员工的机器上根本没有法务的技能包，不是不给，是没有。
// · 业务系统登录态 —— 存在本机 Electron 分区里，是当前用户的登录态，不是被请教岗位的。
// 这条边界写进了 team-core.buildConsultPrompt，否则模型会张口答应"我去 OA 查一下台账"然后编一份。
//
// 【安全】只读（工具表里没有任何写工具，与小分身同一条断言）；且只能请教**管理端配好的**
// collaborators 名单里的岗位——模型不能随便点名一个 expertId 去借别人的知识库授权。
import type { ToolSpec } from './tool-registry'
import { ToolRegistry } from './tool-registry'
import { runAgentCore } from './agent-core'
import { webTools, computeTools } from './core-tools'
import { makeKnowledgeTool } from './core-knowledge'
import { callLlmTools, tierModel, resolvePurposeModel, type LlmConfig } from './llm'
import { afetch, getAdminBaseUrl } from './http'
import type { AgentTrace } from './agent-trace'
import { swallow } from './util'
import {
  MAX_CONSULTS, CONSULT_ITERATIONS,
  checkConsultQuota, shouldForwardConsultEvent, buildConsultPrompt, type ExpertProfile,
} from './team-core'
import type { CoreEvent, CoreMessage } from '../shared/core-protocol'

/** 岗位画像缓存（60s，与知识授权范围的刷新节奏一致）。 */
const profileCache = new Map<string, { p: ExpertProfile; at: number }>()

/**
 * 拉取岗位画像。失败返回 null —— **不造一个占位画像**：
 * 拿不到对方的职责与原则，那就不是"法务的意见"，只是换了个名字的同一个模型。
 */
export async function fetchExpertProfile(expertId: string): Promise<ExpertProfile | null> {
  if (!expertId) return null
  const hit = profileCache.get(expertId)
  if (hit && Date.now() - hit.at < 60_000) return hit.p
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/experts/${expertId}`)
    if (!r.ok) return null
    const e = await r.json() as ExpertProfile & { collaborators?: string[] }
    const p: ExpertProfile = {
      id: expertId,
      title: e.title, spec: e.spec, description: e.description,
      principles: Array.isArray(e.principles) ? e.principles : [],
      workStyle: Array.isArray(e.workStyle) ? e.workStyle : [],
      webSearchEnabled: !!e.webSearchEnabled,
    }
    profileCache.set(expertId, { p, at: Date.now() })
    return p
  } catch (e) { swallow(e, 'fetch-expert-profile'); return null }
}

/** 当前岗位可请教谁（管理端配的 collaborators）。取不到就是空——空则不挂这个工具。 */
export async function fetchCollaborators(expertId: string): Promise<{ id: string; title: string }[]> {
  if (!expertId) return []
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/experts/${expertId}`)
    if (!r.ok) return []
    const e = await r.json() as { collaborators?: string[] }
    const ids = Array.isArray(e.collaborators) ? e.collaborators.filter(x => typeof x === 'string' && x) : []
    const out: { id: string; title: string }[] = []
    for (const id of ids.slice(0, 8)) {
      const p = await fetchExpertProfile(id)
      if (p) out.push({ id, title: p.title || id })
    }
    return out
  } catch (e) { swallow(e, 'fetch-collaborators'); return [] }
}

export interface TeamDeps {
  parentRunId: string
  /** 父任务的审计轨迹（必传，理由同 SubagentDeps.trace）。 */
  trace: AgentTrace
  cfg: LlmConfig
  /** 权限档原样透传；工具表本来也全是只读的。 */
  permMode: 'readonly' | 'full'
  unattended?: boolean
  /** 发起方岗位（用于日志与审计标注）。 */
  fromExpertId: string
  /** 可请教的岗位白名单（管理端配置，模型不得越界）。 */
  collaborators: { id: string; title: string }[]
  emit: (ev: CoreEvent) => void
  isCancelled?: () => boolean
  abortSignal?: () => AbortSignal | undefined
  onWebSources?: (s: { title: string; url: string }[]) => void
}

/** 被请教岗位的模型档：与小分身同理走 standard（出专业意见靠的是知识库命中，不是推理深度）。 */
function consultCfg(parent: LlmConfig): LlmConfig {
  let m = ''
  try { m = tierModel('standard') } catch (e) { swallow(e, 'consult-tier') }
  // 档位映射的值可能是 providerId::model 引用，经统一入口解析（原样塞名会被上游 400）
  return m && m !== parent.modelName ? resolvePurposeModel(parent, m) : parent
}

/**
 * 被请教岗位的工具表——**白名单**，且比小分身更窄。
 *
 * 少给的两样都是有理由的：
 * · read_file —— 工作空间是**当前用户**的文件，跟被请教的岗位没有任何关系；
 * · run_skill —— 本地没有对方岗位的技能包（见文件头），挂上去只会让它调一个不存在的东西。
 */
export function buildConsultRegistry(d: TeamDeps, p: ExpertProfile): ToolRegistry {
  const reg = new ToolRegistry()
  // 联网权限跟**被请教岗位**的配置走，不是发起方的——这正是"用对方的身份去查"的一部分
  if (p.webSearchEnabled) reg.registerAll(webTools(d.cfg, (s) => d.onWebSources?.(s)))
  reg.registerAll(computeTools())
  // 核心价值就在这一行：按**对方岗位**的 knowledgeCategories 检索（后端授权，跨岗位可行）
  reg.register(makeKnowledgeTool(p.id).spec)

  // 与小分身同一条结构性断言：并行的协作分身共享 RunContext 的确认通道，必须全只读。
  for (const s of reg.list()) {
    if (s.metadata.risk === 'write' || s.metadata.requiresApproval) {
      throw new Error(`[team] 协作岗位工具表混入了需确认的工具「${s.name}」——跨岗位协作必须保持全只读。`)
    }
  }
  return reg
}

/** 造 consult_expert 工具。配额存闭包，一轮任务造一个。 */
export function makeConsultTool(d: TeamDeps): ToolSpec {
  let used = 0
  let firstStartMs = 0
  const roster = d.collaborators.map(c => `${c.title}（id: ${c.id}）`).join('、')

  return {
    name: 'consult_expert',
    description: `请教另一个岗位的分身，拿回它的专业意见。可请教：${roster}。`
      + '\n【为什么要问它】企业知识库是**按岗位授权**的——对方能检索到你查不到的资料'
      + '（法务的合同审查指引、财务的核算口径…），这不是你换个检索词就能绕过的。'
      + '\n【它能做什么】按它岗位的授权范围查知识库、（若该岗位有权限）联网、做计算。'
      + '\n【它不能做什么】执行技能、登录或操作业务系统——这些能力不在协作范围内。'
      + '需要核对系统里的具体单据时，它会告诉你"这条要在 X 系统里核对"，由你来处理。'
      + `\n【配额】本次任务最多请教 ${MAX_CONSULTS} 个岗位。question 要写成自足的问题`
      + '（它看不到你们的对话，只看得见你写的这段），把判断所需的背景一并放进 context。',
    parameters: {
      type: 'object',
      properties: {
        expertId: { type: 'string', description: `要请教的岗位 id，只能从这些里选：${d.collaborators.map(c => c.id).join('、')}` },
        question: { type: 'string', description: '要问的问题。写成自足的一问：要它判断什么、给出什么结论' },
        context: { type: 'string', description: '可选：判断所需的背景（合同条款原文、金额、时间范围…）。它看不到对话上文，该给的都要给。' },
      },
      required: ['expertId', 'question'],
    },
    metadata: { label: '请教其他岗位', risk: 'low', category: 'subagent' },

    run: async (args, ctx) => {
      const targetId = String(args.expertId || '').trim()
      const question = String(args.question || '').trim()
      const context = String(args.context || '').trim()
      if (!targetId || !question) return '（consult_expert 需要 expertId 与 question）'

      // 白名单闸：模型不能随便点一个 expertId 去借别人的知识库授权。
      // 这是**安全边界**而不是参数校验——知识授权范围是企业按岗位配的，绕过它就是越权检索。
      const target = d.collaborators.find(c => c.id === targetId)
      if (!target) {
        return `「${targetId}」不在本岗位的可协作名单里，无法请教。可请教的是：${roster || '（本岗位未配置协作岗位）'}。`
          + '请改问名单内的岗位，或用你自己的工具处理这一部分。'
      }

      const quota = checkConsultQuota(used, firstStartMs ? Date.now() - firstStartMs : 0)
      if (!quota.ok) return quota.reason
      if (d.isCancelled?.()) return '（用户已中止任务，未发出请教）'
      if (!firstStartMs) firstStartMs = Date.now()

      const profile = await fetchExpertProfile(targetId)
      if (!profile) {
        return `拿不到「${target.title}」的岗位信息（后端不可达？），无法以该岗位的身份出具意见。`
          + '请如实告知用户这一部分没能取得对方岗位的意见，不要自己代它回答。'
      }

      used++
      const agentId = `${ctx.callId || `consult-${Date.now()}`}-c${used}`
      const label = `${profile.title || targetId} · ${question.slice(0, 12)}`

      d.emit({ type: 'agent_started', runId: d.parentRunId, agentId, label, parentCallId: ctx.callId || '', kind: 'expert' })
      ctx.sendLog('acting', `请教「${profile.title || targetId}」…`)

      const subEmit = (ev: CoreEvent) => {
        if (!shouldForwardConsultEvent(ev.type)) return
        d.emit({ ...ev, agentId, agentLabel: label })
      }

      const registry = buildConsultRegistry(d, profile)
      const messages: CoreMessage[] = [
        { role: 'system', content: buildConsultPrompt(profile, question, context || undefined), ts: Date.now() },
        { role: 'user', content: question, ts: Date.now() },
      ]

      const span = d.trace.beginSpan('team', `请教·${profile.title || targetId}`, { stage: '执行' })
      let answer = ''
      let status: 'ok' | 'error' = 'ok'
      let iterations = 0
      let toolCalls = 0
      try {
        const res = await runAgentCore({
          runId: d.parentRunId, messages, registry,
          cfg: consultCfg(d.cfg), callModel: callLlmTools,
          sendLog: ctx.sendLog, emit: subEmit,
          permMode: d.permMode, unattended: d.unattended,
          maxIterations: CONSULT_ITERATIONS,
          budgetMs: quota.budgetMs,
          ...(d.isCancelled ? { isCancelled: d.isCancelled } : {}),
          ...(d.abortSignal ? { abortSignal: d.abortSignal } : {}),
        })
        answer = (res.answer || '').trim()
        iterations = res.iterations
        toolCalls = res.toolCallCount
        if (res.status !== 'completed' && answer) {
          answer += `\n\n（注：${profile.title || targetId}在 ${res.iterations} 轮后达上限提前收尾，以上意见基于已查到的部分。）`
        }
        if (!answer) {
          status = 'error'
          // 同 agent-subagent：真实原因在内核记的最后一条 notice 里，不取出来就只剩一个 status
          const why = [...res.messages].reverse()
            .find(m => m.role === 'notice' && m.noticeKind === 'error')?.content
          answer = `「${profile.title || targetId}」没能给出意见${why ? `：${why.slice(0, 200)}` : `（${res.status}）`}。`
            + '请在答复中**带上这个具体原因**如实说明这一部分未取得该岗位意见。'
        }
      } catch (e: any) {
        swallow(e, 'consult-run')
        status = 'error'
        answer = `请教「${profile.title || targetId}」时出错：${e?.message || e}。请如实告知用户，不要代它编一份意见。`
      } finally {
        try { await registry.cleanup() } catch (e) { swallow(e, 'consult-cleanup') }
        span.end(status === 'ok' ? 'ok' : 'warn', `${iterations} 轮 · ${toolCalls} 次工具调用 · 意见 ${answer.length} 字`)
        d.trace.attachIo(span.id, `请教·${profile.title || targetId}`, `${question}\n\n${context}`.trim(), answer)
      }

      d.emit({
        type: 'agent_finished', runId: d.parentRunId, agentId,
        status: status === 'ok' ? 'ok' : 'error', summary: answer.slice(0, 500),
      })
      ctx.sendLog('observing', `「${profile.title || targetId}」已给出意见（${answer.length} 字）`)

      // 标明这是**另一个岗位的专业意见**：汇总时要注明出处，几方有分歧时更要显式指出，
      // 不能把它当成自己的判断混进去（用户有权知道这条结论是谁给的）。
      return `【${profile.title || targetId}的专业意见】\n${answer}\n\n`
        + '（转述给用户时请注明这是该岗位给出的意见；若与其他岗位的意见有分歧，必须明确指出分歧点。）'
    },
  }
}
