// agent 子流程：对话上文块、「记住」意图落地个人记忆、「定时」意图落地自动化任务、
// 技能结果 → 记忆/知识库融合 → LLM 合成最终答复。纯搬迁自 main.ts，不改逻辑。
import { memoryGet, memorySet, schedUpsert, configGet, configSet } from './db'
import { type Turn, clipTurn, chooseVerbatimStart, buildSummaryMergePrompt } from './context-core'
import { type LlmConfig, callLlm } from './llm'
import { swallow } from './util'
import { emitToRenderer } from './window-ref'
import { currentUsage } from './automation-runtime'
import { getEnterpriseBlock, getKnowledgeScope, queryCorporateKnowledge, buildCorporateRagBlock, attachRagImages, buildKnowledgeSources, type CorporateChunk } from './corporate-rag'
import { webSearch, refineSearchQuery, getExpertWebSearch } from './web-search'
import { deniesNetworkAccess } from './web-search-core'
import { hasExplicitFormatConstraints, FORMAT_CONTRACT_RULE, collectFormatViolations, buildFormatRewritePrompt } from './output-contract'
import { AgentTrace } from './agent-trace'
import type { AgentTaskData, AgentResult } from './agent-types'
import { type SendLog } from './types'

// 逐字窗口 **token 预算**（估算值）：短轮多带几轮、长轮少带几轮，单轮巨贴不再按"轮数"失真。
const VERBATIM_BUDGET = 3000
const MIN_RECENT_TURNS = 4        // 预算再紧也至少逐字保留的最近轮数（承接指代）
const SUMMARY_STEP = 4            // 折叠边界对齐步长：每 STEP 轮才推进一次 → 摘要合并调用低频
const TURN_CAP = 400              // 单轮字符截断（头尾保留式）；最近一条给大预算（承接性最强）
const LAST_TURN_CAP = 1200

/** 会话级持久摘要的 KV 键（本地库 config 表，按账号分库天然隔离；跨重启保留）。 */
const ctxSumKey = (convId: string) => 'ctx-sum:' + convId
interface CtxSum { summary: string; upto: number }   // upto=已折叠进摘要的**绝对**轮数（会话全程计）

export function ctxSumGet(convId: string): CtxSum {
  try {
    const raw = configGet(ctxSumKey(convId))
    if (raw) { const p = JSON.parse(raw); if (p && typeof p.summary === 'string' && typeof p.upto === 'number') return p }
  } catch (e) { swallow(e, 'ctx-sum-read') }
  return { summary: '', upto: 0 }
}

export function ctxSumSet(convId: string, sum: CtxSum): void {
  try { configSet(ctxSumKey(convId), JSON.stringify(sum)) } catch (e) { swallow(e, 'ctx-sum-write') }
}

/**
 * 拼装对话上文块（async）：逐字窗口按 token 预算选取，窗口外轮次**滚动折叠**进会话级持久摘要
 * （增量合并：旧要点+新轮次→新要点，成本恒定与会话总长无关；落本地库，跨重启保留）。
 * 渲染层只送最近 ~50 轮窗口，但折叠发生在轮次仍在窗口内时（预算窗口 ≪ 50）——
 * 50 轮之外的内容早已并入摘要滚动携带，**不再彻底丢失**。
 * histTotal=会话全程轮数（含窗口外），用于把窗口下标换算成绝对轮数；缺省视为无窗口截断。
 * convId 缺省（定时任务等）→ 无处持久化，退化为纯预算窗口截断。
 */
export async function buildHistoryBlock(history?: Turn[], cfg?: LlmConfig, convId?: string, histTotal?: number): Promise<string> {
  if (!history || !history.length) return ''
  const offset = Math.max(0, (histTotal ?? history.length) - history.length)   // 窗口首条的绝对轮号
  let sum: CtxSum = convId ? ctxSumGet(convId) : { summary: '', upto: 0 }
  const floorIdx = Math.min(history.length, Math.max(0, sum.upto - offset))    // 已折叠边界（窗口相对）
  const startRel = chooseVerbatimStart(history, {
    budget: VERBATIM_BUDGET, minTurns: MIN_RECENT_TURNS, step: SUMMARY_STEP,
    floorIdx, cap: TURN_CAP, lastCap: LAST_TURN_CAP
  })
  const cfgOk = !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)

  let vStart = floorIdx
  if (startRel > floorIdx) {
    if (convId && cfgOk) {
      // 滚动折叠：把 [floorIdx, startRel) 增量并入持久摘要。失败则本轮不推进边界——
      // 这些轮次仍留在逐字窗口里（不丢），下轮再试。
      try {
        const merged = (await callLlm(buildSummaryMergePrompt(sum.summary, history.slice(floorIdx, startRel)), cfg!, { temperature: 0 })).trim()
        if (merged && merged !== '（无）') sum.summary = merged
        sum.upto = offset + startRel
        ctxSumSet(convId, sum)
        vStart = startRel
      } catch (e) { swallow(e, 'ctx-fold') }
    } else {
      vStart = startRel   // 无会话id/无模型配置：无处折叠，超预算部分按窗口截断（如实丢弃）
    }
  }

  const recent = history.slice(vStart)
  const lines = recent.map((h, idx) =>
    `${h.role === 'user' ? '用户' : '分身'}：${clipTurn(h.content || '', idx === recent.length - 1 ? LAST_TURN_CAP : TURN_CAP)}`
  ).join('\n')

  const summaryBlock = sum.summary
    ? `\n【更早对话要点（本会话早前轮次的摘要，可作为已知事实引用）】\n${sum.summary}\n`
    : ''
  return `${summaryBlock}\n【对话上文（本次会话最近几轮，用于理解指代与延续话题；其中用户提供的信息可直接引用作答，勿复述整段。若用户本轮只是简短确认——如同意、认可、让你继续——指的就是分身上一条消息末尾提出的提议/待办，应直接着手执行该提议，而不是再次询问需求）】\n${lines}\n`
}

// 「记住/记下 X」意图：把用户要记的信息提炼成简短事实，追加进个人长期记忆（本地 SQLite，按岗位隔离），
// 之后每次对话自动注入 System Prompt。命中即短路返回确认（不再走技能/联网）。模型异常则如实告知未记住。
const REMEMBER_INTENT = /(记住|记一下|记下|记录一下|帮我记|存一下|记到|备忘|以后记得|请记得)/
export async function runMemoryWrite(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult | null> {
  const expertId = data.expertId || ''
  if (!expertId || !REMEMBER_INTENT.test(data.content)) return null
  sendLog('thinking', '识别到"记住"意图，正在提炼要长期记忆的信息…')
  const prompt = `用户希望分身长期记住一些个人信息/偏好。请从下面这句话里提炼出需要记住的**事实**，每条一行、简短陈述句（含关键要素如日期/名称/偏好），不要解释、不要编号。若确实没有可长期记忆的个人事实则输出 NONE。\n\n【用户的话】\n${data.content}\n\n只输出事实（每行一条）或 NONE：`
  let facts: string[] = []
  try {
    const out = await callLlm(prompt, data.llmConfig, { temperature: 0 })
    facts = (out || '').split('\n').map(l => l.replace(/^[-*\d.、\s]+/, '').trim()).filter(l => l && l !== 'NONE' && l.length <= 200)
  } catch (e) { swallow(e, 'memory-extract') }
  if (!facts.length) return null   // 提炼失败 → 回退正常对话流

  // 读旧记忆 → 去重追加 → 存回（结构与记忆面板一致：{id,content,timestamp}）
  let list: { id: string; content: string; timestamp: string }[] = []
  try { const raw = memoryGet(expertId, 'personal'); if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) list = p } } catch (e) { swallow(e) }
  const existing = new Set(list.map(x => (x.content || '').trim()))
  const added: string[] = []
  const ts = new Date().toLocaleString('zh-CN', { hour12: false })
  for (const f of facts) if (!existing.has(f)) { list.unshift({ id: `fact-${Date.now()}-${added.length}`, content: f, timestamp: ts }); added.push(f) }
  try { memorySet(expertId, 'personal', JSON.stringify(list)) } catch (e) { swallow(e) }

  const body = added.length
    ? `好的康Sir，我已经记住了：\n${added.map(f => `· ${f}`).join('\n')}\n\n这些会长期保存在你的个人记忆里，以后每次对话我都会自动带上。你也可以在「设置 → 资料与记忆」里查看或删除。`
    : `这些信息我之前已经记过了，无需重复。你可以在「设置 → 资料与记忆」里查看。`
  sendLog('completed', `已写入个人长期记忆 ${added.length} 条`)
  trace.spans.push({ type: 'memory', name: `写入个人记忆·${added.length} 条`, status: 'ok' })
  await trace.submit(body, 'SUCCESS', `识别"记住"意图，提炼并写入个人长期记忆 ${added.length} 条。`)
  return { content: body, success: true, traceId: trace.id }
}

// 「每天/每周…定时做某事」意图：解析成定时任务并入库（本地调度器到点自动跑该 prompt），命中即短路确认。
// 覆盖"每天9点总结AI新闻""每个工作日下午5点提醒我写日报"等——把口语指令直接变成自动化任务。
const SCHEDULE_INTENT = /(每天|每日|每周|每星期|每个?工作日|工作日每|每月|定时|以后每天|每隔|定期)/
export async function runScheduleCreate(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult | null> {
  const expertId = data.expertId || ''
  if (!expertId || !SCHEDULE_INTENT.test(data.content)) return null
  sendLog('thinking', '识别到"定时/周期"意图，正在解析成自动化任务…')
  const prompt = `用户想设置一个周期性自动任务。请从下面这句话解析出定时任务参数，输出严格 JSON（不要解释、不要代码块标记）：\n{"title":"简短任务名","prompt":"到点要执行的完整指令（第一人称祈使句，如：总结最新的AI新闻并给我一份摘要）","freq":"daily|weekday|weekly|monthly","time":"HH:MM(24小时)","dow":0-6周日到周六(仅weekly用),"dom":1-28(仅monthly用)}\n规则：\n- "每天"→daily；"每个工作日/工作日"→weekday；"每周X"→weekly+dow；"每月X号"→monthly+dom。\n- 时间转 24 小时 HH:MM（"9点/早上9点"→09:00，"下午5点"→17:00）；没说时间默认 09:00。\n- 若这句话其实不是要设周期任务，输出 {"freq":"none"}。\n\n【用户的话】\n${data.content}\n\n只输出 JSON：`
  let parsed: any = null
  try {
    const out = await callLlm(prompt, data.llmConfig, { temperature: 0 })
    const m = out.match(/\{[\s\S]*\}/)
    if (m) parsed = JSON.parse(m[0])
  } catch (e) { swallow(e, 'schedule-parse') }
  if (!parsed || parsed.freq === 'none' || !['daily', 'weekday', 'weekly', 'monthly'].includes(parsed.freq)) return null

  const time = /^\d{1,2}:\d{2}$/.test(String(parsed.time || '')) ? String(parsed.time).padStart(5, '0') : '09:00'
  const task = {
    id: 'sch-' + Date.now(),
    title: String(parsed.title || '定时任务').slice(0, 40),
    prompt: String(parsed.prompt || data.content).slice(0, 500),
    expertId, expertName: data.expertName || '',
    freq: parsed.freq as 'daily' | 'weekday' | 'weekly' | 'monthly',
    time,
    dow: Number.isInteger(parsed.dow) ? Math.max(0, Math.min(6, parsed.dow)) : 1,
    dom: Number.isInteger(parsed.dom) ? Math.max(1, Math.min(28, parsed.dom)) : 1,
    enabled: true,
  }
  try { schedUpsert(task) } catch (e) { swallow(e, 'schedule-save') }
  emitToRenderer('schedule:changed')   // 通知自动化页刷新

  const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const when = task.freq === 'daily' ? `每天 ${task.time}`
    : task.freq === 'weekday' ? `每个工作日 ${task.time}`
    : task.freq === 'weekly' ? `每${DOW[task.dow]} ${task.time}`
    : `每月 ${task.dom} 日 ${task.time}`
  const body = `好的康Sir，已为你创建定时任务「**${task.title}**」：\n· 触发：**${when}**\n· 到点自动执行：${task.prompt}\n\n任务已开启，可在左侧「自动化」里查看 / 编辑 / 暂停 / 立即执行。到点我会自动跑并给你结果。`
  sendLog('completed', `已创建定时任务：${when}`)
  trace.spans.push({ type: 'schedule', name: `创建定时任务·${when}`, status: 'ok' })
  await trace.submit(body, 'SUCCESS', `识别"定时"意图，创建周期任务（${when}）。`)
  return { content: body, success: true, traceId: trace.id }
}

/**
 * 能力否认自救（问答兜底与技能合成**共用**）：草稿自称"无法联网/无法获取实时信息"，但本轮
 * 其实没检索、且岗位有联网权限 → 补一次真实检索并重答。返回 null = 无需自救或自救失败（沿用原草稿）。
 * 从 synthesizeSkillAnswer 内联抽出——曾只挂技能管线，main.ts 问答兜底裸奔：
 * 基准实测 16 题当着用户自称"无法联网"，无一被自救（2026-07）。
 */
export async function rescueNetDenial(content: string, basePrompt: string, data: AgentTaskData,
  corporateChunks: CorporateChunk[], sendLog: SendLog, trace: AgentTrace):
  Promise<{ content: string; webSources: { title: string; url: string }[] } | null> {
  if (trace.webSearch || !deniesNetworkAccess(content)) return null
  const cfg = data.llmConfig
  try {
    if (!(await getExpertWebSearch(data.expertId || ''))) return null
    sendLog('thinking', '草稿声称无法联网——本系统具备联网检索，先取回真实资料再重新作答…')
    const sq = await refineSearchQuery(data.content, cfg, sendLog)
    const r = await webSearch(sq, sendLog, cfg)
    if (!r.results.length) return null
    trace.webSearch = true
    trace.spans.push({ type: 'web', name: `补救联网检索·${sq}`, status: 'ok', detail: `${r.results.length} 条结果 · 深读 ${r.pages.length} 篇（草稿声称无法联网，触发自救重答）` })
    trace.sources.push(...r.results.map(x => ({ title: x.title, url: x.url })))
    const readUrls = new Set(r.pages.map(p => p.url))
    const webSources = [...r.pages.map(p => ({ title: p.title || p.url, url: p.url })),
      ...r.results.filter(x => !readUrls.has(x.url)).map(x => ({ title: x.title || x.url, url: x.url }))].slice(0, 8)
    const lines = r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
    const pageBlocks = r.pages.map(p => `【来源：${p.title}｜${p.url}】\n${p.text}`).join('\n\n')
    const rescuePrompt = `${basePrompt}\n\n【补救联网检索的真实结果】系统刚已联网检索「${sq}」：\n— 结果列表 —\n${lines}\n\n— 头部网页正文 —\n${pageBlocks || '（未提取到正文，仅有摘要）'}\n\n【重答要求】你此前的草稿声称"无法联网/无法获取实时信息"——这是错误的，系统具备联网检索且刚已完成。请基于以上真实素材重新回答用户，遵守前述时间与信源纪律；素材覆盖不到的部分一句话坦承，**绝不要再出现"无法联网/无法访问网络"之类的说法**。`
    const redone = attachRagImages(await callLlm(rescuePrompt, cfg, { longRunning: true }), corporateChunks)
    return { content: redone, webSources }
  } catch (e) { swallow(e, 'net-denial-rescue'); return null }
}

/**
 * 输出契约生成后校验（问答兜底与技能合成共用）：用户带显式格式约束时，对回答做**确定性**校验，
 * 检出违规则带具体违规点重写一次（与 rescueNetDenial 同构：检测缺陷→定向重答一次）。
 * 无约束/无违规/重写后仍违规都返回原文（重写只做一轮，不无限纠缠）。
 */
export async function enforceFormatContract(content: string, data: AgentTaskData, sendLog: SendLog): Promise<string> {
  if (!hasExplicitFormatConstraints(data.content)) return content
  const violations = collectFormatViolations(data.content, content)
  if (!violations.length) return content
  const cfg = data.llmConfig
  if (!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)) return content
  try {
    sendLog('observing', `回答未满足格式要求（${violations.join('；')}），正在按要求修正…`)
    const fixed = (await callLlm(buildFormatRewritePrompt(data.content, content, violations), cfg, { longRunning: true })).trim()
    // 重写后再校验一次：仍违规则取"违规更少"的那版（不回退到更差的）
    if (fixed && collectFormatViolations(data.content, fixed).length <= violations.length) return fixed
    return content
  } catch (e) { swallow(e, 'format-rewrite'); return content }
}

export async function synthesizeSkillAnswer(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace, sk: { skillResult: string; skillPromptHint: string; skillFiles?: { name: string; sizeBytes: number }[]; webSources?: { title: string; url: string }[]; corporateChunks?: CorporateChunk[] }): Promise<AgentResult> {
  const expertId = data.expertId || ''
  const userNickname = data.userNickname || '用户'
  const { skillResult, skillPromptHint } = sk
    sendLog('thinking', `信息都拿到了，正在帮你整理成回复…`)
    const cfg = data.llmConfig
    const isConfigComplete = cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName

    if (!isConfigComplete) {
      sendLog('observing', `⚠️ 未检测到有效大模型配置。将绕过 LLM 润色，直接以本地沙箱执行结果返回呈现。`)
      sendLog('completed', `[Completed] 本地技能直通测试完毕。`)
      return {
        content: `💡 **[本地技能直通测试模式]**\n您当前未配置有效的大模型（或已关闭连接）。以下为本地 Node.js / Electron 引擎执行该技能的真实返回结果：\n\n---\n\n${skillResult}`,
        success: true, traceId: trace.id, files: sk.skillFiles
      }
    }

    // Retrieve memories from SQLite for context integration
    sendLog('thinking', '先回忆下你的习惯和岗位经验…')
    let personalMemoryList = ''
    let agentSopList = ''
    if (expertId) {
      try {
        const personalStr = memoryGet(expertId, 'personal')
        if (personalStr) {
          const parsed = JSON.parse(personalStr)
          if (Array.isArray(parsed)) {
            personalMemoryList = parsed.map((m: any) => `▸ ${m.content}`).join('\n')
          }
        }
      } catch (e) { swallow(e) }
      try {
        const agentStr = memoryGet(expertId, 'agent')
        if (agentStr) {
          const parsed = JSON.parse(agentStr)
          if (Array.isArray(parsed)) {
            agentSopList = parsed.map((m: any) => `▸ ${m.content}`).join('\n')
          }
        }
      } catch (e) { swallow(e) }
    }

    // 记忆为空就如实为空——绝不注入编造的「用户习惯/岗位 SOP」，否则模型会当事实引用（违反真实性红线）。
    if (!personalMemoryList) personalMemoryList = `（暂无沉淀的个人习惯记忆）`
    if (!agentSopList) agentSopList = `（暂无岗位预置 SOP，按通用岗位常识与下方企业知识作答）`

    const kbScope = getKnowledgeScope(expertId)
    const kbScopeLine = kbScope.length
      ? `\n- 本岗位云端知识库检索范围（由管理端领用下发）：${kbScope.join('、')}`
      : ''

    // 制度检索**复用管线开头查过的结果**(单轮一次即可,一次 15s+;曾开头查一遍、收尾又查一遍,
    // 同一句话两次相同检索纯属浪费还拖慢回复)。调用方没传时才现查(独立入口兜底)。
    let corporateChunks: CorporateChunk[]
    if (sk.corporateChunks) {
      corporateChunks = sk.corporateChunks
    } else {
      // 叙述同 main.ts：查的是企业知识库（不只制度），未命中静默（无关任务下播报"没查到制度"很怪）
      sendLog('thinking', `先查一下企业知识库有没有相关资料…`)
      corporateChunks = await queryCorporateKnowledge(data.content, expertId)
      if (corporateChunks.length) sendLog('thinking', `企业知识库命中 ${corporateChunks.length} 条相关资料，已并入参考。`)
    }
    const corporateRagBlock = buildCorporateRagBlock(corporateChunks)
    const enterpriseBlock = await getEnterpriseBlock()
    const historyBlock = await buildHistoryBlock(data.history, cfg, data.convId, data.histTotal)

    const promptWithContext = `[系统指令/System Prompt]
你是一个岗位专家智能体助手。
你的名字（岗位名称）是：${data.expertName}
你对用户的称呼是：${userNickname}
【当前日期时间】${new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}（系统实时，回答日期/时间相关问题一律以此为准，不要臆测）
${historyBlock}
【岗位预置知识与SOP】
${agentSopList}

【用户个人信息与习惯】
- 岗位背景：${data.background}
- 用户称呼：${userNickname}
${personalMemoryList}

【企业知识与规则】（由管理端统一维护）
${enterpriseBlock}${kbScopeLine}${corporateRagBlock}

【本地真实技能执行数据】
${skillPromptHint || '（本轮未执行任何技能，也未访问任何业务系统——没有任何执行结果）'}

[当前指令/User Instruction]
请严格、且仅依据上述【本地真实技能执行数据】作答：
- 若其中是真实抓取/执行结果，则以你自己完成了该技能的口吻如实汇报；
- 若其中说明"技能未执行 / 需登录 / 执行失败 / 目标系统不可用"，你必须如实转达该情况并给出下一步建议（例如先在弹出的系统窗口登录后重试），不得给出任何看似完成的结论；
- **【本轮未执行任何技能】时的铁律**：本轮你没有连接、打开或操作过任何业务系统，没有提交/审批/录入/修改过任何数据。**绝对禁止**声称"已提交""已审批通过""已代为处理""状态已更新"之类**任何已完成写操作的结论**——哪怕上文里你自己说过"回复同意我就去执行"、哪怕用户刚回了"同意/确认/提交"。此时正确做法是：如实说明尚未实际执行，并**明确请用户把要执行的操作说清楚**（例如"请说'在 OA 里通过王磊的差旅审批 CL-2026-0007'"），由技能真正去系统里执行。
- 严禁编造任何上述数据中不存在的待办、条目、发起人、单号、数字或结果。
- **事实前提零编造（红线）**：已发生的事实——赛果、比分、对阵/晋级双方、获胜方、点位、成交额、单号、人名、日期——只能来自上述真实素材；素材里没有就直说"未查到真实的XX"，**绝不自行填充或凭常识猜测**。事实是回答的前提，编错前提会让整段回答沦为虚构（实锤：世界杯决赛对阵双方、小组赛比分被整段编造成"已知赛况回顾"）。
- **"模拟/推演/预测"的边界**：用户明确要"模拟/推演/预测/展望"时可以做，但必须①建立在素材里**真实存在**的事实之上（如真实晋级的球队、真实公布的数据），②通篇显式标注"以下为推演/预测，非真实结果"，**绝不把推演写进"已知/赛况回顾/截至X日"这类事实段落冒充真相**；③真实事实前提缺失时（如查不到真实对阵双方），先如实说明"未查到真实的XX"，绝不拿臆造前提往下推演。
- **人员名单也是事实（哈兰德红线）**：球队名单/首发/与会人员的**人名与归属**只能来自素材；素材没有某方名单时，如实写"素材未含XX名单，无法给出具体首发"，**绝不从记忆里填人名**——记忆张冠李戴的代价是把挪威球员排进巴西首发（生产实锤）。同理**禁止**以"往届阵容延续性/常规主力框架"为由从记忆补人（实锤："结合2022年决赛阵容延续性"混入了非素材人名）：只能使用素材中出现过的**本届**出场/名单信息组阵，缺哪个位置就明说缺谁。
- **名单取材分层级（素材内部也要甄别）**：① 本届**实际比赛**的首发/出场记录 > ② 官方公布的大名单 > ③ 赛前预测/分析文章——③**不算名单依据**，只能当观点引用。组首发时**每个人名**都必须出现在①或②里；只在预测文里出现、官方名单与实际出场记录均无的人**一律不得进入首发**（实锤：莫拉塔——预测文称"支点地位难以撼动"，但 26 人名单与本届出场记录均查无此人，仍被排进了模拟首发）。存疑宁缺：写"该位置素材依据不足"。"模拟/推演"的自由度只在**过程与走势**，绝不延伸到人名、归属、时间、地点这些事实要素；对某个事实要素犹豫到需要加括号自我怀疑时，就该删掉它而不是保留。
- **决定性前提须双源或权威**：对阵双方/晋级结果/中标方/涉事主体这类决定整个回答走向的事实，须有权威/专业级来源、或至少两个独立来源说法一致才可采用；只有单一低级来源或来源间冲突时，明说"该前提未能确认（来源说法不一）"并列出各方说法，绝不挑一个当真相往下推演。
- **联网素材的时间与信源纪律**：凡带【页面发布时间：…】标注的素材，先核对该时间是否落在用户询问的时间范围（今天/本周/本月）内；不在范围内的内容**绝不当作当期动态呈现**，但**可以作背景参考**——引用时明确写出真实发布时间（如"2月1日消息"）。标注「自媒体」级的来源只可作观点/线索，其独家说法与硬数字不采信；与「权威/专业」级来源冲突时一律以后者为准。标注「一般」级的来源，其**硬事实**（比分/阶段/点位/金额/日期）须有「权威/专业」级来源或接口快照佐证才可采信，孤证一律按"未经证实的说法"表述；素材里出现"东道主/挑战者/球队A"这类占位称谓 = 模板页残留，整段作废不引用。素材若带【⚠️ 信源可信度警示】，严格执行其中的铁律。
- **先给再补，不推诿**：素材与问题不完全对口时，先把其中**能回答的部分**整理出来（标注各自信息时间），可对素材里**真实存在**的信息做提炼、比较、趋势判断（写明"基于X月X日信息"）——但归纳推断**只能在素材已有信息范围内**，不得借"推断"之名补出素材里没有的事实。缺口一句话坦承即可。**禁止**用大段篇幅解释"为什么无法回答"，**禁止**让用户"自行查阅东方财富/同花顺等外部平台"——检索与整理正是你的职责；仅当素材完全为空时，才如实说明未检索到并请用户换个角度提问。
- **搜索结果的标题与摘要即是有效素材（不要因"未深读全文"而拒答）**：检索结果列表里每条的**标题与摘要**就是可直接采信的素材，与深读正文同为一手信息，只是更短。对**长尾事实类问题**（某人名/日期/年份/型号/名次/机构/作品的具体属性），若某条结果的**标题或摘要已明确给出答案**，即可据此作答并标注来源——**"深读 0 篇/未提取到正文"绝不等于素材不足**，摘要够答就答。只有当标题与摘要都未触及问题所问的那个具体事实时，才算素材不足。
如果数据中含图片 Markdown 或表格，请完整保留并显示。${hasExplicitFormatConstraints(data.content) ? '\n' + FORMAT_CONTRACT_RULE : ''}
用户指令："${data.content}"`

    try {
      const llmSpan = trace.beginSpan('model', `模型作答·${cfg.modelName || 'llm'}`, { stage: '作答', model: cfg.modelName || '' })
      const u0 = currentUsage()
      let content = await callLlm(promptWithContext, cfg, { longRunning: true })
      const u1 = currentUsage()
      // token 增量 = 本次调用前后累计 usage 的差（网关回传的真实用量，不是估算）
      const tokens = { in: Math.max(0, (u1?.prompt || 0) - (u0?.prompt || 0)), out: Math.max(0, (u1?.completion || 0) - (u0?.completion || 0)) }
      llmSpan.end('ok', `输入 ${promptWithContext.length} 字 → 输出 ${content.length} 字`, { tokens })
      trace.attachIo(llmSpan.id, '模型作答', promptWithContext, content)
      content = attachRagImages(content, corporateChunks)   // 【图N】占位 → 真实插图

      // ── 能力否认自救（与 main.ts 问答兜底共用 rescueNetDenial，抽出后两条路径同一套逻辑）──
      let rescueSources: { title: string; url: string }[] = []
      const rescued = await rescueNetDenial(content, promptWithContext, data, corporateChunks, sendLog, trace)
      if (rescued) { content = rescued.content; rescueSources = rescued.webSources }

      // ── 输出契约生成后校验：带显式格式约束时检出违规即定向重写一次 ──
      content = await enforceFormatContract(content, data, sendLog)

      sendLog('completed', `[Completed] 问答与本地技能调用链完毕。`)
      const blocked = /未登录|需登录|未执行|未绑定/.test(skillResult)
      await trace.submit(content, blocked ? 'BLOCKED' : 'SUCCESS',
        `目标：完成用户任务。${trace.skill ? '匹配技能「' + trace.skill + '」并执行；' : ''}${trace.webSearch ? '判定需联网→检索→综合作答；' : ''}基于真实结果整理回答，未编造。`)
      const mergedWebSources = [...(sk.webSources || []), ...rescueSources].slice(0, 8)
      return { content, success: true, traceId: trace.id, sources: buildKnowledgeSources(corporateChunks), files: sk.skillFiles, ...(mergedWebSources.length ? { webSources: mergedWebSources } : {}) }
    } catch (err: any) {
      sendLog('observing', `大模型连接润色失败: ${err.message}。自动回退为本地技能直达渲染。`)
      sendLog('completed', `[Completed] 技能运行完毕（回退直通）。`)
      return {
        content: `⚠️ **[大模型连接失败 - 自动切换本地直通输出]**\n\n大模型请求遇到问题 (\`${err.message}\`)，但本地技能已在 Electron 环境内执行成功。以下是物理执行结果：\n\n---\n\n${skillResult}`,
        success: true, traceId: trace.id, files: sk.skillFiles, ...(sk.webSources?.length ? { webSources: sk.webSources } : {})
      }
    }
}
