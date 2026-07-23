// 任务编排（planner-executor）与技能主管线：意图短路（记忆/定时）→ 分层路由
// （关键词快路径 → 模型意图路由）→ 单技能/多技能编排执行 → 结果合成。
// 纯搬迁自 main.ts，不改逻辑。
// ⚠️ 属技能链路：行为正确性冒烟测不到，改动后需真跑一次读取类 + 写入类技能验证。
import { configGet, configSet } from './db'
import { type LlmConfig, callLlm } from './llm'
import { swallow } from './util'
import { requestPermissionChoice, requestFormConfirmation } from './automation-runtime'
import { webSearch, isWebSearchIntent, isTimeSensitive, refineSearchQuery, getExpertWebSearch, shouldWebSearch, shouldFetchMaterials, isMarketQuery, fetchMarketQuotes, lowTrustNotice, followUpSearches, outcomeBlock } from './web-search'
import type { CorporateChunk } from './corporate-rag'
import { KB_CONFIDENT, kbTopScore, sourceTier, isMultiHopQuestion, isSelfContainedMath, needsAgentLoop, needsBrowseAgent } from './web-search-core'
import { runAgentLoop } from './agent-loop'
import { defaultP1Tools, defaultP2Tools, defaultP3Tools, enterpriseBrowseTools, workspaceFileList } from './agent-tools'
import { focusRecent, focusEvents } from './db'
import { focusMentioned, renderFocusBlock } from './focus-core'
import { type SkillDefinition, getLoadedSkills, loadLocalSkills, skillLabel, skillDisplayName, syncMineSkills } from './skill-store'
import { getAdminBaseUrl, afetch } from './http'
import { runMemoryWrite, runScheduleCreate, synthesizeSkillAnswer } from './agent-steps'
import { runSkillCreate } from './skill-create-chat'
import { routeSkillsByIntent, getSkillType, isGenerativeSkill, isWriteSkill, skillTargetSystem } from './skill-exec'
import { formatRouterContext, buildRouteText, SHORT_CONFIRM } from './skill-router-core'
import { runCustomSkill } from './skill-custom'
import { runOntologyHook } from './agent-ontology'
import { resolveBrowseSystem } from './ontology-runtime'
import { runBrowseExecutor } from './browse-executor'
import { AgentTrace } from './agent-trace'
import type { AgentTaskData, AgentResult } from './agent-types'
import { type SendLog } from './types'

// runCustomSkill（自定义技能真实执行）已拆至 skill-custom.ts。

// 岗位在册技能集（装配的 boundSkills ∪ 本人私有 userSkills；无装配退回角色）——技能路由与 browse 前置检查共用一份，避免重复漂移。
function scopedSkillsFor(expertId: string): SkillDefinition[] {
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
    return { content: `🔒 已选择继续保持**只读**：对【${sys.systemName}】的写操作已跳过，未做任何改动。`, success: true, traceId: trace.id }
  }
  // 允许操作：前置签名确认（红线：写操作须人工确认 + 一次性令牌）。
  // 必须先打一条日志——否则执行卡 header 停在上一步"查阅知识库"，用户以为卡死（实测反馈）。
  sendLog('acting', `请在下方**确认卡**核对将在【${sys.systemName}】执行的写操作，**点确认后**分身才会自主执行…`)
  const rc = await requestFormConfirmation([
    { name: '_sys', label: '业务系统', value: sys.systemName, type: 'text' },
    { name: '_task', label: '将由分身在该系统读页面自主执行（含最后的提交），请核对无误后确认', value: cleanQuery.slice(0, 300), type: 'text' },
  ])
  if (!rc || Object.keys(rc).length === 0) {
    await trace.submit(data.content, 'BLOCKED', `企业写(${sys.systemName})：用户取消确认。`)
    return { content: `🚫 已取消，未对【${sys.systemName}】做任何改动。`, success: true, traceId: trace.id }
  }
  sendLog('acting', `在【${sys.systemName}】读页面自主执行写操作…`)
  // 走 runBrowseExecutor（**带登录态预检**）：落在登录页 → 明确回"未登录"，不再让 browse 瞎逛（实测讯飞OA登录态失效教训）。
  // makeBrowseTool 已含 inspect/hover/search/check/rowaction 全部新原语；操作要领作 hint 传入。
  const hint = `【高效执行——页面慢、每步耗时长，务必少走步：别反复 inspect/observe（每个动作执行后系统已自动回观察给你），别一行一行操作】\n1. 进到功能页后先 inspect **一次**，看清表单字段与表格结构。\n2. 设字段：审批人这类"输入再从候选里选"的控件用 search（target=字段名, value=人名）；一次不成再 fill 后从候选点选。类型/原因等用 select/fill。\n3. **批量删除行（关键，绝不要一行一行删）**：要"保留某几行、删掉其余"时——先 **checkall** 全选，再对**要保留的行**用 check（target=该行日期, value=uncheck）取消其勾选，然后**点一次**表格上方/右上角的删除/减号按钮（常是无文字图标，target 写「删除」或「-」）。之后 inspect 一次确认行数正确。\n4. 最后 click 提交，确认页面提示已生效。\n整个流程尽量控制在 12 步内，把时间留给页面加载。`
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
  // 文件在场：显式 @附件 标记，或问题里点名了工作空间某文件 → 走带 read_file 的 agent 循环
  const fileMentioned = /【附件】/.test(data.content) || wsFiles.some(f => cleanQuery.toLowerCase().includes(f.toLowerCase()))
  // 文件**取数/计算/查值**意图（区别于"生成/转换文件"——那走 xlsx/docx 技能）
  const fileCompute = /\b(how many|how much|what (is|are|was|were)|total|sum|count|average|which|list|calculate|difference)\b|多少|总[数计和额]|统计|计算|平均|哪[一个些项]|列出|差[值多]/i.test(cleanQuery)
  const fileGen = /(生成|制作|导出|新建|做一?[份个]|写一?[份个]|整理成|汇总成|转成|排版成|做成|输出成).{0,6}(文档|word|docx|表格|excel|xlsx|ppt|pptx|幻灯|演示|报告|海报|pdf|文件|材料)/.test(data.content)
  const fileTask = fileMentioned && fileCompute && !fileGen
  const webLoop = needsAgentLoop(cleanQuery)
  // browse 触发两路：① 开放网页 heuristic needsBrowseAgent（导航/点击/填表/下单…，WebArena 类）；
  // ② **明确点名已登记业务系统 + browse 意图** → 走 browse（带该系统登录态），**压过技能触发词过拟合**
  //    （用户说「打开讯飞OA看待办」，绝不能被绑定 Mock OA 的「待办」技能靠触发词截胡开错系统——实测教训）。
  //    这条在技能路由**之前**命中即接走，是"显式点名系统 > 触发词"的正解。resolveBrowseSystem 只在
  //    有 browse 意图时才 afetch（不污染每条消息热路径），未点名已登记系统则不走此路（退回技能/问答）。
  // ⚠️ 安全红线：通用 browse 路由**无写确认闸**，故给企业系统挂登录态**只在读/查看意图**下发生；
  //    任何写动词（提交/审批/办理/新建/打卡…）一律排除——写操作走本体钩子/技能的「人工确认+一次性令牌」闸，
  //    绝不给写意图挂企业登录态去无确认操作（实测教训：只读模式下「看考勤」误触打卡技能真打了卡）。
  const writeVerb = /(提交|审批|批准|同意|通过|驳回|退回|办理|处理|新建|创建|发起|录入|填写|上报|打卡|签到|签退|删除|修改|更新|保存|下单|预约|申请)/.test(cleanQuery)
  const readIntent = !writeVerb && /(打开|登录|进入|访问|查看|看一?下|看看|瞧瞧|瞅瞅|查一?下|查询|查阅|浏览|门户)/.test(cleanQuery)
  // 企业域名词：既作读意图的补充信号，也作「未点名系统」时**上下文接续**的资格（避免把「看看天气」也接续到企业系统）。
  const entDomain = !writeVerb && /(待办|待批|待处理|待审|待签|考勤|排班|日程|邮件|通知|公告|审批单|工单|流程|申请单|报销单|记录|列表)/.test(cleanQuery)
  const browseVerb = readIntent || entDomain   // 读/查看意图，或提到企业域名词（且非写意图）
  // 企业登录态**只在读意图下**解析并挂载（browseVerb），needsBrowseAgent 的开放网页/写意图不挂企业登录态。
  let browseSys: { systemId: string; systemName: string; baseUrl: string } | null = null
  if (browseVerb) {
    try { browseSys = await resolveBrowseSystem(cleanQuery) } catch (e) { swallow(e, 'browse-sys') }
    // 多轮上下文接续：当前没点名系统但是「企业域读意图」→ 从最近用户轮次继承系统
    //（turn1「打开讯飞OA看待办」→ turn2「再看看考勤」仍指讯飞OA，不被绑定别的系统的技能截胡）。
    if (!browseSys && entDomain) {
      const recentUser = (data.history || []).filter(h => h.role === 'user').slice(-3).map(h => h.content).join(' ')
      if (recentUser.trim()) { try { browseSys = await resolveBrowseSystem(recentUser) } catch (e) { swallow(e, 'browse-sys-ctx') } }
      if (browseSys) sendLog('thinking', `延续上文，仍在【${browseSys.systemName}】里查看`)
    }
    // 「正确系统的读技能优先于 browse」（用户拍板）：命中系统 Y 且有「绑定 Y + 读类」的在册技能 →
    // 交回技能路由用**确定性技能**执行（快/准/不啰嗦），不走开放式 browse。写技能/别系统技能不认（防截胡）。
    if (browseSys) {
      const readSkill = await pickSystemSkill(cleanQuery, expertId, browseSys.systemId, true)
      if (readSkill) {
        sendLog('thinking', `【${browseSys.systemName}】已有确定性读技能「${skillLabel(readSkill)}」，优先用它（比临场浏览更快更准）…`)
        data.forcedSkillId = readSkill.id   // 交回技能路由确定性执行该技能（绕开 browse 的临场探索）
        return null
      }
    }
  }
  // ===== 企业写任务：写动词 + 点名/接续已登记系统 → browse 写引擎(新原语)+确认，压过技能触发词过拟合 =====
  // （用户实测「进入考勤维护…提交」被绑 Mock OA 的「上班打卡」技能截胡——复杂写该走 browse+确认，不是套现成技能。）
  if (writeVerb) {
    let writeSys = await resolveBrowseSystem(cleanQuery)
    if (!writeSys) {   // 接续最近用户轮次（同读路径：turn1 点名讯飞OA → turn2 写指令仍指讯飞OA）
      const recentUser = (data.history || []).filter(h => h.role === 'user').slice(-3).map(h => h.content).join(' ')
      if (recentUser.trim()) { try { writeSys = await resolveBrowseSystem(recentUser) } catch (e) { swallow(e, 'write-sys-ctx') } }
    }
    if (writeSys) {
      const skill = await pickSystemSkill(cleanQuery, expertId, writeSys.systemId, false)
      if (skill) { sendLog('thinking', `【${writeSys.systemName}】已有确定性技能「${skillLabel(skill)}」，优先用它…`); data.forcedSkillId = skill.id; return null }
      return await runEnterpriseWrite(data, cleanQuery, writeSys, sendLog, trace)
    }
  }
  const browseTask = needsBrowseAgent(cleanQuery) || (!!browseSys && browseVerb)
  if (!(webLoop || fileTask || browseTask)) return null
  // 联网授权闸：开放网页类（web 检索 / 无点名系统的开放 browse）需联网授权；纯文件循环、
  // **操作已登记企业系统的 browse（browseSys 命中）**不需——那是操作内部系统、非联网检索。
  if ((webLoop || (browseTask && !browseSys)) && !fileTask && !(await getExpertWebSearch(expertId))) return null

  trace.webSearch = webLoop || (browseTask && !browseSys)
  const kind = browseTask ? '网站操作' : `${fileTask ? '含文件' : ''}${webLoop && fileTask ? '+' : ''}${webLoop ? '检索+计算' : ''}`
  trace.markRoute('通用Agent循环', `判定为多步任务（${kind}）：ReAct 循环逐步调用工具直至得出答案`)
  const loopSpan = trace.beginSpan('web', '通用Agent循环', { stage: '执行' })
  // browseSys 已在上方（触发判定处）解析：命中已登记业务系统时带其 persist:bizsys-<id> 分区复用受管登录态。
  if (browseSys) sendLog('thinking', `browse 复用【${browseSys.systemName}】本地登录态（无需重新登录）`)
  const kbContext = corporateChunks?.length ? `【企业知识库命中（可作参考）】\n${corporateChunks.slice(0, 3).map((c, i) => `${i + 1}. ${c.text.slice(0, 300)}`).join('\n')}` : ''
  const fileContext = wsFiles.length ? `【工作空间可用文件（可用 read_file 读取）】\n${wsFiles.join('、')}` : ''
  // browse 命中业务系统：告知已登录+入口，并**不灌工作空间文件清单**——否则 agent 卡登录页会误去 read_file 跑偏（实测讯飞OA教训）。
  const browseContext = browseSys
    ? `【目标业务系统】${browseSys.systemName}（入口 ${browseSys.baseUrl}）。你**已登录**该系统（登录态已复用）。\n【只能用 browse 工具操作这个系统】这是企业内部系统，**没有也不需要联网检索**：只用 browse 一步步 goto/observe/click/read；绝不要用 web_search/read_page 去搜内部地址（内部 URL 联网搜不到，只会跑偏读到无关公网页）。\n【要看清真实数据，别只凭首页数字推测】从入口 observe 看清导航菜单，**点进对应功能的实际列表/详情页**读取真实条目再回答；不要只看门户首页的角标/汇总数字（如「9 考勤维护」）就下结论——那可能不准；列表长就 scroll 逐屏看清、需要计数用 python 精确数。\n【这是查看/读取任务（只读）】只浏览、导航、读取并如实整理回答；**绝不点击提交/保存/打卡/签到/审批/新建/删除等任何会改动数据的写按钮**——用户只是要看，不要替他做任何写入。`
    : ''
  const ctx = [browseContext, kbContext, browseSys ? '' : fileContext].filter(Boolean).join('\n\n')
  // 工具集：① 企业系统 browse（browseSys 命中）→ **收敛工具集**（只 browse+python，不含 web_search/read_page/read_file）——
  //           操作内部系统不该联网检索，曾致 agent 拿内部 URL 去 web_search、接口不通退浏览器搜、读一堆无关公网页，
  //           65 步/337 秒混乱且答非所问（实测教训）；② 开放网页 browse → 全 P3 工具集；③ 带文件 P2；④ 否则 P1。
  const tools = browseTask
    ? (browseSys ? enterpriseBrowseTools({ partition: `persist:bizsys-${browseSys.systemId}` })
                 : defaultP3Tools(data.llmConfig))
    : (fileTask || wsFiles.length) ? defaultP2Tools(data.llmConfig)
    : defaultP1Tools(data.llmConfig)
  const res = await runAgentLoop({
    task: cleanQuery, tools, cfg: data.llmConfig, sendLog, callModel: callLlm,
    // maxSteps 14 够追链尾（实测 fr04/fr06 跑满 12 步）；墙钟 330s 预算——慢工具（GAIA 深读/文件）超预算就主动收尾，
    // 不被外层硬 timeout 砍成空答（实测 ga05 跑满 423s 空答教训）。
    contextBlock: ctx || undefined, maxSteps: 14, budgetMs: 330_000,
  })
  loopSpan.end(res.finished ? 'ok' : 'warn', `${res.steps.length} 步 · ${res.finished ? '得出答案' : '步数上限收尾'}`)
  trace.attachIo(loopSpan.id, '通用Agent循环', cleanQuery,
    res.steps.map(s => `[${s.n}] ${s.finish ? 'finish' : s.tool + '(' + JSON.stringify(s.args) + ')'}\n${s.observation || ''}`).join('\n\n'))
  await trace.submit(res.answer, res.finished ? 'SUCCESS' : 'PARTIAL',
    `通用 Agent 循环：${res.steps.length} 步工具调用（${tools.map(t => t.name).join('/')}），基于真实观察作答。`)
  sendLog('completed', `[Completed] 通用 Agent 循环完成（${res.steps.length} 步）。`)
  return { content: res.answer, success: true, traceId: trace.id }
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
  if (doSearch) {
    sendLog('thinking', '这份材料要用到外部数据，先联网取回来再动笔…')
  } else if (isTimeSensitive(data.content) && await getExpertWebSearch(expertId)) {
    // 时效数据(今天/最新/行情/新闻…)确定性触发备料——曾交模型裁量,同一句话时而不搜,
    // 素材为零→沙箱只能 NO_DATA 拒产出。时效词在,备料就不掷骰子。
    // ⚠️ 不受知识库强命中短路：KB 里的是**快照**（实锤：讯飞股票问题命中 4 条 KB 就不联网，
    // 数据停在 7月15日）。时效问题 KB 素材照常注入，联网**并行**补最新，两路一起综合。
    doSearch = true
    sendLog('thinking', kbTopScore(kb) >= KB_CONFIDENT
      ? '知识库有相关资料（历史快照，照常采用），内容涉及时效数据——并行联网补最新…'
      : '内容涉及“今天/最新”等时效数据，直接联网备料…')
  } else if (kbTopScore(kb) < KB_CONFIDENT && await getExpertWebSearch(expertId)) {
    // 用**备料**判定，不是问答判定：后者问"要回答这个问题需不需要联网"，
    // 面对"生成股票信息汇报的 word 和 ppt"会答"不需要"（它把这读成一个会做的文档任务）→ 空壳照旧。
    // 判定函数自带叙述，这里不再重复播报（曾经两条几乎相同的"先联网取回来"连播，界面很业余）。
    doSearch = await shouldFetchMaterials(cleanQuery, data.llmConfig, sendLog, kb, data.history)
  }
  if (doSearch) {
    trace.webSearch = true
    const gatherSpan = trace.beginSpan('web', '联网备料', { stage: '检索' })
    try {
      // 行情类任务先接口直采硬数字（确定性来源），检索只补背景叙事——
      // 指数点位从新闻转述里抄,旧文/自媒体错数事故已实锤两次
      if (isMarketQuery(cleanQuery)) {
        const snap = await fetchMarketQuotes(sendLog)
        if (snap) parts.push(snap)
      }
      // 备料模式：检索词只针对内容数据，载体词（PPT/模板…）被禁止并硬剥离
      const sq = await refineSearchQuery(cleanQuery, data.llmConfig, sendLog, undefined, undefined, true, data.history)
      const r = await webSearch(sq, sendLog, data.llmConfig)
      gatherSpan.end(r.results.length ? 'ok' : 'warn', `检索词「${sq}」→ ${r.results.length} 条结果 · 深读 ${r.pages.length} 篇`)
      trace.attachIo(gatherSpan.id, '联网备料', `任务：${cleanQuery}\n改写检索词：${sq}`, outcomeBlock('备料结果', r))
      trace.sources.push(...r.results.map(x => ({ title: x.title, url: x.url })))
      const readUrls = new Set(r.pages.map(p => p.url))
      for (const pg of r.pages) sources.push({ title: pg.title || pg.url, url: pg.url })
      for (const x of r.results) if (!readUrls.has(x.url)) sources.push({ title: x.title || x.url, url: x.url })
      if (r.results.length) {
        // 信源级别标签:后端标注优先(单一来源,支持管理端自配名单),本地 sourceTier 只兜底旧后端/浏览器路径
        const lines = r.results.map((x, k) => `${k + 1}. [${x.tier || sourceTier(x.url)}] ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
        const pageBlocks = r.pages.map(pg => `【来源：${pg.title}｜${pg.url}｜信源级别：${pg.tier || sourceTier(pg.url)}】\n${pg.text}`).join('\n\n')
        const firstBlock = `— 联网检索「${sq}」的真实结果 —\n${lines}\n\n— 头部网页正文 —\n${pageBlocks || '（未提取到正文，仅有摘要）'}`
        // 多跳补查（对标"先搜出决赛对阵=谁vs谁，再带着队名挖晋级之路/首发"的检索方式）：
        // 从首轮素材提取**新获知的关键实体** → 生成 ≤3 个带实体的补查词 → 逐个检索、跨轮去重。
        // 旧版只补 1 个词且不回灌实体，二跳信息（先查到对象、再查对象详情）拿不到。
        let merged = r
        const fillBlocks: string[] = []
        try {
          const seen = new Set<string>([...r.results.map(x => x.url), ...r.pages.map(p => p.url)])
          const fills = await followUpSearches(cleanQuery, firstBlock, seen, data.llmConfig, sendLog, 3,
            (q, out, ms) => {
              const hid = 'hop' + (trace.spans.length + 1) + '-' + Date.now().toString(36)
              trace.spans.push({ type: 'web', name: `补查·${q}`, status: out.results.length ? 'ok' : 'warn', stage: '检索', atMs: Math.max(0, Date.now() - trace.start - ms), durationMs: ms, pid: gatherSpan.id, id: hid, detail: `${out.results.length} 条新结果 · 深读 ${out.pages.length} 篇` })
              trace.attachIo(hid, `补查·${q}`, `补查检索词：${q}`, outcomeBlock('补查结果', out))
            })
          for (const f of fills) {
            trace.sources.push(...f.out.results.map(x => ({ title: x.title, url: x.url })))
            const read2 = new Set(f.out.pages.map(p => p.url))
            for (const pg of f.out.pages) sources.push({ title: pg.title || pg.url, url: pg.url })
            for (const x of f.out.results) if (!read2.has(x.url)) sources.push({ title: x.title || x.url, url: x.url })
            fillBlocks.push(outcomeBlock(`补查「${f.query}」的结果`, f.out))
            merged = { ...merged, results: [...merged.results, ...f.out.results], pages: [...merged.pages, ...f.out.pages] }
          }
        } catch (e) { swallow(e, 'gather-gap') }
        // 低信源警示按**合并后**素材计算：补查可能带回权威信源，别拿首轮结论吓唬全程
        parts.push(`${lowTrustNotice(merged)}${firstBlock}`)
        parts.push(...fillBlocks)
      } else {
        sendLog('observing', `联网检索「${sq}」没返回结果。`)
      }
    } catch (e) { swallow(e, 'gather-materials') }
  }
  return { materials: parts.join('\n\n'), webSources: sources.slice(0, 8) }
}

// 执行编排：逐步跑，收集每步的最终 section，最后合并。写子任务的确认弹窗在 runCustomSkill 内部完成。
export async function runOrchestratedSkills(steps: OrchStep[], data: AgentTaskData, sendLog: SendLog, trace: AgentTrace, corporateChunks?: CorporateChunk[]): Promise<AgentResult> {
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

export async function runSkillPipeline(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace,
                                      opts?: { corporateChunks?: CorporateChunk[] }): Promise<AgentResult | null> {
  const normalized = data.content.toLowerCase()
  const expertId = data.expertId || ''

  // 「记住 X」意图优先：提炼并写入个人长期记忆，命中即短路（不误路由到技能/联网）
  const remembered = await runMemoryWrite(data, sendLog, trace)
  if (remembered) return remembered

  // 「每天/每周…定时做某事」意图：解析成自动化定时任务，命中即短路
  const scheduled = await runScheduleCreate(data, sendLog, trace)
  if (scheduled) return scheduled

  // 「创建技能」意图：会话内直通 skill-creator 引擎（追问经表单卡、终确认后落库），命中即短路
  const created = await runSkillCreate(data, sendLog, trace)
  if (created) return created

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

  // ── 通用 Agent 循环（在技能路由**之前**）：多步检索+计算、或读文件取数/算 的复杂任务优先走循环，
  // 否则带 .xlsx 附件的文件题会被 xlsx 技能触发词劫持。命中即早返回；未命中继续技能/单趟问答。
  {
    const loopRes = await maybeRunAgentLoop(data, sendLog, trace, opts?.corporateChunks)
    if (loopRes) return loopRes
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
  // 追问补答的**确定性重入**：上一轮技能因缺参暂停（pending-skill），本轮短回复（如"审批人：昕宇"）
  // 直接拉回该技能——不赌语义路由（实测补答被路由进裸问答，模型编造"申请已生成并准备推送"，红线事故）。
  // 只拉短消息（≤40字，典型补参回复）；长消息多半是新任务，不误拉。过期（>10min）作废。
  if (!data.forcedSkillId) {
    try {
      const raw = configGet('pending-skill')
      if (raw) {
        const p = JSON.parse(raw)
        const fresh = p && p.at && (Date.now() - p.at) < 10 * 60 * 1000
        const sameConv = !p.convId || !data.convId || p.convId === data.convId
        if (fresh && sameConv && String(data.content || '').trim().length <= 40 && p.skillId) {
          data.forcedSkillId = String(p.skillId)
          sendLog('thinking', '接续上一轮暂停的技能（补充参数后继续办理）…')
        }
        if (!fresh) configSet('pending-skill', '')
      }
    } catch (e) { swallow(e, 'pending-skill-resume') }
  }
  if (data.forcedSkillId) {
    // ① 用户在「业务技能」里显式锁定 → 直接用它，零歧义
    const s = getLoadedSkills().find(x => x.id === data.forcedSkillId)
    if (s) skillsToRun = [s]
    else {
      // 本地池没有 ≠ 不存在：刚保存的私有技能要等 30s 心跳同步，存完立刻锁定发起就会扑空。
      // **按 id 直取后端**兜底（存完即可用），顺手触发一次私有技能同步让下次本地就有。
      try {
        const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${data.forcedSkillId}`)
        if (r.ok) {
          const full: any = await r.json()
          if (full && full.id) {
            skillsToRun = [{ id: String(full.id), name: String(full.name || data.forcedSkillId), description: String(full.description || ''), triggerKeywords: Array.isArray(full.triggerKeywords) ? full.triggerKeywords : [], allowedRoles: Array.isArray(full.allowedRoles) ? full.allowedRoles : [], sopContent: String(full.sopContent || '') }]
            void syncMineSkills()
          }
        }
      } catch (e) { swallow(e, 'forced-skill-fetch') }
      // 仍找不到 → **明确报错收尾**。绝不静默降级成"裸问答+联网检索"——用户锁了技能却得到一篇
      // 网搜攻略、且毫无提示，是最坏的失败方式（2026-07-22 考勤3 正是这么翻车的）。
      if (!skillsToRun.length) {
        sendLog('completed', `未找到锁定的技能（${data.forcedSkillId}），已停止，未执行任何操作。`)
        return { content: `⚠️ 未能执行：找不到你锁定的技能（${data.forcedSkillId}）。它可能刚保存尚未同步、或已被删除。请稍等几秒重试，或到「技能」页确认它还在。`, success: true }
      }
    }
  } else {
    const scoped = scopedSkillsFor(expertId)   // 岗位在册技能集（装配 ∪ 本人私有；无装配退角色）——与 browse 前置检查共用
    // ② 关键词快路径：命中的全部技能（确定、零成本），按命中数降序
    const keywordHits = scoped
      // 触发词统一小写再比(normalized 已小写):本地加载器虽已归一,但 userSkills/直传路径可能带大写——"PPT"对小写文本永不命中
      .map(s => ({ s, hits: s.triggerKeywords.filter(kw => normalized.includes(String(kw).toLowerCase())).length }))
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
    return await runOrchestratedSkills(orchSteps, data, sendLog, trace, opts?.corporateChunks)
  }

  // 自足算术题闸（生成技能侧）：纯计算题被路由进 pptx/docx，回「已生成文档」却不给答案
  //（留出测量实锤 gs16/gs14，~2/60）。题面自带全部数字、且用户没有**显式**要文件载体
  //（做成/生成/导出 + PPT/文档/表格…）时，剔除生成类技能 → 走问答直接算。
  if (skillsToRun.length && isSelfContainedMath(data.content)) {
    const explicitFile = /(做成|生成|导出|输出|写成|整理成|make|create|generate|export).{0,8}(ppt|pptx|word|docx|excel|xlsx|pdf|文档|表格|幻灯|演示|报告|文件|document|presentation|slide|spreadsheet|report|file)/i.test(data.content)
    if (!explicitFile) {
      const kept: SkillDefinition[] = []
      for (const s of skillsToRun) { if (!(await isGenerativeSkill(s.id))) kept.push(s) }
      if (kept.length !== skillsToRun.length) {
        sendLog('thinking', '这是一道自足的计算题且未要求生成文件，直接计算作答（不产文档）…')
        skillsToRun = kept
      }
    }
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
    const gens = await Promise.all(skillsToRun.map(s => isGenerativeSkill(s.id)))
    if (gens.some(Boolean)) {
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
    // 自足算术应用题（GSM8K 类）：题面自带全部数字，联网无意义还分心——不进联网判定，直接本地作答。
    // 除非用户显式说"搜一下"（isWebSearchIntent 已置 doSearch=true）。实锤：gs21/gs22 因叙事里的
    // "now/recent" 命中时效词被误联网，反而没算数（2026-07 Round3）。
    const selfMath = isSelfContainedMath(cleanQuery)
    if (selfMath && !doSearch) sendLog('thinking', '这是一道自足的计算题，题面已含全部数据，直接算不联网…')
    if (!doSearch && !selfMath && await getExpertWebSearch(expertId)) {
      if (isTimeSensitive(cleanQuery)) {
        // 命中时效词（今天/今年/本届/最新/行情…）→ 确定性联网，不再交模型掷骰子
        //（实锤：「根据今年世界杯之前的比赛情况」同一问题上轮判"要"这轮判"不要"，直接空答）。
        // 且**优先于知识库强命中短路**：KB 是快照不是行情（实锤：讯飞股票命中 4 条 KB 便不联网，
        // 数据停在 7月15日）——KB 素材照常注入，联网并行补最新，两路一起综合。
        doSearch = true
        sendLog('thinking', kbTop >= KB_CONFIDENT
          ? '知识库有相关资料（历史快照，照常采用），问题涉及时效——并行联网取最新数据…'
          : '问题锚定当前现实周期（时效词命中），确定性联网取最新事实…')
      } else if (kbTop >= KB_CONFIDENT) {
        sendLog('thinking', `企业知识库已命中相关资料（${kb.length} 条），直接作答，不联网。`)
      } else {
        doSearch = await shouldWebSearch(cleanQuery, data.llmConfig, sendLog, kb, data.history)
      }
    }
    if (doSearch) {
    isSkillTriggered = true
    trace.webSearch = true
    trace.markRoute('联网问答', '判定该问题需要外部最新信息：检索 → 多跳补查 → 基于素材作答')
    const searchSpan = trace.beginSpan('web', '联网检索', { stage: '检索' })
    try {
      // 行情类问题先接口直采快照——"昨天收盘多少点"这类问题快照本身就是答案，检索只补叙事
      // （此前快照只接在生成类备料，纯问答路径拿不到——实锤："昨天股市收盘数据"答不出）
      let quoteSnap = ''
      if (isMarketQuery(cleanQuery)) quoteSnap = (await fetchMarketQuotes(sendLog)) || ''
      const sq = await refineSearchQuery(cleanQuery, data.llmConfig, sendLog, undefined, undefined, false, data.history)
      const r = await webSearch(sq, sendLog, data.llmConfig)
      searchSpan.end(r.results.length ? 'ok' : 'warn', `检索词「${sq}」→ ${r.results.length} 条结果 · 深读 ${r.pages.length} 篇${quoteSnap ? ' · 含行情快照' : ''}`)
      trace.attachIo(searchSpan.id, '联网检索', `原始问题：${cleanQuery}\n改写检索词：${sq}`, outcomeBlock('检索结果', r))
      trace.sources = r.results.map(x => ({ title: x.title, url: x.url }))
      // 结果卡「联网来源」：已深读网页优先 + 其余结果，按 url 去重、最多 8 条
      const readUrls = new Set(r.pages.map(p => p.url))
      const seenU = new Set<string>()
      webSources = [...r.pages.map(p => ({ title: p.title || p.url, url: p.url })),
                    ...r.results.filter(x => !readUrls.has(x.url)).map(x => ({ title: x.title || x.url, url: x.url }))]
        .filter(w => w.url && !seenU.has(w.url) && (seenU.add(w.url), true)).slice(0, 8)
      if (r.results.length === 0 && !quoteSnap) {
        skillResult = `⚠️ 联网检索「${sq}」未返回结果（可能是网络受限或被搜索引擎拦截）。`
        skillPromptHint = `【联网检索】对「${sq}」的检索未返回任何结果。请如实告知用户暂未检索到相关网页、可能是网络受限，不要编造任何结果或链接。`
      } else {
        const lines = r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
        const pageBlocks = r.pages.map(p => `【来源：${p.title}｜${p.url}｜信源级别：${p.tier || sourceTier(p.url)}】\n${p.text}`).join('\n\n')
        // 多跳补查（与备料同机制）：首轮素材提取新实体 → 带实体补查 → 素材/来源卡/审计并入。
        // 时延闸（Round3）：单跳事实题答案首轮就有，补查纯浪费 ~40s；仅**多跳/比较题**、或**首轮素材过薄**
        // （深读 0 篇且结果 <3 条，可能没搜到答案）才补查。FRAMES 类链式题照常多跳，SimpleQA 类单事实题跳过。
        let merged = r
        let extraBlocks = ''
        const thinRound1 = r.pages.length === 0 && r.results.length < 3
        const needFollowUp = isMultiHopQuestion(cleanQuery) || thinRound1
        try {
          const seen = new Set<string>([...r.results.map(x => x.url), ...r.pages.map(p => p.url)])
          const fills = needFollowUp ? await followUpSearches(cleanQuery, `${lines}\n${pageBlocks}`, seen, data.llmConfig, sendLog, 4,
            (q, out, ms) => {
              const hid = 'hop' + (trace.spans.length + 1) + '-' + Date.now().toString(36)
              trace.spans.push({ type: 'web', name: `补查·${q}`, status: out.results.length ? 'ok' : 'warn', stage: '检索', atMs: Math.max(0, Date.now() - trace.start - ms), durationMs: ms, pid: searchSpan.id, id: hid, detail: `${out.results.length} 条新结果 · 深读 ${out.pages.length} 篇` })
              trace.attachIo(hid, `补查·${q}`, `补查检索词：${q}`, outcomeBlock('补查结果', out))
            }) : []
          if (!needFollowUp) sendLog('thinking', '单跳事实题，首轮素材已覆盖，跳过多跳补查。')
          for (const f of fills) {
            trace.sources.push(...f.out.results.map(x => ({ title: x.title, url: x.url })))
            extraBlocks += `\n\n${outcomeBlock(`补查「${f.query}」的结果`, f.out)}`
            merged = { ...merged, results: [...merged.results, ...f.out.results], pages: [...merged.pages, ...f.out.pages] }
          }
          if (fills.length) {
            const readAll = new Set(merged.pages.map(p => p.url))
            const seenU2 = new Set<string>()
            webSources = [...merged.pages.map(p => ({ title: p.title || p.url, url: p.url })),
                          ...merged.results.filter(x => !readAll.has(x.url)).map(x => ({ title: x.title || x.url, url: x.url }))]
              .filter(w => w.url && !seenU2.has(w.url) && (seenU2.add(w.url), true)).slice(0, 8)
          }
        } catch (e) { swallow(e, 'qa-followup') }
        skillResult = `已联网检索「${sq}」，获取到 ${merged.results.length} 条结果并深读了 ${merged.pages.length} 篇网页${quoteSnap ? '（另有接口直采行情快照）' : ''}，正在综合。`
        skillPromptHint = `${lowTrustNotice(merged, !!quoteSnap)}【联网检索真实结果】用户的问题需要联网信息，以下是刚刚从互联网检索到的真实结果与网页正文。今天是 ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}。\n\n${quoteSnap ? `${quoteSnap}\n\n` : ''}— 搜索结果列表 —\n${lines || '（本轮网页检索未返回结果，请基于上方行情快照作答）'}\n\n— 头部网页正文（可能为空，此时以上方结果列表的标题+摘要作答）—\n${pageBlocks || '（本轮未提取到全文正文——请直接依据上方结果列表的标题与摘要作答，摘要同为一手素材）'}${extraBlocks}\n\n请严格基于以上真实检索内容回答用户问题。**结果列表的标题与摘要即是有效素材**：长尾事实题（人名/日期/型号/名次/机构/作品属性）若某条标题或摘要已明确给出答案，即可据此作答并标注来源，"未提取到全文"绝不等于素材不足。**时效性要求**：留意每条内容自身的日期，优先采用与"今天"相符的最新信息；旧日期内容可作背景参考但必须写明其真实时间，绝不要把它标注成"今日/最新"。**作答姿态**：素材与问题不完全对口时，先把其中能回答的部分整理给用户（标注各自时间），可基于素材做贴近问题的归纳（写明"基于X月X日信息"），缺口一句话坦承即可；**不要**大段解释"为什么无法回答"，**不要**让用户自行去东方财富/同花顺等平台查——检索与整理正是你的职责。**不要在正文里罗列"来源/参考链接"**——来源会由界面单独以「联网来源」卡片展示。素材完全无法支撑时才如实说明未检索到，不要编造任何事实或链接。${isMultiHopQuestion(cleanQuery) ? `\n【多跳/聚合题作答纪律】本题的答案由多环事实链构成。作答前先在心里核对每一环：①列出得出最终答案所需的**全部**事实环节，逐环确认素材里有依据；②**计数/求和/比较类**先确认集合的**完整性**——素材只出现了部分成员时，绝不能把"已找到的"当"全部"直接计算（实锤：全满贯名单只查到 1 人就把总和当完整答案）；集合不完整时给出条件性结论（"若仅计已确认的 X，则…；素材未能穷尽全部成员"）；③任何一环只有单一低信源或互相矛盾时，写明该环未确认，不要挑一个当真相把链条走完；④链条中断处如实说明缺哪一环，宁可给出"已确认到第 N 环"的部分结论，也不要用猜测补链。` : ''}`
      }
    } catch (e: any) {
      skillResult = `❌ 联网检索失败：${e.message}`
      skillPromptHint = `【联网检索失败】检索过程中出错："${e.message}"。请如实告知用户检索失败，不要编造任何结果。`
    }
    }
  }

  if (isSkillTriggered) {
    return await synthesizeSkillAnswer(data, sendLog, trace, { skillResult, skillPromptHint, skillFiles, webSources, corporateChunks: opts?.corporateChunks })
  }
  return null
}
