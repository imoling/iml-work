import './global-env'
import { app, BrowserWindow, ipcMain, shell, session, dialog, Notification } from 'electron'
import path, { join } from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import {
  configGet,
  configSet,
  configGetAll,
  memoryGet,
  memorySet,
  schedList,
  schedUpsert,
  schedSetEnabled,
  schedSetLastRun,
  schedDelete,
  type ScheduledTask
} from './db'
import { getAdminBaseUrl, authToken, authUser, authHeaders, afetch, getOwnerId } from './http'
import { type LlmConfig, callLlm } from './llm'
import { setMainWindow } from './window-ref'
import { incImCommandCount, getImCommandCount } from './stats'
import { type RemoteBotKey, getRemoteBotState, startRemoteBot, stopRemoteBot, bootRemoteBots } from './remote-bots'
import { swallow, sleep } from './util'
import { runningState, runExclusive, requestFormConfirmation, requestPermissionChoice } from './automation-runtime'
import { openSystemAndExtract, extractVisitFields, fillCrmVisitForm, extractFieldsByLabels, replayActionScript, parseDsl, interpretSkillScript } from './browser-automation'
import { AgentTrace } from './agent-trace'
import { registerDbHandlers } from './ipc/db'
import { registerWindowHandlers } from './ipc/window'
import { registerAgentControlHandlers } from './ipc/agent-control'
import { runOntologyHook } from './agent-ontology'
import type { AgentTaskData, AgentResult } from './agent-types'
import { type SendLog, type VisitField, type RecStep } from './types'
import { webSearch, isWebSearchIntent, refineSearchQuery, getExpertWebSearch, shouldWebSearch } from './web-search'
import { getEnterpriseBlock, getKnowledgeScope, queryCorporateKnowledge, buildCorporateRagBlock, attachRagImages, buildKnowledgeSources } from './corporate-rag'
import { type SkillDefinition, getLoadedSkills, skillLabel, skillDisplayName, setSkillDisplayName, loadLocalSkills, pruneDeletedSkills, writeSkillFile, initSkillStore } from './skill-store'
import { workspaceDir, scanWorkspace, extractAttachmentText } from './workspace-files'

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
  startFileSyncWatcher()
  startHeartbeat()
  startBizKeepAlive()
  startScheduler()
  bootRemoteBots()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (fileWatcher) void fileWatcher.close()
  for (const k of ['feishu', 'dingtalk', 'qq'] as RemoteBotKey[]) { void stopRemoteBot(k) }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* =========================================================================
   FileSyncService — real directory watching (chokidar) + delta sync upload
   ========================================================================= */

const DOCUMENTS_DIR = path.join(process.cwd(), 'documents')
let fileWatcher: FSWatcher | null = null

function emitSyncEvent(payload: Record<string, any>) {
  if (mainWindow) mainWindow.webContents.send('filesync:event', payload)
}

function md5OfFile(filePath: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex')
}

// Upload one document to the admin backend via multipart, with md5 delta-skip.
async function syncDocumentFile(fileName: string, filePath: string): Promise<void> {
  try {
    if (!fs.existsSync(filePath)) return
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return

    const hash = md5OfFile(filePath)
    const prev = configGet('fhash:' + fileName)
    if (prev === hash) {
      emitSyncEvent({ action: 'unchanged', name: fileName, status: 'synced' })
      return
    }

    emitSyncEvent({ action: 'detected', name: fileName, status: 'syncing', message: '检测到文件变更，正在差量同步...' })

    const fileBlob = new Blob([fs.readFileSync(filePath)])
    const employeeName = configGet('user-nickname') || '张经理'
    const summary = buildFileSummary(fileName, filePath)

    const formData = new FormData()
    formData.append('file', fileBlob, fileName)
    formData.append('path', `/documents/${fileName}`)
    formData.append('summary', summary)
    formData.append('employee', employeeName)

    const res = await afetch(`${getAdminBaseUrl()}/api/v1/sync/upload`, { method: 'POST', body: formData, timeoutMs: 180000 })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    configSet('fhash:' + fileName, hash)
    if (!localFiles.find(f => f.name === fileName)) {
      localFiles.push({ name: fileName, path: `/documents/${fileName}`, summary, synced: true })
    } else {
      const f = localFiles.find(f => f.name === fileName)!
      f.synced = true
    }
    emitSyncEvent({ action: 'synced', name: fileName, status: 'synced', message: '已差量同步至企业云端' })
    console.log(`[FileSyncService] Delta-synced "${fileName}" (${hash.slice(0, 8)})`)
    // 归档同步之余，顺带自动进「个人知识库」(可解析类型 + 未被排除时)，让分身可检索。
    ingestToPersonalKB(filePath).catch(() => {})
  } catch (err: any) {
    console.warn(`[FileSyncService] sync failed for ${fileName}: ${err.message}`)
    emitSyncEvent({ action: 'error', name: fileName, status: 'local', message: `同步失败(后端离线?): ${err.message}` })
  }
}

// Lightweight text-derived summary for txt/md; placeholder for binary docs.
function buildFileSummary(fileName: string, filePath: string): string {
  const ext = path.extname(fileName).toLowerCase()
  if (ext === '.txt' || ext === '.md' || ext === '.csv') {
    try {
      const text = fs.readFileSync(filePath, 'utf-8').replace(/\s+/g, ' ').trim()
      return text.slice(0, 80) || `文本文件: ${fileName}`
    } catch (e) { swallow(e) }
  }
  return `自动同步的物理文件: ${fileName}`
}

// Watch the local documents directory; auto delta-sync on add/change.
function startFileSyncWatcher() {
  try {
    if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true })
    fileWatcher = chokidarWatch(DOCUMENTS_DIR, {
      ignoreInitial: false,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 100 }
    })
    const onChange = (filePath: string) => {
      const fileName = path.basename(filePath)
      if (fileName.startsWith('.')) return
      void syncDocumentFile(fileName, filePath)
    }
    fileWatcher.on('add', onChange).on('change', onChange)
    console.log(`[FileSyncService] Watching ${DOCUMENTS_DIR} for auto delta-sync.`)
  } catch (err: any) {
    console.warn(`[FileSyncService] watcher failed to start: ${err.message}`)
  }
}

/* =========================================================================
   Client heartbeat — report sandbox runtime telemetry to the admin console
   ========================================================================= */

let heartbeatTimer: NodeJS.Timeout | null = null

function getClientId(): string {
  let id = configGet('clientId')
  if (!id) {
    id = 'node-' + crypto.randomUUID().slice(0, 8)
    configSet('clientId', id)
  }
  return id
}

async function sendHeartbeat() {
  try {
    const body = {
      clientId: getClientId(),
      hostname: os.hostname(),
      expertId: configGet('lastClaimedExpertId') || '',
      expertName: configGet('lastClaimedExpertName') || '',
      sandboxMode: 'backend-docker',      // 本地沙箱已移除；代码执行统一走公司级后端 Docker 沙箱
      // pyodideHealthy 字段兼容 ClientNode；本地沙箱移除后恒 true，沙箱真实状态见管理端「沙箱监控」(/exec/status)
      pyodideHealthy: true,
      imCommandCount: getImCommandCount(),
      appVersion: app.getVersion()
    }
    await afetch(`${getAdminBaseUrl()}/api/v1/clients/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (err: any) {
    // Admin backend offline — heartbeat is best-effort.
  }
}

// 近实时技能同步：按指纹拉取当前岗位装配的技能集，变了才重新落盘/清理/重载并通知渲染层。
// 指纹覆盖：技能增/删（下架即脱离岗位→指纹变）、改（updatedAt 变）、装配变更——无需重启/重新领用。
async function syncClaimedSkills() {
  const expertId = configGet('lastClaimedExpertId')
  if (!expertId) return
  try {
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/experts/${expertId}/skills`)
    if (!res.ok) return
    const data: any = await res.json()
    const fp = String(data.fingerprint || '')
    if (!fp || fp === (configGet('skillFp:' + expertId) || '')) return   // 无变化
    const skills: any[] = Array.isArray(data.skills) ? data.skills : []
    for (const sk of skills) writeSkillFile(sk)
    configSet('boundSkills:' + expertId, JSON.stringify(skills.map(s => String(s.id))))
    await pruneDeletedSkills()
    loadLocalSkills()
    configSet('skillFp:' + expertId, fp)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('skills:changed', { expertId, skills })
    console.log(`[skills:sync] 岗位技能集变更，已同步 ${skills.length} 项并重载（fp=${fp}）`)
  } catch (_) { /* 管理端离线 → 下个周期再试 */ }
}

function startHeartbeat() {
  void sendHeartbeat()
  void syncClaimedSkills()
  heartbeatTimer = setInterval(() => { void sendHeartbeat(); void syncClaimedSkills() }, 30_000)
}

// ===== 定时任务（自动化）：到点把任务的指令注入对话，复用完整 agent 流程（含人工确认） =====
function scheduledFireTime(t: ScheduledTask, now: Date): Date | null {
  const [hh, mm] = (t.time || '09:00').split(':').map(n => parseInt(n, 10))
  const d = new Date(now); d.setHours(hh || 0, mm || 0, 0, 0)
  const dow = now.getDay(), dom = now.getDate()
  if (t.freq === 'daily') return d
  if (t.freq === 'weekday') return (dow >= 1 && dow <= 5) ? d : null
  if (t.freq === 'weekly') return (dow === t.dow) ? d : null
  if (t.freq === 'monthly') return (dom === t.dom) ? d : null
  return null
}
function fireScheduledTask(t: ScheduledTask) {
  schedSetLastRun(t.id, Date.now())
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('schedule:fire', { id: t.id, title: t.title, prompt: t.prompt, expertId: t.expertId, expertName: t.expertName })
  }
  try { if (Notification.isSupported()) new Notification({ title: `定时任务 · ${t.title}`, body: (t.prompt || '').slice(0, 80) }).show() } catch (e) { swallow(e) }
}
let schedTimer: NodeJS.Timeout | null = null
function tickScheduler() {
  const now = new Date()
  for (const t of schedList()) {
    if (!t.enabled) continue
    const fire = scheduledFireTime(t, now)
    if (!fire) continue
    const fireTs = fire.getTime()
    if (now.getTime() >= fireTs && t.lastRun < fireTs) {
      // 计划时刻后 6 分钟内补触发；错过太久则标记本次已过，不补跑（避免开机后补跑很久以前的）
      if (now.getTime() - fireTs <= 6 * 60 * 1000) fireScheduledTask(t)
      else schedSetLastRun(t.id, fireTs)
    }
  }
}
function startScheduler() {
  if (schedTimer) return
  schedTimer = setInterval(tickScheduler, 30_000)
  setTimeout(tickScheduler, 5_000)   // 启动 5s 后先跑一次（补触发刚错过的）
}

ipcMain.handle('schedule:list', () => schedList())
ipcMain.handle('schedule:save', (_e, t: ScheduledTask) => { schedUpsert(t); return schedList() })
ipcMain.handle('schedule:toggle', (_e, { id, enabled }: { id: string; enabled: boolean }) => { schedSetEnabled(id, enabled); return schedList() })
ipcMain.handle('schedule:delete', (_e, { id }: { id: string }) => { schedDelete(id); return schedList() })
ipcMain.handle('schedule:run-now', (_e, { id }: { id: string }) => { const t = schedList().find(x => x.id === id); if (t) fireScheduledTask(t); return { ok: true } })

/* =========================================================================
   Harness Agent Loop & Memory RAG & RPA Sandbox Simulator
   ========================================================================= */

// Local storage files sync & watcher simulation
// 个人空间文件列表：只由 FileSyncService 监听真实工作目录填充——不预置任何演示假文件。
let localFiles: Array<{ name: string; path: string; summary?: string; synced: boolean }> = []

// 「写意图」按钮文案：点击这类按钮会改变业务状态（审批/提交/删除…），须按写操作处理（拦截或确认）。
const WRITE_INTENT_LABEL = /同意|通过|批准|审批|核准|提交|确认|确定|保存|删除|移除|清除|新增|添加|录入|创建|发布|上架|下架|归档|驳回|拒绝|退回|撤回|撤销|作废|付款|转账|下单|支付|签收|收货|盖章|签字|生效|发送|发起/

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


// ── 个人知识库自动入库 ────────────────────────────────────────────────────
// 用户处理的文件（工作空间/附件）自动经服务端 docling 解析后进「个人库」(owner 隔离)，
// 让分身越用越懂你的资料。可全局关闭(kb-autoingest)、可按文件排除(kb-exclude:<name>)。
// 只把用户显式引用/放入工作空间的文档送后端，绝不上传登录态/凭证。
function kbAutoIngestOn(): boolean { return configGet('kb-autoingest') !== '0' }
function kbEmit(payload: any) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('kb:changed', payload) }

async function ingestToPersonalKB(absPath: string, opts?: { force?: boolean }): Promise<{ ok: boolean; docId?: string; reason?: string }> {
  const name = path.basename(absPath)
  try {
    if (!fs.existsSync(absPath)) return { ok: false, reason: 'not-found' }
    if (!opts?.force) {
      if (!kbAutoIngestOn()) return { ok: false, reason: 'autoingest-off' }
      if (configGet('kb-exclude:' + name) === '1') return { ok: false, reason: 'excluded' }
    }
    // 仅入库可解析的文档类型（与解析能力一致），跳过其它
    const ext = path.extname(name).toLowerCase()
    const supported = ['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml', '.html', '.htm',
      '.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp']
    if (!supported.includes(ext)) return { ok: false, reason: 'unsupported-type' }
    // 差量去重：内容未变则跳过（避免重复切块）
    const hash = md5OfFile(absPath)
    if (!opts?.force && configGet('kb-hash:' + name) === hash && configGet('kb-doc:' + name)) {
      return { ok: true, docId: configGet('kb-doc:' + name) || undefined, reason: 'unchanged' }
    }
    const fileBlob = new Blob([fs.readFileSync(absPath)])
    const form = new FormData()
    form.append('file', fileBlob, name)
    form.append('ownerId', getOwnerId())
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/knowledge/ingest`, { method: 'POST', body: form, timeoutMs: 180000 })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    const data: any = await res.json()
    if (!data || !data.success) return { ok: false, reason: data?.error || 'ingest-failed' }
    configSet('kb-doc:' + name, String(data.documentId))
    configSet('kb-hash:' + name, hash)
    kbEmit({ action: 'ingested', name, docId: data.documentId, chunks: data.chunksCreated })
    console.log(`[Personal KB] ingested "${name}" → ${data.documentId} (${data.chunksCreated} chunks)`)
    return { ok: true, docId: data.documentId }
  } catch (e: any) {
    console.warn(`[Personal KB] ingest failed for ${name}: ${e.message}`)
    return { ok: false, reason: e.message }
  }
}

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
  return localFiles
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
      const file = localFiles.find(f => f.name === fileName)
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


// Harness ReAct Loop simulation trigger
// 把近几轮对话渲染成 prompt 上文块（空则空串）。用于单会话多轮上下文：分身能理解指代、延续话题、
// 引用用户上文说过的信息（如上一轮"我的生日是…"）。截断每条，避免历史过长撑爆 token。
function buildHistoryBlock(history?: { role: 'user' | 'assistant'; content: string }[]): string {
  if (!history || !history.length) return ''
  const lines = history.slice(-8).map(h => `${h.role === 'user' ? '用户' : '分身'}：${(h.content || '').replace(/\s+/g, ' ').slice(0, 500)}`).join('\n')
  return `\n【对话上文（本次会话最近几轮，用于理解指代与延续话题；其中用户提供的信息可直接引用作答，勿复述整段）】\n${lines}\n`
}

// 「记住/记下 X」意图：把用户要记的信息提炼成简短事实，追加进个人长期记忆（本地 SQLite，按岗位隔离），
// 之后每次对话自动注入 System Prompt。命中即短路返回确认（不再走技能/联网）。模型异常则如实告知未记住。
const REMEMBER_INTENT = /(记住|记一下|记下|记录一下|帮我记|存一下|记到|备忘|以后记得|请记得)/
async function runMemoryWrite(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult | null> {
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
async function runScheduleCreate(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult | null> {
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
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('schedule:changed')   // 通知自动化页刷新

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

async function synthesizeSkillAnswer(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace, sk: { skillResult: string; skillPromptHint: string; skillFiles?: { name: string; sizeBytes: number }[] }): Promise<AgentResult> {
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

    sendLog('thinking', `正在查相关的公司制度…`)
    const corporateChunks = await queryCorporateKnowledge(data.content, expertId)
    if (corporateChunks.length) {
      sendLog('thinking', `查到 ${corporateChunks.length} 条相关制度，已经一起考虑进去了。`)
    } else {
      sendLog('thinking', `没查到相关制度，先用本地记忆来答。`)
    }
    const corporateRagBlock = buildCorporateRagBlock(corporateChunks)
    const enterpriseBlock = await getEnterpriseBlock()

    const promptWithContext = `[系统指令/System Prompt]
你是一个岗位专家智能体助手。
你的名字（岗位名称）是：${data.expertName}
你对用户的称呼是：${userNickname}
【当前日期时间】${new Date().toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}（系统实时，回答日期/时间相关问题一律以此为准，不要臆测）
${buildHistoryBlock(data.history)}
【岗位预置知识与SOP】
${agentSopList}

【用户个人信息与习惯】
- 岗位背景：${data.background}
- 用户称呼：${userNickname}
${personalMemoryList}

【企业知识与规则】（由管理端统一维护）
${enterpriseBlock}${kbScopeLine}${corporateRagBlock}

【本地真实技能执行数据】
${skillPromptHint}

[当前指令/User Instruction]
请严格、且仅依据上述【本地真实技能执行数据】作答：
- 若其中是真实抓取/执行结果，则以你自己完成了该技能的口吻如实汇报；
- 若其中说明"技能未执行 / 需登录 / 执行失败 / 目标系统不可用"，你必须如实转达该情况并给出下一步建议（例如先在弹出的系统窗口登录后重试），不得给出任何看似完成的结论；
- 严禁编造任何上述数据中不存在的待办、条目、发起人、数字或结果。
如果数据中含图片 Markdown 或表格，请完整保留并显示。
用户指令："${data.content}"`

    try {
      let content = await callLlm(promptWithContext, cfg)
      content = attachRagImages(content, corporateChunks)   // 【图N】占位 → 真实插图
      sendLog('completed', `[Completed] 问答与本地技能调用链完毕。`)
      const blocked = /未登录|需登录|未执行|未绑定/.test(skillResult)
      await trace.submit(content, blocked ? 'BLOCKED' : 'SUCCESS',
        `目标：完成用户任务。${trace.skill ? '匹配技能「' + trace.skill + '」并执行；' : ''}${trace.webSearch ? '判定需联网→检索→综合作答；' : ''}基于真实结果整理回答，未编造。`)
      return { content, success: true, traceId: trace.id, sources: buildKnowledgeSources(corporateChunks), files: sk.skillFiles }
    } catch (err: any) {
      sendLog('observing', `大模型连接润色失败: ${err.message}。自动回退为本地技能直达渲染。`)
      sendLog('completed', `[Completed] 技能运行完毕（回退直通）。`)
      return {
        content: `⚠️ **[大模型连接失败 - 自动切换本地直通输出]**\n\n大模型请求遇到问题 (\`${err.message}\`)，但本地技能已在 Electron 环境内执行成功。以下是物理执行结果：\n\n---\n\n${skillResult}`,
        success: true, traceId: trace.id, files: sk.skillFiles
      }
    }
}

// 自定义技能真实执行：解析绑定业务系统// 自定义技能真实执行：解析绑定业务系统 → 语义脚本(DSL)/录制回放/CRM拜访录入/读取抓取/联网检索/知识推理。
// 命中确定路径→AgentResult 早返回;否则把 skillResult/skillPromptHint 回填到 out、返回 null 交后续 LLM 整理。
// 从技能 SOP/代码里解析沙箱需装的纯 Python 包：识别 `packages:`/`pip:`/`# packages:` 行。
function extractSandboxPackages(text: string): string[] {
  const set = new Set<string>()
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^\s*(?:#|\/\/)?\s*(?:packages|pip|deps|requirements)\s*[:=]\s*(.+)$/i)
    if (m) for (const p of m[1].split(/[,\s]+/)) { const n = p.trim().replace(/^['"]|['"]$/g, ''); if (/^[A-Za-z0-9_.-]{2,40}$/.test(n)) set.add(n) }
  }
  return [...set].slice(0, 10)   // 上限防滥装
}

// 代码执行结果（后端 Docker 沙箱与本地 WASM 沙箱统一形状；engine 标明真实执行平面）。
interface CodeExecResult { ok: boolean; stdout: string; stderr: string; error?: string; files: { name: string; base64: string }[]; engine: string }

// 走后端 Docker 容器沙箱执行代码型技能：不可信代码在服务器/远程隔离容器里跑，永不落到员工机器，
// 也接触不到凭证/宿主文件。afetch 自动带登录 token。返回 null 表示后端沙箱不可达（无本地降级，如实报错）。
// files：可选，agentic 技能 bundle（相对路径 → base64），后端 tar 上传铺进容器 /work。
async function execViaBackendSandbox(code: string, packages: string[], files?: Record<string, string>): Promise<CodeExecResult | null> {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/sandbox/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, packages, ...(files && Object.keys(files).length ? { files } : {}) }),
      timeoutMs: 180000,   // 容器创建 + pip 安装 + 执行，放宽超时
    })
    if (!r.ok) { swallow(new Error(`sandbox exec HTTP ${r.status}`), 'sandbox-exec'); return null }
    const j: any = await r.json()
    return {
      ok: !!j.ok, stdout: String(j.stdout || ''), stderr: String(j.stderr || ''), error: j.error,
      files: Array.isArray(j.files) ? j.files : [], engine: 'Docker 容器',
    }
  } catch (e) { swallow(e, 'sandbox-exec'); return null }
}

// 代码执行型技能（type=python-sandbox）：只走公司级后端 Docker 容器沙箱（不可信代码永不在员工机器上跑）。
// 后端沙箱不可达时如实报错、绝不降级本地。产物 base64 落工作空间；结果回填 out 交 LLM 如实汇报。
// 把沙箱回传的 base64 产物落到工作空间，返回 {name,sizeBytes}[]（供文件卡展示 + 汇报文案）。
function saveSandboxFiles(files: { name: string; base64: string }[]): { name: string; sizeBytes: number }[] {
  const saved: { name: string; sizeBytes: number }[] = []
  for (const f of files) {
    try {
      const buf = Buffer.from(f.base64, 'base64')
      fs.writeFileSync(path.join(workspaceDir(), f.name), buf)
      saved.push({ name: f.name, sizeBytes: buf.length })
    } catch (e) { swallow(e) }
  }
  return saved
}

async function runCodeSkill(skillCode: string, skillSop: string, skl: string, sendLog: SendLog, out: { skillResult: string; skillPromptHint: string; skillFiles?: { name: string; sizeBytes: number }[] }): Promise<void> {
  const pkgs = extractSandboxPackages(skillSop + '\n' + skillCode)
  if (pkgs.length) sendLog('thinking', `准备依赖：${pkgs.join('、')}`)

  sendLog('acting', '在 Docker 容器沙箱中执行技能脚本…')
  const res = await execViaBackendSandbox(skillCode, pkgs)
  if (!res) {
    // 后端沙箱不可达 → 不降级，如实告知（沙箱是公司级集中资源，由管理员配置/运维）
    sendLog('observing', '后端 Docker 沙箱不可达，未执行。')
    out.skillResult = `⚠️ 代码执行沙箱当前不可用，技能「${skl}」未执行。请联系管理员检查沙箱（管理端「沙箱监控」）。`
    out.skillPromptHint = `【技能 "${skl}" 未执行】原因：公司级后端 Docker 沙箱不可达（网络或沙箱服务异常）。请如实告知用户沙箱暂不可用、本次未执行，并建议联系管理员，绝不编造执行结果或产出文件。`
    return
  }

  const savedFiles = saveSandboxFiles(res.files)
  const saved = savedFiles.map(f => f.name)
  out.skillFiles = savedFiles
  if (!res.ok) {
    sendLog('observing', `沙箱执行失败：${res.error}`)
    out.skillResult = `❌ 沙箱执行失败：${res.error}`
    out.skillPromptHint = `【技能 "${skl}" 沙箱执行失败】错误："${res.error}"。${res.stderr ? '\nstderr:\n' + res.stderr.slice(0, 800) : ''}\n请如实告知用户执行失败与原因，绝不编造结果。`
  } else {
    const fileLine = saved.length ? `已生成文件并保存到工作空间：${saved.join('、')}。` : '脚本执行成功，未产出文件。'
    sendLog('completed', `[Docker 沙箱] ${fileLine}`)
    out.skillResult = `🐍 已在 Docker 容器沙箱执行技能「${skl}」。${fileLine}`
    out.skillPromptHint = `【技能 "${skl}" Docker 沙箱真实执行结果】\n标准输出：\n"""\n${(res.stdout || '(无输出)').slice(0, 2000)}\n"""\n${fileLine}\n\n请用**一两句话简洁汇报**已生成了什么即可——文件卡会在下方自动展示文件名、大小与「查看/打开位置」入口，你**无需**罗列文件名、文件大小、保存路径、页数等细节，也不要用编号列表逐个交代。绝不编造未产出的内容。\n\n【SOP】\n${skillSop}`
  }
}

// ── 语义意图路由（分层路由的③模型意图层）：把技能目录交给模型，按语义选出【一个或多个】技能 ──
// 像主流智能体的工具选择：覆盖无触发词/口语化/复合请求（如"要 Word 报告 + PPT"→ 同时选两个）。
// 返回选中的 skillId 数组（可空）；模型异常静默返回 []（不阻塞主链路）。
async function routeSkillsByIntent(userText: string, skills: SkillDefinition[], llmConfig: LlmConfig): Promise<string[]> {
  if (!skills.length || !(userText || '').trim()) return []
  const catalog = skills.map(s =>
    `- id: ${s.id}\n  名称: ${skillDisplayName(s.id) || s.name}\n  描述: ${(s.description || s.sopContent || '').replace(/\s+/g, ' ').slice(0, 240)}`
  ).join('\n')
  const prompt = `你是企业工作分身的技能路由器。根据用户请求，从技能目录中选出完成该请求所需的【全部】技能（可以是 0 个、1 个或多个）。\n\n【技能目录】\n${catalog}\n\n【用户请求】\n${userText}\n\n判定规则：\n- 请求要产出/编辑/起草文档、报告、信函、文书、备忘录、表格、演示文稿等交付物 → 选对应的文档/生成类技能（哪怕没提"docx/word/ppt"字眼）。\n- 一句话要多种交付物（如"要 Word 报告和 PPT"）→ 同时选中对应的多个技能。\n- 请求是操作业务系统（审批、录入、查询）→ 选对应业务技能。\n- 闲聊、普通知识问答、与目录全部无关 → 返回空数组。\n- **宁缺勿滥**：目录里没有与请求的对象/系统真正对应的技能时，必须返回空数组——绝不要硬凑近似项（例如请求是"生产工单开工/排产/零件断供/采购收货"这类 ERM 操作，而目录只有"合同审批"，就返回空数组，不要选合同审批）。\n- skillId 必须逐字取自目录中的 id。\n【示例1】"帮我起草一份致歉文书"（目录有 docx）→ {"skillIds":["<docx技能id>"]}\n【示例2】"准备季度汇报，要 Word 报告和 PPT"（目录有 docx、pptx）→ {"skillIds":["<docx技能id>","<pptx技能id>"]}\n只输出严格 JSON（不要解释、不要代码块标记）：{"skillIds":["id1","id2"]} 或 {"skillIds":[]}`
  try {
    const outText = await callLlm(prompt, llmConfig, { temperature: 0 })
    const m = outText.match(/\{[\s\S]*?\}/)
    const arr = m ? JSON.parse(m[0])?.skillIds : null
    const picked = Array.isArray(arr) ? arr.filter((id: any) => typeof id === 'string' && skills.some(s => s.id === id)) : []
    console.log(`[skill-router] user="${userText.slice(0, 60)}" raw="${(outText || '').replace(/\s+/g, ' ').slice(0, 160)}" picked=${JSON.stringify(picked)}`)
    return picked
  } catch (e) { swallow(e, 'skill-router') }
  return []
}

// 拉取并缓存技能类型（分层路由④安全闸：判断是否生成类 python-sandbox，仅生成类才参与多技能批量）。
const skillTypeCache = new Map<string, string>()
async function getSkillType(id: string): Promise<string> {
  if (skillTypeCache.has(id)) return skillTypeCache.get(id)!
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${id}`)
    if (r.ok) { const f: any = await r.json(); const t = String(f.type || ''); skillTypeCache.set(id, t); return t }
  } catch (e) { swallow(e, 'skill-type') }
  return ''
}

// 判断技能是否为「写入/操作类」（用于编排前置权限闸的预判）：skillKind=write，或动作里含 fill/select，
// 或点击了「同意/提交/删除…」等写意图按钮。与 runCustomSkill 的运行时判定同源，避免只读下静默半执行。
const skillWriteCache = new Map<string, boolean>()
async function isWriteSkill(id: string): Promise<boolean> {
  if (skillWriteCache.has(id)) return skillWriteCache.get(id)!
  let isWrite = false
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${id}`)
    if (r.ok) {
      const f: any = await r.json()
      if (String(f.skillKind || '') === 'write') isWrite = true
      else if (String(f.skillKind || '') !== 'read') {
        // 无明确标注时按动作推断（与运行时一致）
        const code = String(f.code || '')
        if (/(^|\n)\s*(fill|select|searchSelect|dropdown)\b/i.test(code)) isWrite = true
        else try {
          const p = JSON.parse(String(f.actionScript || '{}'))
          const st: any[] = Array.isArray(p.steps) ? p.steps : (Array.isArray(p.rawSteps) ? p.rawSteps : [])
          isWrite = st.some((s: any) => {
            const a = s && (s.action || s.act)
            if (a === 'fill' || a === 'select' || a === 'search' || a === 'searchSelect' || a === 'pickOption' || (s && s.fieldName)) return true
            return (a === 'click' || a === 'tap' || a === 'button') && WRITE_INTENT_LABEL.test(String((s && (s.label || s.text)) || ''))
          }) || (Array.isArray(p.fields) && p.fields.length > 0)
        } catch (e) { swallow(e, 'iswrite-parse') }
      }
    }
  } catch (e) { swallow(e, 'iswrite') }
  skillWriteCache.set(id, isWrite)
  return isWrite
}

// ── agentic bundle 技能执行：LLM 读 SKILL.md 生成驱动脚本 → 沙箱执行 → 失败自修复一轮 ──
// 适配 Anthropic 风格技能包（SKILL.md 指导手册 + scripts/**）：没有直接可执行的 code，
// 由模型按手册+用户请求现场编写 Python 驱动脚本，与 bundle 一起送公司级 Docker 沙箱执行。
// 产物写 /out 回传落工作空间；首轮失败把 stderr 喂回模型修复重试一次（轻量 agentic loop）。
const AGENTIC_PRELOADED_PKGS = 'python-docx、openpyxl、pandas、pillow、python-pptx、PyPDF2、matplotlib'

function buildAgenticPrompt(skillMd: string, fileList: string[], userText: string, lastError?: string, focusHint?: string): string {
  const nowStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
  return `你是企业工作分身的技能执行引擎。请阅读技能手册与文件清单，为用户请求编写一段可在 Linux Python 3.12 容器内独立运行的 Python 驱动脚本。\n\n【当前日期】${nowStr}。凡涉及年份/季度/日期（如"季度汇报""本年度"）一律以此为准，不要臆测成往年。\n\n【运行环境】\n- 工作目录 /work，技能 bundle 文件已按清单铺好（如 /work/scripts/...）；如需 import 它们，先 sys.path.insert(0, "/work")。\n- 已预装：${AGENTIC_PRELOADED_PKGS}。默认无网络，不要联网、不要调用 pip/subprocess 装东西。\n- **中文字体已装**：用 pillow/matplotlib 渲染任何中文时，必须加载 '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'（pillow: ImageFont.truetype(该路径, 字号)；matplotlib: rcParams['font.sans-serif']=['WenQuanYi Micro Hei']），严禁用默认字体，否则中文会变方框(□)。\n- 手册中依赖 soffice/pandoc/node 的流程在本环境不可用——改用预装的纯 Python 库实现同等效果（如用 python-docx 直接生成/编辑 .docx，python-pptx 生成 .pptx，openpyxl 生成 .xlsx）。\n- **产物必须写入 /out/ 目录（唯一会回传给用户的位置）**：脚本开头 import os; os.makedirs('/out', exist_ok=True)；保存时用绝对路径（如 doc.save('/out/讯飞介绍.docx')）；**结尾必须 print('OUT_FILES:', os.listdir('/out'))** 自证已产出。文件名用有意义的中文名。\n\n【硬性要求】\n- 本技能是**生成交付物类**（文档/表格/演示/PDF/图/海报）——脚本**必须真的把文件写进 /out/**；只 print 内容而不落文件、或写到别的目录、或 /out/ 为空，都算失败。宁可报错也不要静默不产出。\n- **只产出属于本技能能力范围（见下方 SKILL.md）的交付物**；即便用户请求里还提到别的格式/其它交付物，也一律不要在本脚本中生成——那些由对应的其它技能负责。\n- 只完成用户请求本身；内容必须来自请求与手册，绝不编造业务数据。\n- 脚本自足、可直接运行；用 print 输出关键进度与结果摘要。\n${focusHint ? `\n【本次协作分工（务必遵守）】\n${focusHint}\n` : ''}${lastError ? `\n【上一轮执行失败，stderr 如下，请修复后重写完整脚本】\n${lastError.slice(0, 1200)}\n` : ''}\n【技能手册 SKILL.md（节选）】\n${skillMd.slice(0, 12000)}\n\n【bundle 文件清单】\n${fileList.join('\n')}\n\n【用户请求】\n${userText}\n\n只输出一个 Python 代码块（\`\`\`python ... \`\`\`），不要任何解释。`
}

function extractPyBlock(text: string): string {
  const m = text.match(/```(?:python|py)?\s*\n([\s\S]*?)```/)
  return (m ? m[1] : text).trim()
}

async function runAgenticSkill(bundleRaw: string, skillSop: string, data: AgentTaskData, skl: string, sendLog: SendLog, out: { skillResult: string; skillPromptHint: string; skillFiles?: { name: string; sizeBytes: number }[] }, focusHint?: string): Promise<void> {
  // bundle: {相对路径: 文本内容}（管理端整目录导入落库格式）
  let bundle: Record<string, string> = {}
  try { bundle = JSON.parse(bundleRaw || '{}') } catch (e) { swallow(e, 'agentic-bundle') }
  const skillMd = bundle['SKILL.md'] || skillSop || ''
  const fileList = Object.keys(bundle).sort()
  const filesB64: Record<string, string> = {}
  for (const [p, content] of Object.entries(bundle)) filesB64[p] = Buffer.from(String(content), 'utf8').toString('base64')

  sendLog('thinking', `已加载技能手册与 ${fileList.length} 个 bundle 文件，正在按手册为本次请求编写执行脚本…`)
  const MAX_ATTEMPTS = 3
  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let driver = ''
    try { driver = extractPyBlock(await callLlm(buildAgenticPrompt(skillMd, fileList, data.content, lastError || undefined, focusHint), data.llmConfig, { temperature: 0 })) }
    catch (e) { swallow(e, 'agentic-gen') }
    if (!driver) {
      out.skillResult = `❌ 技能「${skl}」执行失败：模型未能生成有效的执行脚本。`
      out.skillPromptHint = `【技能 "${skl}" 未执行】原因：模型生成驱动脚本失败。请如实告知用户，绝不编造结果。`
      return
    }
    sendLog('acting', attempt === 1 ? '在 Docker 容器沙箱中执行技能脚本…' : '按上一轮问题修复脚本后重试执行…')
    const res = await execViaBackendSandbox(driver, [], filesB64)
    if (!res) {
      out.skillResult = `⚠️ 代码执行沙箱当前不可用，技能「${skl}」未执行。请联系管理员检查沙箱（管理端「沙箱监控」）。`
      out.skillPromptHint = `【技能 "${skl}" 未执行】原因：公司级后端 Docker 沙箱不可达。请如实告知用户，绝不编造执行结果。`
      return
    }
    const savedFiles = saveSandboxFiles(res.files)
    const saved = savedFiles.map(f => f.name)
    // 成功且产出文件 → 收工
    if (res.ok && saved.length > 0) {
      out.skillFiles = savedFiles
      const fileLine = `已生成文件并保存到工作空间：${saved.join('、')}。`
      sendLog('completed', `[Docker 沙箱·agentic] ${fileLine}`)
      out.skillResult = `🤖 已按技能手册「${skl}」现场编写并执行脚本。${fileLine}`
      out.skillPromptHint = `【技能 "${skl}" agentic 真实执行结果】\n标准输出：\n"""\n${(res.stdout || '(无输出)').slice(0, 2000)}\n"""\n${fileLine}\n\n请用**一两句话简洁汇报**已生成了什么即可——文件卡会在下方自动展示文件名、大小与「查看/打开位置」入口，你**无需**罗列文件名、文件大小、保存路径、页数等细节，也不要用编号列表逐个交代。绝不编造未产出的内容。`
      return
    }
    // 成功但 /out/ 为空 → 大概率没把产物写到 /out/：当软失败，带纠正提示重试；最后一轮仍空才如实报“未产出”
    if (res.ok && saved.length === 0) {
      if (attempt < MAX_ATTEMPTS) {
        lastError = `【上一轮脚本执行成功(exit 0) 但 /out/ 目录为空——你没有把产物文件真正保存到 /out/】。本技能必须产出文件。请修正：① import os; os.makedirs('/out', exist_ok=True)；② 用绝对路径保存（如 doc.save('/out/xxx.docx') / wb.save('/out/xxx.xlsx') / prs.save('/out/xxx.pptx')），不要保存到 /work 或当前目录；③ 结尾 print('OUT_FILES:', os.listdir('/out')) 自证。上一轮 stdout：\n${(res.stdout || '(无输出)').slice(0, 800)}`
        sendLog('observing', `第 ${attempt} 轮执行成功但未产出文件，补充"必须写入 /out/"后重试…`)
        continue
      }
      sendLog('completed', `[Docker 沙箱·agentic] 多轮执行后仍未产出文件。`)
      out.skillResult = `⚠️ 技能「${skl}」脚本多轮执行成功但始终未产出文件。`
      out.skillPromptHint = `【技能 "${skl}" 未产出文件】脚本执行成功但 /out/ 始终为空（模型未把产物写入 /out/）。请如实告知用户"本次未能生成文件、建议重试或换个说法"，绝不编造已生成的文件。stdout：\n"""\n${(res.stdout || '(无输出)').slice(0, 800)}\n"""`
      return
    }
    // 执行报错 → 带 stderr 重试
    lastError = res.stderr || res.error || '未知错误'
    sendLog('observing', `第 ${attempt} 轮执行失败：${lastError.slice(0, 200)}`)
  }
  out.skillResult = `❌ 技能「${skl}」执行失败（已自动修复重试 ${MAX_ATTEMPTS - 1} 次仍未成功）。`
  out.skillPromptHint = `【技能 "${skl}" 执行失败】${MAX_ATTEMPTS} 轮均失败，最后错误：\n${lastError.slice(0, 800)}\n请如实告知用户失败与原因，绝不编造结果。`
}

async function runCustomSkill(matchedSkill: SkillDefinition, skl: string, data: AgentTaskData, sendLog: SendLog, trace: AgentTrace, out: { skillResult: string; skillPromptHint: string; skillFiles?: { name: string; sizeBytes: number }[] }, focusHint?: string): Promise<AgentResult | null> {
  let skillHandled = false
      sendLog('thinking', `[技能执行] 识别到自定义技能 "${skl}"，正在解析其绑定的目标业务系统...`)

      // 本地 SKILL.md 不含目标系统，需向管理端拉取完整技能定义。
      let targetSystemId = ''
      let actionScriptRaw = ''
      let skillCode = ''
      let skillType = ''
      let skillSop = ''
      let skillKind = ''        // read=读取/查看类，write=写入/操作类（FDE 录制时判定）
      let skillNavHash = ''     // 录制到的导航目标路由，读取类据此直达子页
      let skillBundle = ''      // agentic 技能包（SKILL.md+scripts 整目录 JSON），无直接 code 时按手册现场生成脚本
      try {
        const sr = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${matchedSkill.id}`)
        if (sr.ok) { const full: any = await sr.json(); targetSystemId = full.targetSystemId || ''; actionScriptRaw = full.actionScript || ''; skillCode = full.code || ''; skillType = full.type || ''; skillSop = full.sopContent || ''; skillKind = full.skillKind || ''; skillNavHash = full.navHash || ''; skillBundle = full.bundle || ''; if (full.name) setSkillDisplayName(matchedSkill.id, String(full.name)) }
      } catch (e) { swallow(e) }

      // 解析绑定系统地址的小工具
      const resolveSystem = async (): Promise<{ sysName: string; baseUrl: string }> => {
        let sysName = '业务系统', baseUrl = ''
        if (targetSystemId) {
          try {
            const ir = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
            if (ir.ok) { const list: any = await ir.json(); const sys = Array.isArray(list) ? list.find((x: any) => x.id === targetSystemId) : null; if (sys) { sysName = sys.name; baseUrl = sys.baseUrl } }
          } catch (e) { swallow(e) }
        }
        return { sysName, baseUrl }
      }

      // 代码型技能：type=python-sandbox 且带可执行代码 → 公司级后端 Docker 容器沙箱。
      // 沙箱只跑不可信代码、不触碰任何业务系统，故不受「只读模式」约束(只读保护的是业务系统写入)。
      if (skillType === 'python-sandbox' && skillCode.trim()) {
        await runCodeSkill(skillCode, skillSop, skl, sendLog, out)
        // 审计标记：本次经公司级 Docker 沙箱执行（成功与否都记，时间线体现结果）
        trace.sandboxUsed = true
        trace.spans.push({ type: 'sandbox', name: 'Docker 沙箱执行·代码技能', status: out.skillResult.startsWith('🐍') ? 'ok' : 'warn' })
        return null
      }

      // agentic bundle 技能：无直接可执行 code 但带整目录 bundle（SKILL.md+scripts，如 Anthropic 技能包）
      // → 模型读手册现场编写驱动脚本，与 bundle 一起送沙箱执行；失败自修复重试一轮。
      if (skillType === 'python-sandbox' && !skillCode.trim() && skillBundle.trim()) {
        await runAgenticSkill(skillBundle, skillSop, data, skl, sendLog, out, focusHint)
        trace.sandboxUsed = true
        trace.spans.push({ type: 'sandbox', name: 'Docker 沙箱执行·agentic 技能', status: out.skillResult.startsWith('🤖') ? 'ok' : 'warn' })
        return null
      }

      // 知识/指南型技能：无厂商预置脚本，但常常是「为产出交付物服务」的规范/指南（如 brand-guidelines / frontend-design / canvas-design）。
      if (skillType === 'knowledge') {
        if (skillBundle.trim()) {
          // 带素材包 → 本就用于按规范产出交付物（海报/页面/设计稿/图表）。
          // 仍走公司级沙箱：模型读 SKILL.md 规范，现场编写生成脚本、产出文件（只是没有厂商脚本而已）。
          sendLog('acting', `技能「${skl}」为知识/指南型，将按其规范现场生成交付物…`)
          const isPoster = /海报|poster|展板|大图|宣传图|banner|封面|kv|主视觉/i.test(data.content)
          const CJK_FONT = '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'   // 沙箱已装中文字体，pillow/matplotlib 画中文须加载它
          const posterRule = isPoster
            ? `\n【海报/视觉类硬性要求（务必满足）】\n- **大画布、铺满、字要大**：大幅面单张海报（竖版 1080×1920 或横版 1920×1080），固定画布、不要窄栏或大片空白；主标题 ≥ 90px、副标题 ≥ 44px、正文 ≥ 28px，粗体高对比；层次为 主标题→核心卖点→要点列表→落款日期；每个板块都要填入**来自请求的真实文字**，不要占位小字。\n- **中文必须正常显示（不能是方框）**：① 首选自包含 .html（内联 CSS，浏览器中文字体最全最稳）；② 若用 pillow/PIL 输出 .png，**必须**用中文字体 ImageFont.truetype('${CJK_FONT}', 字号)，**严禁** ImageFont.load_default()（中文会变方框）。配图用 CSS/形状/emoji，不外链字体或图片。`
            : `设计/前端/页面类优先自包含 .html（内联 CSS，正文 ≥ 16px）；若用 pillow/matplotlib 渲染含中文的图片，**必须**加载中文字体 '${CJK_FONT}'（pillow 用 ImageFont.truetype；matplotlib 设 font.sans-serif 为 'WenQuanYi Micro Hei'），不要用默认字体（中文会变方框）；报告/文档类输出 .docx/.pdf。`
          const guideHint = focusHint || `本技能是「知识/指南型」，没有预置脚本；请严格按下方 SKILL.md 的规范，为用户请求**生成对应的交付物文件并写入 /out/**：${posterRule}\n不要只在 stdout 打印内容而不产文件。`
          await runAgenticSkill(skillBundle, skillSop, data, skl, sendLog, out, guideHint)
          trace.sandboxUsed = true
          trace.spans.push({ type: 'sandbox', name: 'Docker 沙箱执行·指南型生成', status: out.skillResult.startsWith('🤖') ? 'ok' : 'warn' })
          return null
        }
        // 纯 SOP（无素材包）→ 不进沙箱，由模型作为岗位专家把规范应用到答复中，不生成文件。
        sendLog('acting', `技能「${skl}」为知识/指南型，按其规范应用到本次产出…`)
        const sop = (skillSop || matchedSkill.sopContent || '').trim()
        out.skillResult = `已参照技能「${skl}」的规范/指南完成。`
        out.skillPromptHint = `【技能 "${skl}" · 知识/指南型】\n该技能是一份规范/指南（无可执行代码、不访问任何系统）。请你作为该岗位专家，严格依据下面的指南完成用户任务：把其中的规范、风格、约束、清单落实到你的产出与建议中。\n- 不要声称运行了任何脚本或访问了任何系统；\n- 若指南要求的某些素材（字体/图片/数据）本地不具备，就说明并给出可行替代；\n- 绝不编造不存在的业务数据（人名/单号/金额/日期）。\n\n【指南内容（SKILL.md）】\n${sop || '（该技能未提供指南正文）'}`
        trace.spans.push({ type: 'skill', name: `知识/指南型·${skl}`, status: 'ok' })
        return null
      }

      // 读取类判定（优先 FDE 标注的 skillKind；无标注则按脚本/步骤里有无写入动作推断）。
      // 读取类绝不走「只导航不取数」的 DSL/回放分支——否则只会回“请核对结果”而没有真实数据；
      // 应落到下方「打开目标页 + 抓取真实内容 + 按 SOP 整理」分支，由分身给出真正的待办/查询结果。
      // 写意图点击：点击「同意/提交/批准/删除/确认…」等改变业务状态的按钮 = 写操作。
      // 即便 FDE 录制把它误标为 read（纯"点同意"审批无填表字段就会这样），也一律按写处理——
      // 安全红线：写操作绝不静默执行，必须走「只读拦截」或「人工确认」。
      const writeIntentClick = (() => {
        try {
          const p = JSON.parse(actionScriptRaw || '{}')
          const st: any[] = Array.isArray(p.steps) ? p.steps : (Array.isArray(p.rawSteps) ? p.rawSteps : [])
          return st.some((s: any) => { const a = s && (s.action || s.act); return (a === 'click' || a === 'tap' || a === 'button') && WRITE_INTENT_LABEL.test(String((s && (s.label || s.text || s.value)) || '')) })
        } catch (e) { swallow(e); return false }
      })()
      let isReadSkill = skillKind === 'read'
      if (writeIntentClick) {
        isReadSkill = false   // 覆盖误标：点了写按钮就是写
      } else if (!skillKind) {
        let hasWrite = /(^|\n)\s*(fill|select|searchSelect|dropdown)\b/i.test(skillCode || '')
        if (!hasWrite) {
          try {
            const p = JSON.parse(actionScriptRaw || '{}')
            const st: any[] = Array.isArray(p.steps) ? p.steps : (Array.isArray(p.rawSteps) ? p.rawSteps : [])
            hasWrite = st.some((s: any) => { const a = s && (s.action || s.act); return a === 'fill' || a === 'select' || a === 'search' || a === 'searchSelect' || a === 'pickOption' || !!(s && s.fieldName) })
              || (Array.isArray(p.fields) && p.fields.length > 0)
          } catch (e) { swallow(e) }
        }
        isReadSkill = !hasWrite
      }

      // 只读模式（权限范围=只读）：拦截一切写入/操作类技能，绝不对业务系统做改动
      if (data.permMode === 'readonly' && !isReadSkill) {
        await trace.submit(data.content, 'BLOCKED', `只读模式拦截写入类技能 "${skl}"。`)
        return { content: `🔒 本次为**只读模式**，已拦截写入/操作类技能「${skl}」，未对业务系统做任何改动。\n\n如需执行该操作，请把输入框上方的「权限范围」切到 **允许操作** 后重试（写操作仍会请你人工确认）。`, success: true, traceId: trace.id }
      }

      // —— 语义脚本技能（DSL）：解释执行（灵活、可读可改），优先于原始录制回放 —— 仅写入/操作类走此分支 ——
      const dsl = parseDsl(skillCode)
      if (dsl.length && !isReadSkill) {
        // 脚本里用到的参数 {{name}}
        const usedParams = new Set<string>()
        dsl.forEach(s => { const m = s.valueExpr.match(/^\{\{\s*([\w.]+)\s*\}\}$/); if (m) usedParams.add(m[1]) })
        // 字段定义（含选项）来自 actionScript.fields，仅保留脚本实际用到的
        let scriptFields: VisitField[] = []
        try { const parsed = JSON.parse(actionScriptRaw || '{}'); if (Array.isArray(parsed.fields)) scriptFields = parsed.fields.map((f: any) => ({ name: f.name, label: f.label, type: f.type || 'text', value: '', options: Array.isArray(f.options) ? f.options : undefined })) } catch (e) { swallow(e) }
        scriptFields = scriptFields.filter(f => usedParams.has(f.name))
        usedParams.forEach(pn => { if (!scriptFields.find(f => f.name === pn)) scriptFields.push({ name: pn, label: pn, type: 'text', value: '' }) })

        const filledFields = scriptFields.length ? await extractFieldsByLabels(data.content, scriptFields, data.llmConfig, sendLog) : []
        // 写操作一律须人工确认：无 {{参数}} 的纯操作型脚本也要弹"操作确认"卡（列出关键动作）
        const clickSummary = dsl.filter(s => s.op === 'click' || s.op === 'tap').map(s => String((s as any).label || s.arg || '').trim()).filter(Boolean).join(' → ')
        const confirmFields: VisitField[] = filledFields.length
          ? filledFields
          : [{ name: '_confirm', label: '将执行的写操作（核对后确认，取消则不执行）', type: 'text', value: clickSummary || '执行该技能脚本的操作步骤' }]
        sendLog('acting', filledFields.length ? '已整理出待填写字段，请在下方表单卡片中核对并确认...' : '这是写操作，请在下方卡片中核对确认后执行…')
        const confirmed: Record<string, string> = await requestFormConfirmation(confirmFields)
        if (!confirmed || Object.keys(confirmed).length === 0) { const content = `🚫 已取消该技能执行，未写入任何数据。`; await trace.submit(data.content, 'BLOCKED', `语义脚本技能 "${skl}"：用户取消确认。`); return { content, success: true, traceId: trace.id } }
        const { sysName, baseUrl: sysUrl } = await resolveSystem()
        const baseUrl = sysUrl || (dsl.find(s => s.op === 'open')?.arg || '')
        const fieldTable = filledFields.length
          ? `\n\n**确认的字段：**\n\n| 字段 | 值 |\n| --- | --- |\n${filledFields.map(f => `| ${f.label} | ${confirmed[f.name] || '（空）'} |`).join('\n')}`
          : ''
        if (!baseUrl) {
          await trace.submit(data.content, 'PARTIAL', `语义脚本技能 "${skl}"：已确认字段，但缺少可执行的目标系统地址。`)
          return { content: `✅ 已确认字段，但该技能未绑定可访问的业务系统地址，无法执行。请到管理端为该技能绑定目标系统。${fieldTable}`, success: true, traceId: trace.id }
        }
        const rep = await interpretSkillScript(targetSystemId || 'rec', baseUrl, sysName, dsl, confirmed, sendLog, { llmConfig: data.llmConfig, sop: skillSop, script: skillCode })
        let outcome = ''
        if (!rep.ok) outcome = `❌ 后台访问【${sysName}】失败：${rep.error || '未知错误'}。`
        else if (!rep.loggedIn) outcome = `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后再次发起。`
        else if (rep.failedAt >= 0) outcome = `已成功执行前 ${rep.done}/${rep.total} 步，在第 ${rep.failedAt + 1} 步「${rep.failLabel}」处中断（${rep.error || '未找到目标'}）。可在管理端调整该技能脚本（如改定位/加等待）后重试。`
        else outcome = `🤖 已完整执行 ${rep.done}/${rep.total} 步语义脚本。请在【${sysName}】中核对结果。`
        await trace.submit(data.content, rep.ok && rep.loggedIn && rep.failedAt < 0 ? 'SUCCESS' : 'PARTIAL', `语义脚本技能 "${skl}" 执行：${rep.done}/${rep.total} 步。`)
        return { content: `✅ 已执行语义脚本技能「${skl}」。\n\n**执行结果：**\n\n${outcome}${fieldTable}`, success: true, traceId: trace.id }
      }

      // —— 录制回放型技能：有可回放的录制步骤时，按字段确认 → 确定性回放（兼容旧录制） ——
      // 兼容两种存法：parsed.steps（旧）与 parsed.rawSteps（from-recording 入库字段）。
      let recParsed: any = null
      try { recParsed = actionScriptRaw ? JSON.parse(actionScriptRaw) : null } catch (e) { swallow(e) }
      const recSteps: RecStep[] = recParsed && Array.isArray(recParsed.steps) ? recParsed.steps
        : (recParsed && Array.isArray(recParsed.rawSteps) ? recParsed.rawSteps : [])
      // 是否为写入/表单类技能：有填写/选择动作、或标注了字段、或声明了表单字段。
      // 读取类技能（纯导航/点击）不走脆弱的确定性回放——录制步骤格式（act/nav/fp）与旧回放引擎
      // 期望的 selector 也对不上，且对折叠菜单/hash 路由极易失败——改走更稳的「SOP 打开页面+抓取」。
      const isWriteStep = (s: any) => { const a = s && (s.action || s.act); return a === 'fill' || a === 'select' || a === 'search' || a === 'searchSelect' || a === 'pickOption' || !!(s && s.fieldName) }
      // 优先用 FDE 录制时判定的 skillKind；缺失才按步骤兜底推断。
      const hasWriteOps = writeIntentClick ? true          // 写意图点击优先（覆盖误标的 read）
        : skillKind === 'write' ? true
        : skillKind === 'read' ? false
        : (recSteps.some(isWriteStep) || (recParsed && Array.isArray(recParsed.fields) && recParsed.fields.length > 0))
      // 导航 hash（折叠侧边栏/SPA 路由场景）：优先用 FDE 录制到的 navHash，缺失才从步骤里找。
      const recNavHash: string = skillNavHash || (recSteps.find((s: any) => s && s.nav) as any)?.nav || ''

      // 该技能未绑定业务系统时，是否应走「公网检索」。
      // 仅限「公开信息类」技能（标讯/招标/行业调研/新闻/行情/政策/官网等）——这些公网真能查到；
      // 「需登录平台的数据类」技能（简历/候选人/CRM/OA/待办/审批/内部系统）绝不退化为公网检索充数，
      // 因为真实个人/业务数据在登录墙后，公网只会搜到无关资讯。这类未连接时走「澄清画像+提示连接平台」。
      const skillText2 = (matchedSkill.name || '') + '\n' + (matchedSkill.sopContent || '')
      const platformGated = /(简历|候选人|人才库|人才搜索|招聘平台|ats|猎聘|boss|前程无忧|智联|crm|oa|待办|审批|内部系统|工单|登录态|账号密码)/i.test(skillText2)
      const publicWebIntent = /(标讯|招标|中标|投标|政府采购|项目线索|行业(调研|动态|资讯|分析)|市场调研|新闻|资讯|最新(消息|动态|政策|情况|进展)|行情|股价|汇率|百度|谷歌|google|bing|官网|公开(信息|资料|数据)|联网(查|搜|检索)|网上(查|搜))/i.test(skillText2)
      const webSearchIntent = publicWebIntent && !platformGated
      let deferToWebSearch = false

      // —— 读取/查询类技能：脚本/直达路由导航到目标子页 → 抓取真实页面内容 → 交分身按 SOP 整理 ——
      // （读取类不取数只导航没有意义，必须把真实内容抓回来由分身整理，绝不回“请自行核对”。）
      if (isReadSkill && !skillHandled) {
        const { sysName, baseUrl: sysUrl } = await resolveSystem()
        const baseUrl = sysUrl || (dsl.find(s => s.op === 'open')?.arg || '') || (recSteps[0] as any)?.url || ''
        if (!baseUrl && webSearchIntent) {
          // 未绑定业务系统、但本质是联网检索型技能 → 交由下方「联网检索」分支执行真实检索
          deferToWebSearch = true
        } else if (!baseUrl) {
          // 未绑定业务系统、且非检索型 → 作为「知识/推理型技能」由大模型按 SOP 执行（不一律判“未执行”）
          out.skillResult = `已按技能「${skl}」的标准作业流程执行（该技能未连接业务系统，基于大模型推理与当前上下文完成）。`
          out.skillPromptHint = `【技能 "${skl}" 执行 · 知识/推理型】\n该技能未连接可访问的业务系统，请你作为该岗位专家，严格按下面的 SOP，基于用户输入、已上传附件与工作空间内容进行推理、整理与产出，完成你能完成的部分。\n- 若 SOP 中某一步骤确实需要某个尚未连接系统的实时数据（如需登录某平台抓取真实记录/列表），请明确指出该步骤需先到「设置 → 企业系统连接」连接对应系统；\n- 绝对不要编造任何不存在的真实业务数据（具体人名、单号、简历、待办条目、金额、日期）。\n\n【SOP】\n${matchedSkill.sopContent}`
        } else {
          let okR = false, loggedIn = false, pageText = '', pageTitle = ''
          if (recNavHash) {
            // 优先「直达路由」：整页加载到 #route 抓取（与 FDE 测试一致，最稳——避开折叠菜单/纯 JS 点击）
            const ext = await openSystemAndExtract(targetSystemId || 'rec', baseUrl, sysName, sendLog, recNavHash)
            okR = ext.ok; loggedIn = ext.loggedIn; pageText = ext.text || ''; pageTitle = ext.title || ''
          } else if (dsl.length) {
            // 无直达路由：复用登录态后台按语义脚本导航（读取类无需填表单），完成后抓取最终页面
            const rep = await interpretSkillScript(targetSystemId || 'rec', baseUrl, sysName, dsl, {}, sendLog, { llmConfig: data.llmConfig, sop: skillSop, script: skillCode })
            okR = rep.ok; loggedIn = rep.loggedIn; pageText = rep.text || ''; pageTitle = rep.title || ''
          } else {
            const ext = await openSystemAndExtract(targetSystemId || 'rec', baseUrl, sysName, sendLog, '')
            okR = ext.ok; loggedIn = ext.loggedIn; pageText = ext.text || ''; pageTitle = ext.title || ''
          }
          if (!okR) {
            out.skillResult = `❌ 后台访问【${sysName}】失败。`
            out.skillPromptHint = `【技能执行失败】访问【${sysName}】失败。请如实告知用户失败、建议检查系统地址/网络，勿编造数据。`
          } else if (!loggedIn) {
            out.skillResult = `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录该系统（登录态本地保存），随后再次发起。`
            out.skillPromptHint = `【技能未完成 · 需登录】后台访问【${sysName}】时未登录，未获取到任何真实数据。请：1) 告知用户先到「设置 → 企业系统连接」完成【${sysName}】本地登录后重试；2) 依据下面 SOP 给出手动操作指引。这不是真实数据，勿编造待办/条目/数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          } else if ((pageText || '').length > 40) {
            out.skillResult = `已在【${sysName}】中实际打开目标页面并抓取到真实内容，正在按标准流程整理。`
            out.skillPromptHint = `【技能 "${skl}" 真实执行结果】\n以下是刚刚从【${sysName}】真实页面抓取到的内容（页面标题：${pageTitle}）：\n"""\n${pageText}\n"""\n\n请严格、且仅依据上述真实页面内容，按下面的 SOP 整理后回答用户（如为待办/列表，请逐条列出标题、发起人、时间等页面可见字段）。若内容与任务无关、为空、或仍是登录/首页，请如实说明并提示用户操作，绝对禁止编造任何待办、条目、发起人或数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          } else {
            out.skillResult = `⚠️ 已打开【${sysName}】但未抓取到有效内容（可能仍停留在首页或目标列表为空）。`
            out.skillPromptHint = `【技能执行 · 内容不足】已在【${sysName}】打开页面但未取到有效正文（可能未导航到目标子页或列表为空）。请如实告知用户，并依据下面 SOP 给出手动操作指引，勿编造数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          }
        }
        // 联网检索型技能延后到下方检索分支处理；其余读取类已在此抓取并整理。
        skillHandled = !deferToWebSearch
      }

      if (recSteps.length > 0 && hasWriteOps && !skillHandled) {
        const steps = recSteps
        const scriptFields: VisitField[] = recParsed && Array.isArray(recParsed.fields)
          ? recParsed.fields.map((f: any) => ({ name: f.name, label: f.label, type: f.type || 'text', value: '', options: Array.isArray(f.options) ? f.options : undefined }))
          : []
        // 步骤序号 → 绑定的字段名（录制时标注）
        const fieldByStep: Record<number, string> = {}
        steps.forEach((s: any, i: number) => { const fn = s.param || s.fieldName; if (fn) fieldByStep[i] = fn })
        {
          // ① 抽取字段值
          const filledFields = scriptFields.length ? await extractFieldsByLabels(data.content, scriptFields, data.llmConfig, sendLog) : []
          // ② 写操作一律须人工确认（安全红线）：有可填字段→核对字段值；无字段（纯"点同意/提交/删除"操作）→合成"操作确认"卡后放行。
          const clickSummary = steps.filter((s: any) => { const a = s && (s.action || s.act); return a === 'click' || a === 'tap' || a === 'button' })
            .map((s: any) => String((s && (s.label || s.text)) || '').trim()).filter(Boolean).join(' → ')
          const confirmFields: VisitField[] = filledFields.length
            ? filledFields
            : [{ name: '_confirm', label: '将执行的写操作（核对后确认，取消则不执行）', type: 'text', value: clickSummary || '执行录制的操作步骤' }]
          sendLog('acting', filledFields.length ? '已整理出待填写字段，请在下方表单卡片中核对并确认...' : '这是写操作，请在下方卡片中核对确认后执行…')
          const confirmed: Record<string, string> = await requestFormConfirmation(confirmFields)
          if (!confirmed || Object.keys(confirmed).length === 0) { const content = `🚫 已取消该技能执行，未写入任何数据。`; await trace.submit(data.content, 'BLOCKED', `录制技能 "${skl}"：用户取消确认。`); return { content, success: true, traceId: trace.id } }
          // 解析绑定系统地址
          let sysName = '业务系统'; let baseUrl = ''
          if (targetSystemId) {
            try {
              const ir = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
              if (ir.ok) { const list: any = await ir.json(); const sys = Array.isArray(list) ? list.find((x: any) => x.id === targetSystemId) : null; if (sys) { sysName = sys.name; baseUrl = sys.baseUrl } }
            } catch (e) { swallow(e) }
          }
          if (!baseUrl) { baseUrl = steps[0]?.url || '' }

          const fieldTable = filledFields.length
            ? `\n\n**确认的字段：**\n\n| 字段 | 值 |\n| --- | --- |\n${filledFields.map(f => `| ${f.label} | ${confirmed[f.name] || '（空）'} |`).join('\n')}`
            : ''

          if (!baseUrl) {
            await trace.submit(data.content, 'PARTIAL', `录制技能 "${skl}"：已确认字段，但缺少可回放的目标系统地址。`)
            return { content: `✅ 已确认字段，但该技能未绑定可访问的业务系统地址，无法回放。请到管理端为该技能绑定目标系统。${fieldTable}`, success: true, traceId: trace.id }
          }

          // ③ 确定性回放
          const rep = await replayActionScript(targetSystemId || 'rec', baseUrl, sysName, steps, confirmed, fieldByStep, sendLog)
          let outcome = ''
          if (!rep.ok) outcome = `❌ 后台访问【${sysName}】失败：${rep.error || '未知错误'}。`
          else if (!rep.loggedIn) outcome = `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后再次发起。`
          else if (rep.failedAt >= 0) outcome = `已成功回放前 ${rep.done}/${rep.total} 步，在第 ${rep.failedAt + 1} 步「${rep.failLabel}」处中断（${rep.error || '元素未找到'}）。可能是页面结构有变化，建议重新录制该技能。`
          else outcome = `🤖 已完整回放 ${rep.done}/${rep.total} 步操作。请在【${sysName}】中核对结果。`
          await trace.submit(data.content, rep.ok && rep.loggedIn && rep.failedAt < 0 ? 'SUCCESS' : 'PARTIAL', `录制技能 "${skl}" 回放：${rep.done}/${rep.total} 步。`)
          return { content: `✅ 已执行录制技能「${skl}」。\n\n**执行结果：**\n\n${outcome}${fieldTable}`, success: true, traceId: trace.id }
        }
      }

      // —— 客户拜访记录录入 CRM 的结构化流程：抽取参数 → 表单确认 → 无头浏览器录入 ——
      const skillText = `${matchedSkill.name || ''}\n${matchedSkill.sopContent || ''}`
      const isVisitRecord = /拜访/.test(skillText) && /(crm|拜访反馈|拜访记录|客户管理|拜访过程反馈)/i.test(skillText)
      if (isVisitRecord && !skillHandled) {
        // ① 抽取
        const fields = await extractVisitFields(data.content, data.llmConfig, sendLog)
        // ② 对话框表单确认（阻塞等待用户在卡片中确认）
        sendLog('acting', '已整理出待录入 CRM 的字段，请在下方表单卡片中核对并确认...')
        const confirmed = await requestFormConfirmation(fields)
        if (fields.length && (!confirmed || Object.keys(confirmed).length === 0)) { const content = `🚫 已取消客户拜访记录录入，未写入任何数据。`; await trace.submit(data.content, 'BLOCKED', '拜访记录录入：用户取消确认。'); return { content, success: true, traceId: trace.id } }

        // 解析绑定的目标 CRM 系统地址
        let sysName = 'CRM'
        let baseUrl = ''
        if (targetSystemId) {
          try {
            const ir = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
            if (ir.ok) {
              const list: any = await ir.json()
              const sys = Array.isArray(list) ? list.find((x: any) => x.id === targetSystemId) : null
              if (sys) { sysName = sys.name; baseUrl = sys.baseUrl }
            }
          } catch (e) { swallow(e) }
        }

        const tbl = fields.map(f => `| ${f.label} | ${confirmed[f.name] || '（空）'} |`).join('\n')
        const confirmedTable = `| 字段 | 值 |\n| --- | --- |\n${tbl}`

        if (!baseUrl) {
          await trace.submit(data.content, 'PARTIAL', '拜访记录：已抽取并确认字段，但该技能未绑定可自动录入的 CRM 系统。')
          return {
            content: `✅ 已根据您的拜访记录整理并确认以下字段：\n\n${confirmedTable}\n\n⚠️ 但该技能尚未在管理端「业务系统连接」中绑定可自动录入的 CRM，因此暂未执行无头浏览器录入。请到管理端为该技能绑定目标 CRM 后重试。`,
            success: true, traceId: trace.id
          }
        }

        // ③ 无头浏览器录入
        const entry = await fillCrmVisitForm(targetSystemId, baseUrl, sysName, confirmed, fields, sendLog)
        let outcome = ''
        if (!entry.ok) {
          outcome = `❌ 无头浏览器访问【${sysName}】失败：${entry.error || '未知错误'}。已保留上述参数，请检查系统地址/网络后重试。`
        } else if (!entry.loggedIn) {
          outcome = `⚠️ 检测到尚未登录【${sysName}】，无法录入。请先到「设置 → 企业系统连接」完成该系统登录（登录态会本地保存复用），随后再次发起即可。`
        } else {
          const filledLine = entry.filled.length ? `已自动填充字段：**${entry.filled.join('、')}**。` : '当前页面未匹配到对应的可填写控件。'
          const missingLine = entry.missing.length ? `\n未能在当前页面定位到：${entry.missing.join('、')}。` : ''
          outcome = `🤖 已在后台打开【${sysName}】并复用登录态执行录入。${filledLine}${missingLine}\n\n说明：自动填充按字段标签就近匹配当前页面的表单控件。若部分字段（尤其是下拉框、带 \`+\` 的检索框）未填充，通常是因为需要先在 CRM 中导航到“客户管理 → 拜访反馈 → 新建”表单页，或该 CRM 的控件需要专用选择器适配——这部分可按你的 CRM（如纷享销客）页面结构进一步配置。请在 CRM 中核对后点击保存。`
        }
        await trace.submit(data.content, entry.ok && entry.loggedIn ? 'SUCCESS' : 'PARTIAL', `拜访记录录入：抽取→用户确认→无头浏览器(${entry.ok ? (entry.loggedIn ? '已尝试填充' : '未登录') : '失败'})。`)
        return { content: `✅ 已确认并执行客户拜访记录录入。\n\n**确认的录入参数：**\n\n${confirmedTable}\n\n**执行结果：**\n\n${outcome}`, success: true, traceId: trace.id }
      }

      if (skillHandled) {
        // 读取类已在上面抓取并设置整理提示，跳过默认的"打开首页抓取"。
      } else if (targetSystemId) {
        // 解析目标系统地址（来自管理端"业务系统连接"）。
        let sysName = '业务系统'
        let baseUrl = ''
        try {
          const ir = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
          if (ir.ok) {
            const list: any = await ir.json()
            const sys = Array.isArray(list) ? list.find((x: any) => x.id === targetSystemId) : null
            if (sys) { sysName = sys.name; baseUrl = sys.baseUrl }
          }
        } catch (e) { swallow(e) }

        if (!baseUrl) {
          out.skillResult = `❌ 技能 "${skl}" 绑定的业务系统不存在或已被删除，无法执行。`
          out.skillPromptHint = `【技能未执行】技能 "${skl}" 绑定的目标业务系统不可用。请如实告知用户该技能未能执行、原因是目标系统未配置，绝对不要编造任何业务数据或待办。\n\n【SOP 仅供参考】\n${matchedSkill.sopContent}`
        } else {
          const ext = await openSystemAndExtract(targetSystemId, baseUrl, sysName, sendLog, recNavHash)
          if (ext.ok && ext.loggedIn && ext.text.length > 40) {
            out.skillResult = `已在【${sysName}】中实际打开页面并抓取到真实内容，正在交由分身按标准流程整理。`
            out.skillPromptHint = `【技能 "${skl}" 真实执行结果】\n以下是刚刚从【${sysName}】真实页面抓取到的内容（页面标题：${ext.title}）：\n"""\n${ext.text}\n"""\n\n请严格、且仅依据上述真实页面内容，按下面的 SOP 整理后回答用户。如果这些内容与用户任务无关、为空、或看起来仍是登录/首页，请如实说明并提示用户操作，绝对禁止编造任何待办、条目、发起人或数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          } else if (ext.ok && !ext.loggedIn) {
            out.skillResult = `⚠️ 检测到尚未登录【${sysName}】。请先在「设置 → 企业系统连接」中登录该系统（登录态会保存在本地），随后再次发起该任务即可。`
            out.skillPromptHint = `【技能未完成 · 需登录】后台访问【${sysName}】时发现当前未登录，无法获取任何真实数据。请按以下两点回复用户：\n1) 首先明确告知：需要先到「设置 → 企业系统连接」完成【${sysName}】的本地登录（登录态会保存在本地、可复用），登录后再次发起本任务即可由分身自动获取。\n2) 然后，依据下面的 SOP，给出一份清晰、可照做的「手动操作指引」（编号分步），让用户在登录前也能自己先操作。\n注意：这是操作指引，不是已抓取的真实数据；绝对不要编造任何待办条目、发起人、单号或数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          } else {
            out.skillResult = `❌ 访问【${sysName}】失败：${ext.error || '未知错误'}`
            out.skillPromptHint = `【技能执行失败】访问【${sysName}】失败，原因："${ext.error || '未知错误'}"。请如实告知用户失败原因并建议检查系统地址/网络，绝对不要编造任何数据。`
          }
        }
      } else if (webSearchIntent) {
        // 公开信息类技能（标讯/招标/行业调研等）→ 执行联网检索能力（检索词带上技能意图，更对口）。
        const sklName = skillDisplayName(matchedSkill.id) || (matchedSkill.name !== matchedSkill.id ? matchedSkill.name : '该技能要找的信息')
        const cleanQuery = data.content.split('\n').filter(l => !l.startsWith('【')).join(' ').trim() || data.content
        try {
          const sq = await refineSearchQuery(cleanQuery, data.llmConfig, sendLog, sklName, matchedSkill.sopContent)
          const r = await webSearch(sq, sendLog)
          const lines = r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
          const pageBlocks = r.pages.map(p => `【来源：${p.title}｜${p.url}】\n${p.text}`).join('\n\n')
          out.skillResult = `技能 "${skl}" 已联网检索「${sq}」。`
          out.skillPromptHint = r.results.length
            ? `【技能 "${skl}" · 联网检索真实结果】检索词：「${sq}」。\n— 结果列表 —\n${lines}\n\n— 头部网页正文 —\n${pageBlocks || '（未提取到正文）'}\n\n请严格按下面的 SOP 整理回答，但务必先做一步**相关性判断**：\n- 该技能要找的是【${sklName}】这一类对象。请只挑选**确实属于这一类**的检索结果整理成 SOP 要求的列表格式（如标讯须为"招标/中标/采购公告"类网页，逐条给出发布时间、标题、发布单位、详情链接）。\n- 若上面的检索结果**不是**该类对象（例如要找招标公告却只搜到行业资讯、企业介绍、新闻、招聘等无关内容），**绝对不要**把它们硬凑、改写或包装成该技能的结果；应按 SOP 的"未找到"话术如实告知用户未检索到相关${sklName}，并建议补充更具体的关键词/企业名/地区后重试。\n- 结尾另起一行写「来源：」，把真正引用到的网页写成 Markdown 链接「- [网页标题](链接)」；严禁编造任何不在上述内容中的条目、单位、时间或链接。\n\n【SOP】\n${matchedSkill.sopContent}`
            : `【技能 "${skl}" · 联网检索】对「${sq}」未检索到结果，可能网络受限或无相关${sklName}。请如实告知用户未检索到，并建议更换/补充关键词，勿编造。`
        } catch (e: any) {
          out.skillResult = `❌ 联网检索失败：${e.message}`
          out.skillPromptHint = `【联网检索失败】"${e.message}"。请如实告知用户，勿编造。`
        }
      } else {
        // 未绑定业务系统、也无原生实现 —— 作为「知识/推理型技能」由大模型按 SOP 执行。
        // 很多技能（撰写/分析/规划/答疑/草拟）本就不依赖业务系统，不应一律判为“未执行”。
        out.skillResult = `已按技能「${skl}」的标准作业流程执行（该技能为知识/推理型，基于大模型与当前上下文完成）。`
        out.skillPromptHint = `【技能 "${skl}" 执行 · 知识/推理型】\n该技能不依赖业务系统、也无需自动化网页操作，请你作为该岗位专家，严格按下面的 SOP 完成用户任务：基于用户输入、已上传附件与工作空间内容进行推理、整理与产出。\n- 若 SOP 中某一步骤确实需要某个尚未连接系统的实时数据，请完成你能完成的部分，并明确指出哪一步需要先到「设置 → 企业系统连接」连接对应系统；\n- 绝对不要编造任何不存在的真实业务数据（具体人名、单号、简历、待办条目、金额、日期）。\n\n【SOP】\n${matchedSkill.sopContent}`
      }
  return null
}

// ── 任务编排（planner-executor）─────────────────────────────────────────────
// 一句话含多个异构诉求（读+写、多技能+联网）时，把请求拆成有序子任务依次执行：
// 读取/生成类自动跑；写入类子任务在其内部自然弹出「人工确认 + 一次性签名令牌」流程；
// 最后合并成一条回复 + 一条审计（写子任务的确认/取消状态都如实体现，绝不自动串写）。
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
      localFiles.push(f)
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
// 登录会话按系统隔离持久保存（persist:bizsys-<id>），与技能执行器共用。
// =====================================================================
const bizPartition = (systemId: string) => `persist:bizsys-${systemId}`

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

// ===== 业务系统登录保活心跳 =====
// 定时离屏打开已登录系统的会话分区并访问其地址 —— 访问即触发服务端刷新会话有效期（滑动过期），
// 同时检测在线状态、掉线则标记需重新登录。会话只在本地分区，绝不上传。
const HB_KEY = 'bizsys-hb'
let hbBusy = false
let hbTimer: NodeJS.Timeout | null = null
const hbState = { enabled: configGet(HB_KEY) !== '0', busy: false, lastAt: '', online: 0, total: 0 }
function emitHb() { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('systems:heartbeat', hbState) }

async function pingBizSystem(systemId: string, baseUrl: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { partition: bizPartition(systemId), offscreen: true } })
    let settled = false
    const done = (v: boolean) => { if (settled) return; settled = true; try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }; resolve(v) }
    win.webContents.once('did-finish-load', async () => {
      try {
        await sleep(2500)
        const text: string = await win.webContents.executeJavaScript(`(function(){return (document.body?document.body.innerText:'').slice(0,600)})()`)
        const t = (text || '').trim()
        const loginish = t.length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password|认证|扫码)/i.test(t)
        done(!loginish)
      } catch (_) { done(false) }
    })
    win.webContents.once('did-fail-load', () => done(false))
    win.loadURL(baseUrl).catch(() => {})
    setTimeout(() => done(false), 20000)
  })
}

async function runBizHeartbeat() {
  if (hbBusy) return
  hbBusy = true; hbState.busy = true; emitHb()
  try {
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`).catch(() => null)
    const list: any = res && res.ok ? await res.json() : []
    const linked = (Array.isArray(list) ? list : []).filter((s: any) => s && s.baseUrl && configGet('bizsys-linked:' + s.id) === '1')
    let online = 0
    for (const s of linked) {
      try {
        const ok = await pingBizSystem(s.id, s.baseUrl)
        if (ok) online++; else configSet('bizsys-linked:' + s.id, '0')   // 掉线 → 标记需重新登录
      } catch (e) { swallow(e) }
    }
    const now = new Date()
    hbState.lastAt = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    hbState.online = online; hbState.total = linked.length
  } catch (e) { swallow(e) }
  finally { hbBusy = false; hbState.busy = false; emitHb() }
}

ipcMain.handle('systems:heartbeat-get', () => hbState)
ipcMain.handle('systems:heartbeat-set', (_e, enabled: boolean) => { hbState.enabled = !!enabled; configSet(HB_KEY, enabled ? '1' : '0'); emitHb(); if (enabled) runBizHeartbeat(); return hbState })
ipcMain.handle('systems:heartbeat-now', async () => { await runBizHeartbeat(); return hbState })

function startBizKeepAlive() {
  if (hbTimer) return
  hbTimer = setInterval(() => { if (hbState.enabled) runBizHeartbeat() }, 4 * 60 * 1000)
}

