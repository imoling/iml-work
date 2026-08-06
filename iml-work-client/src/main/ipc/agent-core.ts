// 新执行内核的 IPC 域（register 函数模式，与既有 ipc/*.ts 一致）。
//
// 与旧 `agent:send-message` **并存**：由 config 开关 `turn-engine-enabled` 决定渲染层走哪条，
// 每阶段验证通过后再切默认。回调只做调度（取参 → 组装 → 调 runAgentCore → 回结果），
// 提示词组装在 turn-prompt.ts、工具集在 turn-tools.ts，不在这里内联。
import { ipcMain } from 'electron'
import { ToolRegistry } from '../tool-registry'
import { runAgentCore } from '../agent-core'
import { callLlmTools, currentLlmConfig, getConvModel, setConvModel } from '../llm'
import { defaultReadOnlyTools, browseTools, askUserTool, proposePlanTool } from '../core-tools'
import { makeInstallSkillTool } from '../skill-install'
import { makeSubagentTool } from '../agent-subagent'
import { SUBAGENT_RULE, subagentHint } from '../subagent-core'
import { makeConsultTool, fetchCollaborators } from '../agent-team'
import { buildTeamRule } from '../team-core'
import { buildSystemPrompt, buildEphemeralContext } from '../core-prompt'
import { needsWorkspaceFiles } from '../core-tools'
import { resolveBrowseSystem } from '../ontology-runtime'
import { enterpriseGuidance } from '../general-turn'
import { buildTurnContext, memoryLines } from '../core-context'
import { makeKnowledgeTool, toSourceBadges, isTrivialMessage } from '../core-knowledge'
import { runMemoryWrite, runScheduleCreate, enforceFormatContract } from '../agent-steps'
import { attachRagImages } from '../corporate-rag'
import { makeSkillTools } from '../core-skills'
import { AgentTrace } from '../agent-trace'
import { runOntologyHook } from '../agent-ontology'
import { callLlm } from '../llm'
import { workspaceFileList } from '../agent-tools'
import { collectMessageImages } from '../workspace-files'
import { configGet, configSet, turnMsgAppend, turnMsgList, turnMsgClear } from '../db'
import { emitToRenderer } from '../window-ref'
import { runInContext, runningState } from '../automation-runtime'
import { swallow } from '../util'
import type { CoreEvent, CoreMessage } from '../../shared/core-protocol'
import type { AgentTaskData } from '../agent-types'
import type { SendLog } from '../types'

export interface CoreSendPayload {
  content: string
  convId?: string
  expertId?: string
  expertName?: string
  userNickname?: string
  background?: string
  permMode?: 'readonly' | 'full'
  unattended?: boolean
  /** 用户在技能选择器里显式锁定的技能——确定性直执，不进循环。 */
  forcedSkillId?: string
}

export function registerTurnHandlers(): void {
  // AgentCore 已是唯一执行链路（旧管线 v2.0.0 下线，锚点 tag: legacy-pipeline-final）。
  // 通道保留恒返回 true——老渲染层缓存/第三方调用不至于误走已拆除的旧通道。
  ipcMain.handle('turn:enabled', () => true)
  // 工作空间访问开关：关掉后分身完全看不到工作空间文件（连文件名清单都不给）。
  ipcMain.handle('turn:workspace-access', () => configGet('turn-workspace-access') !== '0')
  ipcMain.handle('turn:set-workspace-access', (_e, on: boolean) => {
    configSet('turn-workspace-access', on ? '1' : '0')
    return true
  })
  ipcMain.handle('turn:set-enabled', (_e, on: boolean) => {
    configSet('turn-engine-enabled', on ? '1' : '0')
    return true
  })
  // 子智能体开关：默认开。关掉后 run_skill/browse 等一切照旧，只是不再挂 run_subagent——
  // 它是成本放大器（一个子智能体就是一整轮内核），必须让用户能一键关掉。
  ipcMain.handle('turn:subagent-enabled', () => configGet('turn-subagent-enabled') !== '0')
  ipcMain.handle('turn:set-subagent-enabled', (_e, on: boolean) => {
    configSet('turn-subagent-enabled', on ? '1' : '0')
    return true
  })

  /** 回放：读回整条会话的结构化轨迹，渲染层据此重建工具卡（刷新后与实时视图一致）。 */
  ipcMain.handle('turn:history', (_e, convId: string) => {
    if (!convId) return []
    try { return turnMsgList(convId) } catch (e) { swallow(e, 'turn-history'); return [] }
  })

  /** 手动压缩上下文：清空轨迹（用户显式操作，对应现有的 context:compact 语义）。 */
  ipcMain.handle('turn:clear-history', (_e, convId: string) => {
    if (convId) { try { turnMsgClear(convId) } catch (e) { swallow(e, 'turn-clear') } }
    return true
  })

  /**
   * 会话级模型选择（composer 的选择器读写）。写空串 = 回到全局默认。
   * 只存模型名，端点与密钥仍是全局那一份——理由见 llm.ts 的会话级模型选择注释。
   */
  ipcMain.handle('turn:conv-model-get', (_e, convId: string) => getConvModel(convId || ''))
  ipcMain.handle('turn:conv-model-set', (_e, { convId, modelName }: { convId: string; modelName: string }) => {
    setConvModel(convId || '', modelName || '')
    return true
  })

  ipcMain.handle('turn:send-message', (_e, data: CoreSendPayload) => {
    const runId = data.convId || `run-${Date.now()}`
    return runInContext(runId, () => runOneTurn(runId, data))
  })
}

async function runOneTurn(runId: string, data: CoreSendPayload) {
  // 模型配置以主进程本地库为唯一真值，不信任渲染层送来的快照（与旧链路同样的血泪教训）。
  // runId ≡ convId，据此叠加会话级模型选择（没选过就是全局默认）。定时任务经渲染层
  // sendMessage 走同一条路，因此也自动继承所属会话的选择。
  const cfg = currentLlmConfig({ convId: runId })
  const expertId = data.expertId || ''
  const permMode = data.permMode || 'full'

  // 执行流既实时广播、也累积一份随结果返回：日志走 send、结果走 invoke 回执是两条 IPC 通道，
  // 到达顺序没有保证，只广播的话渲染层做快照必然少最后几条（旧链路踩过的坑）。
  // 工具内部流水的归属由**内核**在 execOne 里以 tool_progress 事件精确标注（每个调用持自己的闭包 id），
  // 这里不再做"最后启动的工具"式近似。日志流保持原样，供执行详情的旧链路回退。
  const runLogs: { type: string; text: string; timestamp: string }[] = []
  const sendLog: SendLog = (type, text) => {
    const entry = { type, text, timestamp: new Date().toLocaleTimeString() }
    runLogs.push(entry)
    emitToRenderer('agent:log-stream', { runId, ...entry })
  }
  const events: CoreEvent[] = []
  const emit = (ev: CoreEvent) => {
    events.push(ev)
    emitToRenderer('turn:event', ev)
  }

  sendLog('thinking', '正在理解你的任务…')

  // 寒暄快路径：一句「你好/谢谢/你是谁」不值得走整条管线——
  // 知识库检索一次 4~8s、再带全套工具跑一轮，用户等半分钟只为一句问候（旧链路的教训）。
  if (isTrivialMessage(data.content)) {
    return await runTrivialReply(runId, data, sendLog, cfg, runLogs)
  }

  // 工作空间：先看用户允不允许，再看这次任务要不要碰文件。
  // 无条件挂 read_file + 灌文件清单会让模型把工作空间当万能素材库——
  // 问「我是谁」去翻文件猜身份、问「我的待办」从报告里编清单（实测踩红线）。
  const wsAllowed = configGet('turn-workspace-access') !== '0'
  const wsFiles = wsAllowed ? workspaceFileList() : []
  const wantsFiles = wsAllowed && needsWorkspaceFiles(data.content, wsFiles)

  const ctx = await buildTurnContext({ content: data.content, expertId, sendLog, wantsFiles })

  // 知识库改成**按需**：模型判断问题涉及公司制度/流程时才调 search_knowledge。
  // 从前每条消息都预检索一次，无论问的是天气还是算术——那 4~8s 是白付的。
  const kb = makeKnowledgeTool(expertId)

  // 技能链路与 trace 要的是完整 AgentTaskData——**绝不能用 `as any` 把 CoreSendPayload 硬塞进去**。
  // 血泪：起初就是那么写的，而 CoreSendPayload 没有 llmConfig 字段，技能拿到 undefined 的模型配置，
  // 卡在"正在按手册编写执行脚本"一声不响地失败（实测 PPT 技能连跑两次都断在同一步）。
  // 类型本来拦得住，是 `as any` 把它绕过去了。
  const taskData: AgentTaskData = {
    content: data.content,
    expertId,
    expertName: data.expertName || '工作分身',
    userNickname: data.userNickname || '用户',
    background: data.background || '',
    llmConfig: cfg,
    permMode,
    unattended: data.unattended,
    convId: data.convId,
    forcedSkillId: data.forcedSkillId,
  }

  // 审计轨迹（红线：全链路留痕上报管理端）。新内核起初漏了这条——
  // 旧链路每个分支都建 AgentTrace，而 turn:send-message 一条都没报（补齐）。
  const trace = new AgentTrace(taskData, expertId, taskData.userNickname || '用户')

  // 记忆沉淀 / 定时任务意图短路（确定性判定，不赌模型调用）——旧管线同款承接：
  // 「记住 XX」→ 个人/岗位记忆落库；「每天9点…」→ 解析成定时任务。命中即短路返回。
  // 下线旧管线时差点连功能一起删（runMemoryWrite 当时零引用），此处是它们的唯一消费点。
  const remembered = await runMemoryWrite(taskData, sendLog, trace)
  if (remembered) {
    emitToRenderer('turn:event', { type: 'turn_end', runId, status: 'completed', iterations: 1 } as CoreEvent)
    return { content: remembered.content, success: remembered.success !== false, status: 'completed' as const, traceId: trace.id, logs: runLogs }
  }
  const scheduled = await runScheduleCreate(taskData, sendLog, trace)
  if (scheduled) {
    emitToRenderer('turn:event', { type: 'turn_end', runId, status: 'completed', iterations: 1 } as CoreEvent)
    return { content: scheduled.content, success: scheduled.success !== false, status: 'completed' as const, traceId: trace.id, logs: runLogs }
  }

  // ── 本体层钩子（P0 红线链路）：命中「业务对象+动作」→ 语义执行（对象消解/确认闸/真实读取/事件回写）。
  // 新内核起初漏接了它——「XX断供了」这类业务事件直接进了通用循环，本体的对象登记/业务事件
  // 全部旁路（实测反馈）。与旧链路同位：寒暄之后、通用执行之前；未命中词面预筛几乎零开销。
  {
    const ontoRes = await runOntologyHook(taskData, sendLog, trace)
    if (ontoRes) {
      emitToRenderer('turn:event', { type: 'turn_end', runId, status: 'completed', iterations: 1 } as CoreEvent)
      sendLog('completed', '本体语义执行完成。')
      return {
        content: ontoRes.content, success: ontoRes.success !== false, status: 'completed' as const,
        traceId: trace.id, todos: [], logs: runLogs, events: [], iterations: 1, toolCallCount: 0,
        ...(ontoRes.ontology ? { ontology: ontoRes.ontology } : {}),
        ...(ontoRes.loginRequest ? { loginRequest: ontoRes.loginRequest } : {}),
        ...(ontoRes.permSwitch ? { permSwitch: true } : {}),
      }
    }
  }

  trace.markRoute('执行内核', '统一循环：模型按需调用工具直至得出答案')

  // 技能工具化（阶段 4）：run_skill 进工具表后，「生成文件」「确定性业务流程」不再需要绕回旧链路。
  const skillTools = makeSkillTools({ data: taskData, trace, expertId })

  // 显式锁定技能 → **确定性直执**，不进循环。
  // 用户在技能选择器里点了某个技能，那是明确指令，不该再交给模型判断该不该调用
  //（旧链路同样是零歧义直执；靠提示词"请你调用 X"是赌模型听话，赌输就是答非所问）。
  if (data.forcedSkillId) {
    return await runForcedSkill(runId, data, skillTools, trace, sendLog, runLogs)
  }

  // 沙箱产物也要交付：模型有时会直接用 python 生成文件，而不是走技能
  const pyFiles: { name: string; sizeBytes: number }[] = []
  const webSrc: { title: string; url: string }[] = []
  /**
   * 联网来源同时进审计轨迹（按 url 去重）。
   *
   * 补这条是因为查子智能体留痕时顺带发现：`trace.sources` 只有 skill-orchestrator 与
   * agent-steps 的自救路径在填，而 AgentCore 是**唯一执行链路**——也就是说管理端审计里，
   * 一次联网调研任务的来源列表一直是空的。结果卡有来源、审计没有，两边对不上。
   * 小分身的来源走同一个回调，因此一并补齐。
   */
  const seenSrc = new Set<string>()
  const collectSources = (s: { title: string; url: string }[]) => {
    webSrc.push(...s)
    for (const x of s) {
      if (x.url && !seenSrc.has(x.url)) { seenSrc.add(x.url); trace.sources.push(x) }
    }
  }
  // 操作类任务的通道（迁移遗漏修复：browse 之前只在旧链路，新内核没挂 → 「订票」只能沦为问答）。
  // 命中已登记业务系统 → 带登录态分区的 browse，且**不给公网检索**（实测教训：给全套会拿内部 URL
  // 去 web_search，65 步/337 秒读一堆无关公网页，见 general-turn.buildRegistry）；
  // 未命中 → 全量工具 + 无登录态的开放网页 browse（12306 这类外部网站靠它）。
  const browseSys = await resolveBrowseSystem(data.content).catch((e) => { swallow(e, 'turn-browse-sys'); return null })
  const registry = new ToolRegistry()
  registry.registerAll(defaultReadOnlyTools(cfg, {
    includeFiles: wantsFiles,
    includeWeb: !browseSys,
    onFiles: (f) => pyFiles.push(...f),
    onWebSources: collectSources,
  }))
  registry.registerAll(browseTools({
    ...(browseSys ? { partition: `persist:bizsys-${browseSys.systemId}`, systemName: browseSys.systemName } : {}),
    permMode, unattended: data.unattended, sendLog,
  }))
  // 缺关键信息时中途问用户：挂起循环等回答，而不是把问题写进最终答案
  registry.register(askUserTool({ unattended: data.unattended }))
  // 讨论档的 Plan 流转：侦查完 → 行动方案卡 → 用户一键批准自动切档继续
  if (permMode === 'readonly') registry.register(proposePlanTool(runId))
  registry.register(kb.spec)
  // 对话里安装第三方技能。不挂它的话，"帮我装个 xxx" 会被当成知识问答，
  // 模型照着搜到的 README 教用户 npx / git clone —— 在 iML Work 里那么做毫无效果（实测踩到）。
  registry.register(makeInstallSkillTool())
  registry.registerAll(skillTools.specs)
  // 子智能体：需要大量阅读才能得出结论的子问题，交给独立上下文去查（见 agent-subagent 文件头）。
  // 命中业务系统的轮次**不挂**——那种任务要的是 browse 一步步操作，多派一个只读子智能体
  // 只会诱导模型拿内部 URL 去公网查（与 general-turn.buildRegistry 只给 browse 同一条教训）。
  // allowWeb/allowFiles 与主分身的判据逐字一致：子智能体的权限只能等于或窄于派它的那个分身。
  // 跨岗位协作：只在**管理端给本岗位配了协作岗位**时才挂——名单为空就不给这个工具，
  // 否则模型会看见一个"可以请教别人"的能力却点不出任何人（比没有更糟）。
  // 与子智能体同一个开关：它们是同一类成本放大器，用户一次关掉两个是符合直觉的。
  const collaborators = (!browseSys && configGet('turn-subagent-enabled') !== '0' && expertId)
    ? await fetchCollaborators(expertId).catch((e) => { swallow(e, 'turn-collaborators'); return [] })
    : []
  if (collaborators.length) {
    registry.register(makeConsultTool({
      parentRunId: runId, trace, cfg, permMode, unattended: data.unattended,
      fromExpertId: expertId, collaborators, emit,
      isCancelled: () => runningState.aborted,
      abortSignal: () => runningState.abortSignal,
      onWebSources: collectSources,
    }))
  }

  const subagentOn = !browseSys && configGet('turn-subagent-enabled') !== '0'
  if (subagentOn) {
    registry.register(makeSubagentTool({
      parentRunId: runId, trace, cfg, permMode, unattended: data.unattended,
      expertId, allowWeb: true, allowFiles: wantsFiles, emit,
      isCancelled: () => runningState.aborted,
      abortSignal: () => runningState.abortSignal,
      onFiles: (f) => pyFiles.push(...f),
      onWebSources: collectSources,
    }))
  }

  // 历史轨迹 = 模型上下文的真值（含完整 tool_calls/tool_result）。
  // 这正是多轮追问能准的原因：模型看得见自己上一轮调了什么、拿回什么。
  const history: CoreMessage[] = data.convId ? turnMsgList(data.convId) : []
  const messages: CoreMessage[] = history.length
    ? history
    : [{ role: 'system', content: buildSystemPrompt({
        expertName: data.expertName || '工作分身',
        userNickname: data.userNickname || '用户',
        background: data.background,
        personalMemory: memoryLines(expertId, 'personal'),
        agentSop: memoryLines(expertId, 'agent'),
        standing: [ctx.standing, skillTools.catalog].filter(Boolean).join('\n\n'),
      }), ts: Date.now() }]
  const appendFrom = messages.length
  // 本轮的图片随消息带给视觉模型。路径解析走 resolveWorkspaceFile（会找会话产物子目录）；
  // 出站转 data URL 与成本控制在 llm.ts 的 toOpenAiMessages。
  //
  // **显式附件不受工作空间开关约束**：那个开关防的是"模型把工作空间当万能素材库"，
  // 而用户这一轮亲手递过来的文件是明确授权。只有正文里的裸提及才跟着开关走。
  const msgImages = collectMessageImages(data.content, { includeMentions: wsAllowed })
  if (msgImages.length) sendLog('observing', `本轮附带 ${msgImages.length} 张图片，将交给模型查看`)
  messages.push({
    role: 'user', content: data.content, ts: Date.now(),
    ...(msgImages.length ? { imagePaths: msgImages } : {}),
  })

  const res = await runAgentCore({
    runId, messages, registry, cfg, callModel: callLlmTools, sendLog, emit,
    permMode, unattended: data.unattended,
    contextProvider: () => buildEphemeralContext({
      permMode, unattended: data.unattended,
      workspaceFiles: wantsFiles ? wsFiles : [],
      workspaceOff: !wsAllowed,
      extra: [
        browseSys ? enterpriseGuidance(browseSys.systemName, browseSys.baseUrl) : '',
        ctx.ephemeral, skillTools.triggerHint(data.content),
        // 委派规则**只在本轮真挂了这个工具时**下发——否则就是在教模型调一个它没有的工具
        //（命中业务系统的轮次不挂 subagent，见上面的注册条件）。
        ...(subagentOn ? [SUBAGENT_RULE, subagentHint(data.content)] : []),
        // 同理只在真挂了 consult_expert 时下发；规则里带上可请教的名单（模型要按 id 点名）
        ...(collaborators.length ? [buildTeamRule(collaborators)] : []),
      ].filter(Boolean).join('\n\n'),
    }),
    maxIterations: 14,
    budgetMs: 330_000,
    skillNameOf: skillTools.nameOf,
    // runningState 是代理到当前 async 上下文的 RunContext——多会话并发时各自独立，不会互相打断。
    isCancelled: () => runningState.aborted,
    abortSignal: () => runningState.abortSignal,
  })

  // 只落本轮新增的部分（历史已经在库里，重复写会让轨迹翻倍）。
  if (data.convId) {
    try { turnMsgAppend(data.convId, messages.slice(appendFrom)) } catch (e) { swallow(e, 'turn-persist') }
  }

  // 输出契约校验：用户带显式格式约束（字数/句段数/禁词/JSON…）时做**确定性**检查，
  // 违规则带具体违规点重写一次。旧链路一直有这步、新内核漏接——IFEval 上因此低 5 分
  // （见 docs/kernel-capability-report：唯一短板）。两链路共用同一个校验器，不另写一份。
  const answerChecked = await enforceFormatContract(res.answer, data.content, cfg, sendLog)

  // 图文并茂：知识库命中含插图时，把答案里的【图N】占位换成真实插图（占位全丢有文末兜底）。
  // 新内核曾漏接这步——旧链路一直有的能力在这里补齐（attachRagImages 为两链路共用单一来源）。
  const answerWithImages = kb.hits().length ? attachRagImages(answerChecked, kb.hits()) : answerChecked

  await trace.submit(res.answer, res.status === 'completed' ? 'SUCCESS' : 'PARTIAL',
    `执行内核：${res.iterations} 轮 · ${res.toolCallCount} 次工具调用`)

  sendLog('completed', `执行完成（${res.iterations} 轮 · ${res.toolCallCount} 次工具调用）。`)

  // 错误轮把真实原因带回渲染层：AgentCore 的契约是 error 时 answer 为空串（绝不编答案），
  // 而渲染层对空 content 的兜底文案是「请检查大模型配置」——上游拒参 400 这类真因被埋进
  // 执行详情，现场只能翻本地库才查得到（实测 2026-08-06）。真实错误在最后一条 error notice 里。
  const lastError = res.status === 'error'
    ? ([...res.messages].reverse().find(m => m.role === 'notice' && m.noticeKind === 'error')?.content || '').slice(0, 400)
    : ''
  return {
    content: answerWithImages || (lastError ? `❌ 模型调用失败：${lastError}` : ''),
    success: res.status === 'completed',
    status: res.status,
    traceId: trace.id,
    todos: res.todos,
    // 技能与 python 沙箱产出的文件随结果回传（结果卡的文件卡要用）
    files: [...skillTools.files(), ...pyFiles].length ? [...skillTools.files(), ...pyFiles] : undefined,
    // 联网来源 = 工具直查的 ∪ 技能带回的（按 URL 去重）——漏了前者，纯检索任务的来源列表就是空的
    webSources: (() => {
      const seen = new Set<string>()
      const all = [...webSrc, ...skillTools.webSources()].filter(x => {
        if (!x.url || seen.has(x.url)) return false
        seen.add(x.url); return true
      })
      return all.length ? all.slice(0, 12) : undefined
    })(),
    // 溯源角标来自模型**实际查过**的片段（可能多次检索），而不是预检索的一锅端。
    sources: kb.hits().length ? toSourceBadges(kb.hits()) : undefined,
    logs: runLogs,
    events,
    // 统计随**结果**回传，不让渲染层依赖 turn_end 事件——事件走 webContents.send、结果走 invoke 回执，
    // 两条 IPC 通道到达顺序没有保证。结果先到时事件里的轮数还没落到 store，
    // 状态栏就会退回用日志条数冒充轮数（实测显示成「共 40 轮」，而真值是 4 轮）。
    iterations: res.iterations,
    toolCallCount: res.toolCallCount,
  }
}


/**
 * 寒暄快答：带人设直接短答，不检索、不带工具、只一次模型调用。
 * 仍然如实返回统计（0 次工具调用），别让状态栏显示成跑了一轮工具。
 */
async function runTrivialReply(
  runId: string, data: CoreSendPayload, sendLog: SendLog,
  cfg: ReturnType<typeof currentLlmConfig>,
  runLogs: { type: string; text: string; timestamp: string }[],
) {
  sendLog('thinking', '寒暄消息，直接回复…')
  const prompt = `你是「${data.expertName || '工作分身'}」，${data.userNickname || '用户'}的企业工作分身。`
    + `${data.background ? `\n岗位背景：${data.background}` : ''}`
    + `\n\n用户说：「${data.content}」\n\n用一两句话自然地回应即可（可简要说明你能帮他做什么）。不要罗列长清单，不要编造任何业务数据。`
  let answer = ''
  try {
    answer = await callLlm(prompt, cfg, { temperature: 0.3 })
  } catch (e) {
    swallow(e, 'turn-trivial')
    answer = `你好！我是你的工作分身「${data.expertName || '工作分身'}」，可以帮你查资料、写文档、跑业务技能、联网检索等——直接说需求就行。`
  }
  emitToRenderer('turn:event', { type: 'turn_end', runId, status: 'completed', iterations: 1 } as CoreEvent)
  sendLog('completed', '已回复。')
  return {
    content: answer, success: true, status: 'completed' as const,
    todos: [], logs: runLogs, events: [], iterations: 1, toolCallCount: 0,
  }
}


/** 锁定技能的确定性执行：直接调 run_skill，不经过模型循环。 */
async function runForcedSkill(
  runId: string, data: CoreSendPayload,
  skillTools: ReturnType<typeof makeSkillTools>, trace: AgentTrace,
  sendLog: SendLog, runLogs: { type: string; text: string; timestamp: string }[],
) {
  const tool = skillTools.specs[0]
  if (!tool) {
    const msg = `⚠️ 未能执行：本岗位没有在册技能，找不到你锁定的技能（${data.forcedSkillId}）。`
    sendLog('completed', msg)
    return { content: msg, success: true, status: 'completed' as const, todos: [], logs: runLogs, events: [], iterations: 1, toolCallCount: 1 }
  }
  emitToRenderer('turn:event', { type: 'turn_start', runId } as CoreEvent)
  const callId = `forced-${Date.now()}`
  const call = { id: callId, name: tool.name, args: { skillId: data.forcedSkillId! } }
  emitToRenderer('turn:event', { type: 'tool_proposed', runId, call } as CoreEvent)
  emitToRenderer('turn:event', { type: 'tool_started', runId, callId, name: tool.name } as CoreEvent)

  let text = ''
  try {
    text = await tool.run({ skillId: data.forcedSkillId }, { sendLog })
  } catch (e: any) {
    swallow(e, 'turn-forced-skill')
    text = `技能执行出错：${e?.message || e}`
  }
  emitToRenderer('turn:event', { type: 'tool_finished', runId, callId, name: tool.name, status: 'ok', preview: text.slice(0, 500) } as CoreEvent)
  emitToRenderer('turn:event', { type: 'turn_end', runId, status: 'completed', iterations: 1 } as CoreEvent)

  await trace.submit(text, 'SUCCESS', `锁定技能直执（${data.forcedSkillId}）`)
  sendLog('completed', '技能执行完成。')
  return {
    content: text, success: true, status: 'completed' as const, traceId: trace.id, todos: [],
    files: skillTools.files().length ? skillTools.files() : undefined,
    webSources: skillTools.webSources().length ? skillTools.webSources() : undefined,
    logs: runLogs, events: [], iterations: 1, toolCallCount: 1,
  }
}
