// 深度调研引擎（独立技能：SKILL.md/SOP 含 `IML-ENGINE: deep-research` 即分流到本引擎）：
// 规划子问题 → 「检索 → 提炼事实笔记 → 反思缺口 → 补查」循环 → 汇总结构化长报告（md 交付物 + 聊天摘要）。
// 算法骨架改造自开源 dzhng/deep-research（MIT）：generateSerpQueries（带研究目标的子查询规划）/
// processSerpResult（learnings 笔记 + followUp 追问）/ breadth-depth 收敛循环。
// iML 适配：检索复用 webSearch（后端代理检索密钥 + 信源分级 + 深读正文 + 垃圾闸）与
// followUpSearches（缺口盘点 + 实体锚定校验 + URL 去重）；模型统一走中转站 callLlm；
// 笔记强制携带来源与信源级别；报告落工作空间；进度进 sendLog 与 AgentTrace。
// ⚠️ 属技能链路：行为正确性冒烟测不到，改动后需真跑一次深度调研请求验证。
import fs from 'fs'
import path from 'path'
import { callLlm, type LlmConfig } from './llm'
import { swallow } from './util'
import { webSearch, followUpSearches, outcomeBlock, lowTrustNotice, type WebSearchOutcome } from './web-search'
import { workspaceDir } from './workspace-files'
import { uniqueArtifactName, registerArtifact } from './artifact-index'
import { CHART_PROTOCOL_HINT } from './skill-exec'
import type { AgentTaskData } from './agent-types'
import type { AgentTrace } from './agent-trace'
import type { SendLog } from './types'

const MAX_ROUNDS = 3            // 首轮规划检索 + 至多两轮反思补查
const BREADTH_FIRST = 3         // 首轮子问题数
const BREADTH_NEXT = 2          // 反思轮每轮补查数（breadth 减半的收敛思想）
const MAX_SEARCHES = 8          // 全程检索次数硬顶
const DEADLINE_MS = 5 * 60_000  // 全程时限：超时带着已有笔记直接进入写报告
const MAX_LEARNINGS = 40        // 笔记上限（超出说明该收敛了）

interface SourceRef { url: string; title: string; tier: string }

const jsonIn = (text: string): unknown => {
  const m = (text || '').match(/\{[\s\S]*\}|\[[\s\S]*\]/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

// 首轮检索规划（对应开源版 generateSerpQueries）：把调研问题拆成互异角度的子查询。
async function planQueries(task: string, cfg: LlmConfig): Promise<{ q: string; goal: string }[]> {
  try {
    const resp = await callLlm(
      `你是资深研究员。把下面的调研任务拆解成 ${BREADTH_FIRST} 个**互不重复**的检索子查询，共同覆盖回答该任务所需的事实面（如：现状与数据 / 关键主体与背景 / 争议、风险或对比面——按题意选取角度）。\n要求：每个检索词 ≤22 字、含具体实体名；时效类主题必须带当前年份或届次；不含"报告/PPT/模板"这类载体词。\n只输出 JSON 数组：[{"q":"检索词","goal":"该子查询要查明什么、查到后下一步往哪深挖"}]，不要任何解释。\n\n【调研任务】\n${task.slice(0, 600)}`,
      cfg, { temperature: 0 })
    const arr = jsonIn(resp)
    if (Array.isArray(arr)) {
      const qs = arr
        .filter(x => x && typeof x === 'object' && typeof (x as { q?: unknown }).q === 'string')
        .map(x => ({ q: String((x as { q: string }).q).trim(), goal: String((x as { goal?: string }).goal || '').trim() }))
        .filter(x => x.q.length >= 4)
        .slice(0, BREADTH_FIRST)
      if (qs.length) return qs
    }
  } catch (e) { swallow(e, 'dr-plan') }
  return [{ q: task.slice(0, 40), goal: '直接检索调研主题本身' }]   // 规划失败退化为单查询，不阻断
}

// 单次检索结果 → 事实笔记（对应开源版 processSerpResult）。每条笔记必须自带来源与信源级别，
// 后续轮次只带笔记不带原文——这是控 prompt 膨胀的关键（十几篇正文早就撑爆上下文）。
async function extractLearnings(task: string, outcome: WebSearchOutcome, cfg: LlmConfig): Promise<string[]> {
  const material = outcomeBlock(`检索「${outcome.query}」的结果`, outcome).slice(0, 9000)
  try {
    const resp = await callLlm(
      `从下方检索素材中提炼与调研任务相关的**事实笔记**，最多 6 条。\n每条一行，格式：事实内容（含具体数字/日期/主体名，信息密度尽量高）｜来源站点｜信源级别｜内容日期(不明则写"日期不明")。\n纪律：\n- 只记素材中**真实存在**的事实，绝不补充素材之外的记忆知识；\n- 「自媒体」级来源的硬数字不记为事实（只可记为"某自媒体观点：…"）；\n- 各条互不重复；素材与任务无关时输出空数组。\n只输出 JSON 数组：["笔记1","笔记2"]，不要任何解释。\n\n【调研任务】\n${task.slice(0, 400)}\n\n【检索素材】\n${material}`,
      cfg, { temperature: 0 })
    const arr = jsonIn(resp)
    if (Array.isArray(arr)) return arr.filter(x => typeof x === 'string' && x.trim().length > 8).map(x => String(x).trim()).slice(0, 6)
  } catch (e) { swallow(e, 'dr-learnings') }
  return []
}

// 汇总长报告：一次成稿（大纲内嵌在指令里），事实全部来自笔记，引用/缺口/信源清单齐备。
async function writeReport(task: string, learnings: string[], sources: SourceRef[], trustNotice: string, cfg: LlmConfig): Promise<string> {
  const nowStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
  const srcList = sources.slice(0, 30).map((s, i) => `${i + 1}. [${s.tier}] ${s.title} — ${s.url}`).join('\n')
  const prompt = `你是资深行业研究员。基于下方**事实笔记**撰写一份结构化调研报告（Markdown），今天是 ${nowStr}。\n${trustNotice}【硬性要求】\n- 结构：# 标题 → 「## 核心结论」（3-6 条要点，结论先行）→ 按主题聚类的分节正文（每节把相关笔记组织成有观点的论述，不是笔记罗列）→ 「## 未能确认的缺口」（笔记覆盖不到的关键问题，如实列出）→ 「## 信源清单」（原样抄录下方清单）。\n- **事实零编造**：正文中每个事实与数字只能来自事实笔记，句尾以（来源站点·日期）标注；笔记里没有的事实一律不写，缺口写进缺口节。\n- 笔记中标注日期与今天不符的信息，写明其真实日期，绝不冒充最新动态。\n- 成组的数字（多期对比/占比/排行）用 Markdown 表格呈现；其中最关键的 1-2 组，${CHART_PROTOCOL_HINT}，图表数值必须取笔记原值。\n- 涉及投资/医疗/法律判断时，结尾注明"以上为公开信息整理与框架分析，不构成专业建议"。\n只输出报告 Markdown 正文，不要任何解释。\n\n【调研任务】\n${task.slice(0, 600)}\n\n【事实笔记】\n${learnings.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\n【信源清单】\n${srcList}`
  return (await callLlm(prompt, cfg, { longRunning: true })).trim()
}

export async function runDeepResearch(
  data: AgentTaskData, skl: string, sendLog: SendLog, trace: AgentTrace,
  out: { skillResult: string; skillPromptHint: string; skillFiles?: { name: string; sizeBytes: number }[]; webSources?: { title: string; url: string }[] },
): Promise<void> {
  const cfg = data.llmConfig
  if (!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)) {
    out.skillResult = `⚠️ 深度调研需要有效的大模型配置，本次未执行。`
    out.skillPromptHint = `【技能 "${skl}" 未执行】原因：未检测到有效大模型配置（深度调研依赖模型做规划与提炼）。请如实告知用户，绝不编造调研结果。`
    return
  }
  const task = data.content.split('\n').filter(l => !l.startsWith('【')).join(' ').trim() || data.content
  const t0 = Date.now()
  const seenUrls = new Set<string>()
  const learnings: string[] = []
  const sources: SourceRef[] = []
  let searches = 0
  let rounds = 0

  const collect = (o: WebSearchOutcome) => {
    for (const p of o.pages) if (!sources.some(s => s.url === p.url)) sources.push({ url: p.url, title: p.title || p.url, tier: p.tier || '一般' })
    for (const r of o.results) if (!sources.some(s => s.url === r.url)) sources.push({ url: r.url, title: r.title, tier: r.tier || '一般' })
    o.results.forEach(r => seenUrls.add(r.url)); o.pages.forEach(p => seenUrls.add(p.url))
  }
  const addLearnings = (ls: string[], roundLabel: string) => {
    const fresh = ls.filter(l => !learnings.includes(l))
    learnings.push(...fresh)
    if (fresh.length) sendLog('observing', `${roundLabel}：提炼 ${fresh.length} 条事实笔记（累计 ${learnings.length} 条）`)
  }

  // ── 第 1 轮：规划子问题并检索 ──
  sendLog('thinking', `深度调研启动：正在把问题拆解为检索计划…`)
  const planSpan = trace.beginSpan('model', '深度调研·检索规划')
  const plan = await planQueries(task, cfg)
  planSpan.end('ok', plan.map(p => p.q).join(' / '))
  trace.attachIo(planSpan.id, '检索规划', task, plan.map((p, i) => `${i + 1}. ${p.q} —— ${p.goal}`).join('\n'))
  sendLog('thinking', `调研计划（${plan.length} 个子问题）：${plan.map(p => `「${p.q}」`).join('、')}`)

  rounds = 1
  const r1Span = trace.beginSpan('web', '深度调研·第1轮检索')
  const firstOutcomes = await Promise.all(plan.map(async p => {
    try { return await webSearch(p.q, sendLog, cfg) } catch (e) { swallow(e, 'dr-search'); return null }
  }))
  for (const o of firstOutcomes) {
    if (!o) continue
    searches++
    collect(o)
    if (o.results.length || o.pages.length) addLearnings(await extractLearnings(task, o, cfg), '第1轮')
  }
  r1Span.end('ok', `检索 ${plan.length} 个子问题，累计笔记 ${learnings.length} 条`)

  // ── 第 2..N 轮：反思缺口 → 补查（复用 followUpSearches：缺口盘点 + 实体锚定 + URL 去重）──
  while (rounds < MAX_ROUNDS && searches < MAX_SEARCHES && learnings.length > 0 && learnings.length < MAX_LEARNINGS) {
    if (Date.now() - t0 > DEADLINE_MS) { sendLog('observing', '调研时限已到，带着现有笔记进入成稿阶段。'); break }
    rounds++
    const notes = learnings.map((l, i) => `${i + 1}. ${l}`).join('\n')
    const rSpan = trace.beginSpan('web', `深度调研·第${rounds}轮补查`)
    const fills = await followUpSearches(task, notes, seenUrls, cfg, sendLog, BREADTH_NEXT)
    if (!fills.length) { rSpan.end('ok', '缺口盘点：素材已收敛，无需补查'); break }   // 收敛：模型判定素材已够
    let freshBefore = learnings.length
    for (const f of fills) {
      searches++
      collect(f.out)
      addLearnings(await extractLearnings(task, f.out, cfg), `第${rounds}轮`)
    }
    rSpan.end('ok', `补查 ${fills.length} 跳，新增笔记 ${learnings.length - freshBefore} 条`)
    if (learnings.length === freshBefore) break   // 补查无新知（dry）：继续挖也是重复，收敛
  }

  // ── 成稿 ──
  if (!learnings.length) {
    out.skillResult = `⚠️ 深度调研未能取得可用素材（检索 ${searches} 次均无相关结果）。`
    out.skillPromptHint = `【技能 "${skl}" 深度调研·素材不足】共检索 ${searches} 次，未能从检索结果中提炼出与任务相关的真实事实。请如实告知用户本次没有查到可靠素材，建议换个角度描述问题或指定信息来源，**绝不编造任何调研结论**。`
    return
  }
  const merged: WebSearchOutcome = {
    query: task,
    results: sources.map(s => ({ title: s.title, url: s.url, snippet: '', tier: s.tier })),
    pages: [],
  }
  sendLog('acting', `素材收敛（${rounds} 轮 · ${searches} 次检索 · ${learnings.length} 条笔记 · ${sources.length} 个来源），正在撰写调研报告…`)
  const repSpan = trace.beginSpan('model', '深度调研·撰写报告')
  let report = ''
  try { report = await writeReport(task, learnings, sources, lowTrustNotice(merged), cfg) } catch (e) { swallow(e, 'dr-report') }
  if (!report) {
    repSpan.end('warn', '报告生成失败，回退为笔记直出')
    report = `# 调研笔记（报告生成失败，以下为原始事实笔记）\n\n${learnings.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\n## 信源清单\n${sources.slice(0, 30).map(s => `- [${s.tier}] ${s.title} — ${s.url}`).join('\n')}`
  } else {
    repSpan.end('ok', `报告 ${report.length} 字`)
  }
  trace.attachIo(repSpan.id, '调研报告', `${learnings.length} 条笔记`, report.slice(0, 3000))

  // 报告落工作空间（md 交付物，文件卡展示；.md 预览走系统默认应用）
  const topic = task.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 20) || '调研'
  const d = new Date()   // 本地时区拼日期（toISOString 是 UTC，早上会差一天）
  const dateTag = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const dir = workspaceDir()
  const name = uniqueArtifactName(dir, `深度调研-${topic}-${dateTag}.md`)
  const absPath = path.join(dir, name)
  let saved: { name: string; sizeBytes: number } | null = null
  try {
    fs.writeFileSync(absPath, report, 'utf-8')
    registerArtifact({ name, absPath, sizeBytes: Buffer.byteLength(report, 'utf-8'), source: skl })
    saved = { name, sizeBytes: Buffer.byteLength(report, 'utf-8') }
  } catch (e) { swallow(e, 'dr-save') }
  if (saved) out.skillFiles = [saved]
  out.webSources = sources.slice(0, 8).map(s => ({ title: s.title, url: s.url }))

  sendLog('completed', `[深度调研] 报告已生成${saved ? `并保存：${saved.name}` : ''}（${rounds} 轮检索 · ${learnings.length} 条笔记）。`)
  out.skillResult = `🔎 已完成深度调研（${rounds} 轮 · ${searches} 次检索 · ${learnings.length} 条事实笔记）。${saved ? `报告已保存到工作空间：${saved.name}。` : ''}`
  out.skillPromptHint = `【技能 "${skl}" 深度调研真实执行结果】\n引擎完成了 ${rounds} 轮检索（共 ${searches} 次），提炼出以下**带来源的事实笔记**（本次回答的唯一事实来源），完整调研报告已作为文件交付：\n${learnings.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\n${lowTrustNotice(merged)}请基于上述笔记向用户做**结论先行的调研摘要**：\n- 开头先给最重要的 3-5 条综合判断；再按主题分层简述关键发现，引用具体数字并保留（来源·日期）标注；\n- 成组数字可用 markdown 表格；其中最关键的一组，${CHART_PROTOCOL_HINT}，数值必须取笔记原值；\n- 笔记未覆盖的关键缺口如实点明；报告全文在下方文件卡中，无需罗列文件名/大小/路径；\n- 绝不编造笔记中不存在的事实与数字；涉及投资/医疗/法律时结尾注明"不构成专业建议"。`
}
