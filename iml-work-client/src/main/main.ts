import './global-env'
import { app, BrowserWindow, ipcMain } from 'electron'
import path, { join } from 'path'
import {
  configSet,
  memoryGet,
  schedList,
  schedUpsert,
  schedSetEnabled,
  schedDelete,
  type ScheduledTask, focusRecent, focusEvents } from './db'
import { type LlmConfig, callLlm, currentLlmConfig } from './llm'
import { setMainWindow, emitToRenderer } from './window-ref'
import { incImCommandCount } from './stats'
import { type RemoteBotKey, stopRemoteBot, bootRemoteBots } from './remote-bots'
import { swallow, sleep } from './util'
import { runInContext } from './automation-runtime'
import { AgentTrace } from './agent-trace'
import { registerDbHandlers } from './ipc/db'
import { registerWindowHandlers } from './ipc/window'
import { registerAgentControlHandlers } from './ipc/agent-control'
import { registerAuthExpertHandlers } from './ipc/auth-expert'
import { registerFilesKbHandlers } from './ipc/files-kb'
import { registerMiscHandlers } from './ipc/misc'
import { registerBizSystemsHandlers } from './ipc/biz-systems'
import { registerFocusHandlers } from './ipc/focus'
import { registerSkillAuthoringHandlers } from './ipc/skill-authoring'
import { runOntologyHook } from './agent-ontology'
import { getEnterpriseBlock, getKnowledgeScope, queryCorporateKnowledge, buildCorporateRagBlock, attachRagImages, buildKnowledgeSources } from './corporate-rag'
import { initSkillStore } from './skill-store'
import { extractAttachmentText } from './workspace-files'
import { startHeartbeat, stopHeartbeat } from './client-heartbeat'
import { fireScheduledTask, startScheduler } from './scheduler'
import { startFileSyncWatcher, stopFileSyncWatcher } from './file-sync'
import { ingestToPersonalKB } from './personal-kb'
import { startBizKeepAlive } from './biz-keepalive'
import { initFloatBall } from './float-ball'
import { initAutoUpdate } from './updater'
import { buildHistoryBlock } from './agent-steps'
import {  } from './skill-exec'
import { runSkillPipeline } from './skill-orchestrator'
import { focusMentioned, renderFocusBlock } from './focus-core'
import type { AgentResult } from './agent-types'

let mainWindow: BrowserWindow | null = null

// 应用显示名：Hide/Quit/About 菜单项与「关于」面板用它（dev 下菜单栏加粗名来自 Electron.app 的
// Info.plist——已由 scripts 侧改写为 iML Work；打包时由 productName 接管）。
app.setName('iML Work')
app.setAboutPanelOptions({
  applicationName: 'iML Work',
  applicationVersion: 'v1.0.3',
  credits: '工作分身 · 本地安全 · 高效执行',
  copyright: 'iML Studio · 由个人开发者 imoling 打造 · © 2026',
  iconPath: path.join(app.getAppPath(), 'build/icon.png')
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "iML Work - iML Studio",
    frame: false, // Frosted native chrome is simulated in the React layer
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  setMainWindow(mainWindow)

  // Load local Vite dev server in development, compiled HTML in production
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  // Forward maximize/restore state so the renderer can reflect the control icon.
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-changed', false))
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('window:maximized-changed', true))
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('window:maximized-changed', false))

  mainWindow.on('closed', () => {
    mainWindow = null
    setMainWindow(null)
  })
}

app.whenReady().then(() => {
  // macOS 扩展坞图标（dev 运行时 Electron 默认是通用图标；打包由 build/icon.png 提供）
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(app.getAppPath(), 'build/icon.png')) } catch (e) { swallow(e, 'dock-icon') }
  }
  createWindow()
  startFileSyncWatcher(p => { ingestToPersonalKB(p).catch(() => {}) })
  startHeartbeat()
  startBizKeepAlive()
  startScheduler()
  bootRemoteBots()
  initFloatBall()   // 按持久化配置恢复桌面悬浮球
  void initAutoUpdate()   // 自动更新通道（未打包/未配源时惰性）

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  stopHeartbeat()
  stopFileSyncWatcher()
  for (const k of ['feishu', 'dingtalk', 'qq'] as RemoteBotKey[]) { void stopRemoteBot(k) }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* =========================================================================
   FileSyncService — real directory watching (chokidar) + delta sync upload
   ========================================================================= */

// 文件同步 watcher / 客户端心跳 / 定时任务调度已拆至 file-sync.ts / client-heartbeat.ts / scheduler.ts。

ipcMain.handle('schedule:list', () => schedList())
ipcMain.handle('schedule:save', (_e, t: ScheduledTask) => { schedUpsert(t); return schedList() })
ipcMain.handle('schedule:toggle', (_e, { id, enabled }: { id: string; enabled: boolean }) => { schedSetEnabled(id, enabled); return schedList() })
ipcMain.handle('schedule:delete', (_e, { id }: { id: string }) => { schedDelete(id); return schedList() })
ipcMain.handle('schedule:run-now', (_e, { id }: { id: string }) => { const t = schedList().find(x => x.id === id); if (t) fireScheduledTask(t); return { ok: true } })

// 启动初始化本地技能缓存（加载 + 异步清理已删技能）
initSkillStore()
// secure-store：敏感值经系统钥匙串(safeStorage)加密后落盘；绝不打印明文值。
registerDbHandlers()
registerFocusHandlers()

// 各域 IPC 已拆至 ipc/*.ts（auth-expert / files-kb / misc / biz-systems）。
registerAuthExpertHandlers()
registerSkillAuthoringHandlers()
registerFilesKbHandlers()
registerMiscHandlers()
registerBizSystemsHandlers()

// 任务编排与技能主管线已拆至 skill-orchestrator.ts。


ipcMain.handle('agent:send-message', (_event, data: { content: string; expertId?: string; expertName: string; userNickname?: string; background: string; llmConfig: LlmConfig; forcedSkillId?: string; permMode?: 'readonly' | 'full'; history?: { role: 'user' | 'assistant'; content: string }[]; convId?: string }) => {
  // runId ≡ convId：一个会话同时只有一个任务。不同会话的任务真并发（各自独立 RunContext）。
  const runId = data.convId || `run-${Date.now()}`

  // 模型配置以主进程本地库为唯一真值（用户保存的设置 → 跟随 adminBaseUrl 的企业网关 → 默认），
  // 不信任渲染层随消息送来的快照。血泪：渲染层出厂默认把**构建期** VITE_ADMIN_BASE_URL（打包时
  // 通常没设 → localhost:8080）烤进 llmBaseUrl——新机器只在登录页填了服务器地址、没碰过模型
  // 设置时，送来的就是死网关，语义路由与生成类技能整体失败，表象是"技能匹配不上/用不了"。
  data.llmConfig = currentLlmConfig()

  // 执行流的**真值**留在主进程：既实时广播（渲染层滚动展示），也累积一份随结果一起返回。
  // 以前只广播、不留底 —— 渲染层只能在 invoke 回执到达后再去自己的 store 里"捞"日志做快照。
  // 但日志走 webContents.send、结果走 invoke 回执，**是两条 IPC 通道，到达顺序没有保证**：
  // 结果先到时最后一条日志还在路上，快照就少一条 —— 用户看到「执行详情」停在"正在向业务系统提交…"，
  // 以为执行卡住了（其实早已成功）。runLogs 声明在闭包外，才能在唯一出口挂到结果上。
  const runLogs: { type: string; text: string; timestamp: string }[] = []
  const sendLog = (type: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed', text: string) => {
    const entry = { type, text, timestamp: new Date().toLocaleTimeString() }
    runLogs.push(entry)
    emitToRenderer('agent:log-stream', { runId, ...entry })   // 带 runId，渲染层按会话精确路由
  }

  // 在**唯一出口**统一把完整执行流挂到结果上——handler 内部十几个 return 点，逐个改必漏。
  return runInContext(runId, async () => {
  incImCommandCount()
  if (data.expertName) configSet('lastClaimedExpertName', data.expertName)

  const expertId = data.expertId || ''
  const userNickname = data.userNickname || '用户'

  sendLog('thinking', '正在理解你的任务…')

  // —— Agent Trace 采集：本次任务的全链路轨迹，结束时上报管理端审计追溯 ——
  const trace = new AgentTrace(data, expertId, userNickname)

  // 真实性约束：聊天/分析路径没有访问真实业务数据的能力，必须杜绝凭空捏造。
  const NO_FABRICATION_RULE = `【重要 · 真实性边界】
你本身无法访问任何外部系统、邮箱、OA、CRM、ERP、数据库或任何实时/私有业务数据。除非下文明确给出了"真实技能执行结果 / 真实页面抓取内容"，否则你并不掌握用户的任何真实邮件、待办、审批单、报销单、订单、人员或金额数据。
当用户要求查看 / 获取 / 统计这类真实业务数据，而你手头只有静态知识、并无实际执行结果时，你必须如实说明你无法直接获取，并简要给出下一步建议：① 在「企业技能中心」为该需求配置对应技能并绑定目标业务系统；② 在「设置 → 企业系统连接」登录对应系统后重试。
严禁编造任何邮件、待办、条目、姓名、金额、日期、单号或任何不存在的业务数据；不要为了"显得完成了任务"而虚构结果。`

  // === 本体层钩子（P0）：命中「对象+动作」则走语义执行并早返回；未命中继续技能/问答链路 ===
  {
    const ontoRes = await runOntologyHook(data, sendLog, trace)
    if (ontoRes) return ontoRes
  }

  // === 企业知识库检索（提前到技能管线之前）===
  // 为什么提前：管线里的「要不要联网」判定必须知道知识库有没有答案。
  // 以前顺序是反的（先判联网、后查库），模型在信息真空里判断——问「iML Work 的总体架构」时
  // 它想"这是我不掌握的具体事实"→ 需要联网，压根不知道企业知识库里就躺着那份白皮书。
  // 结果白跑一趟搜索，还在客户面前端出"腾讯云/夸智网"这种无关来源，而答案根本来自知识库。
  sendLog('thinking', `正在查相关的公司制度…`)
  const corporateChunks = await queryCorporateKnowledge(data.content, expertId)
  if (corporateChunks.length) sendLog('thinking', `查到 ${corporateChunks.length} 条相关制度，已经一起考虑进去了。`)
  else sendLog('thinking', `没查到相关制度，先用本地记忆来答。`)

  // --- 技能拦截与执行 ---：匹配→内置/自定义技能执行→联网检索兜底→按真实结果整理作答
  {
    const skillRes = await runSkillPipeline(data, sendLog, trace, { corporateChunks })
    if (skillRes) return skillRes
  }
  
  // Simple check to determine if the query requires complex automation actions
  {
    // 所有未匹配技能的请求统一走诚实的大模型路径（带真实性约束），
    // 不再有"复杂指令"模拟分支（之前会弹出与请求无关的假表单）。
    sendLog('thinking', `先回忆下你的习惯和岗位经验…`)
    await sleep(200)

    // Retrieve memories from SQLite
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
    // 执行日志也如实：只有真查到记忆才说“想起”。
    if (personalMemoryList) sendLog('thinking', `想起你的使用习惯了。`)
    if (agentSopList) sendLog('thinking', `想起岗位预置的 SOP 了。`)
    if (!personalMemoryList) personalMemoryList = `（暂无沉淀的个人习惯记忆）`
    if (!agentSopList) agentSopList = `（暂无岗位预置 SOP，按通用岗位常识与下方企业知识作答）`
    await sleep(200)

    const cfg = data.llmConfig
    const mode = cfg?.mode || 'direct'
    const modelName = cfg?.modelName || ''
    const baseUrl = cfg?.baseUrl || ''

    let cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    if (cleanBaseUrl.endsWith('/chat/completions')) cleanBaseUrl = cleanBaseUrl.slice(0, -'/chat/completions'.length)
    if (cleanBaseUrl.endsWith('/v1/messages')) cleanBaseUrl = cleanBaseUrl.slice(0, -'/v1/messages'.length)
    if (mode === 'proxy' && cleanBaseUrl.endsWith('/chat')) cleanBaseUrl = cleanBaseUrl.slice(0, -'/chat'.length)

    sendLog('thinking', `正在准备模型…`)
    sendLog('thinking', `通过${mode === 'proxy' ? '企业模型网关' : '厂商 API'}接入模型…`)
    sendLog('thinking', `使用模型：${modelName}`)
    await sleep(400)

    sendLog('acting', `正在把信息整理给模型，生成回复…`)
    await sleep(400)

    const kbScope = getKnowledgeScope(expertId)
    const kbScopeLine = kbScope.length
      ? `\n- 本岗位云端知识库检索范围（由管理端领用下发）：${kbScope.join('、')}`
      : ''
    if (kbScope.length) {
      sendLog('thinking', `可检索的知识库范围：${kbScope.join('、')}`)
    }

    // 岗位画像：用户点名了最近跟进的业务对象 → 注入其本地沉淀（快照，带日期声明）。
    // 沉淀来自本体链路的真实接触（focus_object/focus_event），这里只读不写。
    let focusBlock = ''
    try {
      const rows = focusRecent(expertId, undefined, 20)
      const hit = focusMentioned(data.content, rows)
      const blocks = hit.map(f => renderFocusBlock(f.displayName, f.lastState, focusEvents(f.id, 5), f.profileSummary)).filter(Boolean)
      if (blocks.length) {
        focusBlock = `\n\n${blocks.join('\n\n')}`
        sendLog('thinking', `想起你最近跟进过：${hit.map(f => `「${f.displayName}」`).join('、')}`)
      }
    } catch (e) { swallow(e, 'focus-inject') }

    // 知识库已在进入技能管线前检索过（同一份 corporateChunks 复用，不重复查库）
    const corporateRagBlock = buildCorporateRagBlock(corporateChunks)
    const enterpriseBlock = await getEnterpriseBlock()
    // 解析本次附件（PDF/文本）的真实内容，供分身基于真实文本作答。
    const attachmentText = await extractAttachmentText(data.content, sendLog)
    const attachmentSection = attachmentText
      ? `\n\n【附件真实内容】（已从工作空间解析，请基于此作答，勿编造）\n${attachmentText}`
      : ''

    // Build the prompt containing the retrieved context
    const historyBlock = await buildHistoryBlock(data.history, cfg)
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

[当前指令/User Instruction]
请基于上述静态知识与用户背景进行回答或分析，称呼用户为“${userNickname}”。务必遵守上面的【真实性边界】：若该指令需要的是你无法获取的真实业务数据（如未读邮件、待办、单据等），请如实说明并给出下一步建议，绝不要编造。若上方提供了【附件真实内容】，请基于该真实文本进行分析：
"${data.content}"`

    let content = ''
    try {
      content = await callLlm(promptWithContext, cfg, { longRunning: true })
      content = attachRagImages(content, corporateChunks)   // 【图N】占位 → 真实插图
      sendLog('observing', `[LLM Response] 成功接收大模型响应内容。`)
    } catch (err: any) {
      sendLog('observing', `[LLM Error] 网络请求失败: ${err.message}`)
      content = `【大模型连接失败】\n\n错误信息: ${err.message}\n\n请检查:\n1. Base URL 是否正确（直连时填写到 /v1 结尾）\n2. API Key 是否有效\n3. 模型名称是否正确`
    }
    sendLog('completed', `[Completed] 问答完毕。`)

    await trace.submit(content, 'SUCCESS',
      `目标：回答用户问题。${trace.webSearch ? '判定需联网→检索→综合作答；' : '基于岗位知识与上下文作答；'}遵守真实性边界，未编造数据。`)
    return { content, success: true, sources: buildKnowledgeSources(corporateChunks) }
  }
  }).then((res: AgentResult) => ({ ...res, execLogs: [...runLogs] }))
})

// IPC Form / Delete Confirmation responses from React UI
registerAgentControlHandlers()

// Window chrome handlers
registerWindowHandlers()

// 工作空间目录/扫描与文档解析已拆至 workspace-files.ts，此处只留 IPC 编排。
