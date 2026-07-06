// 任务编排（planner-executor）与技能主管线：意图短路（记忆/定时）→ 分层路由
// （关键词快路径 → 模型意图路由）→ 单技能/多技能编排执行 → 结果合成。
// 纯搬迁自 main.ts，不改逻辑。
// ⚠️ 属技能链路：行为正确性冒烟测不到，改动后需真跑一次读取类 + 写入类技能验证。
import { configGet } from './db'
import { type LlmConfig, callLlm } from './llm'
import { swallow } from './util'
import { requestPermissionChoice } from './automation-runtime'
import { webSearch, isWebSearchIntent, refineSearchQuery, getExpertWebSearch, shouldWebSearch } from './web-search'
import { type SkillDefinition, getLoadedSkills, loadLocalSkills, skillLabel, skillDisplayName } from './skill-store'
import { runMemoryWrite, runScheduleCreate, synthesizeSkillAnswer } from './agent-steps'
import { routeSkillsByIntent, getSkillType, isWriteSkill } from './skill-exec'
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
        if (r.results.length === 0) {
          genParts.push({ skillResult: `⚠️ 联网检索「${sq}」未返回结果。`, skillPromptHint: `【联网检索“${goal}”】对「${sq}」未返回任何结果，请如实说明暂未检索到、可能网络受限，不要编造结果或链接。` })
        } else {
          const lines = r.results.map((x, k) => `${k + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
          const pageBlocks = r.pages.map(p => `【来源：${p.title}｜${p.url}】\n${p.text}`).join('\n\n')
          genParts.push({ skillResult: `已联网检索「${sq}」并综合。`, skillPromptHint: `【联网检索“${goal}”的真实结果】今天是 ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}。\n— 结果列表 —\n${lines}\n— 头部网页正文 —\n${pageBlocks || '（未能提取到正文，仅有摘要）'}\n请基于以上真实内容作答；留意各条日期，优先当日最新，若多为往年回顾则如实说明"未获取到当日最新，以下为近期可查资料"，绝不把往年标注成"今日/最新"；引用写成 Markdown 链接。` })
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
        if (!done) done = await runCustomSkill(step.skill, label, stepData, sendLog, trace, out)
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
  return { content, success: true, traceId: trace.id, files: files.length ? files : undefined }
}

export async function runSkillPipeline(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult | null> {
  const normalized = data.content.toLowerCase()
  const expertId = data.expertId || ''

  // 「记住 X」意图优先：提炼并写入个人长期记忆，命中即短路（不误路由到技能/联网）
  const remembered = await runMemoryWrite(data, sendLog, trace)
  if (remembered) return remembered

  // 「每天/每周…定时做某事」意图：解析成自动化定时任务，命中即短路
  const scheduled = await runScheduleCreate(data, sendLog, trace)
  if (scheduled) return scheduled

  // --- Skill Interception and Execution ---
  // Reload skills to capture any newly created folders/files by the user!
  loadLocalSkills()

  let isSkillTriggered = false
  let skillResult = ''
  let skillPromptHint = ''
  let skillFiles: { name: string; sizeBytes: number }[] | undefined

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
    const picked: SkillDefinition[] = [...keywordHits]
    // ③ 模型意图层：无关键词命中，或请求含复合连接词（可能要多技能）→ 交模型选集合并入（去重）
    const compositional = /[和、＋+&，,]|以及|并|同时|还要|另外|外加/.test(data.content)
    if (scoped.length && (keywordHits.length === 0 || compositional)) {
      console.log(`[skill-router] ${keywordHits.length === 0 ? '关键词未命中→语义路由' : '复合请求→语义路由补充多技能'}（候选 ${scoped.length}，关键词命中 ${keywordHits.length}）`)
      const routed = await routeSkillsByIntent(data.content, scoped, data.llmConfig)
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
      const done = await runCustomSkill(s, skl, data, sendLog, trace, out, focusHint)
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
  // 联网检索触发：显式关键词，或"已授权联网"的分身自主研判需要联网。
  if (!isSkillTriggered) {
    const cleanQuery = data.content.split('\n').filter(l => !l.startsWith('【')).join(' ').trim() || data.content
    let doSearch = isWebSearchIntent(data.content)
    if (!doSearch && await getExpertWebSearch(expertId)) {
      doSearch = await shouldWebSearch(cleanQuery, data.llmConfig, sendLog)
    }
    if (doSearch) {
    isSkillTriggered = true
    trace.webSearch = true
    trace.spans.push({ type: 'web', name: '联网检索', status: 'ok' })
    try {
      const sq = await refineSearchQuery(cleanQuery, data.llmConfig, sendLog)
      const r = await webSearch(sq, sendLog)
      trace.sources = r.results.map(x => ({ title: x.title, url: x.url }))
      if (r.results.length === 0) {
        skillResult = `⚠️ 联网检索「${sq}」未返回结果（可能是网络受限或被搜索引擎拦截）。`
        skillPromptHint = `【联网检索】对「${sq}」的检索未返回任何结果。请如实告知用户暂未检索到相关网页、可能是网络受限，不要编造任何结果或链接。`
      } else {
        const lines = r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
        const pageBlocks = r.pages.map(p => `【来源：${p.title}｜${p.url}】\n${p.text}`).join('\n\n')
        skillResult = `已联网检索「${sq}」，获取到 ${r.results.length} 条结果并深读了 ${r.pages.length} 篇网页，正在综合。`
        skillPromptHint = `【联网检索真实结果】用户的问题需要联网信息，以下是刚刚从互联网检索到的真实结果与网页正文。今天是 ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}。\n\n— 搜索结果列表 —\n${lines}\n\n— 头部网页正文 —\n${pageBlocks || '（未能提取到正文，仅有上面的摘要）'}\n\n请严格基于以上真实检索内容回答用户问题。**时效性要求**：留意每条内容自身的日期，优先采用与"今天"相符的最新信息；若检索到的多是往年（如去年及更早）的回顾/盘点而非当日最新，请**如实说明"未获取到当日最新，以下为近期可查到的资料"**，绝不要把往年内容标注成"今日/最新"。结尾另起一行写「来源：」，并将每条引用写成 Markdown 链接「- [网页标题](链接)」（用标题文字作为链接文本，不要直接粘贴长链接）。如果这些内容不足以回答，请如实说明，不要编造任何事实或链接。`
      }
    } catch (e: any) {
      skillResult = `❌ 联网检索失败：${e.message}`
      skillPromptHint = `【联网检索失败】检索过程中出错："${e.message}"。请如实告知用户检索失败，不要编造任何结果。`
    }
    }
  }

  if (isSkillTriggered) {
    return await synthesizeSkillAnswer(data, sendLog, trace, { skillResult, skillPromptHint, skillFiles })
  }
  return null
}
