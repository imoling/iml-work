import './global-env'
import { app, BrowserWindow, ipcMain, shell, session, dialog } from 'electron'
import path, { join } from 'path'
import fs from 'fs'
import {
  configGet,
  configSet,
  configGetAll,
  memoryGet,
  schedList,
  schedUpsert,
  schedSetEnabled,
  schedDelete,
  type ScheduledTask
} from './db'
import { getAdminBaseUrl, authToken, authUser, authHeaders, afetch, getOwnerId } from './http'
import { type LlmConfig, callLlm } from './llm'
import { setMainWindow } from './window-ref'
import { incImCommandCount } from './stats'
import { type RemoteBotKey, getRemoteBotState, startRemoteBot, stopRemoteBot, bootRemoteBots } from './remote-bots'
import { swallow, sleep } from './util'
import { runningState, runExclusive, requestPermissionChoice } from './automation-runtime'
import { AgentTrace } from './agent-trace'
import { registerDbHandlers } from './ipc/db'
import { registerWindowHandlers } from './ipc/window'
import { registerAgentControlHandlers } from './ipc/agent-control'
import { runOntologyHook } from './agent-ontology'
import type { AgentTaskData, AgentResult } from './agent-types'
import { type SendLog } from './types'
import { webSearch, isWebSearchIntent, refineSearchQuery, getExpertWebSearch, shouldWebSearch } from './web-search'
import { getEnterpriseBlock, getKnowledgeScope, queryCorporateKnowledge, buildCorporateRagBlock, attachRagImages, buildKnowledgeSources } from './corporate-rag'
import { type SkillDefinition, getLoadedSkills, skillLabel, skillDisplayName, setSkillDisplayName, loadLocalSkills, pruneDeletedSkills, writeSkillFile, initSkillStore } from './skill-store'
import { workspaceDir, scanWorkspace, extractAttachmentText } from './workspace-files'
import { startHeartbeat, stopHeartbeat } from './client-heartbeat'
import { fireScheduledTask, startScheduler } from './scheduler'
import { getLocalFiles, startFileSyncWatcher, stopFileSyncWatcher } from './file-sync'
import { kbAutoIngestOn, kbEmit, ingestToPersonalKB } from './personal-kb'
import { bizPartition, getHbState, setHbEnabled, runBizHeartbeat, startBizKeepAlive } from './biz-keepalive'
import { buildHistoryBlock, runMemoryWrite, runScheduleCreate, synthesizeSkillAnswer } from './agent-steps'
import { execViaBackendSandbox, routeSkillsByIntent, getSkillType, isWriteSkill } from './skill-exec'
import { runCustomSkill } from './skill-custom'

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

/* =========================================================================
   Harness Agent Loop & Memory RAG & RPA Sandbox Simulator
   ========================================================================= */

// 个人空间文件列表状态在 file-sync.ts（getLocalFiles）。


// 技能本地缓存（SKILL.md 加载/落盘/清理/展示名）已拆至 skill-store.ts。

// 启动初始化本地技能缓存（加载 + 异步清理已删技能）
initSkillStore()


// secure-store：敏感值经系统钥匙串(safeStorage)加密后落盘；绝不打印明文值。
registerDbHandlers()

// Claim Expert & Sync Skills
// LLM Connection Test - accepts config directly from renderer
ipcMain.handle('llm:test', async (_event, cfg: { mode: string; apiMode: string; baseUrl: string; apiKey: string; modelName: string }) => {
  const mode = cfg.mode || 'proxy'
  const apiMode = cfg.apiMode || 'chat'
  const baseUrl = cfg.baseUrl || ''
  const apiKey = cfg.apiKey || ''
  const modelName = cfg.modelName || ''

  let cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  if (cleanBaseUrl.endsWith('/chat/completions')) cleanBaseUrl = cleanBaseUrl.slice(0, -'/chat/completions'.length)
  if (cleanBaseUrl.endsWith('/v1/messages')) cleanBaseUrl = cleanBaseUrl.slice(0, -'/v1/messages'.length)

  let targetUrl = ''
  if (mode === 'proxy') {
    targetUrl = `${cleanBaseUrl}/chat`
  } else if (apiMode === 'anthropic') {
    targetUrl = `${cleanBaseUrl}/v1/messages`
  } else {
    targetUrl = `${cleanBaseUrl}/chat/completions`
  }

  const allConfigs = configGetAll()
  const diagnostics = {
    config: { mode, apiMode, baseUrl, modelName, apiKeyPrefix: apiKey?.substring(0, 12) + '...' },
    targetUrl,
    dbKeyCount: Object.keys(allConfigs).length,
    dbKeys: Object.keys(allConfigs)
  }

  if (!baseUrl || !apiKey || !modelName) {
    return { ...diagnostics, error: '配置不完整：Base URL、API Key 或模型名称为空', success: false }
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    let body: any = {}

    if (mode === 'proxy') {
      headers['Authorization'] = `Bearer ${apiKey}`
      body = { model: modelName, messages: [{ role: 'user', content: 'hi, reply with just the word OK' }] }
    } else if (apiMode === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      body = { model: modelName, max_tokens: 20, messages: [{ role: 'user', content: 'hi, reply with just the word OK' }] }
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`
      body = { model: modelName, messages: [{ role: 'user', content: 'hi, reply with just the word OK' }] }
    }

    const response = await fetch(targetUrl, { method: 'POST', headers, body: JSON.stringify(body) })
    const rawText = await response.text()
    let parsed: any = null
    try { parsed = JSON.parse(rawText) } catch (e) { swallow(e) }

    return {
      ...diagnostics,
      httpStatus: response.status,
      httpStatusText: response.statusText,
      rawResponse: rawText.substring(0, 2000),
      parsedContent: parsed?.choices?.[0]?.message?.content || parsed?.content?.[0]?.text || null,
      success: response.ok
    }
  } catch (err: any) {
    return {
      ...diagnostics,
      error: err.message,
      success: false
    }
  }
})

// 企业基础信息与规则：由管理端统一维护，构建系统指令时实时拉取，不在客户端写死。


// 个人知识库自动入库已拆至 personal-kb.ts，此处只留 IPC 编排。

// 从管理端拉取最新的岗位专家列表，供客户端「当前工作分身」展示与领用。
// ── 登录 IPC ──────────────────────────────────────────────────────────────
const REMEMBER_MS = 7 * 24 * 60 * 60 * 1000   // 「7天内自动登录」有效期
ipcMain.handle('auth:login', async (_event, { username, password, remember }: { username: string; password: string; remember?: boolean }) => {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': 'client' },
      body: JSON.stringify({ username, password })
    })
    const data: any = await r.json().catch(() => ({}))
    if (!r.ok || !data.success) return { ok: false, error: data.error || `登录失败(${r.status})` }
    configSet('auth-token', data.token)
    configSet('auth-user', JSON.stringify(data.user))
    configSet('auth-last-username', username)   // 记住上次登录用户名(下次预填)
    // 是否允许下次启动自动登录（勾选「7天内自动登录」）
    configSet('auth-remember', remember === false ? 'false' : 'true')
    configSet('auth-login-at', String(Date.now()))
    return { ok: true, user: data.user }
  } catch (e: any) {
    return { ok: false, error: `无法连接服务端：${e.message}` }
  }
})
ipcMain.handle('auth:session', async () => {
  const u = authUser()
  if (!u || !authToken()) return { user: null }
  // 「7天内自动登录」闸门：未勾选或已过期 → 不自动登录，清凭证要求重新输入密码
  const remember = configGet('auth-remember') === 'true'
  const loginAt = Number(configGet('auth-login-at') || '0')
  if (!remember || !loginAt || Date.now() - loginAt > REMEMBER_MS) {
    configSet('auth-token', ''); configSet('auth-user', '')
    return { user: null }
  }
  // 校验 token 仍有效（顺带刷新用户信息）
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/auth/me`, { headers: authHeaders() })
    if (r.ok) { const fresh: any = await r.json(); configSet('auth-user', JSON.stringify(fresh)); return { user: fresh } }
    if (r.status === 401) { configSet('auth-token', ''); configSet('auth-user', ''); return { user: null } }
  } catch (_) { /* 后端离线：沿用本地缓存用户，允许离线继续用 */ }
  return { user: u }
})
ipcMain.handle('auth:logout', async () => {
  configSet('auth-token', ''); configSet('auth-user', '')
  configSet('auth-remember', 'false'); configSet('auth-login-at', '')
  return { ok: true }
})
ipcMain.handle('auth:last-username', () => configGet('auth-last-username') || '')
ipcMain.handle('auth:forgot', async (_event, { username, phone }: { username: string; phone?: string }) => {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/auth/forgot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': 'client' },
      body: JSON.stringify({ username, phone: phone || '' })
    })
    const data: any = await r.json().catch(() => ({}))
    if (!r.ok || !data.success) return { ok: false, error: data.error || '提交失败' }
    return { ok: true, message: data.message }
  } catch (e: any) { return { ok: false, error: e.message } }
})
ipcMain.handle('auth:change-password', async (_event, { oldPassword, newPassword }: { oldPassword: string; newPassword: string }) => {
  try {
    const r = await fetch(`${getAdminBaseUrl()}/api/v1/auth/change-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ oldPassword, newPassword })
    })
    const data: any = await r.json().catch(() => ({}))
    if (!r.ok || !data.success) return { ok: false, error: data.error || `修改失败(${r.status})` }
    // 刷新本地用户信息（mustChangePassword 变 false）
    try {
      const me = await fetch(`${getAdminBaseUrl()}/api/v1/auth/me`, { headers: authHeaders() })
      if (me.ok) { const fresh: any = await me.json(); configSet('auth-user', JSON.stringify(fresh)); return { ok: true, user: fresh } }
    } catch (e) { swallow(e) }
    return { ok: true }
  } catch (e: any) { return { ok: false, error: e.message } }
})

ipcMain.handle('expert:list', async () => {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/experts`)
    if (!r.ok) return { success: false, error: `backend ${r.status}` }
    const list: any[] = await r.json()
    let experts = (Array.isArray(list) ? list : []).map((e: any) => ({
      id: e.id,
      title: e.title || '未命名分身',
      spec: e.spec || '',
      description: e.description || '',
      skills: Array.isArray(e.skills) ? e.skills.map((s: any) => ({ id: s.id, name: s.name, type: s.type, description: s.description || '', category: s.category || '', version: s.version || '', status: s.status || '', triggerKeywords: Array.isArray(s.triggerKeywords) ? s.triggerKeywords : [] })) : []
    }))
    // 按登录用户的「可领用岗位」过滤（allowAllExperts=true 或未登录则不限制）
    const u = authUser()
    if (u && !u.allowAllExperts) {
      const allow = new Set(u.assignedExpertIds || [])
      experts = experts.filter(e => allow.has(e.id))
    }
    return { success: true, experts }
  } catch (netErr: any) {
    console.warn(`[expert:list] Backend offline: ${netErr.message}`)
    return { success: false, error: 'offline' }
  }
})

ipcMain.handle('expert:claim', async (_event, expertId: string) => {
  console.log(`[expert:claim] expertId="${expertId}"`)

  let syncSuccess = false
  let skillsSynced: Array<{ id: string; name: string; type: string; description?: string; category?: string; version?: string; status?: string; triggerKeywords?: string[] }> = []
  let knowledgeScope: string[] = []

  // 1. Try syncing from Spring Boot backend server
  try {
    console.log(`[expert:claim] Requesting sync from backend for expert: ${expertId}`)
    const response = await afetch(`${getAdminBaseUrl()}/api/v1/experts/claim/${expertId}`, {
      method: 'POST'
    })

    if (response.ok) {
      const data: any = await response.json()
      console.log(`[expert:claim] Backend response:`, data)
      if (data.success && data.skillsSynced) {
        // Write each skill to physical folder
        for (const sk of data.skillsSynced) {
          writeSkillFile(sk)
          if (sk && sk.id && sk.name) setSkillDisplayName(String(sk.id), String(sk.name))
          skillsSynced.push({
            id: sk.id,
            name: sk.name,
            type: sk.type,   // 保留真实引擎类型（python-sandbox/playwright…），由 UI 映射友好标签
            description: sk.description || '',
            category: sk.category || '',
            version: sk.version || '',
            status: sk.status || '',
            triggerKeywords: Array.isArray(sk.triggerKeywords) ? sk.triggerKeywords : []
          })
        }
        // Remember the claimed expert for client heartbeat reporting
        configSet('lastClaimedExpertId', expertId)
        // 记录该岗位实际装配的技能 ID 集（技能匹配据此限定范围，避免误命中未装配/全局技能）
        configSet('boundSkills:' + expertId, JSON.stringify(data.skillsSynced.map((s: any) => String(s.id))))
        // Downlinked corporate knowledge-base retrieval scope for this expert
        if (Array.isArray(data.knowledgeScope)) {
          knowledgeScope = data.knowledgeScope
          configSet('kbScope:' + expertId, JSON.stringify(knowledgeScope))
          console.log(`[expert:claim] Knowledge scope downlinked: ${knowledgeScope.join(', ') || '(none)'}`)
        }
        syncSuccess = true
        console.log(`[expert:claim] Successfully synchronized ${data.skillsSynced.length} skills from backend.`)
      }
    } else {
      console.warn(`[expert:claim] Backend returned non-OK status: ${response.status}`)
    }
  } catch (netErr: any) {
    console.warn(`[expert:claim] Backend server offline or request failed: ${netErr.message}`)
  }

  // 2.（已移除）演示用记忆种子：曾在此伪造「岗位 SOP / 用户个人习惯」写入本地记忆库——
  // 数据与来源(“用户历史会话沉淀”)均系编造，且 agent SOP 每次认领会无条件覆盖真实沉淀，
  // 违反真实性红线。记忆应只来自真实沉淀（用户设置/会话记忆/管理端下发），空着就是空着。

  // 3. Load local skills dynamically (if syncSuccess is false, it loads what's already on disk)
  if (syncSuccess) await pruneDeletedSkills()   // 同步成功 → 以管理端为准清理已删技能
  loadLocalSkills()

  // 4. 管理端离线时的兜底：如实列出本地已落盘的技能（此前同步下来的），没有就是空——不特判、不硬造预置条目。
  if (!syncSuccess) {
    console.log(`[expert:claim] Backend sync offline. Listing local on-disk skills.`)
    getLoadedSkills().forEach(sk => {
      skillsSynced.push({ id: sk.id, name: sk.name, type: '本地已落盘技能 (Markdown SOP)' })
    })
  }

  return {
    success: true,
    skillsSynced,
    knowledgeScope
  }
})

// Files list and mock endpoints
ipcMain.handle('files:list', () => {
  return getLocalFiles()
})

// 代码执行沙箱：状态 + 自检执行统一走公司级后端 Docker 沙箱（本地沙箱已移除）。
ipcMain.handle('sandbox:status', async () => {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/sandbox/exec/status`)
    if (!r.ok) return { healthy: false, reachable: false, error: `HTTP ${r.status}` }
    const j: any = await r.json()
    return { healthy: !!j.reachable && !!j.imageReady, reachable: !!j.reachable, imageReady: !!j.imageReady, mode: j.mode, image: j.image, dockerEndpoint: j.dockerEndpoint }
  } catch (e) { swallow(e, 'sandbox-status'); return { healthy: false, reachable: false, error: String((e as any)?.message || e) } }
})
ipcMain.handle('sandbox:run', async (_e, payload: { code: string; packages?: string[] }) => {
  const res = await execViaBackendSandbox(String(payload?.code || ''), Array.isArray(payload?.packages) ? payload!.packages! : [])
  return res || { ok: false, stdout: '', stderr: '', error: '后端 Docker 沙箱不可达', files: [], engine: 'Docker 容器' }
})

// 快速查看：macOS 原生 Quick Look(与访达按空格一致)；其它平台回退系统默认应用打开。
ipcMain.handle('files:preview', (_event, name: string) => {
  try {
    let abs = path.join(workspaceDir(), String(name || ''))
    if (!abs.startsWith(workspaceDir()) || !fs.existsSync(abs)) {
      // 回退:遗留同步卡片区的文件位于内部 documents 目录
      const legacyDir = path.join(process.cwd(), 'documents')
      const legacy = path.join(legacyDir, String(name || ''))
      if (legacy.startsWith(legacyDir) && fs.existsSync(legacy)) abs = legacy
      else return { success: false, error: '文件不存在或不在工作目录内' }
    }
    if (process.platform === 'darwin' && mainWindow) mainWindow.previewFile(abs, name)
    else shell.openPath(abs)
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) }
  }
})

// 在访达/资源管理器中显示（下载/另存的本地等价操作）：定位到工作空间内的产物文件。
ipcMain.handle('files:reveal', (_event, name: string) => {
  try {
    const abs = path.join(workspaceDir(), String(name || ''))
    if (!abs.startsWith(workspaceDir()) || !fs.existsSync(abs)) return { success: false, error: '文件不存在或不在工作目录内' }
    shell.showItemInFolder(abs)
    return { success: true }
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) }
  }
})

// Real files sync endpoint
ipcMain.handle('files:sync', async (_event, fileName: string) => {
  try {
    const projectRoot = process.cwd()
    const filePath = path.join(projectRoot, 'documents', fileName)
    if (!fs.existsSync(filePath)) {
      throw new Error(`本地文件不存在: ${filePath}`)
    }

    const fileBuffer = fs.readFileSync(filePath)
    const fileBlob = new Blob([fileBuffer])
    
    // Retrieve nickname/employee config from SQLite
    const employeeName = configGet('user-nickname') || '张经理'

    const formData = new FormData()
    formData.append('file', fileBlob, fileName)
    formData.append('path', `/documents/${fileName}`)
    formData.append('summary', `同步备份的物理文件: ${fileName}`)
    formData.append('employee', employeeName)

    console.log(`[files:sync] Uploading file to backend: ${fileName} (${fileBuffer.length} bytes)`)
    const response = await afetch(`${getAdminBaseUrl()}/api/v1/sync/upload`, {
      method: 'POST',
      body: formData,
      timeoutMs: 180000   // 上传+入库可能较慢
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`服务器返回错误: ${response.status} - ${errText}`)
    }

    const resData: any = await response.json()
    console.log(`[files:sync] Upload response:`, resData)

    if (resData.success) {
      const file = getLocalFiles().find(f => f.name === fileName)
      if (file) {
        file.synced = true
        if (mainWindow) {
          mainWindow.webContents.send('files:sync-progress', { name: fileName, progress: 100 })
        }
      }
      return { success: true }
    } else {
      throw new Error(resData.error || '上传失败')
    }
  } catch (err: any) {
    console.error(`[files:sync] Synchronization failed:`, err.message)
    return { success: false, error: err.message }
  }
})

// （已移除）takeWebScreenshot / checkWeatherAndAllowance / analyzeLocalWorkspace：
// 内置演示技能的原生实现，随 runBuiltinSkill 一并拆除——技能只在管理端配置，统一走自定义技能链路。

// 远程控制机器人（飞书/钉钉/QQ）逻辑已抽到 ./remote-bots；此处仅保留 IPC 注册。// 远程控制机器人（飞书/钉钉/QQ）逻辑已抽到 ./remote-bots；此处仅保留 IPC 注册。
ipcMain.handle('remote-bot:status', () => getRemoteBotState())
ipcMain.handle('remote-bot:start', async (_e, key: RemoteBotKey, values: Record<string, string>) => {
  try { await startRemoteBot(key, values); return { success: true } }
  catch (e: any) { return { success: false, error: e?.message || String(e) } }
})
ipcMain.handle('remote-bot:stop', async (_e, key: RemoteBotKey) => {
  await stopRemoteBot(key); return { success: true }
})
// 用户对某条回答的质量反馈 → 回填到管理端 Trace（优先 traceId 精确回填，否则按问题文本兜底）
ipcMain.handle('trace:feedback', async (_e, data: { traceId?: string; userQuestion?: string; feedback: string | null }) => {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/traces/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ traceId: data.traceId, userQuestion: data.userQuestion, feedback: data.feedback })
    })
    return r.ok ? await r.json() : { success: false }
  } catch (e: any) { return { success: false, error: e?.message } }
})
// 工作台驾驶舱：一次拉取真实能力 + 最近任务 + 系统连接，供首页真实驱动展示
ipcMain.handle('workbench:overview', async () => {
  const base = getAdminBaseUrl()
  const get = async (p: string) => { try { const r = await afetch(`${base}${p}`); return r.ok ? await r.json() : [] } catch (_) { return [] } }
  const [skills, actions, traces, systems] = await Promise.all([
    get('/api/v1/skills'), get('/api/v1/ontology/actions'), get('/api/v1/traces'), get('/api/v1/integrations'),
  ])
  return {
    skills: Array.isArray(skills) ? skills : [],
    actions: Array.isArray(actions) ? actions : [],
    traces: (Array.isArray(traces) ? traces : []).slice(0, 6),
    systems: Array.isArray(systems) ? systems : [],
  }
})

ipcMain.handle('remote-bot:test', async (_e, key: RemoteBotKey, values: Record<string, string>) => {
  // 建立真实长连接即为连通验证；成功后保持运行（等价于启用）
  try { await startRemoteBot(key, values); return { success: true, message: '连接成功，已建立官方长连接。' } }
  catch (e: any) { return { success: false, error: e?.message || String(e) } }
})
// runCustomSkill（自定义技能真实执行）已拆至 skill-custom.ts。

type OrchStep = { type: 'websearch' } | { type: 'skill'; skill: SkillDefinition }

// 为每个已确定的步骤写一句"子目标"：让每步的执行/作答只聚焦本步职责，不越界answer整个复合请求。
async function planStepGoals(userText: string, steps: OrchStep[], cfg: LlmConfig): Promise<string[]> {
  const fallback = steps.map(() => userText)   // 规划失败时退回整句（至少能跑，只是不分工）
  const isCfg = cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName
  if (!isCfg) return fallback
  const desc = steps.map((s, i) => {
    const label = s.type === 'websearch' ? '联网检索并总结相关最新信息' : `业务技能「${skillLabel(s.skill)}」`
    return `${i + 1}. ${label}`
  }).join('\n')
  const prompt = `用户的复合请求：${userText}\n\n系统已确定按以下 ${steps.length} 个步骤依次处理，步骤与技能已固定、不要增删或替换：\n${desc}\n\n请为每一步写一句"该步要达成的子目标"，只覆盖该步自身职责、不要跨步、不要笼统重复整句请求。严格输出 JSON 字符串数组，长度与步骤数一致、一一对应，例如 ["...","..."]。只输出 JSON，不要任何解释。`
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
async function runOrchestratedSkills(steps: OrchStep[], data: AgentTaskData, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult> {
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

async function runSkillPipeline(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult | null> {
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

ipcMain.handle('agent:send-message', (_event, data: { content: string; expertId?: string; expertName: string; userNickname?: string; background: string; llmConfig: LlmConfig; forcedSkillId?: string; permMode?: 'readonly' | 'full'; history?: { role: 'user' | 'assistant'; content: string }[] }) => runExclusive(async () => {
  incImCommandCount()
  runningState.aborted = false   // 新任务开始，清中止标志
  if (data.expertName) configSet('lastClaimedExpertName', data.expertName)
  const sendLog = (type: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed', text: string) => {
    if (mainWindow) {
      mainWindow.webContents.send('agent:log-stream', { type, text, timestamp: new Date().toLocaleTimeString() })
    }
  }

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

  // --- 技能拦截与执行 ---：匹配→内置/自定义技能执行→联网检索兜底→按真实结果整理作答
  {
    const skillRes = await runSkillPipeline(data, sendLog, trace)
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

    sendLog('thinking', `正在查相关的公司制度…`)
    const corporateChunks = await queryCorporateKnowledge(data.content, expertId)
    if (corporateChunks.length) {
      sendLog('thinking', `查到 ${corporateChunks.length} 条相关制度，已经一起考虑进去了。`)
    } else {
      sendLog('thinking', `没查到相关制度，先用本地记忆来答。`)
    }
    const corporateRagBlock = buildCorporateRagBlock(corporateChunks)
    const enterpriseBlock = await getEnterpriseBlock()
    // 解析本次附件（PDF/文本）的真实内容，供分身基于真实文本作答。
    const attachmentText = await extractAttachmentText(data.content, sendLog)
    const attachmentSection = attachmentText
      ? `\n\n【附件真实内容】（已从工作空间解析，请基于此作答，勿编造）\n${attachmentText}`
      : ''

    // Build the prompt containing the retrieved context
    const promptWithContext = `[系统指令/System Prompt]
你是一个岗位专家智能体助手。
你的名字（岗位名称）是：${data.expertName}
你对用户的称呼是：${userNickname}
【当前日期时间】${new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}（系统实时，回答日期/时间相关问题一律以此为准，不要臆测）
${buildHistoryBlock(data.history)}
${NO_FABRICATION_RULE}

【岗位预置知识与SOP】
${agentSopList}

【用户个人信息与习惯】
- 岗位背景：${data.background}
- 用户称呼：${userNickname}
${personalMemoryList}

【企业知识与规则】（由管理端统一维护）
${enterpriseBlock}${kbScopeLine}${corporateRagBlock}${attachmentSection}

[当前指令/User Instruction]
请基于上述静态知识与用户背景进行回答或分析，称呼用户为“${userNickname}”。务必遵守上面的【真实性边界】：若该指令需要的是你无法获取的真实业务数据（如未读邮件、待办、单据等），请如实说明并给出下一步建议，绝不要编造。若上方提供了【附件真实内容】，请基于该真实文本进行分析：
"${data.content}"`

    let content = ''
    try {
      content = await callLlm(promptWithContext, cfg)
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
}))

// IPC Form / Delete Confirmation responses from React UI
registerAgentControlHandlers()

// Window chrome handlers
registerWindowHandlers()

// 工作空间目录/扫描与文档解析已拆至 workspace-files.ts，此处只留 IPC 编排。
ipcMain.handle('workspace:files', () => ({ dir: workspaceDir(), files: scanWorkspace() }))
ipcMain.handle('workspace:pick-dir', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择工作空间目录' })
  if (r.canceled || !r.filePaths.length) return { canceled: true, dir: workspaceDir(), files: scanWorkspace() }
  configSet('workspaceDir', r.filePaths[0])
  return { ok: true, dir: workspaceDir(), files: scanWorkspace() }
})
ipcMain.handle('workspace:reset-dir', () => { configSet('workspaceDir', ''); return { dir: workspaceDir(), files: scanWorkspace() } })

// 在系统文件管理器中打开工作空间目录。
ipcMain.handle('workspace:open', async () => {
  try {
    const dir = workspaceDir()
    await shell.openPath(dir)
    return { success: true, dir }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

// 选择本地文件作为附件：拷贝进工作空间并登记，供分身/技能读取。
ipcMain.handle('attach:pick', async () => {
  try {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled || !result.filePaths.length) return { success: false, canceled: true, files: [] }
    const dir = workspaceDir()
    const files: { name: string; path: string }[] = []
    for (const src of result.filePaths) {
      const base = path.basename(src)
      const dest = path.join(dir, base)
      try { fs.copyFileSync(src, dest) } catch (e) { swallow(e) }
      const f = { name: base, path: `/documents/${base}`, summary: `用户上传附件：${base}`, synced: false }
      getLocalFiles().push(f)
      if (mainWindow) mainWindow.webContents.send('files:watch-event', { action: 'add', file: f })
      files.push({ name: base, path: f.path })
      // 显式上传的附件也自动进个人知识库（可解析类型 + 未排除时）
      ingestToPersonalKB(dest).catch(() => {})
    }
    return { success: true, files }
  } catch (err: any) {
    return { success: false, error: err.message, files: [] }
  }
})

// ── 个人知识库 IPC ────────────────────────────────────────────────────────
// 概览：owner、自动入库开关、本地文件的入库/排除状态。
ipcMain.handle('kb:overview', async () => {
  const ownerId = getOwnerId()
  const autoIngest = kbAutoIngestOn()
  let docs: any[] = []
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/knowledge/docs?scope=PERSONAL&ownerId=${encodeURIComponent(ownerId)}`)
    if (r.ok) { const d: any = await r.json(); if (Array.isArray(d)) docs = d }
  } catch (e) { swallow(e) }
  // 以文件名关联本地状态
  const files = scanWorkspace().map(f => ({
    name: f.name,
    excluded: configGet('kb-exclude:' + f.name) === '1',
    docId: configGet('kb-doc:' + f.name) || '',
    doc: docs.find(d => d.filename === f.name) || null
  }))
  return { ok: true, ownerId, autoIngest, files, personalDocs: docs }
})
// 记忆面板·企业知识级：拉取本岗位可检索的企业知识库范围（分类）+ 该范围下的真实文档清单。
// 只读真实数据（不硬编造事实）；问答时由 queryCorporateKnowledge 现查现用 RAG 召回。
ipcMain.handle('memory:enterprise', async (_e, expertId?: string) => {
  const categories = getKnowledgeScope(expertId)
  let docs: any[] = []
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/knowledge/docs?scope=ENTERPRISE`)
    if (r.ok) { const d: any = await r.json(); if (Array.isArray(d)) docs = d }
  } catch (e) { swallow(e, 'memory-enterprise') }
  // 有范围则按分类过滤（岗位只看得到授权范围）；无范围则全部企业文档
  const inScope = categories.length ? docs.filter(d => categories.includes(d.category)) : docs
  const list = inScope.map(d => ({ name: d.filename || d.title || d.id, category: d.category || '未分类', updatedAt: d.updatedAt || d.createdAt || '' }))
  return { ok: true, categories, total: list.length, docs: list.slice(0, 30) }
})
ipcMain.handle('kb:set-autoingest', (_e, on: boolean) => { configSet('kb-autoingest', on ? '1' : '0'); return { ok: true, autoIngest: on } })
// 手动入库某文件（强制，忽略排除与去重）
ipcMain.handle('kb:ingest', async (_e, name: string) => {
  configSet('kb-exclude:' + name, '0')
  const r = await ingestToPersonalKB(path.join(workspaceDir(), name), { force: true })
  return r
})
// 移出个人库：删除后端文档 + 标记排除，之后不再自动入库
ipcMain.handle('kb:remove', async (_e, name: string) => {
  const docId = configGet('kb-doc:' + name)
  if (docId) {
    try { await afetch(`${getAdminBaseUrl()}/api/v1/knowledge/docs/${docId}`, { method: 'DELETE' }) } catch (e) { swallow(e) }
  }
  configSet('kb-doc:' + name, '')
  configSet('kb-hash:' + name, '')
  configSet('kb-exclude:' + name, '1')
  kbEmit({ action: 'removed', name })
  return { ok: true }
})
// 归档到企业库：对已入个人库的文档发起「提名」，走管理端审批
ipcMain.handle('kb:promote', async (_e, { name, category }: { name: string; category: string }) => {
  const docId = configGet('kb-doc:' + name)
  if (!docId) return { ok: false, reason: 'not-in-personal-kb' }
  try {
    const params = new URLSearchParams({ category: category || '公司基本信息', ownerId: getOwnerId() })
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/knowledge/docs/${docId}/promote?${params.toString()}`, { method: 'POST' })
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` }
    const d: any = await r.json()
    return { ok: !!d.success, status: d.status }
  } catch (e: any) { return { ok: false, reason: e.message } }
})

// =====================================================================
// 企业业务系统连接：系统由管理端定义，客户端在此完成员工个人登录。
// 登录会话按系统隔离持久保存（persist:bizsys-<id>，bizPartition 见 biz-keepalive.ts），与技能执行器共用。
// =====================================================================

// 列出管理端定义的业务系统，并附带本地登录态标记。
ipcMain.handle('systems:list', async () => {
  try {
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
    if (!res.ok) return { ok: false, systems: [], error: `HTTP ${res.status}` }
    const list: any = await res.json()
    const systems = (Array.isArray(list) ? list : []).map((s: any) => ({
      id: s.id, type: s.type, name: s.name, baseUrl: s.baseUrl, status: s.status,
      linked: configGet('bizsys-linked:' + s.id) === '1'
    }))
    return { ok: true, adminBaseUrl: getAdminBaseUrl(), systems }
  } catch (e: any) {
    return { ok: false, systems: [], error: e.message }
  }
})

// 保存浏览器实操录制生成的技能到管理端（技能中心据此下发/编辑）。
ipcMain.handle('skill:save-recorded', async (_event, payload: { name: string; triggerKeywords: string[]; targetSystemId: string; actionScript: string; allowedRoles?: string[] }) => {
  try {
    const body = {
      name: payload.name,
      type: 'playwright',
      category: '录制技能',
      status: 'PUBLISHED',
      source: 'recorded',
      description: '由浏览器实操录制生成的可回放技能。',
      triggerKeywords: payload.triggerKeywords || [],
      allowedRoles: payload.allowedRoles || [],
      targetSystemId: payload.targetSystemId || '',
      actionScript: payload.actionScript,
      sopContent: '本技能通过实操录制生成，执行时按确认参数确定性回放录制步骤。'
    }
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/skills`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const created: any = await res.json()
    return { ok: true, skill: created }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

// 当前打开的登录窗口（按系统隔离）；"我已登录，检测"直接读这个窗口的真实内容。
const bizLoginWins = new Map<string, BrowserWindow>()
// 判定页面是否仍为登录页（内容很少且含登录字样）。
function isBizLoginPage(text: string): boolean {
  const t = (text || '').trim()
  return t.length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password|认证|扫码|验证码)/i.test(t)
}

// 打开系统登录窗口：立即返回（窗口保持打开），员工登录后点「我已登录，检测」。
ipcMain.handle('systems:login', async (_event, { systemId, baseUrl }: { systemId: string; baseUrl: string }) => {
  const exist = bizLoginWins.get(systemId)
  if (exist && !exist.isDestroyed()) { try { exist.focus() } catch (e) { swallow(e) } return { ok: true } }
  const win = new BrowserWindow({
    show: true, width: 1200, height: 820,
    title: 'iML 工作分身 · 登录企业系统',
    webPreferences: { partition: bizPartition(systemId) }
  })
  bizLoginWins.set(systemId, win)
  win.on('closed', () => { if (bizLoginWins.get(systemId) === win) bizLoginWins.delete(systemId) })
  win.loadURL(baseUrl).catch(() => {})
  return { ok: true }
})

// 关闭某系统的登录窗口（取消验证）。
ipcMain.handle('systems:login-close', async (_event, { systemId }: { systemId: string }) => {
  const win = bizLoginWins.get(systemId)
  if (win && !win.isDestroyed()) { try { win.close() } catch (e) { swallow(e) } }
  bizLoginWins.delete(systemId)
  return { ok: true }
})

// 检测登录态：优先读"当前打开的登录窗口"（有现成会话，最准）；无打开窗口时离屏探测。登录成功则关窗。
ipcMain.handle('systems:check', async (_event, { systemId, baseUrl }: { systemId: string; baseUrl: string }) => {
  const openWin = bizLoginWins.get(systemId)
  if (openWin && !openWin.isDestroyed()) {
    try {
      const text: string = await openWin.webContents.executeJavaScript(
        `(function(){return (document.body ? document.body.innerText : '').slice(0, 800)})()`
      )
      const loggedIn = !isBizLoginPage(text)
      configSet('bizsys-linked:' + systemId, loggedIn ? '1' : '0')
      if (loggedIn) { try { openWin.close() } catch (e) { swallow(e) }; bizLoginWins.delete(systemId) }
      return { ok: true, loggedIn }
    } catch (e: any) { return { ok: false, error: e.message } }
  }
  // 无打开的登录窗口 → 离屏探测系统地址
  return await new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false, width: 1100, height: 760,
      webPreferences: { partition: bizPartition(systemId), offscreen: true }
    })
    let settled = false
    const done = (loggedIn: boolean, error?: string) => {
      if (settled) return
      settled = true
      try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
      if (!error) configSet('bizsys-linked:' + systemId, loggedIn ? '1' : '0')
      resolve({ ok: !error, loggedIn, error })
    }
    win.webContents.once('did-finish-load', async () => {
      try {
        await sleep(2800)
        const text: string = await win.webContents.executeJavaScript(
          `(function(){return (document.body ? document.body.innerText : '').slice(0, 800)})()`
        )
        done(!isBizLoginPage(text))
      } catch (e: any) { done(false, e.message) }
    })
    win.webContents.once('did-fail-load', (_e, code, desc) => done(false, `加载失败(${code}): ${desc}`))
    win.loadURL(baseUrl).catch(() => {})
    setTimeout(() => done(false, '检测超时'), 22000)
  })
})

// 退出登录：清空该系统的本地会话分区。
ipcMain.handle('systems:logout', async (_event, { systemId }: { systemId: string }) => {
  try {
    await session.fromPartition(bizPartition(systemId)).clearStorageData()
    configSet('bizsys-linked:' + systemId, '0')
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

// 业务系统登录保活心跳已拆至 biz-keepalive.ts，此处只留 IPC 编排。
ipcMain.handle('systems:heartbeat-get', () => getHbState())
ipcMain.handle('systems:heartbeat-set', (_e, enabled: boolean) => setHbEnabled(enabled))
ipcMain.handle('systems:heartbeat-now', async () => { await runBizHeartbeat(); return getHbState() })

