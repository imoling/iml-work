// 子智能体（subagent）——把一个独立的调查子任务交给「另一轮内核」去跑，主分身只拿回结论。
//
// 【为什么需要它】主循环的上下文是有限的：每条工具结果按 obsCap 截断、整轮 maxIterations 封顶。
// 「对比三个竞品近半年动向」这类任务，需要读 15~20 篇正文才谈得上有依据，而这些正文**全都要挤进
// 同一个上下文**——结果就是每篇都只能浅尝辄止，最后给一份看着完整、其实没读透的对比。
// 子智能体把这件事反过来：每个子任务有**自己的**上下文预算，读够了再把 800 字结论交回来，
// 主分身的上下文里只留结论。这是 subagent 的第一价值，「并行加速」反而是次要的（见下）。
//
// 【实现就是递归】子智能体跑的是同一个 runAgentCore，只是换一张工具表、换一份 messages。
// 所以这里没有第二套执行引擎，只有「组装 + 约束 + 事件转发」三件事。
//
// 【三条硬约束——写在代码里，不靠提示词】
// ① 能力白名单：只给只读工具，且是**白名单不是黑名单**。黑名单迟早会漏掉某个新加的写工具，
//    而漏掉的那一次，就是子智能体在没人签字的情况下动了业务系统。
// ② 不可递归：子智能体的工具表里没有它自己，所以第二层从结构上就不存在（同款处理：
//    Claude Code 的只读搜索 agent 同样不在自己的工具表里挂 Agent）。
// ③ 配额封顶：单次时长、任务级总时长、派发次数三重封顶。子智能体是按次计费的成本放大器
//    （业界公开经验：多智能体的 token 消耗是普通对话的十几倍），不封顶就是账单事故。
//
// 【并行】允许（模型一批发几个就并行跑几个，上限 MAX_SUBAGENTS）。承载已实测：模型网关 4 路
// 并发 4/4 成功、3.82× 加速且单次延迟无劣化；本地 Docker 沙箱 3 路并发 3/3 成功、1.71× 加速。
// 但并行成立的前提是**工具表全只读**（并行子智能体共享同一个 RunContext 的确认通道），
// 这条前提由 buildSubRegistry 末尾的断言当场守住，不是靠注释提醒。
import type { ToolSpec } from './tool-registry'
import { ToolRegistry } from './tool-registry'
import { runAgentCore } from './agent-core'
import { webTools, computeTools, fileTools } from './core-tools'
import { makeKnowledgeTool } from './core-knowledge'
import { callLlmTools, tierModel, type LlmConfig } from './llm'
// type-only：agent-trace 会拉起 db/http（进而 electron），只用它的方法签名就别引入运行时依赖。
import type { AgentTrace } from './agent-trace'
import { swallow } from './util'
import {
  MAX_SUBAGENTS, MAX_ITERATIONS,
  checkQuota, shouldForwardSubEvent, buildSubagentPrompt,
} from './subagent-core'
import type { CoreEvent, CoreMessage } from '../shared/core-protocol'

export interface SubagentDeps {
  parentRunId: string
  /**
   * 父任务的审计轨迹。**必传**——子智能体是真实执行链路的一部分（它联网、读正文、跑沙箱），
   * 不留痕就等于这段执行对管理端不存在，直接踩「全链路留痕上报」这条红线。
   *
   * 做成必填而不是可选，是因为这次就是这么漏的：设计文档里写了「子的 spans 挂父 trace」，
   * 实现时整个忘掉，而可选参数不会有任何东西提醒你。必填能让新的调用点**必须**当场面对
   * 「这条链路的审计怎么办」，而不是默默漏过去。
   */
  trace: AgentTrace
  /** 父的模型配置（子智能体在此基础上换档，换不到就沿用）。 */
  cfg: LlmConfig
  /** 权限档：**原样透传，只能收窄不能放宽**。子智能体的工具表里本来也没有写工具。 */
  permMode: 'readonly' | 'full'
  unattended?: boolean
  /** 岗位 id：决定子智能体能查哪些知识库分类（与主链路同源，不另开口子）。 */
  expertId: string
  /** 岗位是否被授权联网（与主链路同一判据，子智能体不得绕过）。 */
  allowWeb: boolean
  /** 工作空间文件是否可读（用户可能整体关掉了工作空间访问）。 */
  allowFiles: boolean
  emit: (ev: CoreEvent) => void
  isCancelled?: () => boolean
  abortSignal?: () => AbortSignal | undefined
  /** 子智能体沙箱产出的文件汇总回父（用户该拿到它，交付卡要展示）。 */
  onFiles?: (files: { name: string; sizeBytes: number }[]) => void
  /** 子智能体查过的联网来源汇总回父（来源列表要完整，否则用户以为结论没出处）。 */
  onWebSources?: (s: { title: string; url: string }[]) => void
}

/**
 * 子智能体的模型档：走 standard 档。
 *
 * 子智能体干的是「读网页 → 提炼事实」，不需要父那种规划与取舍能力，却是调用次数的大头。
 * 让它跟着父走推理档，等于按强档单价买一件不需要强档的活（与 agent-steps.summaryCfg 同一取舍）。
 * 没配档位映射就沿用父的配置——宁可贵一点，也不能因为取不到模型名而整个跑不起来。
 */
export function subagentCfg(parent: LlmConfig): LlmConfig {
  let m = ''
  try { m = tierModel('standard') } catch (e) { swallow(e, 'subagent-tier') }
  return m && m !== parent.modelName ? { ...parent, modelName: m } : parent
}

/**
 * 组装子智能体的工具表——**白名单**。
 *
 * 这里刻意不复用 defaultReadOnlyTools：那个函数是给主链路用的，将来往里加工具是很自然的事
 * （它本来就该长），而子智能体的能力集必须**显式列举**、加工具时需要有人专门决定要不要给它。
 * 两者共用一个入口，早晚会有一个写工具顺着主链路的扩张漏进子智能体。
 */
export function buildSubRegistry(d: SubagentDeps): ToolRegistry {
  const reg = new ToolRegistry()
  // 联网检索三件套（搜 → 读正文 → 下载文档）：子智能体的主力，来源汇总回父
  if (d.allowWeb) reg.registerAll(webTools(d.cfg, (s) => d.onWebSources?.(s)))
  // 沙箱计算：算术/计数/统计一律真算。不给它反而会逼子智能体心算硬报（踩真实性红线），
  // 产物重名由 saveSandboxFiles 的 uniqueArtifactName 兜住，不会互相覆盖。
  reg.registerAll(computeTools((f) => d.onFiles?.(f)))
  if (d.allowFiles) reg.registerAll(fileTools())
  // 企业知识库：按岗位授权范围检索，与主链路同一个入口
  reg.register(makeKnowledgeTool(d.expertId).spec)
  // 到此为止。**不给**：browse（操作系统要人盯着）、run_skill（技能内部有自己的确认闸与写能力）、
  // install_skill（装东西是全局副作用）、ask_user（子智能体见不到用户）、todo_write（清单是主分身的）、
  // 以及 run_subagent 自身（第二层递归从结构上不存在）。

  // 并行安全的**结构性前提**——就地断言，不让它停留在注释层面。
  //
  // 子智能体允许并行（网关 4 路实测 3.82× 加速无劣化、本地沙箱 3 路 1.71× 加速全成功），
  // 但这件事成立**只因为它的工具表全是只读的**：并行的子智能体共享同一个 RunContext
  //（ALS 按 runId 一个），而 RunContext 的 formResolve 是单字段、batchApproved 是共享 Set。
  // 一旦哪天有人往上面这份白名单里加了个需要确认的工具，两个子智能体同时挂起等确认，
  // 后来者就会覆盖前者的 resolve —— 前一个 Promise 永不兑现，子智能体挂死、父的预算被拖爆，
  // 而且这种故障是偶发的、极难复现。所以在这里当场炸掉，让它在开发期就暴露。
  for (const s of reg.list()) {
    if (s.metadata.risk === 'write' || s.metadata.requiresApproval) {
      throw new Error(
        `[subagent] 工具表混入了需确认的工具「${s.name}」。子智能体必须保持全只读——`
        + '并行的子智能体共享 RunContext 的确认通道，会互相覆盖 resolve 导致挂死。'
        + '若确实要给子智能体写能力，先改造 RunContext（formResolve→Map、batchApproved 分桶），再放开这里。',
      )
    }
  }
  return reg
}

/**
 * 造一个 run_subagent 工具。配额状态存在闭包里，因此**一轮主任务造一个**，
 * 由它统一管住这轮里所有子智能体的次数与总时长。
 */
export function makeSubagentTool(d: SubagentDeps): ToolSpec {
  let spawned = 0
  /**
   * 第一个子智能体的起跑时刻。总预算按**墙钟**算，不是各自耗时累加——
   * 并行时 3 个各跑 60s，累加是 180s 而真实只过了 60s，按累加算会让预算凭空少掉三分之二，
   * 后面该派的子智能体全被配额闸拒掉。0 表示还没派过。
   */
  let firstStartMs = 0

  return {
    name: 'run_subagent',
    // 措辞刻意用「小分身」而不是技术词：模型会照着工具描述的用语写实时叙述，
    // 而那句叙述是**直接展示给用户**的——这里说"子智能体"，用户对话框里就会冒出"子智能体"。
    // 工具**名**保持 run_subagent 不变：模型对这个 API 概念有先验，换成生造词会降低调用准确率。
    description: '分出一个**小分身**去独立调查某件事，拿回它整理好的结论（你是它的老板）。'
      + '小分身有自己独立的上下文，能读完十几篇资料再提炼——适合「需要大量阅读才能得出一个结论」的子问题。'
      + '\n【什么时候用】任务可以拆成 2~4 个**互不依赖**的调查面（如三个竞品各查一家、几个地区分别取数），'
      + '且每一面都需要多次检索/深读才说得清。**一次把它们全部分出去**（它们会并行跑），各自的结论再由你汇总。'
      + '\n【什么时候不要用】① 一两次检索就能答的问题——自己查更快；'
      + '② 有对应业务技能的任务（出报告/做PPT/取行情）——直接 run_skill，小分身没有这些能力；'
      + '③ 需要操作业务系统或写入数据——小分身是**只读**的，做不了；'
      + '④ 后一步依赖前一步结果的串行任务——拆开也不能并行，只是白等。'
      + `\n【配额】本次任务最多分出 ${MAX_SUBAGENTS} 个，用完就得自己干。task 要写成完整、自足的调查要求`
      + '（小分身看不到你们的对话，只看得见 task 这段文字）。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '交给这个小分身的**完整任务**。必须自足：查什么、要查到什么程度、'
            + '结论里需要包含哪些要素（时间范围、指标口径、对比维度）都要写进去。它看不到对话上文。',
        },
        label: {
          type: 'string',
          description: '这个小分身要办的事的短标题（6~12 字，如「竞品B产品动向」），展示给用户看进度用',
        },
      },
      required: ['task'],
    },
    // low 档且无需审批：子智能体的工具表里没有任何写工具，它自身不可能改动外部系统。
    // category 'subagent' 会被 isParallelSafe 显式排除（并发安全，见那里的注释）。
    metadata: { label: '分出小分身去查', risk: 'low', category: 'subagent' },

    run: async (args, ctx) => {
      const task = String(args.task || '').trim()
      if (!task) return '（run_subagent 需要 task 参数：要交给小分身的完整任务描述）'

      // —— 配额闸（纯逻辑在 subagent-core，单测钉住）：拒绝时给的理由会原样回灌给模型，
      //    必须带上「那你该怎么办」，否则它只会换个措辞把同一个请求再发一遍。
      const quota = checkQuota(spawned, firstStartMs ? Date.now() - firstStartMs : 0)
      if (!quota.ok) return quota.reason
      if (d.isCancelled?.()) return '（用户已中止任务，小分身没有分出去）'
      if (!firstStartMs) firstStartMs = Date.now()

      spawned++
      const agentId = `${ctx.callId || `sub-${Date.now()}`}-a${spawned}`
      const label = String(args.label || '').trim().slice(0, 20) || task.slice(0, 12)

      d.emit({
        type: 'agent_started', runId: d.parentRunId, agentId, label,
        parentCallId: ctx.callId || '',
      })
      ctx.sendLog('acting', `分出一个小分身「${label}」，让它自己去查…`)

      // 子事件 → 父事件：打上 agentId 后转发，边界事件与清单事件拦在闸外
      //（判定与理由见 subagent-core.shouldForwardSubEvent，单测钉住）。
      const subEmit = (ev: CoreEvent) => {
        if (!shouldForwardSubEvent(ev.type)) return
        d.emit({ ...ev, agentId, agentLabel: label })
      }

      const registry = buildSubRegistry(d)
      const messages: CoreMessage[] = [
        { role: 'system', content: buildSubagentPrompt(task), ts: Date.now() },
        { role: 'user', content: task, ts: Date.now() },
      ]

      // 审计：一个小分身一个 span（**不是每次内部工具一个**——3 个小分身 × 8 轮会把时间线撑爆，
      // 而追溯真正需要的是「派了谁、让它查什么、它带回了什么、花了多久」）。
      // token 不报：并行时 currentUsage() 是 RunContext 级的共用累加，取差值必然互相串号；
      // 宁可不报，也不报一个错的数（AgentTrace 的估算 token 已经吃过这个亏）。
      const span = d.trace.beginSpan('agent', `小分身·${label}`, { stage: '执行' })

      let answer = ''
      let status: 'ok' | 'error' = 'ok'
      let iterations = 0
      let toolCalls = 0
      try {
        const res = await runAgentCore({
          runId: d.parentRunId, messages, registry,
          cfg: subagentCfg(d.cfg),
          callModel: callLlmTools,
          // sendLog 原样用父给的：内核已把工具内部流水挂到本次调用上（execOne 的 nestedLog），
          // 所以子智能体的全部日志天然归属到「派出子智能体」这一行，这里不用另接线。
          sendLog: ctx.sendLog,
          emit: subEmit,
          permMode: d.permMode,
          unattended: d.unattended,
          maxIterations: MAX_ITERATIONS,
          budgetMs: quota.budgetMs,
          // 单条观察比主分身收得更紧（默认 4000）。小分身跑的是**密集检索**——8 轮里可能攒下
          // 十几条带正文的结果，按 4000 累加轻松突破 standard 档的上下文窗口，
          // 表现就是「前几次检索全成功、最后一次模型调用直接抛异常」（实测见过一次）。
          // 2800 字符≈1400 汉字，提炼事实够用；它本来的职责也是提炼而不是搬运原文。
          obsCap: 2800,
          ...(d.isCancelled ? { isCancelled: d.isCancelled } : {}),
          ...(d.abortSignal ? { abortSignal: d.abortSignal } : {}),
        })
        answer = (res.answer || '').trim()
        iterations = res.iterations
        toolCalls = res.toolCallCount
        // 没跑完要**如实标注**：主分身据此决定是自己补查还是照单引用。
        // 不标的话它会把一份半成品当完整结论写进给用户的答复（这类"看着完整的假答案"最危险）。
        if (res.status !== 'completed' && answer) {
          answer += `\n\n（注：本子任务在 ${res.iterations} 轮后因步数/时间上限提前收尾，以上结论基于已查到的部分。）`
        }
        if (!answer) {
          status = 'error'
          // 失败原因不能只报一个 status。实测：小分身 4 次联网检索**全部成功**，最后却
          // 「空手而归（error）」——真正的原因（模型调用抛异常：上下文超限 / 网关报错 / 超时）
          // 被内核记进了最后一条 notice，而这里没取出来，于是主分身既判断不了要不要换个方式重来，
          // 也没法如实告诉用户为什么。
          const why = [...res.messages].reverse()
            .find(m => m.role === 'notice' && m.noticeKind === 'error')?.content
          answer = `小分身「${label}」没能带回结论${why ? `：${why.slice(0, 200)}` : `（${res.status}）`}。`
            + '这一项请改用你自己的工具查，或在答复中**带上这个具体原因**如实说明没查到——不要只说"查询失败"。'
        }
      } catch (e: any) {
        swallow(e, 'subagent-run')
        status = 'error'
        answer = `小分身「${label}」中途出错：${e?.message || e}。请如实告知用户这一项没能查到，不要编造它的结论。`
      } finally {
        // 预算不在这里累加：它按 firstStartMs 起算的墙钟计（见上面的注释）。
        try { await registry.cleanup() } catch (e) { swallow(e, 'subagent-cleanup') }
        span.end(
          status === 'ok' ? 'ok' : 'warn',
          `${iterations} 轮 · ${toolCalls} 次工具调用 · 带回 ${answer.length} 字`,
        )
        // 输入/输出全文进 trace payload：审计要能回答「交给它的到底是什么、它到底带回了什么」，
        // 只有一行统计是查不出问题的（结论有没有编造、任务描述是不是传歪了，都在这两段文本里）。
        d.trace.attachIo(span.id, `小分身·${label}`, task, answer)
      }

      d.emit({
        type: 'agent_finished', runId: d.parentRunId, agentId,
        status: status === 'ok' ? 'ok' : 'error',
        summary: answer.slice(0, 500),
      })
      ctx.sendLog('observing', `小分身「${label}」回来了，带回 ${answer.length} 字`)

      // 回给父的观察：标明这是**小分身提炼过的结论**而非原始资料，让模型知道不用再把它
      // 当素材去二次检索验证（那等于把小分身的活重做一遍）。
      // 这里用「小分身」而非技术词：模型会照着上下文的措辞写叙述，用户看到的才是同一套话。
      return `【小分身「${label}」带回的调查结论】\n${answer}`
    },
  }
}
