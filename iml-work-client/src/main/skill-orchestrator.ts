// 任务编排（planner-executor）与技能主管线：意图短路（记忆/定时）→ 分层路由
// （关键词快路径 → 模型意图路由）→ 单技能/多技能编排执行 → 结果合成。
// 纯搬迁自 main.ts，不改逻辑。
// ⚠️ 属技能链路：行为正确性冒烟测不到，改动后需真跑一次读取类 + 写入类技能验证。
import { configGet } from './db'
import { type LlmConfig, callLlm } from './llm'
import { swallow } from './util'
import { requestPermissionChoice } from './automation-runtime'
import { requestSignedConfirmation, tokenStateNote } from './confirm-token'
import { webSearch, refineSearchQuery, getExpertWebSearch, isMarketQuery, fetchMarketQuotes, lowTrustNotice } from './web-search'
import type { CorporateChunk } from './corporate-rag'
import { sourceTier, needsAgentLoop, needsBrowseAgent } from './web-search-core'
import { workspaceFileList } from './agent-tools'
import { needsWorkspaceFiles, wantsGeneratedFile } from './core-tools'
import { type SkillDefinition, getLoadedSkills, loadLocalSkills, skillLabel, skillDisplayName } from './skill-store'
import { synthesizeSkillAnswer } from './agent-steps'
import { isWriteSkill, skillTargetSystem, isSelfFetchingSkill } from './skill-exec'
import { runCustomSkill } from './skill-custom'
import { runOntologyHook } from './agent-ontology'
import { resolveBrowseSystem } from './ontology-runtime'
import { runGeneralTurn } from './general-turn'
import { WRITE_TASK_VERB } from './write-intent-core'
import { runBrowseExecutor } from './browse-executor'
import { AgentTrace } from './agent-trace'
import type { AgentTaskData, AgentResult, SkillExecOut } from './agent-types'
import { type SendLog } from './types'

// runCustomSkill（自定义技能真实执行）已拆至 skill-custom.ts。

// 岗位在册技能集（装配的 boundSkills ∪ 本人私有 userSkills；无装配退回角色）——技能路由与 browse 前置检查共用一份，避免重复漂移。
export function scopedSkillsFor(expertId: string): SkillDefinition[] {
  let boundIds: string[] = []
  try { const raw = configGet('boundSkills:' + expertId); if (raw) boundIds = JSON.parse(raw) } catch (e) { swallow(e, 'scoped-bound') }
  // 本人私有技能（skill-creator 自建）始终在范围内——不随岗位装配走，认领/换岗不清除
  let userIds: string[] = []
  try { const raw = configGet('userSkills'); if (raw) userIds = JSON.parse(raw) } catch (e) { swallow(e, 'scoped-user') }
  const inScope = (s: SkillDefinition) => userIds.includes(s.id) || (boundIds.length
    ? boundIds.includes(s.id)                                   // 有装配信息 → 仅限装配的技能
    : (s.allowedRoles.includes(expertId) || s.allowedRoles.length === 0))  // 无装配信息 → 退回角色判定
  return getLoadedSkills().filter(s => inScope(s))
}

/**
 * browse 前置：企业「读/查看」意图命中系统 Y 时，若有**绑定同一系统 Y + 读类**的在册技能匹配 →
 * 优先用它（确定性、快、准），不走开放式 browse（临场探索、啰嗦）。用户拍板：「正确系统的读技能优先于 browse」。
 * 安全：写技能不在读路径优先（防「看考勤」触发打卡类写技能）；绑定别的系统的技能不认（防跨系统截胡）。
 * 未命中返回 null → 交由 browse 兜底自适应。
 */
async function pickSystemSkill(query: string, expertId: string, systemId: string, readOnly: boolean): Promise<SkillDefinition | null> {
  if (!systemId) return null
  loadLocalSkills()   // 用最新技能集（与技能路由一致）
  const norm = query.toLowerCase()
  const hits = scopedSkillsFor(expertId).filter(s => s.triggerKeywords.some(kw => norm.includes(String(kw).toLowerCase())))
  for (const s of hits) {
    try {
      if (await skillTargetSystem(s.id) !== systemId) continue  // 必须绑定同一系统（防跨系统截胡：Mock OA 的技能不接讯飞OA 任务）
      if (readOnly && await isWriteSkill(s.id)) continue         // 读路径不选写技能（安全红线）
      return s                                                   // 绑定同一系统且形态匹配 → 优先用它（确定性）
    } catch (e) { swallow(e, 'pick-system-skill') }
  }
  return null
}

/**
 * 企业写任务的 browse 执行（用户拍板"browse 主引擎" + 安全红线）：复杂写（进功能页填表/删行/提交）交 browse 写引擎办，
 * 而非套一个触发词过拟合的现成技能（如"考勤维护"被"上班打卡"截胡）。安全：只读→权限卡（绝不写）；
 * 允许→**前置签名确认**（人工确认+一次性令牌红线）→ browse 用新原语(inspect/hover/search/check/rowaction)自主执行。
 */
async function runEnterpriseWrite(data: AgentTaskData, cleanQuery: string, sys: { systemId: string; systemName: string; baseUrl: string }, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult> {
  trace.markRoute('企业写·browse', `识别为对【${sys.systemName}】的写操作，交 browse 写引擎（读页面自主填表/删行/提交）`)
  // 只读模式：弹权限卡（切档重跑 / 继续只读），绝不写
  if (data.permMode === 'readonly') {
    sendLog('acting', `识别为对【${sys.systemName}】的写操作，当前只读——请选择如何处理…`)
    const choice = await requestPermissionChoice([`在【${sys.systemName}】执行写操作`])
    if (choice === 'switch') {
      await trace.submit('用户选择切到「允许操作」后重跑本任务。', 'BLOCKED', `只读拦截企业写(${sys.systemName})，切档重跑。`)
      return { content: `🔄 已切到「允许操作」，正在按原任务重新执行…（写操作会请你人工确认）`, success: true, traceId: trace.id, permSwitch: true }
    }
    await trace.submit(data.content, 'BLOCKED', `只读拦截企业写(${sys.systemName})（用户选择继续只读）。`)
    return { content: `🔒 已选择继续保持**只读**：对【${sys.systemName}】的写操作已跳过，未做任何改动。`, outcome: 'readonly-blocked', success: true, traceId: trace.id }
  }
  // 允许操作：前置签名确认（红线：写操作须人工确认 + 一次性令牌，B2-2 已双闸接线）。
  // 必须先打一条日志——否则执行卡 header 停在上一步"查阅知识库"，用户以为卡死（实测反馈）。
  sendLog('acting', `请在下方**确认卡**核对将在【${sys.systemName}】执行的写操作，**点确认后**分身才会自主执行…`)
  const sc = await requestSignedConfirmation([
    { name: '_sys', label: '业务系统', value: sys.systemName, type: 'text' },
    { name: '_task', label: '将由分身在该系统读页面自主执行（含最后的提交），请核对无误后确认', value: cleanQuery.slice(0, 300), type: 'text' },
  ], { actionId: `enterprise-write:${sys.systemId}` })
  if (sc.tokenState === 'rejected') {
    await trace.submit(data.content, 'BLOCKED', `企业写(${sys.systemName})：签名令牌拒绝（${sc.rejectReason || ''}）。`)
    return { content: `🚫 安全闸拦截：确认令牌校验未通过（${sc.rejectReason || '过期/重放/表单变更'}），未对【${sys.systemName}】做任何改动。请重新发起。`, outcome: 'blocked', success: true, traceId: trace.id }
  }
  if (!sc.values) {
    await trace.submit(data.content, 'BLOCKED', `企业写(${sys.systemName})：用户取消确认。`)
    return { content: `🚫 已取消，未对【${sys.systemName}】做任何改动。`, outcome: 'blocked', success: true, traceId: trace.id }
  }
  trace.spans.push({ type: 'confirm', name: '写前人工确认', status: 'ok', detail: tokenStateNote(sc.tokenState) })
  sendLog('acting', `在【${sys.systemName}】读页面自主执行写操作…`)
  // 走 runBrowseExecutor（**带登录态预检**）：落在登录页 → 明确回"未登录"，不再让 browse 瞎逛（实测讯飞OA登录态失效教训）。
  // makeBrowseTool 已含 inspect/hover/search/check/rowaction 全部新原语；操作要领作 hint 传入。
  // 操作要领分层（体检 P2-10）：通用要领人人都发；「批量删行」剧本是考勤维护场景的复盘产物，
  // 只在任务确实涉及删除/清除/保留其余时才附加——填请假单的任务不该收到删行教程（会带偏动作选择）。
  const wantsRowDelete = /(删除|删掉|移除|清除|保留.{0,12}(其余|其他|别的))/.test(cleanQuery)
  const deleteHint = wantsRowDelete
    ? `\n3. **批量删除行（关键，绝不要一行一行删）**：要"保留某几行、删掉其余"时——先 **checkall** 全选，再对**要保留的行**用 check（target=该行日期, value=uncheck）取消其勾选，然后**点一次**表格上方/右上角的删除/减号按钮（常是无文字图标，target 写「删除」或「-」）。之后 inspect 一次确认行数正确。`
    : ''
  const hint = `【高效执行——页面慢、每步耗时长，务必少走步：别反复 inspect/observe（每个动作执行后系统已自动回观察给你），别一行一行操作】\n1. 进到功能页后先 inspect **一次**，看清表单字段与表格结构。\n2. 设字段：审批人这类"输入再从候选里选"的控件用 search（target=字段名, value=人名）；一次不成再 fill 后从候选点选。类型/原因等用 select/fill。${deleteHint}\n${wantsRowDelete ? '4' : '3'}. 最后 click 提交，确认页面提示已生效。\n整个流程尽量控制在 12 步内，把时间留给页面加载。`
  const res = await runBrowseExecutor({
    systemId: sys.systemId, systemName: sys.systemName, entryUrl: sys.baseUrl,
    task: data.content, hint, cfg: data.llmConfig, callModel: callLlm, sendLog, maxSteps: 30, budgetMs: 600000,
  })
  if (!res.loggedIn) {
    // 未登录 → 直接在对话里弹**登录卡**（复用系统连接的登录状态复用机制）：点「登录」开登录窗，
    // 登录成功广播 systems:logged-in → 渲染层用 retryContent **自动重跑原任务**（无需用户再发一遍）。
    const content = `⚠️ 需要先登录【${sys.systemName}】才能执行（登录态可能已过期）。点下方「登录」完成后会**自动继续**执行本任务——登录态本地保存、执行时复用，无需在对话里给密码。`
    await trace.submit(content, 'BLOCKED', `企业写(${sys.systemName})：未登录/登录态失效，弹登录卡。`)
    return { content, success: true, traceId: trace.id, loginRequest: { systemId: sys.systemId, systemName: sys.systemName, baseUrl: sys.baseUrl, retryContent: data.content } }
  }
  const content = res.ok
    ? `🤖 已在【${sys.systemName}】读页面自主执行（${res.steps} 步）：${res.outcome || '已完成'}\n\n请到系统核实是否已按预期生效。`
    : `⚠️ 在【${sys.systemName}】执行 ${res.steps} 步后未确认办成：${res.outcome || ''}\n\n请到系统核实；必要时到 FDE 工作台为该操作录一个确定性技能。`
  await trace.submit(content, res.ok ? 'SUCCESS' : 'PARTIAL', `企业写(${sys.systemName}) browse 引擎：${res.steps} 步。`)
  return { content, success: true, traceId: trace.id }
}

/**
 * 通用 Agent 循环入口（P1 检索/计算 + P2 文件）：命中"多步检索+计算"或"读文件取数/算"的复杂任务时，
 * 走 ReAct 循环逐步调工具直至答案；否则返回 null 让主链路继续（技能/单趟联网问答）。
 * **必须在技能路由之前调用**——否则带 .xlsx 附件的文件题会先被 xlsx 技能触发词劫持，永远到不了这里。
 * 与快路径并存：只吃明确复杂档；简单问答/寒暄/生成类技能不受影响。工具全只读/只算，写操作不在其内。
 */
export async function maybeRunAgentLoop(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace,
                                        corporateChunks?: CorporateChunk[]): Promise<AgentResult | null> {
  const expertId = data.expertId || ''
  const cleanQuery = data.content.split('\n').filter(l => !l.startsWith('【')).join(' ').trim() || data.content
  const wsFiles = workspaceFileList()

  // ── 文件在场（保留）：显式附件标记，或问题里点名了工作空间某文件 ──
  const fileMentioned = /【附件】/.test(data.content) || wsFiles.some(f => cleanQuery.toLowerCase().includes(f.toLowerCase()))
  // 「生成交付物」一律让给技能路由——**无条件早返回**，不只是把它从文件任务里排除掉。
  // 真正能产出 .pptx/.docx/.xlsx 的是 pptx/docx/xlsx 技能（沙箱里跑 python-pptx 等真写文件），
  // 通用循环的工具表里根本没有"写文件"这个能力。
  // 之前这条只参与 fileTask 的计算，于是「分析下最新的A股情况，给我做个汇报PPT」被检索意图
  // 抢先接走，跑了 10 轮检索后模型只能说"当前环境无法导出 pptx，请自己复制到 WPS"（实测）。
  // 技能路由那边还有 orchSteps 编排，能把"先检索、再生成"串起来，正是这类复合请求该去的地方。
  if (wantsGeneratedFile(data.content)) return null
  const fileTask = fileMentioned

  // ── 入口判断（保留到阶段 4）：这题该不该走通用循环。技能仍是独立链路，总得有东西分流。 ──
  const webLoop = needsAgentLoop(cleanQuery)
  const openBrowse = needsBrowseAgent(cleanQuery)

  // ── 点名/接续了哪个已登记业务系统 ──
  // 从前这里被一串「读意图」中文正则（readIntent/entDomain/browseVerb）守着才敢查，因为每次都要打后端。
  // 系统列表加了 60s 缓存后，解析可以无条件执行，那三个守门正则随之下线。
  // 写动词表没删、只是降级：移进 write-intent-core 作单一来源（WRITE_TASK_VERB），现在只决定走哪个引擎，
  // 不再是安全判据——判读写意图本就不可靠（「补个卡」「作废掉」曾被判成读），
  // 写保护已由工具层的签字闸兜底，判漏也拦得住。
  let browseSys = await resolveBrowseSystem(cleanQuery).catch((e) => { swallow(e, 'browse-sys'); return null })
  if (!browseSys) {
    // 多轮接续：turn1「打开讯飞OA看待办」→ turn2「再看看考勤」仍指讯飞OA，不被别的系统的技能截胡。
    const recentUser = (data.history || []).filter(h => h.role === 'user').slice(-3).map(h => h.content).join(' ')
    if (recentUser.trim()) {
      browseSys = await resolveBrowseSystem(recentUser).catch((e) => { swallow(e, 'browse-sys-ctx'); return null })
      if (browseSys) sendLog('thinking', `延续上文，仍在【${browseSys.systemName}】里操作`)
    }
  }

  // 这句任务是不是要改动业务系统。只决定**走哪个引擎**，不再充当安全判据——
  // 判漏了也只是走进通用内核，那里的 browse 工具照样在点击写按钮前签字。
  const isWriteTask = !!browseSys && WRITE_TASK_VERB.test(cleanQuery)

  // ── 「正确系统的在册技能」优先于临场浏览（用户拍板）：确定性技能更快更准。 ──
  // 只认绑定该系统的技能，别系统的不认（防触发词截胡）。
  // readOnly 取 !isWriteTask 是**安全红线**：读任务绝不能选中写技能——「只读模式下看考勤却真打了卡」
  // 就是这么出的事故。合并读写两条路时差点把这个区分丢掉。
  if (browseSys) {
    const skill = await pickSystemSkill(cleanQuery, expertId, browseSys.systemId, !isWriteTask)
    if (skill) {
      sendLog('thinking', `【${browseSys.systemName}】已有确定性技能「${skillLabel(skill)}」，优先用它（比临场浏览更快更准）…`)
      data.forcedSkillId = skill.id
      return null
    }
  }

  // ── 企业系统「写」任务：仍走专用写引擎 ──
  // 这条**没有**并入新内核，因为它有三样新内核暂时没有的能力：登录态预检（失效直接弹登录卡+自动重跑）、
  // 任务级一次确认（而非每个按钮弹一次）、只读档的「切档重跑 / 继续只读」选择卡。
  if (isWriteTask && browseSys) {
    return await runEnterpriseWrite(data, cleanQuery, browseSys, sendLog, trace)
  }

  if (!(webLoop || openBrowse || browseSys || fileTask)) return null

  // 联网授权闸：开放网页类（公网检索 / 无点名系统的开放 browse）需岗位授权；
  // 纯文件任务、操作已登记内部系统不需要——那不是联网检索。
  const wantsWeb = webLoop || (openBrowse && !browseSys)
  const allowWeb = wantsWeb && !browseSys ? await getExpertWebSearch(expertId) : false
  if (wantsWeb && !browseSys && !fileTask && !allowWeb) return null

  trace.webSearch = allowWeb
  return await runGeneralTurn({
    data, cleanQuery, sendLog, trace, browseSys, allowWeb,
    hasFiles: needsWorkspaceFiles(data.content, wsFiles), corporateChunks,
  })
}

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

// 旧管线的备料函数 gatherMaterials 已随 runSkillPipeline 下线（见 tag legacy-pipeline-final）。

/**
 * 计划里同时有「自取数技能」和独立「联网检索」步时，砍掉后者。
 *
 * 深度调研自带多轮检索循环（规划子问题 → 检索 → 提炼 → 反思缺口 → 补查），图片/视频生成的
 * 输入就是一句提示词——旁边再挂一个联网检索步纯属重复劳动：同一批网页被搜两遍、读两遍，
 * 慢一倍、模型额度烧两份，用户看到的还是"调研明明在搜，旁边又冒出一堆联网检索"（2026-08-06 反馈）。
 *
 * 判据函数 isSelfFetchingSkill 早就写好放在 skill-exec 里，却**从没有任何调用方**——写了守卫
 * 没接线，等于没写。这里就是它该在的位置：步骤定下来、子目标还没规划之前（goals 与 steps 一一
 * 对应，必须先筛后规划，否则下标错位）。
 */
async function dropRedundantWebSearch(steps: OrchStep[], sendLog: SendLog): Promise<OrchStep[]> {
  if (!steps.some(s => s.type === 'websearch')) return steps
  const selfFetchers: string[] = []
  for (const s of steps) {
    if (s.type !== 'skill') continue
    try { if (await isSelfFetchingSkill(s.skill.id)) selfFetchers.push(skillDisplayName(s.skill.id) || s.skill.name || s.skill.id) }
    catch (e) { swallow(e, 'self-fetch-check') }
  }
  if (!selfFetchers.length) return steps
  const kept = steps.filter(s => s.type !== 'websearch')
  sendLog('thinking', `「${selfFetchers.join('、')}」自带联网检索能力，已省去计划里单独的联网检索步（避免同一批资料搜两遍）`)
  return kept
}

// 执行编排：逐步跑，收集每步的最终 section，最后合并。写子任务的确认弹窗在 runCustomSkill 内部完成。
export async function runOrchestratedSkills(steps: OrchStep[], data: AgentTaskData, sendLog: SendLog, trace: AgentTrace, corporateChunks?: CorporateChunk[]): Promise<AgentResult> {
  steps = await dropRedundantWebSearch(steps, sendLog)
  const goals = await planStepGoals(data.content, steps, data.llmConfig)
  // 展示用友好名：只取技能名，不带内部 id
  const nameOf = (s: OrchStep) => s.type === 'websearch' ? '联网检索'
    : (skillDisplayName(s.skill.id) || (s.skill.name && s.skill.name !== s.skill.id ? s.skill.name : s.skill.id))
  const planList = steps.map((s, i) => `${i + 1}. ${nameOf(s)} —— ${goals[i]}`).join('\n')
  trace.skill = steps.map(s => nameOf(s)).join(' + ')
  trace.markRoute('多步编排', `拆解为 ${steps.length} 个有序子任务：${steps.map(s => nameOf(s)).join(' → ')}`)
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
  const genParts: SkillExecOut[] = []   // 可合并综合（生成/联网/知识型）
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
        // 行情类目标先接口直采快照并入素材（与问答/备料路径同一纪律）
        if (isMarketQuery(goal)) {
          const snap = await fetchMarketQuotes(sendLog)
          if (snap) orchMaterials += (orchMaterials ? '\n\n' : '') + snap
        }
        // 多步计划里的检索子步：产物是给后续生成技能的素材，同属备料语境（不搜载体词）
        const sq = await refineSearchQuery(goal, data.llmConfig, sendLog, undefined, undefined, true, data.history)
        const r = await webSearch(sq, sendLog, data.llmConfig)
        trace.sources.push(...r.results.map(x => ({ title: x.title, url: x.url })))
        // 结果卡「联网来源」：优先已深读的网页，不足再补搜索结果；标题缺失兜底为域名
        const readUrls = new Set(r.pages.map(p => p.url))
        for (const p of r.pages) webSources.push({ title: p.title || p.url, url: p.url })
        for (const x of r.results) if (!readUrls.has(x.url)) webSources.push({ title: x.title || x.url, url: x.url })
        if (r.results.length === 0) {
          genParts.push({ skillResult: `⚠️ 联网检索「${sq}」未返回结果。`, skillPromptHint: `【联网检索“${goal}”】今天是 ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}（用户说的"昨天/上周"等相对日期一律按此换算，**绝不凭记忆猜日期**）。对「${sq}」未返回任何结果，请如实说明暂未检索到、可能网络受限，不要编造结果或链接。` })
        } else {
          const lines = r.results.map((x, k) => `${k + 1}. [${x.tier || sourceTier(x.url)}] ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
          const pageBlocks = r.pages.map(p => `【来源：${p.title}｜${p.url}｜信源级别：${p.tier || sourceTier(p.url)}】\n${p.text}`).join('\n\n')
          // 检索结果同时留一份当「素材」交给后续技能 —— 以前只进 genParts（喂最后那段总结回复），
          // 后面的生成技能拿不到，照样在真空里写出「待填充」空壳。
          orchMaterials = `${lowTrustNotice(r)}— 联网检索「${sq}」的真实结果 —\n${lines}\n\n— 头部网页正文 —\n${pageBlocks || '（未提取到正文，仅有摘要）'}`
          genParts.push({ skillResult: `已联网检索「${sq}」并综合。`, skillPromptHint: `${lowTrustNotice(r)}【联网检索“${goal}”的真实结果】今天是 ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}。\n— 结果列表 —\n${lines}\n— 头部网页正文 —\n${pageBlocks || '（未能提取到正文，仅有摘要）'}\n请基于以上真实内容作答；留意各条日期，优先当日最新，若多为往年回顾则如实说明"未获取到当日最新，以下为近期可查资料"，绝不把往年标注成"今日/最新"；**不要在正文罗列来源链接**（界面会单独以「联网来源」卡展示）。` })
        }
        stepStat.push({ label, status: 'ok' })
      } else {
        const out: SkillExecOut = { skillResult: '', skillPromptHint: '' }
        // 写步骤优先走本体候选消解（读真实候选 → 全部/指定下拉），命中即用；未命中再回退录制技能（固定单目标）。
        let done: AgentResult | null = null
        if (await isWriteSkill(step.skill.id)) {
          try { done = await runOntologyHook(stepData, sendLog, trace, { noPermGate: true }) } catch (e) { swallow(e, 'orch-onto') }
          if (done) sendLog('acting', `「${label}」经本体候选消解处理。`)
        }
        if (!done) done = await runCustomSkill(step.skill, label, stepData, sendLog, trace, out, undefined, orchMaterials || undefined)
        if (done) {
          // 写入/读取直达/拦截类：已是终态文本（含人工确认结果）→ 单独成文，不并入统一综合
          // 结构化终态优先（AgentResult.outcome），文案正则仅旧产出兜底（体检 P2-11）
          const isReadonlyBlock = done.outcome === 'readonly-blocked' || (!done.outcome && /^🔒|只读模式/.test(done.content))
          if (isReadonlyBlock) {
            // 只读拦截：不把整段 🔒 文本塞进正文，改由顶部统一横幅提示（避免淹没在末尾）
            readonlyBlocked.push(label)
            stepStat.push({ label, status: 'blocked' })
          } else {
            const blocked = done.outcome === 'blocked' || (!done.outcome && /^🚫|已取消|拦截/.test(done.content))
            terminalBodies.push(done.content)
            if (done.files?.length) allFiles.push(...done.files)
            stepStat.push({ label, status: blocked ? 'blocked' : 'ok' })
          }
        } else {
          // 生成/知识型：文件已在沙箱内产出（out.skillFiles）→ 结果并入统一综合
          genParts.push({ skillResult: out.skillResult, skillPromptHint: `【“${label}”· 面向"${goal}"的真实结果】\n${out.skillPromptHint}` })
          if (out.skillFiles?.length) allFiles.push(...out.skillFiles)
          // 前序产出接力：总结/知识类步骤的结果并入素材，后续生成技能（PPT/Word）才拿得到
          // "第一步的总结"——此前只有联网步写 orchMaterials，技能→技能链路真空，
          // 第二步在沙箱里只能以"素材不足"拒产出（实锤：昨天AI动态→汇报PPT 两连败）。
          if (out.skillPromptHint) {
            orchMaterials += (orchMaterials ? '\n\n' : '') + `【前序步骤「${label}」的真实产出】\n${String(out.skillPromptHint).slice(0, 6000)}`
          }
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
    const combinedHint = `今天是 ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}——涉及日期一律以此为准换算（"昨天"＝它的前一天），**绝不凭记忆或猜测写日期**。\n以下是同一个请求下多项工作的真实执行结果。请用**一段自然、连贯的话统一汇报**：只用一次称呼、不要分“第一步/第二步”、不要重复问候语、不要给每项加小标题；把它们当作一件事的多个产出，简洁说明各产出了什么即可（文件明细由下方文件卡展示，无需罗列文件名/大小/路径）。\n**严格只依据下面给出的真实结果作答**：${otherHandled ? '用户请求里的其它诉求（尤其写操作/审批）已由系统另行处理（拦截或单独确认），本段**绝对不要提及、不要描述其状态、不要给"系统无法完成/请手动操作"之类的说法或指引**——只汇报下面这些已完成的产出。' : '不要提及或臆测任何未在下面结果中出现的事项。'}\n\n${genParts.map(r => r.skillPromptHint).filter(Boolean).join('\n\n———\n\n')}${otherHandled ? '\n\n【最后再次强调】你的这段话只覆盖上面给出的产出；用户请求中的审批/写操作部分已由系统单独处理并会单独呈现给用户——你若提及它（包括"需您手动/我无法代为执行/涉及权限"等任何说法）即为错误输出。' : ''}`
    const res = await synthesizeSkillAnswer(data, sendLog, trace, { skillResult: combinedResult, skillPromptHint: combinedHint, skillFiles: files, corporateChunks })
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

// 旧技能主管线 runSkillPipeline 已于 v2.0.0 下线（AgentCore run_skill 工具化取代）。
// 完整实现见 tag legacy-pipeline-final；本文件保留的 scopedSkillsFor / 执行编排仍被新内核共用。
