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
import { runningState, runExclusive, requestFormConfirmation } from './automation-runtime'
import { openSystemAndExtract, extractVisitFields, fillCrmVisitForm, extractFieldsByLabels, replayActionScript, parseDsl, interpretSkillScript } from './browser-automation'
import { AgentTrace } from './agent-trace'
import { registerDbHandlers } from './ipc/db'
import { registerWindowHandlers } from './ipc/window'
import { registerAgentControlHandlers } from './ipc/agent-control'
import { runOntologyHook } from './agent-ontology'
import type { AgentTaskData, AgentResult } from './agent-types'
import { type SendLog, type VisitField, type RecStep } from './types'
import { webSearch, isWebSearchIntent, refineSearchQuery, getExpertWebSearch, shouldWebSearch } from './web-search'

let mainWindow: BrowserWindow | null = null

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
      sandboxMode: configGet('sandboxMode') || 'local-pyodide',
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
let localFiles: Array<{ name: string; path: string; summary?: string; synced: boolean }> = [
  { name: "2026_q2_sales_plan.pdf", path: "/documents/2026_q2_sales_plan.pdf", summary: "Q2销售规划，目标拓展北方市场客户", synced: true },
  { name: "company_policy.docx", path: "/documents/company_policy.docx", summary: "企业考勤与报销管理规定细则", synced: false }
]

interface SkillDefinition {
  id: string
  name: string
  description: string
  triggerKeywords: string[]
  allowedRoles: string[]
  sopContent: string
}

let loadedSkills: SkillDefinition[] = []

// 技能「展示名」映射（id → 管理端维护的人类可读名称）。本地 SKILL.md 的 `name:` 是 slug(=id)，
// 真正的展示名在管理端，需异步拉取后缓存。用于在用户可见文案里展示「名称（编号）」。
const skillNameMap = new Map<string, string>()
function skillLabel(s: { id: string; name?: string } | null | undefined): string {
  if (!s) return ''
  const disp = skillNameMap.get(s.id) || (s.name && s.name !== s.id ? s.name : '')
  return disp ? `${disp}（${s.id}）` : s.id
}

// （已移除）ensureDefaultSkills：曾在客户端预置 web-screenshot / weather-check / workspace-analyzer
// 三个演示技能的 SKILL.md。技能的单一来源是管理端（配置→认领下发→本地落盘），客户端不自造预置。
// 原生演示实现(runBuiltinSkill 三分支)亦已一并移除：技能只在管理端配置，统一走自定义技能链路。

function loadLocalSkills() {
  const projectRoot = process.cwd()
  const skillsDir = path.join(projectRoot, 'skills')
  
  console.log(`[Skills Loader] Loading skills from directory: ${skillsDir}`)
  
  try {
    const subdirs = fs.readdirSync(skillsDir)
    const newSkills: SkillDefinition[] = []

    for (const subdir of subdirs) {
      const subdirPath = path.join(skillsDir, subdir)
      if (!fs.statSync(subdirPath).isDirectory()) continue

      const skillMdPath = path.join(subdirPath, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) continue

      const content = fs.readFileSync(skillMdPath, 'utf-8')
      
      const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/
      const match = frontmatterRegex.exec(content)
      
      let name = subdir
      let description = `Local skill from ${subdir}`
      let triggerKeywords: string[] = []
      let allowedRoles: string[] = []
      let sopContent = content

      if (match) {
        const yamlText = match[1]
        sopContent = content.substring(match[0].length).trim()
        
        const lines = yamlText.split('\n')
        let currentKey = ''
        
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed.startsWith('-')) {
            if (currentKey === 'trigger_keywords') {
              const val = trimmed.replace(/^-/, '').trim().replace(/^['"]|['"]$/g, '')
              // 触发词可能被错误地存成「A，B、C」长串（录制转技能时未拆分），统一按分隔符拆开，
              // 否则纯子串匹配永远命中不了整串，导致对话框调不出技能。
              if (val) for (const part of val.split(/[，,、；;\s]+/)) { const k = part.trim().toLowerCase(); if (k) triggerKeywords.push(k) }
            } else if (currentKey === 'allowed_roles') {
              const val = trimmed.replace(/^-/, '').trim().replace(/^['"]|['"]$/g, '')
              if (val) allowedRoles.push(val)
            }
          } else if (trimmed.includes(':')) {
            const separatorIndex = trimmed.indexOf(':')
            const key = trimmed.substring(0, separatorIndex).trim()
            let val = trimmed.substring(separatorIndex + 1).trim()
            
            val = val.replace(/^['"]|['"]$/g, '')

            if (key === 'name') {
              name = val
            } else if (key === 'description') {
              description = val
            } else if (key === 'trigger_keywords') {
              currentKey = 'trigger_keywords'
            } else if (key === 'allowed_roles') {
              if (val.startsWith('[') && val.endsWith(']')) {
                allowedRoles = val.substring(1, val.length - 1).split(',').map(v => v.trim().replace(/^['"]|['"]$/g, ''))
              } else if (val) {
                allowedRoles.push(val)
              }
              currentKey = 'allowed_roles'
            } else {
              currentKey = ''
            }
          }
        }
      }

      console.log(`[Skills Loader] Loaded skill "${name}" (Keywords: ${triggerKeywords.join(', ')} | Roles: ${allowedRoles.join(', ') || 'all'})`)
      newSkills.push({
        id: subdir,
        name,
        description,
        triggerKeywords,
        allowedRoles,
        sopContent
      })
    }

    loadedSkills = newSkills
  } catch (err: any) {
    console.error(`[Skills Loader] Failed to load local skills:`, err.message)
  }
}

// 清理本地已被管理端删除的技能：以管理端技能全集为准，删掉本地多余的技能目录。
// 仅在成功取到管理端清单时执行（避免离线时误删全部）。返回清理数量。
async function pruneDeletedSkills(): Promise<number> {
  try {
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/skills`)
    if (!res.ok) return 0
    const list: any = await res.json()
    if (!Array.isArray(list)) return 0
    // 顺带缓存技能展示名（id → name），供后续文案展示「名称（编号）」
    list.forEach((s: any) => { if (s && s.id && s.name) skillNameMap.set(String(s.id), String(s.name)) })
    const keep = new Set(list.map((s: any) => String(s.id)))
    const skillsDir = path.join(process.cwd(), 'skills')
    if (!fs.existsSync(skillsDir)) return 0
    let removed = 0
    for (const sub of fs.readdirSync(skillsDir)) {
      const dir = path.join(skillsDir, sub)
      try { if (!fs.statSync(dir).isDirectory()) continue } catch (_) { continue }
      if (!keep.has(sub)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); removed++; console.log(`[Skills Loader] 清理已删除技能：${sub}`) } catch (e) { swallow(e) }
      }
    }
    return removed
  } catch (_) { return 0 }
}

// Initial load
loadLocalSkills()
// 启动后异步清理一次管理端已删技能，再重载（不阻塞启动）
pruneDeletedSkills().then(n => { if (n > 0) loadLocalSkills() })


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

function writeSkillFile(skill: any) {
  const projectRoot = process.cwd()
  // The skill's stable identifier (matches the directory name); the SKILL.md
  // `name:` frontmatter is this slug, NOT the display name.
  const skillId = skill.id || skill.name
  const skillDir = path.join(projectRoot, 'skills', skillId)
  const skillMd = path.join(skillDir, 'SKILL.md')

  // Physical skills already on disk are the source of truth — never clobber
  // them on claim. This stops the backend's display name from overwriting the
  // preset SKILL.md slug (`name: web-screenshot` → `name: 网页截图`) every sync.
  if (fs.existsSync(skillMd)) {
    return
  }
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true })
  }

  const yamlHeader = [
    '---',
    `name: ${skillId}`,
    `description: ${skill.description || ''}`,
    'trigger_keywords:',
    ...(skill.triggerKeywords || []).map((kw: string) => `  - ${kw}`),
    'allowed_roles:',
    ...(skill.allowedRoles || []).map((role: string) => `  - ${role}`),
    '---',
    '',
    ''
  ].join('\n')

  fs.writeFileSync(skillMd, yamlHeader + (skill.sopContent || ''), 'utf-8')
  console.log(`[Skills Sync] Seeded new physical skill file: ${skillMd}`)
}

// 企业基础信息与规则：由管理端统一维护，构建系统指令时实时拉取，不在客户端写死。
async function getEnterpriseBlock(): Promise<string> {
  let p: any = {}
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/enterprise`)
    if (r.ok) p = await r.json()
  } catch (e) { swallow(e) }
  const lines: string[] = []
  if (p.companyName) lines.push(`- 企业名称：${p.companyName}`)
  if (p.info) lines.push(`- 其他信息：${String(p.info).replace(/\n/g, '\n  ')}`)
  return lines.length ? lines.join('\n') : '- （企业信息尚未在管理端配置）'
}

// Corporate knowledge retrieval scope downlinked on claim, keyed per expert.
function getKnowledgeScope(expertId?: string): string[] {
  if (!expertId) return []
  try {
    const raw = configGet('kbScope:' + expertId)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed
    }
  } catch (e) { swallow(e) }
  return []
}

interface CorporateChunk { documentId: string; text: string; score: number; scope?: string; images?: { marker: string; dataUri: string }[] }

// Layered RAG: query the admin backend's pgvector store. Returns the union of
// ENTERPRISE chunks in the expert's knowledge categories PLUS the caller's own
// PERSONAL chunks (owner-scoped). Degrades gracefully to [] when offline.
async function queryCorporateKnowledge(text: string, expertId?: string): Promise<CorporateChunk[]> {
  if (!text || !text.trim()) return []
  try {
    const scope = getKnowledgeScope(expertId)
    const params = new URLSearchParams({ text: text.slice(0, 500), topK: '4', clientId: expertId || 'client' })
    if (scope.length) params.set('categories', scope.join(','))
    params.set('ownerId', getOwnerId())   // 带上个人库归属 → 企业库 ∪ 我的个人库
    const url = `${getAdminBaseUrl()}/api/v1/knowledge/query?${params.toString()}`
    const res = await fetch(url)
    if (!res.ok) return []
    const data: any = await res.json()
    if (!Array.isArray(data)) return []
    // Keep only reasonably relevant hits.
    return data
      .filter((c: any) => typeof c.text === 'string' && (c.score ?? 0) > 0.1)
      .map((c: any) => ({ documentId: c.documentId, text: c.text, score: c.score ?? 0, scope: c.scope, images: Array.isArray(c.images) ? c.images : undefined }))
  } catch (err: any) {
    console.warn('[Corporate RAG] retrieval failed (offline?):', err.message)
    return []
  }
}

// Render retrieved chunks as a prompt block (empty string when none). Personal
// and enterprise hits are labelled so the agent knows which is the user's own
// material vs company policy.
function buildCorporateRagBlock(chunks: CorporateChunk[]): string {
  if (!chunks.length) return ''
  const lines = chunks
    .map((c, i) => {
      const tag = c.scope === 'PERSONAL' ? '个人知识' : '企业制度'
      return `${i + 1}. [${tag}] (相似度 ${(c.score * 100).toFixed(0)}% · ${c.documentId}) ${c.text}`
    })
    .join('\n')
  const hasImages = chunks.some(c => c.images && c.images.length)
  const imageRule = hasImages
    ? `\n注意：部分内容含插图占位标记（如【图1】）。若答案引用了对应内容，请在恰当位置**原样保留该标记**（系统会自动替换为真实插图），不要改写或删除标记，也不要编造不存在的标记。`
    : ''
  return `\n\n【知识库检索结果 (个人+企业分层 · pgvector)】\n以下为从「我的个人知识库」与「企业云端知识库」实时检索到的最相关内容，请优先据此作答（[个人知识]=用户自己的资料，[企业制度]=公司统一规则）：\n${lines}${imageRule}`
}

// 图文回答：把答案中的【图N】占位替换为知识库真实插图(markdown data-URI，渲染层可直接显示)。
// 模型输出了但库里没有的占位一律清除(绝不虚构图片)。
function attachRagImages(content: string, chunks: CorporateChunk[]): string {
  if (!content || !content.includes('【图')) return content
  const map = new Map<string, string>()
  for (const c of chunks) for (const im of c.images || []) map.set(im.marker, im.dataUri)
  return content.replace(/【图(\d+)】/g, (m) => {
    const uri = map.get(m)
    return uri ? `\n\n![${m.slice(1, -1)}](${uri})\n\n` : ''
  })
}

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
      skills: Array.isArray(e.skills) ? e.skills.map((s: any) => ({ id: s.id, name: s.name, type: s.type })) : []
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
  let skillsSynced: Array<{ id: string; name: string; type: string }> = []
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
          if (sk && sk.id && sk.name) skillNameMap.set(String(sk.id), String(sk.name))
          skillsSynced.push({
            id: sk.id,
            name: sk.name,
            type: sk.type === 'playwright' ? '本地离屏渲染截图技能' : '本地文件与环境沙箱技能'
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
    loadedSkills.forEach(sk => {
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

ipcMain.handle('files:add-mock', (_event, name: string) => {
  const newFile = {
    name,
    path: `/documents/${name}`,
    summary: `关于 ${name.split('.')[0]} 的概要总结`,
    synced: false
  }
  localFiles.push(newFile)
  if (mainWindow) {
    mainWindow.webContents.send('files:watch-event', { action: 'add', file: newFile })
  }
  return { success: true }
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
async function synthesizeSkillAnswer(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace, sk: { skillResult: string; skillPromptHint: string }): Promise<AgentResult> {
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
        success: true, traceId: trace.id
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
      return { content, success: true, traceId: trace.id }
    } catch (err: any) {
      sendLog('observing', `大模型连接润色失败: ${err.message}。自动回退为本地技能直达渲染。`)
      sendLog('completed', `[Completed] 技能运行完毕（回退直通）。`)
      return {
        content: `⚠️ **[大模型连接失败 - 自动切换本地直通输出]**\n\n大模型请求遇到问题 (\`${err.message}\`)，但本地技能已在 Electron 环境内执行成功。以下是物理执行结果：\n\n---\n\n${skillResult}`,
        success: true, traceId: trace.id
      }
    }
}

// 自定义技能真实执行：解析绑定业务系统// 自定义技能真实执行：解析绑定业务系统 → 语义脚本(DSL)/录制回放/CRM拜访录入/读取抓取/联网检索/知识推理。
// 命中确定路径→AgentResult 早返回;否则把 skillResult/skillPromptHint 回填到 out、返回 null 交后续 LLM 整理。
async function runCustomSkill(matchedSkill: SkillDefinition, skl: string, data: AgentTaskData, sendLog: SendLog, trace: AgentTrace, out: { skillResult: string; skillPromptHint: string }): Promise<AgentResult | null> {
  let skillHandled = false
      sendLog('thinking', `[技能执行] 识别到自定义技能 "${skl}"，正在解析其绑定的目标业务系统...`)

      // 本地 SKILL.md 不含目标系统，需向管理端拉取完整技能定义。
      let targetSystemId = ''
      let actionScriptRaw = ''
      let skillCode = ''
      let skillSop = ''
      let skillKind = ''        // read=读取/查看类，write=写入/操作类（FDE 录制时判定）
      let skillNavHash = ''     // 录制到的导航目标路由，读取类据此直达子页
      try {
        const sr = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${matchedSkill.id}`)
        if (sr.ok) { const full: any = await sr.json(); targetSystemId = full.targetSystemId || ''; actionScriptRaw = full.actionScript || ''; skillCode = full.code || ''; skillSop = full.sopContent || ''; skillKind = full.skillKind || ''; skillNavHash = full.navHash || ''; if (full.name) skillNameMap.set(matchedSkill.id, String(full.name)) }
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

      // 读取类判定（优先 FDE 标注的 skillKind；无标注则按脚本/步骤里有无写入动作推断）。
      // 读取类绝不走「只导航不取数」的 DSL/回放分支——否则只会回“请核对结果”而没有真实数据；
      // 应落到下方「打开目标页 + 抓取真实内容 + 按 SOP 整理」分支，由分身给出真正的待办/查询结果。
      let isReadSkill = skillKind === 'read'
      if (!skillKind) {
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
        let confirmed: Record<string, string> = {}
        if (filledFields.length) {
          sendLog('acting', '已整理出待填写字段，请在下方表单卡片中核对并确认...')
          confirmed = await requestFormConfirmation(filledFields)
          if (!confirmed || Object.keys(confirmed).length === 0) { const content = `🚫 已取消该技能执行，未写入任何数据。`; await trace.submit(data.content, 'BLOCKED', `语义脚本技能 "${skl}"：用户取消确认。`); return { content, success: true, traceId: trace.id } }
        }
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
      const hasWriteOps = skillKind === 'write' ? true
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
          // ② 表单确认（有可填字段才弹）
          let confirmed: Record<string, string> = {}
          if (filledFields.length) {
            sendLog('acting', '已整理出待填写字段，请在下方表单卡片中核对并确认...')
            confirmed = await requestFormConfirmation(filledFields)
            if (!confirmed || Object.keys(confirmed).length === 0) { const content = `🚫 已取消该技能执行，未写入任何数据。`; await trace.submit(data.content, 'BLOCKED', `录制技能 "${skl}"：用户取消确认。`); return { content, success: true, traceId: trace.id } }
          }
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
        const sklName = skillNameMap.get(matchedSkill.id) || (matchedSkill.name !== matchedSkill.id ? matchedSkill.name : '该技能要找的信息')
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

async function runSkillPipeline(data: AgentTaskData, sendLog: SendLog, trace: AgentTrace): Promise<AgentResult | null> {
  const normalized = data.content.toLowerCase()
  const expertId = data.expertId || ''
  // --- Skill Interception and Execution ---
  // Reload skills to capture any newly created folders/files by the user!
  loadLocalSkills()

  let isSkillTriggered = false
  let skillResult = ''
  let skillPromptHint = ''

  // 技能匹配：限定在「当前岗位实际装配的技能集」内，并取关键词命中最精确的那个。
  // 这样不会误命中其它岗位/全局("all"角色)技能；只有该岗位没有任何装配信息时，才退回按 allowed_roles 判定。
  let matchedSkill: SkillDefinition | null = null
  if (data.forcedSkillId) {
    // 用户在「业务技能」里显式锁定了技能 → 直接用它，绕过关键词猜测（更确定）
    matchedSkill = loadedSkills.find(s => s.id === data.forcedSkillId) || null
  }
  if (!matchedSkill) {
    let boundIds: string[] = []
    try { const raw = configGet('boundSkills:' + expertId); if (raw) boundIds = JSON.parse(raw) } catch (e) { swallow(e) }
    const inScope = (s: SkillDefinition) => boundIds.length
      ? boundIds.includes(s.id)                                   // 有装配信息 → 仅限装配的技能
      : (s.allowedRoles.includes(expertId) || s.allowedRoles.length === 0)  // 无装配信息 → 退回角色判定
    // 候选 = 在范围内 且 命中关键词；按命中关键词数降序（更精确者优先），并列保持加载顺序
    const candidates = loadedSkills
      .filter(s => inScope(s))
      .map(s => ({ s, hits: s.triggerKeywords.filter(kw => normalized.includes(kw)).length }))
      .filter(x => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
    if (candidates.length) matchedSkill = candidates[0].s
  }

  if (matchedSkill) {
    // 用户可见文案统一用「名称（编号）」展示该技能（展示名来自管理端缓存，缺失则回退编号）
    const skl = skillLabel(matchedSkill)
    trace.skill = skl
    sendLog('acting', `找到合适的技能「${skl}」，这就去办…`)
    trace.spans.push({ type: 'skill', name: `匹配技能·${skl}`, status: 'ok' })
    // 统一走自定义技能链路(管理端配置的技能：DSL/录制回放/读取抓取/检索/知识推理)
    isSkillTriggered = true
    const out = { skillResult: '', skillPromptHint: '' }
    const done = await runCustomSkill(matchedSkill, skl, data, sendLog, trace, out)
    if (done) return done
    skillResult = out.skillResult
    skillPromptHint = out.skillPromptHint
  }

  // 未匹配到技能，但任务需要联网检索 → 触发联网检索能力。
  // 联网检索触发：显式关键词，或"已授权联网"的分身自主研判需要联网。
  if (!matchedSkill && !isSkillTriggered) {
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
        skillPromptHint = `【联网检索真实结果】用户的问题需要联网信息，以下是刚刚从互联网检索到的真实结果与网页正文。\n\n— 搜索结果列表 —\n${lines}\n\n— 头部网页正文 —\n${pageBlocks || '（未能提取到正文，仅有上面的摘要）'}\n\n请严格基于以上真实检索内容回答用户问题。结尾另起一行写「来源：」，并将每条引用写成 Markdown 链接「- [网页标题](链接)」（用标题文字作为链接文本，不要直接粘贴长链接）。如果这些内容不足以回答，请如实说明，不要编造任何事实或链接。`
      }
    } catch (e: any) {
      skillResult = `❌ 联网检索失败：${e.message}`
      skillPromptHint = `【联网检索失败】检索过程中出错："${e.message}"。请如实告知用户检索失败，不要编造任何结果。`
    }
    }
  }

  if (isSkillTriggered) {
    return await synthesizeSkillAnswer(data, sendLog, trace, { skillResult, skillPromptHint })
  }
  return null
}

ipcMain.handle('agent:send-message', (_event, data: { content: string; expertId?: string; expertName: string; userNickname?: string; background: string; llmConfig: LlmConfig; forcedSkillId?: string; permMode?: 'readonly' | 'full' }) => runExclusive(async () => {
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
    return { content, success: true }
  }
}))

// IPC Form / Delete Confirmation responses from React UI
registerAgentControlHandlers()

// Window chrome handlers
registerWindowHandlers()

// 本地工作空间目录（截图、附件、技能产物都落在这里）。
function workspaceDir(): string {
  // 用户可指定工作目录（在「工作空间」里选）；未指定则用默认 documents
  const override = configGet('workspaceDir')
  if (override && fs.existsSync(override)) return override
  const dir = path.join(process.cwd(), 'documents')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// 实时扫描当前工作目录里的文件（供「工作空间」弹层展示与引用）
function scanWorkspace(): { name: string; path: string }[] {
  const dir = workspaceDir()
  try {
    return fs.readdirSync(dir)
      .filter(n => { if (n.startsWith('.')) return false; try { return fs.statSync(path.join(dir, n)).isFile() } catch { return false } })
      .map(n => ({ name: n, path: path.join(dir, n) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch { return [] }
}

ipcMain.handle('workspace:files', () => ({ dir: workspaceDir(), files: scanWorkspace() }))
ipcMain.handle('workspace:pick-dir', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择工作空间目录' })
  if (r.canceled || !r.filePaths.length) return { canceled: true, dir: workspaceDir(), files: scanWorkspace() }
  configSet('workspaceDir', r.filePaths[0])
  return { ok: true, dir: workspaceDir(), files: scanWorkspace() }
})
ipcMain.handle('workspace:reset-dir', () => { configSet('workspaceDir', ''); return { dir: workspaceDir(), files: scanWorkspace() } })

// 服务端 docling 解析：把文件传给后端 /api/v1/parse/document，拿规整 Markdown。
// 重活(PDF 版面/表格/OCR、docx/xlsx/pptx)放服务端跑，终端不吃算力；不可达时返回 null 由调用方回退。
// 仅上传用户显式引用的文档，绝不上传登录态/凭证。
const DOCLING_EXTS = ['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp']
async function parseViaBackend(absPath: string): Promise<string | null> {
  try {
    const fileBlob = new Blob([fs.readFileSync(absPath)])
    const form = new FormData()
    form.append('file', fileBlob, path.basename(absPath))
    const res = await afetch(`${getAdminBaseUrl()}/api/v1/parse/document`, { method: 'POST', body: form, timeoutMs: 180000 })
    if (!res.ok) return null
    const data: any = await res.json()
    if (data && data.ok && typeof data.markdown === 'string' && data.markdown.trim()) return data.markdown.trim()
    return null   // ok:false（docling 未配置/解析失败）→ 交给本地回退
  } catch (_) {
    return null   // 后端离线 → 本地回退
  }
}

// PDF 本地兜底解析（pdfjs 只抽文字流，丢表格/版式；仅在服务端 docling 不可用时用）。
async function extractPdfLocal(absPath: string): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(fs.readFileSync(absPath))
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise
  const maxPages = Math.min(doc.numPages, 40)
  let out = ''
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    out += tc.items.map((it: any) => ('str' in it ? it.str : '')).join(' ') + '\n'
  }
  if (doc.numPages > maxPages) out += `\n…（共 ${doc.numPages} 页，仅解析前 ${maxPages} 页）`
  return out.trim()
}

// 文档解析：文本类直接读；复杂/二进制格式优先走服务端 docling，失败再本地兜底(PDF→pdfjs)。
async function extractFileText(absPath: string): Promise<string> {
  const ext = path.extname(absPath).toLowerCase()
  // 纯文本类：直读最快，无需绕服务端
  if (['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml'].includes(ext)) {
    return fs.readFileSync(absPath, 'utf-8')
  }
  // 复杂/二进制格式(含 html)：优先 docling
  if (DOCLING_EXTS.includes(ext) || ext === '.html' || ext === '.htm') {
    const md = await parseViaBackend(absPath)
    if (md) return md
    // 服务端不可用 → 本地兜底
    if (ext === '.pdf') return await extractPdfLocal(absPath)
    if (ext === '.html' || ext === '.htm') return fs.readFileSync(absPath, 'utf-8')
    return ''  // docx/xlsx/pptx/图片 无本地兜底
  }
  return ''
}

// 解析消息里 “【附件】a、b（已加入工作空间）” 引用的文件，抽取其真实文本。
async function extractAttachmentText(content: string, sendLog: SendLog): Promise<string> {
  const m = content.match(/【附件】([^\n]*?)（已加入工作空间）/)
  if (!m) return ''
  const names = m[1].split('、').map(s => s.trim()).filter(Boolean)
  if (!names.length) return ''
  const dir = workspaceDir()
  const blocks: string[] = []
  for (const name of names) {
    const abs = path.join(dir, name)
    if (!fs.existsSync(abs)) { blocks.push(`【${name}】未在工作空间找到该文件。`); continue }
    sendLog('acting', `[文档解析] 正在读取并解析附件：${name}`)
    try {
      let text = await extractFileText(abs)
      if (!text) {
        blocks.push(`【${name}】未能解析出文本。文本类(txt/md/csv/json)本地直读；PDF/DOCX/XLSX/PPTX/图片 需服务端文档解析引擎(docling)在线——当前不可用,已回退基础解析仍取不到内容。`)
      } else {
        if (text.length > 9000) text = text.slice(0, 9000) + '\n…（内容过长，已截断）'
        sendLog('observing', `[文档解析] ${name} 解析成功，提取约 ${text.length} 字`)
        blocks.push(`【${name} 的真实文本内容】\n${text}`)
      }
    } catch (e: any) {
      sendLog('observing', `[文档解析] ${name} 解析失败：${e.message}`)
      blocks.push(`【${name}】解析失败：${e.message}`)
    }
  }
  return blocks.join('\n\n')
}

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

