// 任务编排（planner-executor）与技能主管线：意图短路（记忆/定时）→ 分层路由
// （关键词快路径 → 模型意图路由）→ 单技能/多技能编排执行 → 结果合成。
// 纯搬迁自 main.ts，不改逻辑。
// ⚠️ 属技能链路：行为正确性冒烟测不到，改动后需真跑一次读取类 + 写入类技能验证。
import { configGet } from './db'
import { type LlmConfig, callLlm } from './llm'
import { swallow } from './util'
import { requestPermissionChoice } from './automation-runtime'
import { webSearch, isWebSearchIntent, refineSearchQuery, getExpertWebSearch, shouldWebSearch, shouldFetchMaterials } from './web-search'
import { KB_CONFIDENT, kbTopScore } from './web-search-core'
import { focusRecent, focusEvents } from './db'
import { focusMentioned, renderFocusBlock } from './focus-core'
import { type SkillDefinition, getLoadedSkills, loadLocalSkills, skillLabel, skillDisplayName } from './skill-store'
import { runMemoryWrite, runScheduleCreate, synthesizeSkillAnswer } from './agent-steps'
import { routeSkillsByIntent, getSkillType, isWriteSkill } from './skill-exec'
import { formatRouterContext, buildRouteText, SHORT_CONFIRM } from './skill-router-core'
import { runCustomSkill } from './skill-custom'
import { runOntologyHook } from './agent-ontology'
import { AgentTrace } from './agent-trace'
import type { AgentTaskData, AgentResult } from './agent-types'
import { type SendLog } from './types'

// runCustomSkill（自定义技能真实执行）已拆至 skill-custom.ts。

export type OrchStep = { type: 'websearch' } | { type: 'skill'; skill: SkillDefinition }

// 为每个已确定的步骤写一句"子目标"：让每步的执行/作答只聚焦本步职责，不越界answer整个复合请求。
export async function planStepGoals(userText: string, steps: OrchStep[], cfg: LlmConfig): Promise<string[]> {
  const fallback = steps.map(() => userText)   // 规划失败时退回整句（至少能跑，只是不分工）
  const isCfg = cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName
  if (!isCfg) return fallback
  const desc = steps.map((s, i) => {
    const label = s.type === 'websearch' ? '联网检索并总结相关最新信息' : `业务技能「${skillLabel(s.skill)}」`
    return `${i + 1}. ${label}`
  }).join('\n')
  const prompt = `用户的复合请求：${userText}\n\n系统已确定按以下 ${steps.length} 个步骤依次处理，步骤与技能已固定、不要增删或替换：\n${desc}\n\n请为每一步写一句"该步要达成的子目标"，只覆盖该步自身职责、不要跨步、不要笼统重复整句请求。\n子目标必须忠实于用户要的【产出形态】：用户明确要求生成文件（做/生成/导出文档、PPT 等）才以文件为目标；用户只要求梳理/大纲/思路/建议/点评等内容时，子目标以文本内容为目标，不得擅自升级为"生成文件"。\n严格输出 JSON 字符串数组，长度与步骤数一致、一一对应，例如 ["...","..."]。只输出 JSON，不要任何解释。`
  try {
    const raw = await callLlm(prompt, cfg)
    const m = raw.match(/\[[\s\S]*\]/)
    if (m) {
      const arr = JSON.parse(m[0])
      if (Array.isArray(arr) && arr.length === steps.length && arr.every(x => typeof x === 'string' && x.trim())) {
        return arr.map(x => String(x).trim())
      }
    }
  } catch (e) { swallow(e, 'planStepGoals') }
  return fallback
}

/**
 * 生成类技能的「备料」：技能开跑前，把它要写进文档的真实数据先取回来。
 *
 * 为什么必须有：沙箱是网络隔离的，模型在容器里拿不到任何外部数据。以前生成类技能只收到用户原话
 * （"生成股票信息汇报的 word 和 ppt"），于是在信息真空里干活——只能产出「待填充」「暂无数据」的
 * 占位空壳：文件确实生成了，内容是空的。模型没编假行情是对的（红线），错在管线没给它数据。
 *
 * 素材两个来源：① 企业知识库命中（main.ts 在进管线前已查好传入）
 *              ② 联网检索——**不能只看用户嘴上有没有说"联网"**。"生成股票信息汇报"显然依赖外部实时数据，
 *                 却不含"联网"二字。所以走与兜底路径同一套判定：显式意图 → 知识库强命中则免搜 → 否则问模型。
 */
async function gatherMaterials(data: AgentTaskData, kb: { filename?: string; text: string; score: number }[],
                               sendLog: SendLog, trace: AgentTrace, expertId: string):
                               Promise<{ materials: string; webSources: { title: string; url: string }[] }> {
  const parts: string[] = []
  const sources: { title: string; url: string }[] = []

  if (kb.length) {
    parts.push('— 企业知识库命中 —\n' + kb.map((c, i) => `${i + 1}. 【${c.filename || '知识库'}】\n${c.text}`).join('\n\n'))
  }

  // 岗位画像：请求点名了跟进过的对象 → 本地沉淀也算素材（标明快照，绝不冒充实时数据）
  try {
    const hit = focusMentioned(data.content, focusRecent(expertId, undefined, 20))
    const blocks = hit.map(f => renderFocusBlock(f.displayName, f.lastState, focusEvents(f.id, 5), f.profileSummary)).filter(Boolean)
    if (blocks.length) parts.push('— 你对相关对象的本地跟进记录（快照，非实时）—\n' + blocks.join('\n\n'))
  } catch (e) { swallow(e, 'focus-materials') }

  const cleanQuery = data.content.split('\n').filter(l => !l.startsWith('【')).join(' ').trim() || data.content
  let doSearch = isWebSearchIntent(data.content)
  if (!doSearch && kbTopScore(kb) < KB_CONFIDENT && await getExpertWebSearch(expertId)) {
    // 用**备料**判定，不是问答判定：后者问"要回答这个问题需不需要联网"，
    // 面对"生成股票信息汇报的 word 和 ppt"会答"不需要"（它把这读成一个会做的文档任务）→ 空壳照旧。
    doSearch = await shouldFetchMaterials(cleanQuery, data.llmConfig, sendLog, kb)
  }
  if (doSearch) {
    trace.webSearch = true
    trace.spans.push({ type: 'web', name: '联网备料', status: 'ok' })
    sendLog('thinking', '这份材料要用到外部数据，先联网取回来再动笔…')
    try {
      const sq = await refineSearchQuery(cleanQuery, data.llmConfig, sendLog)
      const r = await webSearch(sq, sendLog)
      trace.sources.push(...r.results.map(x => ({ title: x.title, url: x.url })))
      const readUrls = new Set(r.pages.map(p => p.url))
      for (const pg of r.pages) sources.push({ title: pg.title || pg.url, url: pg.url })
      for (const x of r.results) if (!readUrls.has(x.url)) sources.push({ title: x.title || x.url, url: x.url })
      if (r.results.length) {
        const lines = r.results.map((x, k) => `${k + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
        const pageBlocks = r.pages.map(pg => `【来源：${pg.title}｜${pg.url}】\n${pg.text}`).join('\n\n')
        parts.push(`— 联网检索「${sq}」的真实结果 —\n${lines}\n\n— 头部网页正文 —\n${pageBlocks || '（未提取到正文，仅有摘要）'}`)
      } else {
        sendLog('observing', `联网检索「${sq}」没返回结果。`)
      }
    } catch (e) { swallow(e, 'gather-materials') }
  }
  return { materials: parts.join('\n\n'), webSources: sources.slice(0, 8) }
}

// 执行编排：逐步跑，收集每步的最终 section，最后合并。写子任务的确认弹窗在 runCustomSkill 内部完成。
export async function runOrchestratedSkills(steps: OrchStep[], data: AgentTaskData, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult> {
  const goals = await planStepGoals(data.content, steps, data.llmConfig)
  // 展示用友好名：只取技能名，不带内部 id
  const nameOf = (s: OrchStep) => s.type === 'websearch' ? '联网检索'
    : (skillDisplayName(s.skill.id) || (s.skill.name && s.skill.name !== s.skill.id ? s.skill.name : s.skill.id))
  const planList = steps.map((s, i) => `${i + 1}. ${nameOf(s)} —— ${goals[i]}`).join('\n')
  trace.skill = steps.map(s => nameOf(s)).join(' + ')
  sendLog('acting', `任务较复杂，已拆成 ${steps.length} 步依次处理：\n${planList}`)

  // ── 先决权限闸：只读模式 + 任务含写步骤 → 开跑前让用户选择，别执行一半才在结果里提示 ──
  if (data.permMode === 'readonly') {
    const writeLabels: string[] = []
    for (const s of steps) { if (s.type === 'skill' && await isWriteSkill(s.skill.id)) writeLabels.push(nameOf(s)) }
    if (writeLabels.length) {
      sendLog('acting', `检测到写操作（${writeLabels.join('、')}），当前为只读——请先选择如何处理…`)
      const choice = await requestPermissionChoice(writeLabels)
      if (choice === 'switch') {
        // 用户选择切到「允许操作」后重跑 → 本次不执行任何步骤；permSwitch 让渲染层在本次结束后以 full 权限自动重发原任务
        await trace.submit('用户选择切到「允许操作」后重跑本任务。', 'BLOCKED', `只读含写操作（${writeLabels.join('、')}），用户选择切档重跑。`)
        return { content: `🔄 已切到「允许操作」，正在按原任务重新执行…（写操作会请你逐个确认）`, success: true, traceId: trace.id, permSwitch: true }
      }
      // choice === 'continue'：继续，只跑可执行步骤；写步骤仍会在只读闸被拦（进 readonlyBlocked，末尾如实记录）
      sendLog('acting', `已选择「继续」：执行可执行的部分，跳过写操作。`)
    }
  }

  // 子任务执行期间暂缓各自上报；各步只收集"真实结果"，最后一次综合成单条连贯回复 + 一条审计。
  trace.deferSubmit = true
  const genParts: { skillResult: string; skillPromptHint: string }[] = []   // 可合并综合（生成/联网/知识型）
  const terminalBodies: string[] = []                                        // 已终态（写入类确认结果，各自成文）
  const readonlyBlocked: string[] = []                                       // 只读模式下被拦截的写技能名（顶部醒目提示，不再淹没在末尾）
  const stepStat: { label: string; status: 'ok' | 'blocked' | 'fail' }[] = []
  const allFiles: { name: string; sizeBytes: number }[] = []
  const webSources: { title: string; url: string }[] = []                     // 联网检索来源（结果卡展示，区别于知识来源）
  let orchMaterials = ''                                                     // 联网步骤取到的素材 → 传给后续生成类技能

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const goal = goals[i] || data.content
    const stepData: AgentTaskData = { ...data, content: goal }   // 每步执行聚焦到自己的子目标（生成正确的交付物）
    const label = nameOf(step)
    sendLog('acting', `第 ${i + 1}/${steps.length} 步 · ${label}…`)

    try {
      if (step.type === 'websearch') {
        trace.webSearch = true
        const sq = await refineSearchQuery(goal, data.llmConfig, sendLog)
        const r = await webSearch(sq, sendLog)
        trace.sources.push(...r.results.map(x => ({ title: x.title, url: x.url })))
        // 结果卡「联网来源」：优先已深读的网页，不足再补搜索结果；标题缺失兜底为域名
        const readUrls = new Set(r.pages.map(p => p.url))
        for (const p of r.pages) webSources.push({ title: p.title || p.url, url: p.url })
        for (const x of r.results) if (!readUrls.has(x.url)) webSources.push({ title: x.title || x.url, url: x.url })
        if (r.results.length === 0) {
          genParts.push({ skillResult: `⚠️ 联网检索「${sq}」未返回结果。`, skillPromptHint: `【联网检索“${goal}”】对「${sq}」未返回任何结果，请如实说明暂未检索到、可能网络受限，不要编造结果或链接。` })
        } else {
          const lines = r.results.map((x, k) => `${k + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
          const pageBlocks = r.pages.map(p => `【来源：${p.title}｜${p.url}】\n${p.text}`).join('\n\n')
          // 检索结果同时留一份当「素材」交给后续技能 —— 以前只进 genParts（喂最后那段总结回复），
          // 后面的生成技能拿不到，照样在真空里写出「待填充」空壳。
          orchMaterials = `— 联网检索「${sq}」的真实结果 —\n${lines}\n\n— 头部网页正文 —\n${pageBlocks || '（未提取到正文，仅有摘要）'}`
          genParts.push({ skillResult: `已联网检索「${sq}」并综合。`, skillPromptHint: `【联网检索“${goal}”的真实结果】今天是 ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}。\n— 结果列表 —\n${lines}\n— 头部网页正文 —\n${pageBlocks || '（未能提取到正文，仅有摘要）'}\n请基于以上真实内容作答；留意各条日期，优先当日最新，若多为往年回顾则如实说明"未获取到当日最新，以下为近期可查资料"，绝不把往年标注成"今日/最新"；**不要在正文罗列来源链接**（界面会单独以「联网来源」卡展示）。` })
        }
        stepStat.push({ label, status: 'ok' })
      } else {
        const out: { skillResult: string; skillPromptHint: string; skillFiles?: { name: string; sizeBytes: number }[] } = { skillResult: '', skillPromptHint: '' }
        // 写步骤优先走本体候选消解（读真实候选 → 全部/指定下拉），命中即用；未命中再回退录制技能（固定单目标）。
        let done: AgentResult | null = null
        if (await isWriteSkill(step.skill.id)) {
          try { done = await runOntologyHook(stepData, sendLog, trace, { noPermGate: true }) } catch (e) { swallow(e, 'orch-onto') }
          if (done) sendLog('acting', `「${label}」经本体候选消解处理。`)
        }
        if (!done) done = await runCustomSkill(step.skill, label, stepData, sendLog, trace, out, undefined, orchMaterials || undefined)
        if (done) {
          // 写入/读取直达/拦截类：已是终态文本（含人工确认结果）→ 单独成文，不并入统一综合
          const isReadonlyBlock = /^🔒|只读模式/.test(done.content)
          if (isReadonlyBlock) {
            // 只读拦截：不把整段 🔒 文本塞进正文，改由顶部统一横幅提示（避免淹没在末尾）
            readonlyBlocked.push(label)
            stepStat.push({ label, status: 'blocked' })
          } else {
            const blocked = /^🚫|已取消|拦截/.test(done.content)
            terminalBodies.push(done.content)
            if (done.files?.length) allFiles.push(...done.files)
            stepStat.push({ label, status: blocked ? 'blocked' : 'ok' })
          }
        } else {
          // 生成/知识型：文件已在沙箱内产出（out.skillFiles）→ 结果并入统一综合
          genParts.push({ skillResult: out.skillResult, skillPromptHint: `【“${label}”· 面向"${goal}"的真实结果】\n${out.skillPromptHint}` })
          if (out.skillFiles?.length) allFiles.push(...out.skillFiles)
          stepStat.push({ label, status: 'ok' })
        }
      }
    } catch (e: any) {
      swallow(e, 'orchestrate-step')
      terminalBodies.push(`❌ 「${label}」执行出错：${e?.message || e}`)
      stepStat.push({ label, status: 'fail' })
    }
  }

  const seen = new Set<string>()
  const files = allFiles.filter(f => seen.has(f.name) ? false : (seen.add(f.name), true))

  // 一次综合：把各生成步骤的真实结果合并，产出「单条、连贯、只一个称呼」的回复（不分步、不重复问候）
  let content = ''
  if (genParts.length) {
    const combinedResult = genParts.map(r => r.skillResult).filter(Boolean).join('\n')
    const otherHandled = readonlyBlocked.length || terminalBodies.length
    const combinedHint = `以下是同一个请求下多项工作的真实执行结果。请用**一段自然、连贯的话统一汇报**：只用一次称呼、不要分“第一步/第二步”、不要重复问候语、不要给每项加小标题；把它们当作一件事的多个产出，简洁说明各产出了什么即可（文件明细由下方文件卡展示，无需罗列文件名/大小/路径）。\n**严格只依据下面给出的真实结果作答**：${otherHandled ? '用户请求里的其它诉求（尤其写操作/审批）已由系统另行处理（拦截或单独确认），本段**绝对不要提及、不要描述其状态、不要给"系统无法完成/请手动操作"之类的说法或指引**——只汇报下面这些已完成的产出。' : '不要提及或臆测任何未在下面结果中出现的事项。'}\n\n${genParts.map(r => r.skillPromptHint).filter(Boolean).join('\n\n———\n\n')}${otherHandled ? '\n\n【最后再次强调】你的这段话只覆盖上面给出的产出；用户请求中的审批/写操作部分已由系统单独处理并会单独呈现给用户——你若提及它（包括"需您手动/我无法代为执行/涉及权限"等任何说法）即为错误输出。' : ''}`
    const res = await synthesizeSkillAnswer(data, sendLog, trace, { skillResult: combinedResult, skillPromptHint: combinedHint, skillFiles: files })
    content = res.content
  }
  if (terminalBodies.length) content += (content ? '\n\n' : '') + terminalBodies.join('\n\n')
  // 只读拦截写操作 → 顶部醒目横幅（放最前，先看到）
  if (readonlyBlocked.length) {
    const banner = `> ⚠️ 本次包含**写操作**（${readonlyBlocked.join('、')}），当前「权限范围」为**只读**，已跳过、未对业务系统做任何改动。\n> 如需执行，请把输入框上方的「权限范围」切到**允许操作**后重发（写操作仍会请你逐个确认）。`
    content = content ? `${banner}\n\n${content}` : banner
  }
  if (!content) content = '已完成。'

  // 合并审计：任一步 blocked/fail → 整体 PARTIAL，否则 SUCCESS
  trace.deferSubmit = false
  const anyBad = stepStat.some(s => s.status !== 'ok') || trace.deferred.some(d => d.status !== 'SUCCESS')
  await trace.submit(content, anyBad ? 'PARTIAL' : 'SUCCESS',
    `任务编排：${steps.length} 项一次综合汇报（${stepStat.map(s => `${s.label}:${s.status}`).join('；')}）。读取类自动执行，写入类经人工确认。`)
  sendLog('completed', `[Completed] 任务编排完成，共 ${steps.length} 项。`)
  // 联网来源去重（按 url），最多留 8 条，随结果卡展示
  const seenUrl = new Set<string>()
  const webSrc = webSources.filter(w => w.url && !seenUrl.has(w.url) && (seenUrl.add(w.url), true)).slice(0, 8)
  return { content, success: true, traceId: trace.id, files: files.length ? files : undefined, webSources: webSrc.length ? webSrc : undefined }
}

export async function runSkillPipeline(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace,
                                      opts?: { corporateChunks?: { filename?: string; text: string; score: number }[] }): Promise<AgentResult | null> {
  const normalized = data.content.toLowerCase()
  const expertId = data.expertId || ''

  // 「记住 X」意图优先：提炼并写入个人长期记忆，命中即短路（不误路由到技能/联网）
  const remembered = await runMemoryWrite(data, sendLog, trace)
  if (remembered) return remembered

  // 「每天/每周…定时做某事」意图：解析成自动化定时任务，命中即短路
  const scheduled = await runScheduleCreate(data, sendLog, trace)
  if (scheduled) return scheduled

  // 「总结/分析这个（附件）文档」纯读取意图：读附件真实内容直接作答即可，别误路由到"生成文档"技能又造一个新 Word。
  // 命中条件：含附件引用 + 分析类动词（总结/分析/解读…）+ 无"生成一份交付物"意图 → 交回问答链路（main.ts 解析附件作答）。
  if (/【附件】[^\n]*?（已加入工作空间）/.test(data.content)) {
    const analysis = /(总结|概括|摘要|提炼|归纳|梳理|分析|解读|解释|看一?下|看看|读一?[下遍]|讲了?些?什么|什么内容|要点|重点|审阅|点评|理解一?下)/.test(data.content)
    const genDeliverable = /(生成|制作|导出|新建|做一?[份个]|写一?[份个]|整理成|汇总成|转成|排版成|做成|输出成).{0,6}(文档|word|docx|表格|excel|xlsx|ppt|pptx|幻灯|演示|报告|海报|pdf|文件|材料)/.test(data.content)
    if (analysis && !genDeliverable) {
      sendLog('thinking', '这是对附件的总结/分析，我读一下附件内容直接答复（不另生成文件）…')
      return null   // → 问答链路读「附件真实内容」作答，产出文字总结而非新文件
    }
  }

  // --- Skill Interception and Execution ---
  // Reload skills to capture any newly created folders/files by the user!
  loadLocalSkills()

  let isSkillTriggered = false
  let skillResult = ''
  let skillPromptHint = ''
  let skillFiles: { name: string; sizeBytes: number }[] | undefined
  let webSources: { title: string; url: string }[] | undefined   // 联网检索来源 → 结果卡「联网来源」

  // ── 分层路由（① 显式锁定 → ② 关键词快路径 → ③ 模型意图层 → ④ 读/写安全闸）─────────────
  // 产出待执行技能集合 skillsToRun。多技能仅对「生成类(python-sandbox)」批量；含写入/交互类退回单技能。
  // 匹配限定在「当前岗位实际装配的技能集」内，不误命中其它岗位/全局("all")技能。
  let skillsToRun: SkillDefinition[] = []
  let orchSteps: OrchStep[] | null = null   // 非空 → 走任务编排（异构复合请求）
  if (data.forcedSkillId) {
    // ① 用户在「业务技能」里显式锁定 → 直接用它，零歧义
    const s = getLoadedSkills().find(x => x.id === data.forcedSkillId)
    if (s) skillsToRun = [s]
  } else {
    let boundIds: string[] = []
    try { const raw = configGet('boundSkills:' + expertId); if (raw) boundIds = JSON.parse(raw) } catch (e) { swallow(e) }
    const inScope = (s: SkillDefinition) => boundIds.length
      ? boundIds.includes(s.id)                                   // 有装配信息 → 仅限装配的技能
      : (s.allowedRoles.includes(expertId) || s.allowedRoles.length === 0)  // 无装配信息 → 退回角色判定
    const scoped = getLoadedSkills().filter(s => inScope(s))
    // ② 关键词快路径：命中的全部技能（确定、零成本），按命中数降序
    const keywordHits = scoped
      .map(s => ({ s, hits: s.triggerKeywords.filter(kw => normalized.includes(kw)).length }))
      .filter(x => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .map(x => x.s)
    let picked: SkillDefinition[] = [...keywordHits]
    // 承接语境闸：上一轮助手以问句收尾（在等用户补充信息）时，用户这句大概率是"在回答"而非发起新任务
    // ——业务词撞上触发词（如答"下周去北京出差"命中"出差"）不再直接开火，降级交带上下文的语义层复核。
    const routerCtx = formatRouterContext(data.history)
    const lastAssistant = [...(data.history || [])].reverse().find(h => h.role === 'assistant')
    const awaitingReply = !!lastAssistant && /[？?]\s*$/.test((lastAssistant.content || '').trim())

    // 短确认接续闸（红线：回「同意」曾致「未跑自动化却声称已提交审批」）：拼装逻辑在 skill-router-core，与评测同源。
    const isShortConfirm = SHORT_CONFIRM.test(data.content) && !!lastAssistant
    const routeText = buildRouteText(data.content, data.history)
    if (isShortConfirm) console.log('[skill-router] 短确认接续：把上一轮提议并入路由文本，交语义路由判定真实操作')

    // ③ 模型意图层：无关键词命中 / 复合请求 / 承接语境需复核 → 交模型判定（带最近对话上下文）
    const compositional = /[和、＋+&，,]|以及|并|同时|还要|另外|外加/.test(data.content)
    if (isShortConfirm && !keywordHits.length) {
      const routed = await routeSkillsByIntent(routeText, scoped, data.llmConfig, routerCtx)
      picked = routed.map(id => scoped.find(x => x.id === id)).filter((s): s is SkillDefinition => !!s)
      if (picked.length) sendLog('thinking', '识别为对上一步提议的确认，正在按上文执行对应操作…')
      else console.log('[skill-router] 短确认但上文未对应任何可执行技能 → 交 QA 路径（prompt 铁律禁止声称已执行）')
    } else if (awaitingReply && keywordHits.length) {
      console.log(`[skill-router] 承接语境（上一轮助手在提问）→ 关键词命中 ${keywordHits.length} 个降级，语义路由带上下文复核`)
      const routed = await routeSkillsByIntent(data.content, scoped, data.llmConfig, routerCtx)
      picked = routed.map(id => scoped.find(x => x.id === id)).filter((s): s is SkillDefinition => !!s)
      if (!picked.length) console.log('[skill-router] 复核判定为承接回答（answer），本轮不执行技能')
    } else if (scoped.length && (keywordHits.length === 0 || compositional)) {
      console.log(`[skill-router] ${keywordHits.length === 0 ? '关键词未命中→语义路由' : '复合请求→语义路由补充多技能'}（候选 ${scoped.length}，关键词命中 ${keywordHits.length}）`)
      const routed = await routeSkillsByIntent(data.content, scoped, data.llmConfig, routerCtx)
      for (const id of routed) { const s = scoped.find(x => x.id === id); if (s && !picked.some(p => p.id === s.id)) picked.push(s) }
      if (!keywordHits.length && picked.length) sendLog('thinking', '未命中触发词，已按语义理解匹配到技能…')
    }
    // ④ 安全闸 / 编排判定：
    //  · 全生成类(python-sandbox)且无联网诉求 → 现有同类批量合成（一条汇总回复，不变）
    //  · 异构（读+写 / 技能+联网 / 多类混合）→ 任务编排：读自动跑、写逐个人工确认
    const needWeb = compositional && isWebSearchIntent(data.content)
    const capped = picked.slice(0, 4)   // 单轮最多编排 4 步，避免失控
    if (capped.length >= 2) {
      const types = await Promise.all(capped.map(s => getSkillType(s.id)))
      const allGen = types.every(t => t === 'python-sandbox')
      if (allGen && !needWeb) {
        skillsToRun = capped
      } else {
        orchSteps = capped.map(s => ({ type: 'skill', skill: s }) as OrchStep)
        if (needWeb) orchSteps.unshift({ type: 'websearch' })
      }
    } else if (capped.length === 1 && needWeb) {
      orchSteps = [{ type: 'websearch' }, { type: 'skill', skill: capped[0] }]
    } else {
      skillsToRun = capped
    }
  }

  // 异构复合请求 → 任务编排（读自动 + 写逐个确认），早返回
  if (orchSteps && orchSteps.length >= 2) {
    isSkillTriggered = true
    return await runOrchestratedSkills(orchSteps, data, sendLog, trace)
  }

  if (skillsToRun.length) {
    isSkillTriggered = true
    // 先决权限闸（与编排一致）：只读 + 含写技能 → 开跑前弹「继续 / 切档重跑」两选一卡，不再执行到一半才提示
    if (data.permMode === 'readonly') {
      const wl: string[] = []
      for (const s of skillsToRun) { if (await isWriteSkill(s.id)) wl.push(skillDisplayName(s.id) || s.name) }
      if (wl.length) {
        sendLog('acting', `检测到写操作（${wl.join('、')}），当前为只读——请先选择如何处理…`)
        const choice = await requestPermissionChoice(wl)
        if (choice === 'switch') {
          await trace.submit('用户选择切到「允许操作」后重跑本任务。', 'BLOCKED', `只读含写技能（${wl.join('、')}），用户选择切档重跑。`)
          return { content: `🔄 已切到「允许操作」，正在按原任务重新执行…（写操作会请你人工确认）`, success: true, traceId: trace.id, permSwitch: true }
        }
        sendLog('acting', '已选择「继续」：写技能将被只读拦截，不改动业务系统。')
      }
    }
    const multi = skillsToRun.length > 1
    trace.skill = skillsToRun.map(s => skillLabel(s)).join(' + ')
    if (multi) sendLog('acting', `识别到 ${skillsToRun.length} 个技能，将依次执行：${skillsToRun.map(s => skillLabel(s)).join('、')}`)

    // 备料：生成类技能要往文档里写真实内容，开跑前先把数据取回来（知识库 + 必要时联网）。
    // 沙箱网络隔离，模型进了容器就与世隔绝——不在这里备好，它只能写「待填充」。
    let materials = ''
    const runTypes = await Promise.all(skillsToRun.map(s => getSkillType(s.id)))
    if (runTypes.some(t => t === 'python-sandbox')) {
      const m = await gatherMaterials(data, opts?.corporateChunks || [], sendLog, trace, expertId)
      materials = m.materials
      if (m.webSources.length) webSources = m.webSources
      if (materials) sendLog('thinking', `素材已备齐（${materials.length} 字），开始按素材写内容。`)
    }
    const allFiles: { name: string; sizeBytes: number }[] = []
    const results: { skillResult: string; skillPromptHint: string }[] = []
    // 多技能协作时给每个技能一个"聚焦分工"约束：只产出本技能能力范围内的交付物，避免越界重复生成
    const others = skillsToRun.map(s => skillDisplayName(s.id) || s.name)
    for (const s of skillsToRun) {
      const skl = skillLabel(s)
      if (!multi) sendLog('acting', `找到合适的技能「${skl}」，这就去办…`)
      else sendLog('acting', `执行技能「${skl}」…`)
      trace.spans.push({ type: 'skill', name: `匹配技能·${skl}`, status: 'ok' })
      const focusHint = multi
        ? `本次由多个技能协作完成用户请求，涉及的技能：${others.join('、')}。你现在是其中的「${skillDisplayName(s.id) || s.name}」。你**只负责产出本技能能力范围内的那一类交付物**（严格按你的 SKILL.md），其余交付物由其它技能各自负责，你**绝对不要**生成本技能之外类型的文件（例如你是 PPT 技能就只产出 .pptx、是 Word 技能就只产出 .docx）。`
        : undefined
      const out: { skillResult: string; skillPromptHint: string; skillFiles?: { name: string; sizeBytes: number }[] } = { skillResult: '', skillPromptHint: '' }
      const done = await runCustomSkill(s, skl, data, sendLog, trace, out, focusHint, materials || undefined)
      // 交互/写入/读取类技能会早返回终态 AgentResult（表单确认/拦截/直达结果）→ 直接返回。
      // 多技能批量仅含生成类，正常不会走到这；防御性：若出现终态则中止批量返回该结果。
      if (done) return done
      results.push({ skillResult: out.skillResult, skillPromptHint: out.skillPromptHint })
      if (out.skillFiles?.length) allFiles.push(...out.skillFiles)
    }
    skillResult = results.map(r => r.skillResult).filter(Boolean).join('\n\n')
    skillPromptHint = results.map(r => r.skillPromptHint).filter(Boolean).join('\n\n———\n\n')
    // 按文件名去重（同名会在工作空间互相覆盖，只保留一张卡；也兜底防越界重复产出）
    const seenNames = new Set<string>()
    const uniqueFiles = allFiles.filter(f => seenNames.has(f.name) ? false : (seenNames.add(f.name), true))
    skillFiles = uniqueFiles.length ? uniqueFiles : undefined
  }

  // 未匹配到技能，但任务需要联网检索 → 触发联网检索能力。
  //
  // 顺序很关键：**企业知识库先查，联网只做兜底**（chunks 由 main.ts 在进入本管线前就检索好并传入）。
  // 以前是反的——先决定联网、后查知识库，模型在信息真空里判断，内部问题也被判成"需要联网"。
  // 现在：① 用户显式说"联网/搜一下" → 照办（尊重明确指令）
  //      ② 知识库**强命中** → 直接跳过，连"要不要联网"这次模型调用都省了（快，且不端出无关外链）
  //      ③ 弱命中/未命中 → 才问模型，且把知识库检索结果一并交给它判断
  if (!isSkillTriggered) {
    const cleanQuery = data.content.split('\n').filter(l => !l.startsWith('【')).join(' ').trim() || data.content
    const kb = opts?.corporateChunks || []
    const kbTop = kbTopScore(kb)
    let doSearch = isWebSearchIntent(data.content)
    if (!doSearch && await getExpertWebSearch(expertId)) {
      if (kbTop >= KB_CONFIDENT) {
        sendLog('thinking', `企业知识库已命中相关资料（${kb.length} 条），直接作答，不联网。`)
      } else {
        doSearch = await shouldWebSearch(cleanQuery, data.llmConfig, sendLog, kb)
      }
    }
    if (doSearch) {
    isSkillTriggered = true
    trace.webSearch = true
    trace.spans.push({ type: 'web', name: '联网检索', status: 'ok' })
    try {
      const sq = await refineSearchQuery(cleanQuery, data.llmConfig, sendLog)
      const r = await webSearch(sq, sendLog)
      trace.sources = r.results.map(x => ({ title: x.title, url: x.url }))
      // 结果卡「联网来源」：已深读网页优先 + 其余结果，按 url 去重、最多 8 条
      const readUrls = new Set(r.pages.map(p => p.url))
      const seenU = new Set<string>()
      webSources = [...r.pages.map(p => ({ title: p.title || p.url, url: p.url })),
                    ...r.results.filter(x => !readUrls.has(x.url)).map(x => ({ title: x.title || x.url, url: x.url }))]
        .filter(w => w.url && !seenU.has(w.url) && (seenU.add(w.url), true)).slice(0, 8)
      if (r.results.length === 0) {
        skillResult = `⚠️ 联网检索「${sq}」未返回结果（可能是网络受限或被搜索引擎拦截）。`
        skillPromptHint = `【联网检索】对「${sq}」的检索未返回任何结果。请如实告知用户暂未检索到相关网页、可能是网络受限，不要编造任何结果或链接。`
      } else {
        const lines = r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
        const pageBlocks = r.pages.map(p => `【来源：${p.title}｜${p.url}】\n${p.text}`).join('\n\n')
        skillResult = `已联网检索「${sq}」，获取到 ${r.results.length} 条结果并深读了 ${r.pages.length} 篇网页，正在综合。`
        skillPromptHint = `【联网检索真实结果】用户的问题需要联网信息，以下是刚刚从互联网检索到的真实结果与网页正文。今天是 ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}。\n\n— 搜索结果列表 —\n${lines}\n\n— 头部网页正文 —\n${pageBlocks || '（未能提取到正文，仅有上面的摘要）'}\n\n请严格基于以上真实检索内容回答用户问题。**时效性要求**：留意每条内容自身的日期，优先采用与"今天"相符的最新信息；若检索到的多是往年（如去年及更早）的回顾/盘点而非当日最新，请**如实说明"未获取到当日最新，以下为近期可查到的资料"**，绝不要把往年内容标注成"今日/最新"。**不要在正文里罗列"来源/参考链接"**——来源会由界面单独以「联网来源」卡片展示，你只管把正文答好即可。如果这些内容不足以回答，请如实说明，不要编造任何事实或链接。`
      }
    } catch (e: any) {
      skillResult = `❌ 联网检索失败：${e.message}`
      skillPromptHint = `【联网检索失败】检索过程中出错："${e.message}"。请如实告知用户检索失败，不要编造任何结果。`
    }
    }
  }

  if (isSkillTriggered) {
    return await synthesizeSkillAnswer(data, sendLog, trace, { skillResult, skillPromptHint, skillFiles, webSources })
  }
  return null
}
