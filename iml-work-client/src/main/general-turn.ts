// 通用任务的执行（新内核）——「注册哪些工具」取代「走哪条分支」。
//
// 阶段 2 的核心变化：调用方只需告诉这里「文件在不在场、点没点名业务系统、能不能联网」，
// 至于要不要检索、要不要读文件、先做哪步，全交给模型在循环里决定。
// 旧链路那串判断读写意图的中文正则（readIntent/entDomain/browseVerb/fileCompute）随之下线——
// 它们既漏（换个说法就不认）又危险（判错读写直接影响安全路径）。
//
// 降级：上游模型不认 function-calling 时，原样退回 agent-loop.ts 的文本 ReAct，能力不减。
//
// 依赖单向：skill-orchestrator → 本模块 → turn-engine / turn-tools / agent-tools，绝不反向。
import { ToolRegistry } from './tool-registry'
import { runAgentCore } from './agent-core'
import { makeTodoToolSpec } from './agent-core'
import { callLlmTools } from './llm'
import { runAgentLoop } from './agent-loop'
import { webTools, computeTools, fileTools, browseTools } from './core-tools'
import { makeKnowledgeTool } from './core-knowledge'
import { defaultP1Tools, defaultP2Tools, defaultP3Tools, enterpriseBrowseTools, workspaceFileList } from './agent-tools'
import { buildEphemeralContext } from './core-prompt'
import { emitToRenderer } from './window-ref'
import { runningState } from './automation-runtime'
import { swallow } from './util'
import type { AgentTaskData, AgentResult } from './agent-types'
import type { AgentTrace } from './agent-trace'
import type { SendLog } from './types'
import type { CorporateChunk } from './corporate-rag'
import type { CoreEvent, CoreMessage } from '../shared/core-protocol'

export interface GeneralTurnInput {
  data: AgentTaskData
  /** 去掉【…】标记块后的任务正文。 */
  cleanQuery: string
  sendLog: SendLog
  trace: AgentTrace
  /** 命中的已登记业务系统（决定 browse 挂哪个登录态分区）。 */
  browseSys?: { systemId: string; systemName: string; baseUrl: string } | null
  /** 是否允许联网检索（岗位授权 + 非内部系统任务）。 */
  allowWeb: boolean
  /** 工作空间是否有可读文件。 */
  hasFiles: boolean
  corporateChunks?: CorporateChunk[]
  /** 沙箱产出的文件（模型可能直接用 python 生成交付物）。 */
  onFiles?: (files: { name: string; sizeBytes: number }[]) => void
}

/** 操作内部业务系统时的额外约束——实测教训固化成规则，别让模型拿内部 URL 去公网搜。 */
export function enterpriseGuidance(systemName: string, baseUrl: string): string {
  return `【目标业务系统】${systemName}（入口 ${baseUrl}）。你**已登录**该系统（登录态已复用）。
【只用 browse 操作这个系统】这是企业内部系统，**没有也不需要联网检索**：只用 browse 一步步 goto/observe/click/read；绝不要拿内部地址去公网检索（内部 URL 搜不到，只会读到无关的公网页面）。
【看清真实数据，别只凭首页数字推测】从入口 observe 看清导航菜单，**点进对应功能的实际列表/详情页**读取真实条目再回答；不要只看门户首页的角标/汇总数字就下结论；列表长就 scroll 逐屏看清，需要计数用 python 精确数。`
}

/** 新内核的工具集：按"在场的东西"注册，不按"猜到的意图"注册。 */
function buildRegistry(i: GeneralTurnInput, onWebSources?: (s: { title: string; url: string }[]) => void): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(makeTodoToolSpec())
  registry.registerAll(computeTools(f => i.onFiles?.(f)))

  if (i.browseSys) {
    // 操作内部系统：只给 browse + python。曾经给全套工具，导致 agent 拿内部 URL 去 web_search、
    // 接口不通又退回浏览器搜索，65 步/337 秒读了一堆无关公网页（实测教训）。
    registry.registerAll(browseTools({
      partition: `persist:bizsys-${i.browseSys.systemId}`,
      systemName: i.browseSys.systemName,
      permMode: i.data.permMode || 'full',
      unattended: i.data.unattended,
      sendLog: i.sendLog,
    }))
    return registry
  }

  if (i.allowWeb) registry.registerAll(webTools(i.data.llmConfig, onWebSources))
  if (i.hasFiles) registry.registerAll(fileTools())
  // 企业知识库按需查（与联网检索是两回事：公司自己的规定只可能在这里）
  registry.register(makeKnowledgeTool(i.data.expertId || '').spec)
  // 开放网页操作（非已登记系统）：给一个无企业登录态的 browse。
  registry.registerAll(browseTools({
    permMode: i.data.permMode || 'full',
    unattended: i.data.unattended,
    sendLog: i.sendLog,
  }))
  return registry
}

/** 降级路径的工具集（文本 ReAct，与旧链路完全一致）。 */
function legacyTools(i: GeneralTurnInput) {
  if (i.browseSys) return enterpriseBrowseTools({ partition: `persist:bizsys-${i.browseSys.systemId}` })
  if (i.hasFiles) return i.allowWeb ? defaultP3Tools(i.data.llmConfig) : defaultP2Tools(i.data.llmConfig)
  return i.allowWeb ? defaultP1Tools(i.data.llmConfig) : defaultP2Tools(i.data.llmConfig)
}

function contextBlock(i: GeneralTurnInput): string {
  const parts: string[] = []
  if (i.browseSys) parts.push(enterpriseGuidance(i.browseSys.systemName, i.browseSys.baseUrl))
  if (i.corporateChunks?.length) {
    parts.push(`【企业知识库命中（可作参考）】\n${i.corporateChunks.slice(0, 3).map((c, n) => `${n + 1}. ${String(c.text || '').slice(0, 300)}`).join('\n')}`)
  }
  // 内部系统任务不灌工作空间文件清单——否则 agent 卡在登录页时会跑去 read_file 找答案（实测教训）。
  if (!i.browseSys && i.hasFiles) parts.push(`工作空间可读文件：${workspaceFileList().join('、')}`)
  return parts.join('\n\n')
}

/**
 * 跑一个通用任务。上游不支持 function-calling 时自动降级到文本 ReAct。
 */
export async function runGeneralTurn(i: GeneralTurnInput): Promise<AgentResult> {
  const kind = i.browseSys ? `业务系统操作（${i.browseSys.systemName}）` : i.hasFiles ? '含文件的多步任务' : '多步检索/计算'
  i.trace.markRoute('通用执行内核', `判定为多步任务（${kind}）：循环调用工具直至得出答案`)
  const span = i.trace.beginSpan('web', '通用执行内核', { stage: '执行' })

  if (i.browseSys) i.sendLog('thinking', `browse 复用【${i.browseSys.systemName}】本地登录态（无需重新登录）`)

  try {
    const res = await runViaTurnEngine(i)
    span.end(res.ok ? 'ok' : 'warn', res.detail)
    i.trace.attachIo(span.id, '通用执行内核', i.cleanQuery, res.transcript)
    await i.trace.submit(res.answer, res.ok ? 'SUCCESS' : 'PARTIAL', res.detail)
    i.sendLog('completed', `执行完成（${res.detail}）。`)
    return { content: res.answer, success: true, traceId: i.trace.id, ...(res.webSources ? { webSources: res.webSources } : {}) }
  } catch (e: any) {
    if (e?.name !== 'ToolsUnsupportedError') throw e
    // 上游不认工具调用 → 原样退回文本 ReAct，能力不减，只是没有结构化工具卡。
    i.sendLog('thinking', '当前模型不支持工具调用，改用兼容模式执行…')
    swallow(e, 'general-turn-fallback')
    const res = await runLegacyLoop(i)
    span.end(res.ok ? 'ok' : 'warn', res.detail)
    i.trace.attachIo(span.id, '通用执行内核（兼容模式）', i.cleanQuery, res.transcript)
    await i.trace.submit(res.answer, res.ok ? 'SUCCESS' : 'PARTIAL', res.detail)
    i.sendLog('completed', `执行完成（${res.detail}）。`)
    return { content: res.answer, success: true, traceId: i.trace.id }
  }
}

interface RunOutcome { answer: string; ok: boolean; detail: string; transcript: string; webSources?: { title: string; url: string }[] }

async function runViaTurnEngine(i: GeneralTurnInput): Promise<RunOutcome> {
  // 联网来源收集：这条路（含文件/开放网页任务）此前没接 onSources，检索了却不给来源列表
  const webSrc: { title: string; url: string }[] = []
  const registry = buildRegistry(i, (s) => webSrc.push(...s))
  const runId = i.data.convId || `run-${Date.now()}`
  const messages: CoreMessage[] = [{ role: 'user', content: i.data.content, ts: Date.now() }]

  const res = await runAgentCore({
    runId, messages, registry, cfg: i.data.llmConfig, callModel: callLlmTools,
    sendLog: i.sendLog,
    emit: (ev: CoreEvent) => emitToRenderer('turn:event', ev),
    permMode: i.data.permMode || 'full',
    unattended: i.data.unattended,
    contextProvider: () => buildEphemeralContext({
      permMode: i.data.permMode || 'full',
      unattended: i.data.unattended,
      knowledgeChunks: [],
    }) + (contextBlock(i) ? `\n\n${contextBlock(i)}` : ''),
    maxIterations: 14,
    budgetMs: 330_000,
    isCancelled: () => runningState.aborted,
  })

  const seen = new Set<string>()
  const sources = webSrc.filter(x => { if (!x.url || seen.has(x.url)) return false; seen.add(x.url); return true }).slice(0, 12)
  return {
    answer: res.answer,
    ok: res.status === 'completed',
    ...(sources.length ? { webSources: sources } : {}),
    detail: `${res.iterations} 轮 · ${res.toolCallCount} 次工具调用`,
    transcript: res.messages
      .filter(m => m.role === 'assistant' || m.role === 'tool')
      .map(m => m.role === 'tool' ? `[${m.toolName}] ${m.content}` : m.content)
      .filter(Boolean).join('\n\n'),
  }
}

async function runLegacyLoop(i: GeneralTurnInput): Promise<RunOutcome> {
  const { callLlm } = await import('./llm')
  const res = await runAgentLoop({
    task: i.cleanQuery, tools: legacyTools(i), cfg: i.data.llmConfig, sendLog: i.sendLog, callModel: callLlm,
    contextBlock: contextBlock(i) || undefined, maxSteps: 14, budgetMs: 330_000,
  })
  return {
    answer: res.answer,
    ok: res.finished,
    detail: `兼容模式 ${res.steps.length} 步`,
    transcript: res.steps.map(s => `[${s.n}] ${s.finish ? 'finish' : `${s.tool}(${JSON.stringify(s.args)})`}\n${s.observation || ''}`).join('\n\n'),
  }
}
