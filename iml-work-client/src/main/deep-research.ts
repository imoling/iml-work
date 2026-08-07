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
import { callLlm, tierModel, resolvePurposeModel, type LlmConfig } from './llm'
import { configGet } from './db'
import { swallow } from './util'
import { webSearch, followUpSearches, outcomeBlock, lowTrustNotice, searchKey, type WebSearchOutcome } from './web-search'
import { workspaceDir } from './workspace-files'
import { uniqueArtifactName, registerArtifact } from './artifact-index'
import { CHART_PROTOCOL_HINT } from './skill-exec'
import { runningState } from './automation-runtime'
import type { AgentTaskData, SkillExecOut } from './agent-types'
import type { AgentTrace } from './agent-trace'
import type { SendLog } from './types'

// 档位参数（2026-07-29 拍板升级）：默认 deep 档——轮数/广度/笔记密度全面放宽，
// 覆盖面向头部产品靠拢一步。config 键 `research-depth` 设 'standard' 可回旧档（省时省钱的退路）。
const DEPTHS = {
  standard: { rounds: 3, breadthFirst: 3, breadthNext: 2, maxSearches: 8,  notesPerSearch: 6, maxLearnings: 40, deadlineMs: 5 * 60_000 },
  deep:     { rounds: 5, breadthFirst: 4, breadthNext: 3, maxSearches: 14, notesPerSearch: 9, maxLearnings: 70, deadlineMs: 9 * 60_000 },
} as const
type DepthParams = (typeof DEPTHS)[keyof typeof DEPTHS]
function researchParams(): DepthParams {
  return configGet('research-depth') === 'standard' ? DEPTHS.standard : DEPTHS.deep
}

/**
 * 调研专用模型。规划子问题、盘点缺口、分节成稿是整条链里**最吃推理**的环节，
 * 默认通道通常是快档模型——给调研换推理档，是缩小与头部产品差距最便宜的一步。
 *
 * 这是模型解析的**用途专用层**，位于 currentLlmConfig 三级优先级的最高级：入参 cfg 已经
 * 叠加过会话级选择，这里再覆盖，即"用途 > 会话选择 > 全局默认"。用途要赢过用户偏好，
 * 因为调研对推理档是能力要求——用户在 composer 里挑了个快档小模型，规划环节会直接崩。
 *
 * 三级取值：
 * ① 手填覆盖（config 键 `llm-research-model`，LlmTab 高级设置）——用户明确指定就听用户的；
 * ② 网关自动路由（proxy 模式）：发**类型别名** `corp-reasoning`，网关按管理端标注的通道类型
 *    选推理档；没标注任何推理档时网关 fail-open 回默认池——所以可以无脑发，绝不会打挂；
 * ③ 自配直连：厂商不认别名，但用户"导入模型服务"时已把推理档映射存在本地
 *    （llm-tier-models），这里直接取真实模型名——此前这条路径拿不到推理档，
 *    自配用户的深度调研只能用默认快档跑，规划环节质量明显更差。
 * ④ 都没有：保持默认模型。
 */
function researchCfg(cfg: LlmConfig): LlmConfig {
  // 手填值与档位映射都可能是 `providerId::model` 引用，必须经 resolvePurposeModel 解析——
  // 曾原样塞进 modelName 发出去，上游 400「passed deepseek::deepseek-v4-pro」，
  // 规划/盘点/成稿全线退化到兜底路径（2026-08-08 实锤）。
  const m = (configGet('llm-research-model') || '').trim()
  if (m && m !== cfg.modelName) return resolvePurposeModel(cfg, m)
  if ((cfg.mode || 'direct') === 'proxy') return { ...cfg, modelName: 'corp-reasoning' }
  const mapped = tierModel('reasoning')
  return mapped ? resolvePurposeModel(cfg, mapped) : cfg
}

interface SourceRef { url: string; title: string; tier: string }

const jsonIn = (text: string): unknown => {
  const m = (text || '').match(/\{[\s\S]*\}|\[[\s\S]*\]/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

/**
 * 规划失败时的兜底检索词：把**任务句**削成能搜的**关键词**。
 *
 * 原来直接 `task.slice(0,40)` —— 于是「深度调研科大讯飞在教育AI市场的竞品格局，产出结构化
 * 调研报告（Markdown交」这种半句话被当检索词发出去，搜索引擎必然 0 条（实测），调研随即
 * 以"素材不足"收场。任务句里真正可搜的只有主体和主题，"深度调研/产出/报告/Markdown"
 * 这些是**交付指令**，属于噪声。
 */
export function fallbackQuery(task: string): string {
  const head = (task || '').split(/[，,。；;：:\n（(]/)[0] || task     // 只取第一个子句，不切在半个词上
  const cleaned = head
    .replace(/^(请|帮我|帮忙|麻烦)?\s*(深度)?(调研|研究|分析|搜集|收集|查一下|查查|了解)\s*/i, '')
    .replace(/(产出|输出|生成|交付|写)一?[份个篇].*/i, '')
    .replace(/(结构化)?(调研|研究|分析)?报告|Markdown|PPT|文档|表格|模板/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned.length >= 4 ? cleaned : (task || '').trim()).slice(0, 40)
}

// 首轮检索规划（对应开源版 generateSerpQueries）：把调研问题拆成互异角度的子查询。
// **必须声明 longRunning**：调研走推理档模型（agnes-2.5-pro / o系 等），"规划"看着是秒级小活，
// 推理档却要先思考半分钟——网关短超时 30s 会把它掐死，返回 502「所有上游模型通道均不可用：
// request timed out」，然后整条调研带着垃圾兜底检索词跑完（2026-08-05 实锤）。档位决定快慢，
// 不是任务类型决定快慢。
async function planQueries(task: string, cfg: LlmConfig, breadth: number, sendLog?: SendLog): Promise<{ q: string; goal: string }[]> {
  const prompt = `你是资深研究员。把下面的调研任务拆解成 ${breadth} 个**互不重复**的检索子查询，共同覆盖回答该任务所需的事实面（如：现状与数据 / 关键主体与背景 / 争议、风险或对比面——按题意选取角度）。\n要求：每个检索词 ≤22 字、含具体实体名；时效类主题必须带当前年份或届次；不含"报告/PPT/模板"这类载体词。\n只输出 JSON 数组：[{"q":"检索词","goal":"该子查询要查明什么、查到后下一步往哪深挖"}]，不要任何解释。\n\n【调研任务】\n${task.slice(0, 600)}`
  let why = ''
  // 规划挂了 = 整条调研退化成"单个兜底词",代价远大于再发一次请求 → 值得重试一轮。
  // 失败原因必须**带样本**：只报"未返回可解析的检索计划"时，空返回 / 被截断 / 吐了段散文
  // 三种病长得一模一样，排查只能靠猜（2026-08-06 实锤：推理档思考吃满输出上限，正文被挤空，
  // 界面只显示一句"模型未返回可解析的检索计划"，无从判断该调上限还是改提示词）。
  for (let attempt = 1; attempt <= 2; attempt++) {
    let resp = ''
    try {
      resp = await callLlm(attempt === 1 ? prompt : `${prompt}\n\n（上一轮没有输出可解析的 JSON 数组。请直接以 [ 开头输出，不要思考过程、不要解释、不要代码围栏。）`,
        cfg, { temperature: 0, longRunning: true })
      const arr = jsonIn(resp)
      if (Array.isArray(arr)) {
        const qs = arr
          .filter(x => x && typeof x === 'object' && typeof (x as { q?: unknown }).q === 'string')
          .map(x => ({ q: String((x as { q: string }).q).trim(), goal: String((x as { goal?: string }).goal || '').trim() }))
          .filter(x => x.q.length >= 4)
          .slice(0, breadth)
        if (qs.length) return qs
      }
      const sample = (resp || '').replace(/\s+/g, ' ').trim()
      why = sample
        ? `模型未返回可解析的检索计划（返回 ${sample.length} 字符：「${sample.slice(0, 100)}」）`
        : '模型返回空内容——推理档常见于"思考过程吃满输出上限"，请在管理端给推理档通道设 max_output_tokens'
    } catch (e: any) { why = String(e?.message || e).slice(0, 120); swallow(e, 'dr-plan') }
    if (attempt === 1) sendLog?.('thinking', `检索规划这轮没成（${why}），换更严格的措辞重试一次…`)
  }
  // 降级要让用户看见：原来这里一声不响，界面上"调研计划（1 个子问题）"看着像正常规划，
  // 实则是失败兜底——排查时完全看不出模型这一步已经挂了。
  sendLog?.('observing', `检索规划失败（${why}），改用主题关键词直接检索`)
  return [{ q: fallbackQuery(task), goal: '直接检索调研主题本身' }]
}

// 单次检索结果 → 事实笔记（对应开源版 processSerpResult）。每条笔记必须自带来源与信源级别，
// 后续轮次只带笔记不带原文——这是控 prompt 膨胀的关键（十几篇正文早就撑爆上下文）。
async function extractLearnings(task: string, outcome: WebSearchOutcome, cfg: LlmConfig, maxNotes: number): Promise<string[]> {
  const material = outcomeBlock(`检索「${outcome.query}」的结果`, outcome).slice(0, 9000)
  try {
    const resp = await callLlm(
      `从下方检索素材中提炼与调研任务相关的**事实笔记**，最多 ${maxNotes} 条。\n每条一行，格式：事实内容（含具体数字/日期/主体名，信息密度尽量高）｜来源站点｜信源级别｜内容日期(不明则写"日期不明")。\n纪律：\n- 只记素材中**真实存在**的事实，绝不补充素材之外的记忆知识；\n- 「自媒体」级来源的硬数字不记为事实（只可记为"某自媒体观点：…"）；\n- 各条互不重复；素材与任务无关时输出空数组。\n只输出 JSON 数组：["笔记1","笔记2"]，不要任何解释。\n\n【调研任务】\n${task.slice(0, 400)}\n\n【检索素材】\n${material}`,
      cfg, { temperature: 0, longRunning: true })   // longRunning 保留：素材块大、prompt 长，短超时容易掐死
    const arr = jsonIn(resp)
    if (Array.isArray(arr)) return arr.filter(x => typeof x === 'string' && x.trim().length > 8).map(x => String(x).trim()).slice(0, maxNotes)
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

// ── 分节成稿（升级 ④）：一次成稿在笔记多时会"平均用力"，长报告后半段明显稀释。
// 两阶段：① 大纲规划（同时产出核心结论与缺口——模型此刻看得见全部笔记，顺手写掉，省一次调用）；
// ② 各节并行起草（每节只带分到的笔记，信息密度不被其他节摊薄）。任何环节失败回退单次成稿。
interface Outline { title: string; conclusions: string[]; sections: { heading: string; noteIds: number[] }[]; gaps: string[] }

async function planOutline(task: string, learnings: string[], cfg: LlmConfig): Promise<Outline | null> {
  try {
    const resp = await callLlm(
      `你是资深行业研究员。基于下方事实笔记，为调研报告做**成稿规划**。\n只输出 JSON：`
      + `{"title":"报告标题","conclusions":["核心结论1（结论先行、含关键数字）",…3-6条],`
      + `"sections":[{"heading":"章节标题","noteIds":[该节要用的笔记编号]},…3-6节],`
      + `"gaps":["笔记覆盖不到的关键问题",…]}\n`
      + `规划纪律：按主题聚类分节（不是按检索轮次）；每条笔记至少分给一节，与多节相关可重复分配；`
      + `结论只能来自笔记，不得引入笔记外的判断；gaps 如实列出（没有就空数组）。\n\n`
      + `【调研任务】\n${task.slice(0, 600)}\n\n【事实笔记】\n${learnings.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
      cfg, { temperature: 0, longRunning: true })   // 同上：推理档规划要思考，短超时不够
    const o = jsonIn(resp) as Outline | null
    if (!o || !Array.isArray(o.sections) || !o.sections.length) return null
    o.sections = o.sections.filter(x => x && typeof x.heading === 'string' && x.heading.trim()).slice(0, 7)
    if (!o.sections.length) return null
    o.conclusions = Array.isArray(o.conclusions) ? o.conclusions.filter(x => typeof x === 'string').slice(0, 6) : []
    o.gaps = Array.isArray(o.gaps) ? o.gaps.filter(x => typeof x === 'string').slice(0, 8) : []
    return o
  } catch (e) { swallow(e, 'dr-outline'); return null }
}

async function draftSection(task: string, heading: string, notes: string[], nowStr: string, cfg: LlmConfig): Promise<string> {
  const prompt = `你是资深行业研究员，正在撰写调研报告中的一节，今天是 ${nowStr}。\n`
    + `【本节标题】${heading}\n【调研任务】${task.slice(0, 400)}\n\n`
    + `【本节可用的事实笔记】（本节唯一事实来源）\n${notes.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\n`
    + `【硬性要求】把笔记组织成**有观点的论述**（不是笔记罗列）；每个事实与数字句尾以（来源站点·日期）标注；`
    + `笔记里没有的事实一律不写；笔记日期与今天不符的写明真实日期；`
    + `本节若有成组对比数字用 Markdown 表格，其中最关键的一组（最多一张图），${CHART_PROTOCOL_HINT}。\n`
    + `只输出该节正文 Markdown（不含节标题本身），不要任何解释。`
  return (await callLlm(prompt, cfg, { longRunning: true })).trim()
}

async function writeReportSectioned(
  task: string, learnings: string[], sources: SourceRef[], trustNotice: string, cfg: LlmConfig,
  sendLog: SendLog,
): Promise<{ report: string; mode: string }> {
  const nowStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
  const outline = await planOutline(task, learnings, cfg)
  if (!outline || runningState.aborted) {
    // 大纲失败/用户取消 → 回退单次成稿（原行为），不因升级引入新的失败面
    return { report: await writeReport(task, learnings, sources, trustNotice, cfg), mode: '单稿' }
  }
  sendLog('acting', `报告大纲 ${outline.sections.length} 节，分节起草中…`)
  const bodies = await Promise.all(outline.sections.map(async sec => {
    const ids = Array.isArray(sec.noteIds) ? sec.noteIds.filter(n => Number.isInteger(n) && n >= 1 && n <= learnings.length) : []
    // 分配为空/非法 → 给全部笔记（截断防爆），宁可信息重复也不让一节无米下锅
    const notes = ids.length ? ids.map(n => learnings[n - 1]) : learnings.slice(0, 30)
    try {
      const body = await draftSection(task, sec.heading, notes, nowStr, cfg)
      return `## ${sec.heading}\n\n${body || '（本节起草为空）'}`
    } catch (e) {
      swallow(e, 'dr-section')
      // 单节失败不拖垮整报告：该节退化为笔记直出（诚实标注）
      return `## ${sec.heading}\n\n（本节自动起草失败，以下为该节原始事实笔记）\n${notes.map(l => `- ${l}`).join('\n')}`
    }
  }))
  const srcList = sources.slice(0, 30).map((x, i) => `${i + 1}. [${x.tier}] ${x.title} — ${x.url}`).join('\n')
  const report = [
    `# ${outline.title || task.slice(0, 30)}`,
    trustNotice.trim() ? trustNotice.trim() : '',
    outline.conclusions.length ? `## 核心结论\n\n${outline.conclusions.map(c => `- ${c}`).join('\n')}` : '',
    ...bodies,
    outline.gaps.length ? `## 未能确认的缺口\n\n${outline.gaps.map(g => `- ${g}`).join('\n')}` : '',
    `## 信源清单\n\n${srcList}`,
  ].filter(Boolean).join('\n\n')
  return { report, mode: `分节×${outline.sections.length}` }
}

export async function runDeepResearch(
  data: AgentTaskData, skl: string, sendLog: SendLog, trace: AgentTrace,
  out: SkillExecOut,
): Promise<void> {
  const cfg = data.llmConfig
  if (!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)) {
    out.skillOk = false
    out.skillResult = `⚠️ 深度调研需要有效的大模型配置，本次未执行。`
    out.skillPromptHint = `【技能 "${skl}" 未执行】原因：未检测到有效大模型配置（深度调研依赖模型做规划与提炼）。请如实告知用户，绝不编造调研结果。`
    return
  }
  const task = data.content.split('\n').filter(l => !l.startsWith('【')).join(' ').trim() || data.content
  const P = researchParams()
  // 规划/缺口盘点/成稿走调研模型（真吃推理的环节）；检索相关性把关与事实提炼走默认档——
  // 提炼是抄录式压缩、每次检索跟一次，推理档在这两处只贡献时延（曾整链全走推理档，
  // 14 次检索 × 半分钟思考把调研拖进死线）。
  const rcfg = researchCfg(cfg)
  if (rcfg.modelName !== cfg.modelName) {
    sendLog('thinking', rcfg.modelName === 'corp-reasoning'
      ? '调研模型：由网关按「推理档」类型自动路由（管理端未标注推理档通道时用默认档）'
      : `调研专用模型：${rcfg.modelName}（手动指定）`)
  }
  const t0 = Date.now()
  const seenUrls = new Set<string>()
  const seenQueries = new Set<string>()   // 已检索词（searchKey 归一化）：挡补查轮的同词/同义重复检索
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
  const plan = await planQueries(task, rcfg, P.breadthFirst, sendLog)
  planSpan.end('ok', plan.map(p => p.q).join(' / '))
  trace.attachIo(planSpan.id, '检索规划', task, plan.map((p, i) => `${i + 1}. ${p.q} —— ${p.goal}`).join('\n'))
  sendLog('thinking', `调研计划（${plan.length} 个子问题）：${plan.map(p => `「${p.q}」`).join('、')}`)

  rounds = 1
  const r1Span = trace.beginSpan('web', '深度调研·第1轮检索')
  plan.forEach(p => seenQueries.add(searchKey(p.q)))
  const firstOutcomes = await Promise.all(plan.map(async p => {
    try { return await webSearch(p.q, sendLog, cfg, { seenUrls }) } catch (e) { swallow(e, 'dr-search'); return null }
  }))
  // 提炼并行：各 outcome 互相独立，此前逐个 await 让 4 次提炼调用串行排队（一次半分钟起），
  // 是整条链最大的时延来源之一；笔记去重在合并时做（addLearnings 内部 filter），结果不变。
  // 取消检查在发起前：已在途的调用本就取消不了（与旧行为一致）。
  const firstNotes = await Promise.all(firstOutcomes.map(async o => {
    if (!o || runningState.aborted) return null   // 用户已取消：不再烧提炼调用（体检 P2-13）
    const ls = (o.results.length || o.pages.length) ? await extractLearnings(task, o, cfg, P.notesPerSearch) : []
    return { o, ls }
  }))
  for (const x of firstNotes) {
    if (!x) continue
    searches++
    collect(x.o)
    if (x.ls.length) addLearnings(x.ls, '第1轮')
  }
  r1Span.end('ok', `检索 ${plan.length} 个子问题，累计笔记 ${learnings.length} 条`)

  // 首轮颗粒无收 → 换主题关键词再试一次，别直接判"素材不足"。
  // 首轮全空几乎都是**检索词本身不可搜**（规划失败时的兜底词、或模型编出的长句），
  // 而不是"这题网上真没有"——同一轮里外层智能体用正常关键词一搜就有结果（实测对照）。
  if (!learnings.length && !runningState.aborted && searches < P.maxSearches) {
    const retryQ = fallbackQuery(task)
    if (retryQ && !plan.some(p => p.q === retryQ)) {
      sendLog('observing', `首轮没搜到可用素材，换关键词「${retryQ}」重试一次…`)
      const rSpan = trace.beginSpan('web', '深度调研·首轮重试')
      try {
        seenQueries.add(searchKey(retryQ))
        const o = await webSearch(retryQ, sendLog, cfg, { seenUrls })
        if (o) {
          searches++
          collect(o)
          if (o.results.length || o.pages.length) addLearnings(await extractLearnings(task, o, cfg, P.notesPerSearch), '重试轮')
        }
      } catch (e) { swallow(e, 'dr-retry') }
      rSpan.end('ok', `重试检索，累计笔记 ${learnings.length} 条`)
    }
  }

  // ── 第 2..N 轮：反思缺口 → 补查（复用 followUpSearches：缺口盘点 + 实体锚定 + URL 去重）──
  while (rounds < P.rounds && searches < P.maxSearches && learnings.length > 0 && learnings.length < P.maxLearnings) {
    if (runningState.aborted) break   // 用户已取消：立即停止补查（不再进任何模型/检索调用）
    if (Date.now() - t0 > P.deadlineMs) { sendLog('observing', '调研时限已到，带着现有笔记进入成稿阶段。'); break }
    rounds++
    const notes = learnings.map((l, i) => `${i + 1}. ${l}`).join('\n')
    const rSpan = trace.beginSpan('web', `深度调研·第${rounds}轮补查`)
    // 缺口盘点走推理档（rcfg），检索内部把关走默认档（searchCfg）；seenQueries 挡重复补查词
    const fills = await followUpSearches(task, notes, seenUrls, rcfg, sendLog, P.breadthNext, undefined, { seenQueries, searchCfg: cfg })
    if (!fills.length) { rSpan.end('ok', '缺口盘点：素材已收敛，无需补查'); break }   // 收敛：模型判定素材已够
    const freshBefore = learnings.length
    // 提炼并行（同第 1 轮）：各跳素材互相独立，串行 await 白白叠加时延
    const hopNotes = await Promise.all(fills.map(async f => {
      if (runningState.aborted) return null
      return { f, ls: await extractLearnings(task, f.out, cfg, P.notesPerSearch) }
    }))
    for (const x of hopNotes) {
      if (!x) continue
      searches++
      collect(x.f.out)
      addLearnings(x.ls, `第${rounds}轮`)
    }
    rSpan.end('ok', `补查 ${fills.length} 跳，新增笔记 ${learnings.length - freshBefore} 条`)
    if (learnings.length === freshBefore) break   // 补查无新知（dry）：继续挖也是重复，收敛
  }

  // ── 成稿 ──
  if (runningState.aborted) {
    sendLog('completed', '已终止深度调研，未生成报告。')
    out.skillOk = false
    out.skillResult = `🚫 深度调研已按你的要求终止（已检索 ${searches} 次、笔记 ${learnings.length} 条，未成稿）。`
    out.skillPromptHint = `【技能 "${skl}" 深度调研·用户终止】用户中途取消，未生成报告。请简短确认已终止即可，绝不基于半程笔记编造调研结论。`
    return
  }
  if (!learnings.length) {
    out.skillOk = false
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
  let repMode = ''
  let repErr = ''
  try {
    const r = await writeReportSectioned(task, learnings, sources, lowTrustNotice(merged), rcfg, sendLog)
    report = r.report; repMode = r.mode
  } catch (e: any) { repErr = String(e?.message || e).slice(0, 200); swallow(e, 'dr-report') }
  // 推理档挂了就用默认档补一稿：检索、提炼全跑完了（几分钟 + 一堆额度），只差成稿这一步，
  // 直接吐一堆笔记等于把前面的活作废。实锤 2026-08-06：上游推理通道余额不足返回 403，
  // 而默认档通道当时完全健康——却没人去用它，用户拿到的是「报告生成失败」的笔记堆。
  if (!report && !runningState.aborted) {
    sendLog('observing', `推理档成稿失败（${repErr || '未知原因'}），改用默认模型补一稿…`)
    const backSpan = trace.beginSpan('model', '深度调研·撰写报告(默认档补稿)')
    try {
      const r2 = await writeReportSectioned(task, learnings, sources, lowTrustNotice(merged), cfg, sendLog)
      report = r2.report; repMode = `${r2.mode}·默认档补稿`
      backSpan.end(report ? 'ok' : 'warn', report ? `补稿 ${report.length} 字` : '补稿仍失败')
    } catch (e: any) {
      repErr = `${repErr}；默认档补稿也失败：${String(e?.message || e).slice(0, 160)}`
      backSpan.end('warn', '默认档补稿失败')
      swallow(e, 'dr-report-fallback')
    }
  }
  if (!report) {
    repSpan.end('warn', `报告生成失败，回退为笔记直出：${repErr || '未知原因'}`)
    // 失败原因必须写进交付物：只写"报告生成失败"时，用户看到一堆笔记完全不知道是模型挂了、
    // 余额没了还是素材不够——而这三种的处置办法完全不同。
    report = `# 调研笔记（报告生成失败，以下为原始事实笔记）\n\n> 失败原因：${repErr || '未知原因'}\n> 检索与提炼已完成，缺的只是成稿这一步；排除原因后可重跑本次调研。\n\n${learnings.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\n## 信源清单\n${sources.slice(0, 30).map(s => `- [${s.tier}] ${s.title} — ${s.url}`).join('\n')}`
  } else {
    repSpan.end('ok', `报告 ${report.length} 字（${repMode}）`)
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
  out.skillOk = true
  out.skillResult = `🔎 已完成深度调研（${rounds} 轮 · ${searches} 次检索 · ${learnings.length} 条事实笔记）。${saved ? `报告已保存到工作空间：${saved.name}。` : ''}`
  out.skillPromptHint = `【技能 "${skl}" 深度调研真实执行结果】\n引擎完成了 ${rounds} 轮检索（共 ${searches} 次），提炼出以下**带来源的事实笔记**（本次回答的唯一事实来源），完整调研报告已作为文件交付：\n${learnings.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\n${lowTrustNotice(merged)}请基于上述笔记向用户做**结论先行的调研摘要**：\n- 开头先给最重要的 3-5 条综合判断；再按主题分层简述关键发现，引用具体数字并保留（来源·日期）标注；\n- 成组数字可用 markdown 表格；其中最关键的一组，${CHART_PROTOCOL_HINT}，数值必须取笔记原值；\n- 笔记未覆盖的关键缺口如实点明；报告全文在下方文件卡中，无需罗列文件名/大小/路径；\n- 绝不编造笔记中不存在的事实与数字；涉及投资/医疗/法律时结尾注明"不构成专业建议"。`
}
