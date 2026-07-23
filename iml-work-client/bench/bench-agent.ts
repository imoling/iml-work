// 无头基准测试 harness：忠实复刻 main.ts 的 agent:send-message 编排
// （本体钩子 → 寒暄快路径 → 企业知识库 → 技能管线 → 诚实问答兜底），
// 经 esbuild 把 electron/db 桩掉后在纯 Node 下驱动【真实管线模块】。
// 用途：跑主流智能体测试集（SimpleQA/FRAMES/GSM8K/IFEval/多跳…），产出逐题结果 JSONL。
import fs from 'node:fs'
import path from 'node:path'

import { runInContext, getRunContext, resolvePermChoice, cancelForm, resolveDelete, abortRun } from '../src/main/automation-runtime'
import { AgentTrace } from '../src/main/agent-trace'
import { runOntologyHook } from '../src/main/agent-ontology'
import { getEnterpriseBlock, getKnowledgeScope, queryCorporateKnowledge, buildCorporateRagBlock, attachRagImages, buildKnowledgeSources } from '../src/main/corporate-rag'
import { runSkillPipeline } from '../src/main/skill-orchestrator'
import { buildHistoryBlock, rescueNetDenial, enforceFormatContract } from '../src/main/agent-steps'
import { hasExplicitFormatConstraints, FORMAT_CONTRACT_RULE } from '../src/main/output-contract'
import { isSelfContainedMath } from '../src/main/web-search-core'
import { callLlm, type LlmConfig } from '../src/main/llm'
import { extractAttachmentText, materializeHtmlAnswer } from '../src/main/workspace-files'
import { focusMentioned, renderFocusBlock } from '../src/main/focus-core'
import { memoryGet, focusRecent, focusEvents } from '../src/main/db'
import { swallow, sleep } from '../src/main/util'
import type { AgentResult } from '../src/main/agent-types'

// localhost 不走系统代理（与 eval-router 同处理）
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',')

// 进程级兜底：Playwright 常驻 chrome 在死亡瞬间可能从内部传输层抛未捕获 rejection——
// 真实 Electron 主进程不会因此退出，但 Node harness 默认会崩，一崩整批中断。这里显式吞掉续跑。
// （真实客户端对应的是 pwGet 的 isConnected 自愈；此处只是让批量测试不被单条搜索的底层抖动带崩。）
process.on('unhandledRejection', (r) => { console.error('[bench] unhandledRejection(已续跑):', String(r).slice(0, 200)) })
process.on('uncaughtException', (e) => { console.error('[bench] uncaughtException(已续跑):', String(e).slice(0, 200)) })

interface LogEntry { type: string; text: string; timestamp: string; atMs: number }
interface TaskItem { id: string; benchmark: string; question: string; gold?: string; meta?: Record<string, unknown> }
interface BenchRecord {
  id: string; benchmark: string; question: string; gold?: string
  answer: string; success: boolean; ms: number; timedOut: boolean; error?: string
  traceId?: string; files?: { name: string; sizeBytes: number }[]
  webSources?: { title: string; url: string }[]
  logs: { type: string; text: string; atMs: number }[]
  llmCalls?: number; route?: string
}

const cfg: LlmConfig = {
  mode: 'proxy', apiMode: 'chat',
  baseUrl: (process.env.BENCH_ADMIN_BASE || 'http://localhost:8080') + '/api/v1/model',
  apiKey: process.env.BENCH_CORP_KEY || 'sk-corp-default-key',
  modelName: process.env.BENCH_MODEL || 'corp-default',
}
const EXPERT_ID = process.env.BENCH_EXPERT_ID || 'expert-1781625723384'
const EXPERT_NAME = process.env.BENCH_EXPERT_NAME || '销售'
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 420000)
const CONC = Number(process.env.BENCH_CONC || 3)

// ── main.ts handler 的忠实复刻（去掉渲染层广播，其余逐行同构） ────────────────
async function runAgentTask(content: string, convId: string, sendLog: (t: string, x: string) => void): Promise<AgentResult> {
  const data = {
    content, expertId: EXPERT_ID, expertName: EXPERT_NAME, userNickname: '康Sir',
    background: '销售部员工，负责客户跟进与业绩达成', llmConfig: cfg,
    permMode: 'readonly' as const, history: [] as { role: 'user' | 'assistant'; content: string }[],
    convId, histTotal: 0,
  }
  const runId = convId

  return runInContext(runId, async () => {
    const expertId = data.expertId || ''
    const userNickname = data.userNickname || '用户'
    sendLog('thinking', '正在理解你的任务…')
    const trace = new AgentTrace(data as never, expertId, userNickname)

    const NO_FABRICATION_RULE = `【重要 · 真实性边界】
你本身无法访问任何外部系统、邮箱、OA、CRM、ERP、数据库或任何实时/私有业务数据。除非下文明确给出了"真实技能执行结果 / 真实页面抓取内容"，否则你并不掌握用户的任何真实邮件、待办、审批单、报销单、订单、人员或金额数据。
当用户要求查看 / 获取 / 统计这类真实业务数据，而你手头只有静态知识、并无实际执行结果时，你必须如实说明你无法直接获取，并简要给出下一步建议：① 在「企业技能中心」为该需求配置对应技能并绑定目标业务系统；② 在「设置 → 企业系统连接」登录对应系统后重试。
严禁编造任何邮件、待办、条目、姓名、金额、日期、单号或任何不存在的业务数据；不要为了"显得完成了任务"而虚构结果。`

    // 寒暄快路径判定（与 main.ts 同构：先算，决定要不要预取知识库）
    const TRIVIAL_TOKEN = /^(你好|您好|hi|hello|嗨|哈喽|在吗|在不在|你是谁|你是什么|你能干什么|你能做什么|你会什么|你能做些什么|介绍下自己|介绍一下自己|自我介绍|谢谢|多谢|辛苦了|早上好|中午好|下午好|晚上好|早安|晚安|好的|收到|ok|再见|拜拜)$/i
    const trivialSegs = data.content.trim().split(/[\s,，。.!！?？~～、;；]+/).filter(Boolean)
    const trivialMsg = data.content.trim().length <= 16 && trivialSegs.length > 0 && trivialSegs.every(s => TRIVIAL_TOKEN.test(s))

    // === 企业知识库检索与本体钩子【并行】（与 main.ts 同构）===
    let kbSpan: { id: string; end: (status?: string, detail?: string) => void } | null = null
    const kbPromise: Promise<Awaited<ReturnType<typeof queryCorporateKnowledge>>> = trivialMsg
      ? Promise.resolve([])
      : (() => {
          sendLog('thinking', `先查一下企业知识库有没有相关资料…`)
          kbSpan = trace.beginSpan('kb', '企业知识库检索', { stage: '检索' })
          return queryCorporateKnowledge(data.content, expertId).catch((e) => { swallow(e, 'kb-query'); return [] })
        })()

    // === 本体层钩子 ===
    {
      const ontoRes = await runOntologyHook(data as never, sendLog as never, trace)
      if (ontoRes) return ontoRes
    }

    const corporateChunks: Awaited<ReturnType<typeof queryCorporateKnowledge>> = await kbPromise
    if (trivialMsg) {
      sendLog('thinking', '寒暄消息，直接回复…')
      trace.markRoute('寒暄', '命中寒暄快路径：跳过知识库检索与技能管线，带人设直接短答')
    } else {
      kbSpan?.end('ok', corporateChunks.length ? `命中 ${corporateChunks.length} 条相关资料` : '未命中相关资料')
      if (corporateChunks.length) sendLog('thinking', `企业知识库命中 ${corporateChunks.length} 条相关资料，已并入参考。`)
    }

    // --- 技能管线（路由/编排/联网检索兜底）---
    if (!trivialMsg) {
      const skillRes = await runSkillPipeline(data as never, sendLog as never, trace, { corporateChunks })
      if (skillRes) return skillRes
    }

    // --- 诚实问答兜底（与 main.ts 同构）---
    {
      sendLog('thinking', `先回忆下你的习惯和岗位经验…`)
      await sleep(200)
      let personalMemoryList = ''
      let agentSopList = ''
      if (expertId) {
        try {
          const personalStr = memoryGet(expertId, 'personal')
          if (personalStr) { const parsed = JSON.parse(personalStr); if (Array.isArray(parsed)) personalMemoryList = parsed.map((m: { content: string }) => `▸ ${m.content}`).join('\n') }
        } catch (e) { swallow(e) }
        try {
          const agentStr = memoryGet(expertId, 'agent')
          if (agentStr) { const parsed = JSON.parse(agentStr); if (Array.isArray(parsed)) agentSopList = parsed.map((m: { content: string }) => `▸ ${m.content}`).join('\n') }
        } catch (e) { swallow(e) }
      }
      if (!personalMemoryList) personalMemoryList = `（暂无沉淀的个人习惯记忆）`
      if (!agentSopList) agentSopList = `（暂无岗位预置 SOP，按通用岗位常识与下方企业知识作答）`
      await sleep(200)

      sendLog('thinking', `使用模型：${cfg.modelName}（企业模型网关）`)
      sendLog('acting', `正在把信息整理给模型，生成回复…`)

      const kbScope = getKnowledgeScope(expertId)
      const kbScopeLine = kbScope.length ? `\n- 本岗位云端知识库检索范围（由管理端领用下发）：${kbScope.join('、')}` : ''

      let focusBlock = ''
      try {
        const rows = focusRecent(expertId, undefined, 20)
        const hit = focusMentioned(data.content, rows)
        const blocks = hit.map(f => renderFocusBlock(f.displayName, f.lastState, focusEvents(f.id, 5), f.profileSummary)).filter(Boolean)
        if (blocks.length) focusBlock = `\n\n${blocks.join('\n\n')}`
      } catch (e) { swallow(e, 'focus-inject') }

      const corporateRagBlock = buildCorporateRagBlock(corporateChunks)
      const enterpriseBlock = await getEnterpriseBlock()
      const attachmentText = await extractAttachmentText(data.content, sendLog as never)
      const attachmentSection = attachmentText ? `\n\n【附件真实内容】（已从工作空间解析，请基于此作答，勿编造）\n${attachmentText}` : ''
      const historyBlock = await buildHistoryBlock(data.history, cfg, data.convId, data.histTotal)
      const promptWithContext = `[系统指令/System Prompt]
你是一个岗位专家智能体助手。
你的名字（岗位名称）是：${data.expertName}
你对用户的称呼是：${userNickname}
【当前日期时间】${new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}（系统实时，回答日期/时间相关问题一律以此为准，不要臆测）
${historyBlock}
${NO_FABRICATION_RULE}

【岗位预置知识与SOP】
${agentSopList}

【用户个人信息与习惯】
- 岗位背景：${data.background}
- 用户称呼：${userNickname}
${personalMemoryList}

【企业知识与规则】（由管理端统一维护）
${enterpriseBlock}${kbScopeLine}${corporateRagBlock}${focusBlock}${attachmentSection}
${hasExplicitFormatConstraints(data.content) ? FORMAT_CONTRACT_RULE + '\n' : ''}${isSelfContainedMath(data.content) ? '\n【计算题作答规范】最终答案给出一个明确数值，并按题目语境的自然精度表述：数量/人数/金额/年龄等离散量给整数；出现分数或无限小数时换算为十进制并按语境取整或保留合理位数（可另附精确形式）。答案单独成行，如「**答案：36**」。\n' : ''}
[当前指令/User Instruction]
请基于上述静态知识与用户背景进行回答或分析，称呼用户为“${userNickname}”。务必遵守上面的【真实性边界】：若该指令需要的是你无法获取的真实业务数据（如未读邮件、待办、单据等），请如实说明并给出下一步建议，绝不要编造。若上方提供了【附件真实内容】，请基于该真实文本进行分析：
【通用问题服务纪律】岗位名称只用于称呼与业务侧重，**不构成拒答依据**。用户问到岗位之外的通用知识、常识问题，或提出通用写作/改写/翻译/计算类任务时，照常尽力完成（知识型回答可注明"属通用常识，供参考"）；**禁止**以"不在我的岗位职责/知识库范围"为由拒绝或只给一句"建议咨询他人"。确实没把握时如实说不确定，并主动提出"如需要我可以帮你联网查证"——**绝不**让用户"自行去搜索引擎/其他平台查"。
"${data.content}"`

      let content = ''
      let qaWebSources: { title: string; url: string }[] = []
      try {
        content = await callLlm(promptWithContext, cfg, { longRunning: true })
        content = attachRagImages(content, corporateChunks)
        sendLog('observing', `[LLM Response] 成功接收大模型响应内容。`)
        // 能力否认自救（与 main.ts 问答兜底同构）
        const rescued = await rescueNetDenial(content, promptWithContext, data as never, corporateChunks, sendLog as never, trace)
        if (rescued) { content = rescued.content; qaWebSources = rescued.webSources }
        // 输出契约生成后校验（与 main.ts 问答兜底同构）
        content = await enforceFormatContract(content, data as never, sendLog as never)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        sendLog('observing', `[LLM Error] 网络请求失败: ${msg}`)
        content = `【大模型连接失败】\n\n错误信息: ${msg}`
      }
      const materialized = materializeHtmlAnswer(content)
      content = materialized.content
      sendLog('completed', `[Completed] 问答完毕。`)
      await trace.submit(content, 'SUCCESS',
        `目标：回答用户问题。${trace.webSearch ? '判定需联网→检索→综合作答；' : '基于岗位知识与上下文作答；'}遵守真实性边界，未编造数据。（bench）`)
      return { content, success: true, sources: buildKnowledgeSources(corporateChunks), files: materialized.files,
        ...(qaWebSources.length ? { webSources: qaWebSources } : {}) }
    }
  })
}

// ── 挂起确认的自动应答：只读闸选「继续」、表单/删除确认一律取消（安全侧） ──
function startAutoResponder(runId: string): () => void {
  const t = setInterval(() => {
    const c = getRunContext(runId)
    if (!c) return
    if (c.permChoiceResolve) resolvePermChoice(runId, 'continue')
    if (c.isFormPending) cancelForm(runId)
    if (c.isDeletePending) resolveDelete(runId, false)
  }, 1500)
  return () => clearInterval(t)
}

async function runOne(item: TaskItem): Promise<BenchRecord> {
  const t0 = Date.now()
  const logs: LogEntry[] = []
  const sendLog = (type: string, text: string) => { logs.push({ type, text, timestamp: new Date().toLocaleTimeString(), atMs: Date.now() - t0 }) }
  const runId = `bench-${item.benchmark}-${item.id}`
  const stopResponder = startAutoResponder(runId)
  let timedOut = false
  try {
    const res = await Promise.race([
      runAgentTask(item.question, runId, sendLog),
      (async () => { await sleep(TIMEOUT_MS); timedOut = true; abortRun(runId); await sleep(3000); return null })(),
    ])
    const routeLog = logs.find(l => /命中|路由|判定|识别/.test(l.text))
    return {
      id: item.id, benchmark: item.benchmark, question: item.question, gold: item.gold,
      answer: res?.content ?? '', success: !!res?.success && !timedOut, ms: Date.now() - t0, timedOut,
      traceId: (res as { traceId?: string } | null)?.traceId, files: res?.files, webSources: (res as { webSources?: { title: string; url: string }[] } | null)?.webSources,
      logs: logs.map(l => ({ type: l.type, text: l.text.slice(0, 300), atMs: l.atMs })),
      route: routeLog?.text.slice(0, 120),
    }
  } catch (err) {
    return {
      id: item.id, benchmark: item.benchmark, question: item.question, gold: item.gold,
      answer: '', success: false, ms: Date.now() - t0, timedOut,
      error: err instanceof Error ? (err.stack || err.message) : String(err),
      logs: logs.map(l => ({ type: l.type, text: l.text.slice(0, 300), atMs: l.atMs })),
    }
  } finally {
    stopResponder()
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
  const tasksFile = get('--tasks')
  const outFile = get('--out')
  if (!tasksFile || !outFile) { console.error('用法: bench-agent --tasks tasks.jsonl --out results.jsonl'); process.exit(2) }

  const items: TaskItem[] = fs.readFileSync(tasksFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const done = new Set<string>()
  if (fs.existsSync(outFile)) {
    for (const l of fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean)) {
      try { const r = JSON.parse(l); done.add(r.benchmark + '/' + r.id) } catch { /* 跳过坏行 */ }
    }
  }
  const todo = items.filter(i => !done.has(i.benchmark + '/' + i.id))
  console.log(`[bench] 共 ${items.length} 题，已完成 ${done.size}，待跑 ${todo.length}，并发 ${CONC}，单题超时 ${TIMEOUT_MS / 1000}s`)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })

  let next = 0
  let finished = 0
  const workers = Array.from({ length: Math.min(CONC, todo.length) }, async (_, w) => {
    while (next < todo.length) {
      const i = next++
      const item = todo[i]
      console.log(`[bench][w${w}] ▶ ${item.benchmark}/${item.id}: ${item.question.slice(0, 60).replace(/\n/g, ' ')}`)
      const rec = await runOne(item)
      fs.appendFileSync(outFile, JSON.stringify(rec) + '\n')
      finished++
      console.log(`[bench][w${w}] ✔ ${item.benchmark}/${item.id} ${rec.timedOut ? '⏱超时' : rec.error ? '✗异常' : 'ok'} ${(rec.ms / 1000).toFixed(1)}s (${finished}/${todo.length})`)
    }
  })
  await Promise.all(workers)
  console.log('[bench] 全部完成')
  process.exit(0)
}

main().catch(e => { console.error('[bench] 致命错误', e); process.exit(1) })
