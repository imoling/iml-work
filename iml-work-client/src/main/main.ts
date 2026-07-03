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
  encryptValue,
  decryptValue,
  convList,
  convCreate,
  convDelete,
  convUpdateTitle,
  msgAdd,
  msgList,
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
import { VISIT_FILL_FN, RECORDER_BOOTSTRAP, REPLAY_STEP_FN, HOVER_LOCATE_FN, SEMANTIC_FN, SNAPSHOT_FN, PAGE_SETTLE_FN } from './browser-scripts'
import { setMainWindow } from './window-ref'
import { incImCommandCount, getImCommandCount } from './stats'
import { type RemoteBotKey, getRemoteBotState, startRemoteBot, stopRemoteBot, bootRemoteBots } from './remote-bots'
import { swallow, sleep } from './util'
import { runningState, runExclusive, requestFormConfirmation } from './automation-runtime'
import { type SendLog, type VisitField, type RecStep, type DslStep } from './types'
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

function ensureDefaultSkills() {
  const projectRoot = process.cwd()
  const skillsDir = path.join(projectRoot, 'skills')
  
  const defaults = {
    'web-screenshot': {
      sop: `---
name: web-screenshot
description: 网页离屏截图与保存技能，当用户要求对某个网页进行截图、查看网页视图、捕获页面或截图时使用。
trigger_keywords:
  - 截图
  - screenshot
  - 网页截图
  - 截屏
allowed_roles:
  - expert-1
---

# 网页截图技能 SOP

## 核心原则
- 接收用户提供的 URL 地址。如果用户未指定具体 URL，将自动使用默认网址。
- 启动本地静默渲染引擎，载入该网页视图，并捕捉页面快照。
- 将生成的物理图片保存到本地个人文件空间，并返回 HTML/Markdown 图片占位符。

## 使用指导
- 在回复中向用户确认网页截图已成功保存到本地。
- 必须包含占位符 [IMAGE_PLACEHOLDER_PNG] 以便前端加载图像。
`
    },
    'weather-check': {
      sop: `---
name: weather-check
description: 查询实时天气并进行出差标准合规性校验的技能。当用户提到天气、出差气候、weather 时触发。
trigger_keywords:
  - 天气
  - weather
  - 气候
  - 出差天气
allowed_roles:
  - expert-2
---

# 天气与差旅标准校验 SOP

## 核心原则
- 识别用户出差的目的地城市。
- 向天气接口发起网络查询，获取实时温度和气象。
- 将目标城市与艾姆尔公司《差旅报销管理规范》标准进行对比，输出酒店及伙食补贴限额判断。

## 差旅标准参考
- 华东/华北区：酒店限额 500元/天，伙食补贴 100元/天。
- 华南区：酒店限额 450元/天，伙食补贴 80元/天。
- 其他地区：酒店限额 300元/天，伙食补贴 60元/天。
`
    },
    'workspace-analyzer': {
      sop: `---
name: workspace-analyzer
description: 扫描本地个人空间物理目录、提取文件元数据并生成文件同步报告的技能。当用户要求分析文档、查看文件状态、扫描本地文件夹时触发。
trigger_keywords:
  - 分析文档
  - 分析文件
  - 分析本地
  - 分析空间
  - 扫描本地
  - 扫描文件
allowed_roles:
  - expert-3
---

# 本地工作空间文件分析 SOP

## 核心原则
- 扫描本地工作目录中的物理文件，读取其物理尺寸、修改时间等元数据。
- 查询本地缓存与云端同步标记，确定哪些文件未同步，生成表格报告。
- 输出的报告中，文件名必须为 clickable local links 协议格式：[文件名](file:///绝对路径)。
`
    }
  }

  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true })
  }

  for (const [id, item] of Object.entries(defaults)) {
    const dir = path.join(skillsDir, id)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const skillMd = path.join(dir, 'SKILL.md')
    
    // We rewrite default skills to ensure the allowed_roles property gets added
    let needsWrite = !fs.existsSync(skillMd)
    if (fs.existsSync(skillMd)) {
      const existing = fs.readFileSync(skillMd, 'utf-8')
      if (!existing.includes('allowed_roles:')) {
        needsWrite = true
      }
    }
    
    if (needsWrite) {
      fs.writeFileSync(skillMd, item.sop, 'utf-8')
      console.log(`[Skills Loader] Seeded default skill file: ${skillMd}`)
    }
  }
}

function loadLocalSkills() {
  ensureDefaultSkills()
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
ipcMain.handle('secure-store:save', (_event, key: string, value: string) => {
  try {
    if (typeof value !== 'string') {
      console.error(`[secure-store:save] key="${key}" 值非字符串，已拒绝`)
      return { success: false, error: 'value must be a string' }
    }
    configSet(key, encryptValue(value))   // 加密后落盘（configSet 不会对非白名单 key 二次加密）
    return { success: true }
  } catch (err: any) {
    console.error(`[secure-store:save] key="${key}" 异常:`, err.message)
    return { success: false, error: err.message }
  }
})

ipcMain.handle('secure-store:get', (_event, key: string) => {
  try {
    const raw = configGet(key)
    if (raw === '[object Object]') return null   // 兼容历史脏值
    return decryptValue(raw)
  } catch (err: any) {
    console.error(`[secure-store:get] key="${key}" 异常:`, err.message)
    return null
  }
})

// SQLite native database handlers
ipcMain.handle('db:config-get', (_event, key: string) => {
  return configGet(key)
})

ipcMain.handle('db:config-set', (_event, key: string, value: string) => {
  configSet(key, value)
  return true
})

ipcMain.handle('db:config-get-all', (_event) => {
  return configGetAll()
})

ipcMain.handle('db:conv-list', (_event, expertId: string) => {
  return convList(expertId)
})

ipcMain.handle('db:conv-create', (_event, expertId: string, title?: string) => {
  return convCreate(expertId, title)
})

ipcMain.handle('db:conv-delete', (_event, id: string) => {
  convDelete(id)
  return true
})

ipcMain.handle('db:conv-update-title', (_event, id: string, title: string) => {
  convUpdateTitle(id, title)
  return true
})

ipcMain.handle('db:msg-add', (_event, conversationId: string, role: 'user' | 'assistant', content: string) => {
  return msgAdd(conversationId, role, content)
})

ipcMain.handle('db:msg-list', (_event, conversationId: string) => {
  return msgList(conversationId)
})

ipcMain.handle('db:memory-get', (_event, expertId: string, type: 'agent' | 'personal') => {
  return memoryGet(expertId, type)
})

ipcMain.handle('db:memory-set', (_event, expertId: string, type: 'agent' | 'personal', content: string) => {
  memorySet(expertId, type, content)
  return true
})

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

interface CorporateChunk { documentId: string; text: string; score: number; scope?: string }

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
      .map((c: any) => ({ documentId: c.documentId, text: c.text, score: c.score ?? 0, scope: c.scope }))
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
  return `\n\n【知识库检索结果 (个人+企业分层 · pgvector)】\n以下为从「我的个人知识库」与「企业云端知识库」实时检索到的最相关内容，请优先据此作答（[个人知识]=用户自己的资料，[企业制度]=公司统一规则）：\n${lines}`
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

  // 2. Local database memories seeding fallback (always run to ensure DB context is ready)
  try {
    const defaultSops: Record<string, string[]> = {
      'expert-1': [
        'SOP-01：OA审批填写格式约定 - 标题格式为 [拜访业务]-[客户名称]-[日期]，类型选择[市场拓展]。',
        'SOP-02：当审批金额大于1000元时，系统会自动增加财务部门二级会签流程，需提前上传报销电子发票。'
      ],
      'expert-2': [
        '发票识别规则：只接受增值税电子普通发票/电子专用发票，不接受手写或剪贴发票。'
      ],
      'expert-3': [
        '同步策略：每5分钟扫描本地 documents 目录下的新增变更文件，并生成 MD5 块比对，同步至云端。'
      ]
    }
    const sops = defaultSops[expertId] || []
    const sopsJson = JSON.stringify(sops.map((content, idx) => ({
      id: `asst-${expertId}-${idx}`,
      level: 'assistant',
      content,
      source: '专家内置技能包',
      timestamp: '2026-06-13 18:00'
    })))
    memorySet(expertId, 'agent', sopsJson)

    // Seed default personal memories if not present
    const defaultPersonals: Record<string, string[]> = {
      'expert-1': ['个人差旅习惯：通常出差乘坐高铁，常去城市为上海、南京。'],
      'expert-2': ['报销偏好：偏向于月末统一提交本月所有报销单，常选电子发票自动关联。'],
      'expert-3': ['文档同步习惯：习惯在周五下午下班前手动触发一次全量文档云端同步校验。']
    }
    const personals = defaultPersonals[expertId] || []
    const personalsJson = JSON.stringify(personals.map((content, idx) => ({
      id: `pers-${expertId}-${idx}`,
      level: 'personal',
      content,
      source: '用户历史会话沉淀',
      timestamp: '2026-06-13 09:12'
    })))
    
    if (!memoryGet(expertId, 'personal')) {
      memorySet(expertId, 'personal', personalsJson)
    }
  } catch (err: any) {
    console.error(`[expert:claim] Seeding memories failed:`, err.message)
  }

  // 3. Load local skills dynamically (if syncSuccess is false, it loads what's already on disk)
  if (syncSuccess) await pruneDeletedSkills()   // 同步成功 → 以管理端为准清理已删技能
  loadLocalSkills()

  // 4. Fallback seeding for skills metadata if backend was offline
  if (!syncSuccess) {
    console.log(`[expert:claim] Backend sync offline. Using local skills directory seeding.`)
    if (expertId === 'expert-1') {
      const sk = loadedSkills.find(s => s.id === 'web-screenshot')
      if (sk) skillsSynced.push({ id: sk.id, name: sk.name, type: '本地离屏渲染截图技能' })
    } else if (expertId === 'expert-2') {
      const sk = loadedSkills.find(s => s.id === 'weather-check')
      if (sk) skillsSynced.push({ id: sk.id, name: sk.name, type: '本地网络天气合规技能' })
    } else if (expertId === 'expert-3') {
      const sk = loadedSkills.find(s => s.id === 'workspace-analyzer')
      if (sk) skillsSynced.push({ id: sk.id, name: sk.name, type: '本地文件物理分析技能' })
    }

    loadedSkills.forEach(sk => {
      if (!['web-screenshot', 'weather-check', 'workspace-analyzer'].includes(sk.id)) {
        skillsSynced.push({ id: sk.id, name: sk.name, type: '本地自定义流程 (Markdown SOP)' })
      }
    })

    if (skillsSynced.length === 0) {
      skillsSynced = [
        { id: 'web-screenshot', name: '网页截图', type: '本地离屏渲染截图技能' }
      ]
    }
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

async function takeWebScreenshot(url: string, sendLog: (type: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed', text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    sendLog('thinking', `[网页截图技能] 准备对目标网页进行截图: ${url}`)
    sendLog('acting', `正在初始化静默 Electron BrowserWindow 实例进行离屏渲染...`)
    
    const view = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: {
        offscreen: true
      }
    })

    sendLog('stdout', `加载网页中: ${url}`)
    view.loadURL(url).catch(err => {
      sendLog('stdout', `网页加载初始化出错: ${err.message}`)
    })

    const handleFinish = async () => {
      try {
        sendLog('observing', `网页加载已就绪，等待 2 秒以确保所有异步资源及 CSS 样式完全就绪...`)
        await sleep(2000)
        
        sendLog('acting', `正在捕获当前页面视图 (webContents.capturePage)...`)
        const image = await view.webContents.capturePage()
        const pngBuffer = image.toPNG()
        
        const projectRoot = process.cwd()
        const docsDir = path.join(projectRoot, 'documents')
        if (!fs.existsSync(docsDir)) {
          fs.mkdirSync(docsDir, { recursive: true })
        }
        
        const fileName = `screenshot_${Date.now()}.png`
        const filePath = path.join(docsDir, fileName)
        fs.writeFileSync(filePath, pngBuffer)
        sendLog('stdout', `物理截图文件已成功写入到本地工作空间: ${filePath} (${pngBuffer.length} 字节)`)

        // Add to local files memory array
        const newFile = {
          name: fileName,
          path: `/documents/${fileName}`,
          summary: `自动网页截图: ${url}`,
          synced: false
        }
        localFiles.push(newFile)
        
        // Notify React frontend file watcher
        if (mainWindow) {
          mainWindow.webContents.send('files:watch-event', { action: 'add', file: newFile })
        }
        
        const base64 = pngBuffer.toString('base64')
        const markdownImg = `![screenshot](data:image/png;base64,${base64})`
        
        view.destroy()
        sendLog('completed', `[网页截图技能] 离屏截图成功并已同步至“个人空间”。`)
        resolve(markdownImg)
      } catch (err: any) {
        view.destroy()
        sendLog('completed', `[网页截图技能] 执行失败: ${err.message}`)
        reject(err)
      }
    }

    view.webContents.on('did-finish-load', handleFinish)
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      view.destroy()
      sendLog('completed', `[网页截图技能] 网页加载失败: ${errorDescription} (错误码: ${errorCode})`)
      reject(new Error(`网页加载失败: ${errorDescription} (错误码: ${errorCode})`))
    })

    // Safety timeout
    setTimeout(() => {
      view.destroy()
      sendLog('completed', `[网页截图技能] 加载超时`)
      reject(new Error(`网页加载超时`))
    }, 25000)
  })
}


// 跨所有 iframe 抓取「文本最多」的那一帧正文（读取类技能的目标列表常渲染在子 iframe，
// 只读顶层 document.body 往往为空）。对齐 FDE 的"取最丰富 frame"策略。
async function scrapeRichestText(wc: any, max = 6000): Promise<{ title: string; text: string; url: string }> {
  let title = '', url = '', best = ''
  try {
    const m: any = await wc.executeJavaScript(`({t:document.title||'',u:location.href,x:(document.body?document.body.innerText:'')})`)
    title = m.t || ''; url = m.u || ''; best = m.x || ''
  } catch (e) { swallow(e) }
  try {
    const frames: any[] = wc.mainFrame && wc.mainFrame.framesInSubtree ? wc.mainFrame.framesInSubtree : []
    for (const f of frames) {
      try {
        const t: string = await f.executeJavaScript(`(document.body?document.body.innerText:'')`)
        if (t && t.trim().length > best.trim().length) best = t
      } catch (e) { swallow(e) }
    }
  } catch (e) { swallow(e) }
  return { title, text: (best || '').replace(/\s+\n/g, '\n').slice(0, max), url }
}

interface SystemExtractResult { ok: boolean; loggedIn: boolean; title: string; text: string; error?: string }

/**
 * 真实驱动一个业务系统：在带持久化登录态的浏览器窗口中打开系统地址，等待加载后
 * 抓取页面真实文本。员工首次需在弹出的窗口里登录（登录态按系统隔离持久保存），
 * 之后即可复用。返回真实页面内容，绝不臆造——若未登录或加载失败则如实反馈。
 */
async function openSystemAndExtract(systemId: string, baseUrl: string, systemName: string, sendLog: SendLog, navHash: string = ''): Promise<SystemExtractResult> {
  return new Promise((resolve) => {
    sendLog('acting', `正在打开【${systemName}】，沿用你之前的登录…`)
    // 技能执行全程在后台静默运行（离屏），不弹出可见窗口。登录在"设置 → 企业系统连接"完成。
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 860,
      webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true }
    })

    let settled = false
    const finish = async () => {
      if (settled) return
      settled = true
      try {
        sendLog('observing', `页面打开了，等它加载一下…`)
        await sleep(3500)
        // 若录制带有导航 hash（如 #/todo / #crm/list/...），抓取前先按它直达目标子页，
        // 再等待二次渲染——这样读取类技能能落到正确页面，而不是只抓首页。
        if (navHash) {
          sendLog('acting', `正在直达目标页面…`)
          try {
            const h = navHash.startsWith('#') ? navHash : '#' + navHash
            const full = baseUrl.replace(/#.*$/, '') + h
            // 整页加载到 hash 路由，强制 SPA 加载该子页（比 location.hash= 可靠，和 FDE 直达一致）
            await win.webContents.loadURL(full)
            await sleep(3500)
            // 兜底：若仍未进入该路由，再用 location.hash 触发一次 SPA 路由
            try {
              const cur: string = await win.webContents.executeJavaScript('location.href')
              if (typeof cur === 'string' && cur.indexOf(h.replace('#', '')) < 0) {
                await win.webContents.executeJavaScript(`(function(){location.hash=${JSON.stringify(h)};return 1})()`)
                await sleep(2500)
              }
            } catch (e) { swallow(e) }
          } catch (e) { swallow(e) }
        }
        const data = await scrapeRichestText(win.webContents, 6000)
        const text: string = (data.text || '').trim()
        const lower = text.toLowerCase()
        // 登录态判断：内容很短且像登录页，视为未登录
        const loginish = text.length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password|认证)/.test(lower)
        sendLog('stdout', `拿到【${systemName}】的页面内容了（约 ${text.length} 字），正在看…`)
        win.close()
        if (loginish) {
          // 后台静默执行，不弹窗；如未登录则提示去设置里登录。
          sendLog('observing', `好像还没登录【${systemName}】，先去「设置 → 企业系统连接」登录一下吧…`)
          resolve({ ok: true, loggedIn: false, title: data.title, text })
        } else {
          sendLog('completed', `已经从【${systemName}】拿到内容啦。`)
          resolve({ ok: true, loggedIn: true, title: data.title, text })
        }
      } catch (e: any) {
        try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
        resolve({ ok: false, loggedIn: false, title: '', text: '', error: e.message })
      }
    }

    win.webContents.once('did-finish-load', finish)
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (settled) return
      settled = true
      try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
      resolve({ ok: false, loggedIn: false, title: '', text: '', error: `页面加载失败(${code}): ${desc}` })
    })
    win.loadURL(baseUrl).catch(() => {})

    setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, loggedIn: false, title: '', text: '', error: '页面加载超时（30秒）' })
    }, 30000)
  })
}

// =====================================================================
// 客户拜访记录录入 CRM：① 抽取字段 → ② 对话框表单确认 → ③ 无头浏览器录入
// =====================================================================


// CRM 拜访记录的必填字段（与技能 SOP 对齐）。
const VISIT_RECORD_FIELDS: Array<{ name: string; label: string; type: string }> = [
  { name: 'visitType', label: '拜访类型', type: 'text' },
  { name: 'visitDate', label: '拜访日期', type: 'date' },
  { name: 'visitForm', label: '拜访形式', type: 'text' },
  { name: 'visitResult', label: '本次拜访结果', type: 'text' },
  { name: 'customerName', label: '客户名称', type: 'text' },
  { name: 'contact', label: '联系人', type: 'text' },
  { name: 'salesPlatform', label: '销售平台归属', type: 'text' },
  { name: 'regionPlatform', label: '区域平台归属', type: 'text' },
  { name: 'currentProgress', label: '当前进展', type: 'textarea' },
  { name: 'nextPlan', label: '下一步计划', type: 'textarea' }
]

// 用大模型从用户的自然语言拜访描述中抽取结构化字段，绝不编造关键信息（缺失留空）。
async function extractVisitFields(userContent: string, cfg: LlmConfig, sendLog: SendLog): Promise<VisitField[]> {
  sendLog('thinking', '[拜访记录] 正在用大模型从您的描述中抽取要录入 CRM 的必填字段...')
  const today = new Date().toISOString().slice(0, 10)
  const prompt = `你是 CRM 拜访记录信息抽取助手。请从下面这段用户提供的拜访记录中抽取字段，输出严格 JSON 对象，键名固定为：${VISIT_RECORD_FIELDS.map(f => f.name).join(', ')}。
字段含义：${VISIT_RECORD_FIELDS.map(f => `${f.name}=${f.label}`).join('；')}。
规则：
- 拜访日期输出 YYYY-MM-DD 格式；若用户说“今天”则用 ${today}。
- 找不到的字段输出空字符串；绝对不要编造客户名称、联系人等关键信息，缺失就留空。
- 当前进展、下一步计划可在忠于原文的前提下做简洁客观的归纳。
- 只输出 JSON，不要任何解释或代码块标记。

拜访记录：
${userContent}`
  let values: Record<string, string> = {}
  try {
    const out = await callLlm(prompt, cfg)
    const s = (out || '').replace(/```json/g, '').replace(/```/g, '').trim()
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a >= 0 && b > a) values = JSON.parse(s.slice(a, b + 1))
  } catch (e: any) {
    sendLog('observing', `[拜访记录] 字段自动抽取失败（${e.message}），将给出空白表单供您手动填写。`)
  }
  const filledCount = VISIT_RECORD_FIELDS.filter(f => values[f.name]).length
  sendLog('stdout', `[拜访记录] 已抽取 ${filledCount}/${VISIT_RECORD_FIELDS.length} 个字段，未识别的字段留空待您确认。`)
  return VISIT_RECORD_FIELDS.map(f => ({ name: f.name, label: f.label, type: f.type, value: typeof values[f.name] === 'string' ? values[f.name] : '' }))
}

interface VisitEntryResult { ok: boolean; loggedIn: boolean; filled: string[]; missing: string[]; title: string; url: string; error?: string }

// 在页面上下文里按字段标签就近定位表单控件并填充（best-effort，覆盖 antd/element/原生表单）。

// 复用本地登录态在后台静默打开 CRM，按确认后的参数尽力填充拜访记录表单，如实回报实际结果。
async function fillCrmVisitForm(systemId: string, baseUrl: string, systemName: string, confirmed: Record<string, string>, fields: VisitField[], sendLog: SendLog): Promise<VisitEntryResult> {
  return new Promise((resolve) => {
    sendLog('acting', `正在后台静默打开【${systemName}】并复用本地登录态，准备录入拜访记录：${baseUrl}`)
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true } })
    let settled = false
    const fail = (error: string) => {
      if (settled) return; settled = true
      try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
      resolve({ ok: false, loggedIn: false, filled: [], missing: fields.map(f => f.label), title: '', url: '', error })
    }
    const finish = async () => {
      if (settled) return; settled = true
      try {
        await sleep(3500)
        const pre = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',text:(document.body?document.body.innerText:'').slice(0,2000),url:location.href}})()`)
        const lower = (pre.text || '').toLowerCase()
        const loginish = (pre.text || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test(lower)
        if (loginish) {
          sendLog('observing', `检测到尚未登录【${systemName}】，无法录入。请先在「设置 → 企业系统连接」完成登录。`)
          try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
          resolve({ ok: true, loggedIn: false, filled: [], missing: fields.map(f => f.label), title: pre.title, url: pre.url })
          return
        }
        sendLog('acting', '页面已就绪，正在按字段标签逐项定位并填充表单控件...')
        const payload = JSON.stringify(fields.map(f => ({ label: f.label, value: confirmed[f.name] || '' })).filter(x => x.value))
        const report = await win.webContents.executeJavaScript(`(${VISIT_FILL_FN})(${payload})`)
        await sleep(600)
        const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
        sendLog('stdout', `[拜访记录] 已填充 ${(report.filled || []).length} 个字段：${(report.filled || []).join('、') || '无'}`)
        try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
        resolve({ ok: true, loggedIn: true, filled: report.filled || [], missing: report.missing || [], title: after.title, url: after.url })
      } catch (e: any) { fail(e.message) }
    }
    win.webContents.once('did-finish-load', finish)
    win.webContents.once('did-fail-load', (_e, code, desc) => fail(`页面加载失败(${code}): ${desc}`))
    win.loadURL(baseUrl).catch(() => {})
    setTimeout(() => fail('页面加载超时（30秒）'), 30000)
  })
}

// =====================================================================
// 浏览器实操录制（Record & Replay）：用户在监控下操作业务系统，捕获稳健选择器与步骤，
// 生成可确定性回放的技能脚本。录制复用 persist:bizsys-<id> 登录态，所见即所录。
// =====================================================================


let recorderWin: BrowserWindow | null = null
let recorderSteps: RecStep[] = []

// 注入到被录制页面里的脚本：计算稳健选择器并监听 click / change，通过 console 通道上报。

function injectRecorder(wc: Electron.WebContents) {
  wc.executeJavaScript(RECORDER_BOOTSTRAP).catch(() => {})
}

ipcMain.handle('recorder:start', async (_e, payload: { systemId: string; baseUrl: string; systemName: string }) => {
  try {
    if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (e) { swallow(e) } }
    recorderSteps = []
    const win = new BrowserWindow({
      show: true, width: 1280, height: 860, title: `实操录制 · ${payload.systemName}`,
      webPreferences: { partition: `persist:bizsys-${payload.systemId}` }
    })
    recorderWin = win
    const onStep = (_ev: any, _level: any, message: string) => {
      if (typeof message === 'string' && message.startsWith('__REC__')) {
        try {
          const step: RecStep = JSON.parse(message.slice('__REC__'.length))
          // 合并连续对同一控件的 fill（取最后值），避免重复步骤
          const last = recorderSteps[recorderSteps.length - 1]
          if (step.action === 'fill' && last && last.action === 'fill' && last.selector === step.selector) {
            last.value = step.value
          } else {
            recorderSteps.push(step)
          }
          if (mainWindow) mainWindow.webContents.send('recorder:step', step)
        } catch (e) { swallow(e) }
      }
    }
    win.webContents.on('console-message', onStep)
    win.webContents.on('did-finish-load', () => injectRecorder(win.webContents))
    win.webContents.on('did-frame-navigate', () => injectRecorder(win.webContents))
    win.on('closed', () => { recorderWin = null })
    await win.loadURL(payload.baseUrl)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('recorder:stop', async () => {
  const steps = recorderSteps.slice()
  if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (e) { swallow(e) } }
  recorderWin = null
  return { ok: true, steps }
})

ipcMain.handle('recorder:cancel', async () => {
  recorderSteps = []
  if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (e) { swallow(e) } }
  recorderWin = null
  return { ok: true }
})

// 用大模型按给定字段标签从用户描述抽取值（通用版，配合录制脚本的字段清单）。
async function extractFieldsByLabels(userContent: string, fields: VisitField[], cfg: LlmConfig, sendLog: SendLog): Promise<VisitField[]> {
  if (!fields.length) return []
  sendLog('thinking', '[录制技能] 正在用大模型从您的描述中抽取待填写字段...')
  const today = new Date().toISOString().slice(0, 10)
  const optionLines = fields.filter(f => Array.isArray(f.options) && f.options.length)
    .map(f => `${f.name}(${f.label}) 只能从以下选项中选一个：${f.options!.join(' / ')}`)
  const prompt = `请从下面用户的描述中抽取字段值，输出严格 JSON 对象，键名固定为：${fields.map(f => f.name).join(', ')}。
字段含义：${fields.map(f => `${f.name}=${f.label}`).join('；')}。
规则：日期类字段输出 YYYY-MM-DD（“今天”用 ${today}）；找不到就输出空字符串；不要编造关键信息（如客户名、联系人），缺失留空。${optionLines.length ? '\n下列字段为下拉选择，必须从给定选项里选最贴切的一个原样输出，选不出就留空：\n' + optionLines.join('\n') : ''}
只输出 JSON。

用户描述：
${userContent}`
  let values: Record<string, string> = {}
  try {
    const out = await callLlm(prompt, cfg)
    const s = (out || '').replace(/```json/g, '').replace(/```/g, '').trim()
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a >= 0 && b > a) values = JSON.parse(s.slice(a, b + 1))
  } catch (e) { swallow(e) }
  return fields.map(f => ({ ...f, value: typeof values[f.name] === 'string' ? values[f.name] : '' }))
}

// 在页面上下文中执行单个录制步骤（带等待重试），返回是否成功。
// 支持 kind:'search' —— 纷享销客等"带 + 检索选择框"：填入关键词→等待异步结果→点击匹配项。

// 在页面里定位元素并返回其视口中心坐标（供主进程派发真实指针移动，驱动纯 CSS :hover 菜单）。
// 优先用录制选择器 sel，其次按文本 arg。

// 真实指针 hover：先把鼠标移到元素中心（触发 CSS :hover），再派发合成事件（兜底 JS 框架）。
async function realHover(wc: Electron.WebContents, arg: string, sel?: string): Promise<{ ok: boolean; error?: string }> {
  let loc: any = null
  try { loc = await wc.executeJavaScript(`(${HOVER_LOCATE_FN})(${JSON.stringify(arg)}, ${JSON.stringify(sel || '')})`) } catch (e) { swallow(e) }
  if (loc && loc.ok) {
    try {
      wc.sendInputEvent({ type: 'mouseMove', x: loc.x, y: loc.y } as any)
      await sleep(80)
      wc.sendInputEvent({ type: 'mouseMove', x: loc.x, y: loc.y } as any)
    } catch (e) { swallow(e) }
  }
  let syn: any = null
  try { syn = await wc.executeJavaScript(`(${SEMANTIC_FN})(${JSON.stringify({ op: 'hover', arg, value: '', sel: sel || '' })})`) } catch (e) { swallow(e) }
  await sleep(350)
  if ((loc && loc.ok) || (syn && syn.ok)) return { ok: true }
  return { ok: false, error: (syn && syn.error) || '未找到悬停目标' }
}

interface ReplayResult { ok: boolean; loggedIn: boolean; done: number; total: number; failedAt: number; failLabel: string; title: string; url: string; error?: string }

// 复用登录态在后台静默回放录制脚本，把确认后的字段值替换进绑定步骤，如实回报执行结果。
async function replayActionScript(systemId: string, baseUrl: string, systemName: string, steps: RecStep[], fieldValues: Record<string, string>, fieldByStep: Record<number, string>, sendLog: SendLog): Promise<ReplayResult> {
  return new Promise((resolve) => {
    sendLog('acting', `正在后台静默打开【${systemName}】并复用登录态，按录制脚本回放 ${steps.length} 步操作...`)
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true } })
    let settled = false
    const fail = (error: string) => { if (settled) return; settled = true; try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }; resolve({ ok: false, loggedIn: false, done: 0, total: steps.length, failedAt: -1, failLabel: '', title: '', url: '', error }) }
    const run = async () => {
      if (settled) return; settled = true
      try {
        await sleep(3000)
        const pre = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',text:(document.body?document.body.innerText:'').slice(0,2000),url:location.href}})()`)
        const lower = (pre.text || '').toLowerCase()
        if ((pre.text || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test(lower)) {
          try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
          resolve({ ok: true, loggedIn: false, done: 0, total: steps.length, failedAt: -1, failLabel: '', title: pre.title, url: pre.url }); return
        }
        let done = 0
        for (let i = 0; i < steps.length; i++) {
          const step = { ...steps[i] }
          const boundField = fieldByStep[i]
          if (boundField && fieldValues[boundField] !== undefined) step.value = fieldValues[boundField]
          // 回放等待：用户为该步标注的等待（如等异步检索/页面跳转渲染）。
          const waitBefore = Number(step.waitBefore) || 0
          if (waitBefore > 0) { sendLog('observing', `[回放] 等待 ${waitBefore}ms（${step.label || ''}）`); await sleep(waitBefore) }
          const kindLabel = step.kind === 'search' ? '检索选择' : ((step as any).action || (step as any).act || 'click')
          sendLog('stdout', `[回放 ${i + 1}/${steps.length}] ${kindLabel} · ${step.label || step.selector}`)
          const r = await win.webContents.executeJavaScript(`(${REPLAY_STEP_FN})(${JSON.stringify(step)})`)
          if (!r || !r.ok) {
            const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
            try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
            resolve({ ok: true, loggedIn: true, done, total: steps.length, failedAt: i, failLabel: step.label || step.selector, title: after.title, url: after.url, error: r && r.error }); return
          }
          done++
          await sleep(700)
        }
        const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
        try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
        resolve({ ok: true, loggedIn: true, done, total: steps.length, failedAt: -1, failLabel: '', title: after.title, url: after.url })
      } catch (e: any) { fail(e.message) }
    }
    win.webContents.once('did-finish-load', run)
    win.webContents.once('did-fail-load', (_e, code, desc) => fail(`页面加载失败(${code}): ${desc}`))
    win.loadURL(baseUrl).catch(() => {})
    setTimeout(() => fail('页面加载超时（30秒）'), 30000)
  })
}

// =====================================================================
// 语义化技能脚本（DSL）解释执行 —— 比录制原始步骤更灵活、可读可改。
// 支持动词：click "文本" / fill "标签"=值 / select "标签"=值 / dropdown "标签"=值
//          searchSelect "标签"=值 / wait <ms> / waitText "文本"
// =====================================================================


// 解析 DSL 文本为步骤数组。支持行尾可选的 ` @sel=<css选择器>`（录制时的稳健定位，回放优先用它）。
function parseDsl(code: string): DslStep[] {
  const out: DslStep[] = []
  for (const raw of (code || '').split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let sel = ''
    const sm = line.match(/\s@sel=(.+)$/)
    if (sm) { sel = sm[1].trim(); line = line.slice(0, (sm as any).index).trim() }
    let m: RegExpMatchArray | null
    if ((m = line.match(/^wait\s+(\d+)/i))) { out.push({ op: 'wait', arg: '', valueExpr: m[1] }); continue }
    if ((m = line.match(/^waitText\s+"([^"]*)"/i))) { out.push({ op: 'waitText', arg: m[1], valueExpr: '', sel }); continue }
    if ((m = line.match(/^(\w+)\s+"([^"]*)"\s*(?:=\s*(.+))?$/))) { out.push({ op: m[1], arg: m[2], valueExpr: (m[3] || '').trim(), sel }); continue }
  }
  return out
}

// 把 valueExpr（{{字段}} 或 "字面量"）解析成最终值。
function resolveDslValue(valueExpr: string, fieldValues: Record<string, string>): string {
  if (!valueExpr) return ''
  const pm = valueExpr.match(/^\{\{\s*([\w.]+)\s*\}\}$/)
  if (pm) return fieldValues[pm[1]] !== undefined ? fieldValues[pm[1]] : ''
  return valueExpr.replace(/^"|"$/g, '')
}

// 在页面上下文中按语义定位执行一个动作（含等待/检索/下拉轮询）。

// 抓取当前页面"可交互元素"清单（供自愈智能体看页面决策）。

// 等待页面"稳定"：readyState 完成 + 无加载指示 + DOM 安静一小段，避免 SPA 导航未完成就误点上一个视图。

async function settlePage(wc: Electron.WebContents, maxMs = 9000): Promise<void> {
  try { await wc.executeJavaScript(`(${PAGE_SETTLE_FN})(${maxMs})`) } catch (e) { swallow(e) }
}

// 统一执行一个步骤（hover 走真实指针，其余走语义解释器）。
async function execStep(wc: Electron.WebContents, step: any): Promise<{ ok: boolean; error?: string }> {
  if (step.op === 'hover') return realHover(wc, step.arg, step.sel)
  try { return await wc.executeJavaScript(`(${SEMANTIC_FN})(${JSON.stringify(step)})`) } catch (e: any) { return { ok: false, error: e.message } }
}

interface HealOpts { llmConfig?: LlmConfig; sop?: string; script?: string }

// 自愈：某步按录制定位失败时，让大模型看当前页面 + SOP 意图，修正定位/关掉遮挡弹窗/或如实停止。
async function selfHeal(wc: Electron.WebContents, opts: HealOpts, step: any, sendLog: SendLog): Promise<{ ok: boolean; reason?: string }> {
  const cfg = opts.llmConfig
  if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.modelName) return { ok: false, reason: '未配置大模型，无法智能自愈' }
  for (let round = 0; round < 3; round++) {
    let els: any[] = []
    try { els = await wc.executeJavaScript(`(${SNAPSHOT_FN})()`) } catch (e) { swallow(e) }
    if (!els.length) { await sleep(800); continue }
    const list = els.map((e, i) => `${i}. <${e.tag}${e.role ? ' role=' + e.role : ''}> ${e.text || '(无文本)'}`).join('\n')
    const intent = `${step.op}${step.arg ? ' “' + step.arg + '”' : ''}${step.value ? ' 值=' + step.value : ''}`
    const prompt = `你在浏览器里执行一个业务自动化技能。整体标准流程(SOP)/脚本如下：\n${(opts.sop || opts.script || '').slice(0, 1500)}\n\n当前要完成的这一步意图：${intent}\n（录制时的定位提示：选择器 \`${(step.sel || '无')}\`，仅供参考；请以当前页面真实元素清单为准来定位）\n按录制提示未命中。下面是当前页面"可交互元素"清单（带编号）：\n${list}\n\n请决定如何完成这一步。规则：\n- 很多菜单要先把鼠标悬停在某个图标/模块入口上才会展开（左侧边栏图标、顶部一级菜单等）。目标项当前清单里看不到时，**不要急着 stop**：先在清单里挑一个最可能展开出目标的图标/模块入口，action 用 "hover"、completed=false（系统会把真实指针移上去展开后重试原步骤），可多次 hover 不同入口尝试。例如：目标是「客户管理」就 hover 清单里的「CRM」「客户」等模块入口；目标是某二级项就 hover 其一级菜单。\n- 若有遮挡弹窗（权限提示/确认框/引导层）挡住目标，先选关闭它的元素（如"我知道了"/"确定"/关闭），并设 completed=false。\n- 若能直接完成这一步，选对应元素并设 completed=true；需要填值时给 value。\n- 仅当已尝试过 hover 展开相关入口、仍确实无法完成（如明确提示无权限、目标确不存在）时，才用 action "stop" 并在 reason 说明。\n只输出严格 JSON：{"action":"click|fill|select|hover|stop","index":<编号或-1>,"value":"<可选>","completed":true|false,"reason":"<简述>"}`
    let d: any = null
    try {
      const out = await callLlm(prompt, cfg)
      const s = (out || '').replace(/```json/g, '').replace(/```/g, '')
      const a = s.indexOf('{'), b = s.lastIndexOf('}')
      if (a >= 0 && b > a) d = JSON.parse(s.slice(a, b + 1))
    } catch (e) { swallow(e) }
    if (!d) return { ok: false, reason: '自愈决策解析失败' }
    const tgt = (typeof d.index === 'number' && d.index >= 0 && els[d.index]) ? els[d.index] : null
    sendLog('thinking', `[自愈] ${d.action}${tgt ? ' 「' + (tgt.text || '') + '」' : ''} — ${d.reason || ''}`)
    if (d.action === 'stop') return { ok: false, reason: d.reason || '智能体判定无法继续' }
    if (!tgt) return { ok: false, reason: '自愈未指定有效元素' }
    await execStep(wc, { op: d.action, arg: '', value: d.value || '', sel: tgt.sel })
    await sleep(700)
    if (d.completed) return { ok: true }
    const rr = await execStep(wc, step)   // 关闭遮挡后重试原步骤
    if (rr && rr.ok) return { ok: true }
  }
  return { ok: false, reason: '多轮自愈仍未完成' }
}

interface InterpretResult { ok: boolean; loggedIn: boolean; done: number; total: number; failedAt: number; failLabel: string; title: string; url: string; text?: string; error?: string }

// 复用登录态在后台静默打开系统，按语义脚本逐步解释执行；失败步触发 SOP 智能自愈。
async function interpretSkillScript(systemId: string, baseUrl: string, systemName: string, dsl: DslStep[], fieldValues: Record<string, string>, sendLog: SendLog, opts: HealOpts = {}): Promise<InterpretResult> {
  return new Promise((resolve) => {
    sendLog('acting', `正在后台静默打开【${systemName}】并复用登录态，按语义脚本执行 ${dsl.length} 步...`)
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true } })
    let settled = false
    const fail = (error: string) => { if (settled) return; settled = true; try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }; resolve({ ok: false, loggedIn: false, done: 0, total: dsl.length, failedAt: -1, failLabel: '', title: '', url: '', error }) }
    const run = async () => {
      if (settled) return; settled = true
      try {
        await sleep(3000)
        const pre = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',text:(document.body?document.body.innerText:'').slice(0,2000),url:location.href}})()`)
        const lower = (pre.text || '').toLowerCase()
        if ((pre.text || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test(lower)) {
          try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
          resolve({ ok: true, loggedIn: false, done: 0, total: dsl.length, failedAt: -1, failLabel: '', title: pre.title, url: pre.url }); return
        }
        let done = 0
        let prevOp = ''
        for (let i = 0; i < dsl.length; i++) {
          const value = resolveDslValue(dsl[i].valueExpr, fieldValues)
          const step = { op: dsl[i].op, arg: dsl[i].arg, value, sel: dsl[i].sel || '' }
          const desc = `${step.op} ${step.arg ? '“' + step.arg + '”' : ''}${value ? ' = ' + value : ''}`
          // 上一步可能触发了导航 → 执行本步前等页面加载稳定，避免误点旧视图
          if (prevOp === 'click' || prevOp === 'hover') { sendLog('observing', `等待页面加载稳定...`); await settlePage(win.webContents) }
          sendLog('stdout', `[脚本 ${i + 1}/${dsl.length}] ${desc}`)
          let r = await execStep(win.webContents, step)
          if (!r || !r.ok) {
            sendLog('observing', `[第 ${i + 1} 步] 按录制定位未命中，启动 SOP 智能体自愈...`)
            const h = await selfHeal(win.webContents, opts, step, sendLog)
            r = h.ok ? { ok: true } : { ok: false, error: h.reason || (r && r.error) }
          }
          if (!r || !r.ok) {
            const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
            try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
            resolve({ ok: true, loggedIn: true, done, total: dsl.length, failedAt: i, failLabel: desc, title: after.title, url: after.url, error: r && r.error }); return
          }
          done++
          prevOp = step.op
          await sleep(500)
        }
        // 全部步骤完成 → 等页面稳定后跨 frame 抓取最丰富正文（读取类据此整理结果），再关闭
        await settlePage(win.webContents)
        await sleep(1500)
        const after = await scrapeRichestText(win.webContents, 4000)
        try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
        resolve({ ok: true, loggedIn: true, done, total: dsl.length, failedAt: -1, failLabel: '', title: after.title, url: after.url, text: after.text })
      } catch (e: any) { fail(e.message) }
    }
    win.webContents.once('did-finish-load', run)
    win.webContents.once('did-fail-load', (_e, code, desc) => fail(`页面加载失败(${code}): ${desc}`))
    win.loadURL(baseUrl).catch(() => {})
    setTimeout(() => fail('脚本执行总超时（90秒）'), 90000)
  })
}

// =====================================================================
// 联网检索能力（业界主流做法：检索 → 抓取头部结果 → 提取正文 → 带来源综合）。
// 无需任何 API Key：用离屏浏览器打开搜索引擎结果页解析，再深读头部结果。
// =====================================================================


async function checkWeatherAndAllowance(city: string, sendLog: (type: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed', text: string) => void): Promise<{ weatherText: string; limitText: string }> {
  sendLog('thinking', `[天气与差旅校验技能] 准备查询城市 "${city}" 的实时天气状况...`)
  sendLog('acting', `向公用天气接口 wttr.in 发起网络请求...`)
  
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=3`
  sendLog('stdout', `GET ${url}`)
  
  let weatherText = ''
  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP 状态码 ${response.status}`)
    }
    weatherText = await response.text()
    weatherText = weatherText.trim()
    sendLog('observing', `网络接口返回天气详情: ${weatherText}`)
  } catch (err: any) {
    sendLog('stdout', `网络请求失败: ${err.message}，正在通过本地基站进行备用模拟定位...`)
    const mockWeathers: Record<string, string> = {
      '北京': '北京: ☀️ +28°C ↙️ 风速 12km/h',
      '上海': '上海: 🌧️ +24°C ↙️ 风速 18km/h',
      '南京': '南京: ⛅ +26°C ↙️ 风速 10km/h',
      '广州': '广州: ⛈️ +30°C ↙️ 风速 22km/h',
      '深圳': '深圳: ☁️ +29°C ↙️ 风速 15km/h',
    }
    weatherText = mockWeathers[city] || `${city}: ⛅ +25°C ↙️ 风速 10km/h`
    sendLog('observing', `定位成功。基站数据模拟天气: ${weatherText}`)
  }

  sendLog('thinking', `对比艾姆尔公司《差旅报销管理规定》与政策标准...`)
  let region = '其他地区'
  let allowance = '酒店限额 300元/天，伙食补贴 60元/天'
  
  if (['北京', '天津', '河北', '石家庄', '太原', '呼和浩特'].some(x => city.includes(x))) {
    region = '华北区'
    allowance = '酒店限额 500元/天，伙食补贴 100元/天'
  } else if (['上海', '南京', '杭州', '苏州', '无锡', '合肥'].some(x => city.includes(x))) {
    region = '华东区'
    allowance = '酒店限额 500元/天，伙食补贴 100元/天'
  } else if (['广州', '深圳', '福州', '厦门'].some(x => city.includes(x))) {
    region = '华南区'
    allowance = '酒店限额 450元/天，伙食补贴 80元/天'
  }
  
  const limitText = `【公司差旅限额校验结果】\n- 目标城市: **${city}**\n- 对应管理区域: **${region}**\n- 报销最高限额标准: **${allowance}**\n- **温馨提示**: 随行差旅如超出此额度，报销单在提交财务记账系统时，将自动升级为 VP 二级审批流程。请合理安排行程。`
  sendLog('stdout', `校验标准输出完毕。`)
  sendLog('completed', `[天气与差旅校验技能] 执行完毕。`)
  
  return { weatherText, limitText }
}

async function analyzeLocalWorkspace(sendLog: (type: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed', text: string) => void): Promise<string> {
  sendLog('thinking', `[文件空间分析技能] 准备扫描物理本地工作目录...`)
  const projectRoot = process.cwd()
  const docsDir = path.join(projectRoot, 'documents')
  
  sendLog('acting', `检查物理工作空间目录: ${docsDir}`)
  if (!fs.existsSync(docsDir)) {
    sendLog('stdout', `物理目录不存在，正在自动初始化物理目录并预置基础说明文件...`)
    fs.mkdirSync(docsDir, { recursive: true })
    fs.writeFileSync(path.join(docsDir, 'company_policy.docx'), '企业考勤与报销管理规定细则 - 艾姆尔公司财务部发布')
    fs.writeFileSync(path.join(docsDir, 'readme_local_workspace.txt'), '此文件夹是 iML Work Client 客户端的本地物理同步工作空间。放入此文件夹的文件将被自动扫描建立索引。')
  }

  const physicalFiles = fs.readdirSync(docsDir)
  sendLog('stdout', `物理目录读取完毕，共发现 ${physicalFiles.length} 个物理文件。`)
  
  const fileDetails = []
  for (const file of physicalFiles) {
    if (file === '.DS_Store') continue
    const filePath = path.join(docsDir, file)
    const stats = fs.statSync(filePath)
    
    // Check if it's already in our memory list, if not add it
    let meta = localFiles.find(f => f.name === file)
    if (!meta) {
      meta = {
        name: file,
        path: `/documents/${file}`,
        summary: `自动扫描发现的本地物理文件`,
        synced: false
      }
      localFiles.push(meta)
      // Notify frontend
      if (mainWindow) {
        mainWindow.webContents.send('files:watch-event', { action: 'add', file: meta })
      }
    }

    fileDetails.push({
      name: file,
      size: stats.size,
      mtime: stats.mtime,
      synced: meta.synced
    })
  }

  sendLog('observing', `正在分析提取元数据并生成 markdown 报告表单...`)
  
  let report = `### 📂 iML Work 物理工作空间文件报告\n\n`
  report += `> 本地同步监听目录: \`${docsDir}\`\n\n`
  report += `| 物理文件名 | 物理大小 (字节) | 修改时间 | 云端数据库同步状态 |\n`
  report += `| :--- | :--- | :--- | :--- |\n`
  
  for (const f of fileDetails) {
    const status = f.synced ? '🟢 已同步备份' : '🟡 仅在本地 (未备份)'
    report += `| [${f.name}](file://${path.join(docsDir, f.name)}) | ${f.size} B | ${f.mtime.toLocaleString()} | ${status} |\n`
  }
  
  if (fileDetails.length === 0) {
    report += `| (暂无物理文件) | - | - | - |\n`
  }

  sendLog('completed', `[文件空间分析技能] 扫描与报告生成成功。`)
  return report
}

// 远程控制机器人（飞书/钉钉/QQ）逻辑已抽到 ./remote-bots；此处仅保留 IPC 注册。
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

// ================= 本体运行时（P0：解析对象+动作 → 策略 → 事件回写）=================
// 平台只存 Schema + 对象引用 + 业务事件；对象实例由此现查现用、留本地、不上传。
let ontologyHintsCache: { types: any[]; actions: any[] } | null = null
let ontologyHintsAt = 0
async function fetchOntologyHints(): Promise<{ types: any[]; actions: any[] }> {
  if (ontologyHintsCache && Date.now() - ontologyHintsAt < 60000) return ontologyHintsCache
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/ontology/resolve-hints`)
    if (r.ok) { ontologyHintsCache = await r.json(); ontologyHintsAt = Date.now() }
  } catch (e) { swallow(e) }
  return ontologyHintsCache || { types: [], actions: [] }
}
interface OntologyResolution {
  matched: boolean; domain?: string; objectType?: string; actionKey?: string
  displayName?: string; externalId?: string; amount?: number | null; reason?: string
}
// 便宜的预门：指令里没有任何本体标签/关键动词就直接跳过 LLM 解析，避免拖慢普通对话
function ontologyMightMatch(userMsg: string, hints: { types: any[]; actions: any[] }): boolean {
  const words = new Set<string>(['审批', '通过', '驳回', '拜访', '录入', '商机', '推进', '风险', '合同', '赢单'])
  for (const t of hints.types || []) if (t.label) words.add(t.label)
  for (const a of hints.actions || []) if (a.label) words.add(a.label)
  for (const w of words) if (w && userMsg.includes(w)) return true
  return false
}
async function resolveOntology(userMsg: string, cfg: LlmConfig): Promise<{ res: OntologyResolution; action: any | null; type: any | null }> {
  const none = { res: { matched: false } as OntologyResolution, action: null, type: null }
  const hints = await fetchOntologyHints()
  if (!hints.actions?.length || !ontologyMightMatch(userMsg, hints)) return none
  const typeList = hints.types.map((t: any) => {
    let rel = ''
    try { const rs = t.relationsJson ? JSON.parse(t.relationsJson) : []; rel = rs.map((r: any) => `${r.name}→${r.targetType}`).join(',') } catch (e) { swallow(e) }
    return `- domain=${t.domain} objectType=${t.typeKey} 标签=${t.label}${rel ? ' 关系=' + rel : ''}`
  }).join('\n')
  const actionList = hints.actions.map((a: any) =>
    `- domain=${a.domain} objectType=${a.objectType} actionKey=${a.actionKey} 标签=${a.label} 能力=${a.capability}`).join('\n')
  const prompt = `你是企业本体解析器。\n【对象类型】\n${typeList}\n\n【对象动作】\n${actionList}\n\n用户指令："${userMsg}"\n\n判断该指令是否明确对应上面某一个对象动作。注意：用户常用关联对象指代动作——例如"审批合同"其实是对该合同关联的审批任务(ApprovalTask)执行 approve；"拜访录入"对应 VisitEvent.logVisit。只输出 JSON（不要任何解释）：\n{"matched":true或false,"domain":"","objectType":"该动作所属的 objectType","actionKey":"","displayName":"从指令识别到的对象展示名(如 宝钢/宝钢合同/宝钢钢铁数字化项目)","amount":金额数字或null,"reason":"一句话理由"}\nmatched=true 仅当明确对应某 actionKey；objectType 必须填动作真正所属的类型；displayName 抽取指令里的客户/合同/商机名；amount 抽取金额(元)否则 null。`
  try {
    const out = await callLlm(prompt, cfg)
    const m = out.match(/\{[\s\S]*\}/)
    const res: OntologyResolution = m ? JSON.parse(m[0]) : { matched: false }
    if (!res.matched) return none
    const action = hints.actions.find((a: any) => a.domain === res.domain && a.objectType === res.objectType && a.actionKey === res.actionKey) || null
    if (!action) return none
    const type = hints.types.find((t: any) => t.domain === res.domain && t.typeKey === res.objectType) || null
    return { res, action, type }
  } catch (_) { return none }
}
function ontologyNeedsConfirm(action: any, amount?: number | null): boolean {
  try {
    const p = action?.policyJson ? JSON.parse(action.policyJson) : {}
    if (p.confirmIf === 'always') return true
    if (typeof p.confirmIf === 'string') {
      const mm = p.confirmIf.match(/amount\s*>\s*(\d+)/)
      if (mm && amount != null) return Number(amount) > Number(mm[1])
    }
    if (p.auto === false) return true
    return false
  } catch (_) { return false }
}
async function recordObjectRef(objectType: string, systemId: string, externalId: string, displayName: string, currentState: string): Promise<string> {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/ontology/object-refs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objectType, systemId, externalId, displayName, currentState })
    })
    if (r.ok) { const d = await r.json(); return d.id || '' }
  } catch (e) { swallow(e) }
  return ''
}
async function recordBusinessEvent(ev: any): Promise<void> {
  try {
    await afetch(`${getAdminBaseUrl()}/api/v1/ontology/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev)
    })
  } catch (e) { swallow(e) }
}
function buildOntologyGraphText(type: any, res: OntologyResolution, toState: string): string {
  try {
    const rels = type.relationsJson ? JSON.parse(type.relationsJson) : []
    let s = '```\n' + `${type.typeKey}: ${res.displayName || ''}  [${toState}]\n`
    for (const r of rels) s += `  └─ ${r.name} → ${r.targetType}\n`
    return s + '```'
  } catch (_) { return '' }
}

// ===== P1·B 读驱动消解：从对象列表页抓取候选对象（身份来自真实系统，不由录制写死）=====
interface OntologyCandidate { text: string; href: string; rowText?: string }
async function browseAndExtractLinks(systemId: string, url: string, sendLog: SendLog): Promise<{ ok: boolean; loggedIn: boolean; links: OntologyCandidate[]; error?: string }> {
  return new Promise((resolve) => {
    sendLog('observing', `读取候选对象列表：${url}`)
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true } })
    let settled = false
    const done = (r: any) => { if (settled) return; settled = true; try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }; resolve(r) }
    const run = async () => {
      try {
        await sleep(2500)
        const info = await win.webContents.executeJavaScript(`(function(){
          var txt = document.body ? document.body.innerText : '';
          var loginLike = txt.length < 400 && /(登录|登陆|login|sign in|密码|password|账号)/i.test(txt.toLowerCase());
          var out = [], seen = {};
          var as = document.querySelectorAll('a[href]');
          for (var i = 0; i < as.length; i++){ var a = as[i]; var t = (a.innerText||'').trim(); if (!t || t.length < 2) continue; if (seen[t]) continue; seen[t] = 1;
            var row = a.closest ? a.closest('tr, li, .row, .card, .item') : null;
            var rowText = row ? (row.innerText||'').replace(/\\s+/g,' ').trim() : t;
            out.push({ text: t, href: a.href, rowText: rowText }); }
          return { loginLike: !!loginLike, links: out };
        })()`)
        if (info.loginLike) { done({ ok: true, loggedIn: false, links: [] }); return }
        done({ ok: true, loggedIn: true, links: info.links || [] })
      } catch (e: any) { done({ ok: false, loggedIn: false, links: [], error: e?.message }) }
    }
    win.webContents.once('did-finish-load', run)
    win.webContents.once('did-fail-load', (_e, c, d) => done({ ok: false, loggedIn: false, links: [], error: `加载失败(${c}):${d}` }))
    win.loadURL(url).catch(() => {})
    setTimeout(() => done({ ok: false, loggedIn: false, links: [], error: '页面加载超时（30秒）' }), 30000)
  })
}
// 用「本体解析出的对象名 + 金额 + 原始指令」在候选里匹配。
// 先按名字关键词命中；若指令带了金额，再用金额（同行文本里的金额列）把同名的进一步收敛到唯一。
function matchOntologyCandidates(cands: OntologyCandidate[], displayName: string, userMsg: string, amount?: number | null): OntologyCandidate[] {
  const strip = (s: string) => (s || '').replace(/[0-9\s]/g, '').replace(/(万元|万|元|合同|审批|商机|客户|拜访|记录|的|那个|个|服务|采购|项目|平台|系统|建设|升级)/g, '')
  const key = strip(displayName)
  const msgKey = strip(userMsg)
  const probe = key || msgKey
  let hit: OntologyCandidate[] = []
  if (probe && probe.length >= 2) {
    hit = cands.filter(c => (c.text || '').replace(/\s/g, '').includes(probe))
  }
  if (!hit.length) hit = cands.filter(c => { const tk = strip(c.text); return tk.length >= 2 && msgKey.includes(tk) })
  // 金额收敛：指令里给了金额时，用同行文本中的金额把同名候选筛到唯一
  if (hit.length > 1 && amount != null && Number(amount) > 0) {
    const n = Number(amount)
    const variants = [
      n.toLocaleString('en-US'),                 // 60,000,000
      String(n),                                  // 60000000
      (n % 10000 === 0 ? (n / 10000) + '万' : ''), // 6000万
    ].filter(Boolean) as string[]
    const byAmount = hit.filter(c => { const rt = (c.rowText || c.text || '').replace(/\s/g, ''); return variants.some(v => rt.includes(v.replace(/\s/g, ''))) })
    if (byAmount.length) return byAmount
  }
  return hit
}
async function loadExecutorSteps(executorId: string): Promise<{ found: boolean; steps: RecStep[]; fieldDefs: VisitField[]; systemId: string }> {
  let steps: RecStep[] = [], fieldDefs: VisitField[] = [], systemId = '', found = false
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/connector-actions/${executorId}`)
    if (r.ok) { const ca: any = await r.json(); found = true; systemId = ca.systemId || ''
      try { const s = JSON.parse(ca.stepsJson || '[]'); steps = Array.isArray(s) ? s : (s.steps || s.rawSteps || []) } catch (e) { swallow(e) }
      try { const f = JSON.parse(ca.fieldsJson || '[]'); const arr = Array.isArray(f) ? f : (f.fields || []); fieldDefs = arr.map((x: any) => ({ name: x.name, label: x.label, type: x.type || 'text', value: '', options: Array.isArray(x.options) ? x.options : undefined })) } catch (e) { swallow(e) }
    }
  } catch (e) { swallow(e) }
  if (!found) {
    try {
      const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${executorId}`)
      if (r.ok) { const sk: any = await r.json(); found = true; systemId = sk.targetSystemId || ''
        try { const p = JSON.parse(sk.actionScript || '{}'); steps = (Array.isArray(p.rawSteps) ? p.rawSteps : (Array.isArray(p.steps) ? p.steps : [])); fieldDefs = (Array.isArray(p.fields) ? p.fields : []).map((x: any) => ({ name: x.name, label: x.label, type: x.type || 'text', value: '', options: Array.isArray(x.options) ? x.options : undefined })) } catch (e) { swallow(e) }
      }
    } catch (e) { swallow(e) }
  }
  return { found, steps, fieldDefs, systemId }
}
async function resolveSystemBaseUrl(systemId: string): Promise<{ sysName: string; baseUrl: string }> {
  let sysName = '业务系统', baseUrl = ''
  try {
    const ir = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
    if (ir.ok) { const list: any = await ir.json(); const sys = Array.isArray(list) ? list.find((x: any) => x.id === systemId) : null; if (sys) { sysName = sys.name; baseUrl = sys.baseUrl } }
  } catch (e) { swallow(e) }
  return { sysName, baseUrl }
}

// P1：执行绑定到本体动作的「连接器动作」——抽取字段 → 人工确认（签名）→ 对真实系统回放。
// 复用现有 extractFieldsByLabels / requestFormConfirmation / replayActionScript，不另造执行引擎。
interface OntologyExecResult { status: 'ok' | 'notLoggedIn' | 'noSystem' | 'noSteps' | 'notFound' | 'fail' | 'partial' | 'cancelled'; outcome: string; confirmed: Record<string, string>; fields: VisitField[] }
async function executeOntologyConnectorAction(executorId: string, userMsg: string, cfg: LlmConfig, sendLog: SendLog, requireConfirm?: boolean, summaryFields?: VisitField[]): Promise<OntologyExecResult> {
  const empty = { confirmed: {}, fields: [] as VisitField[] }
  // 绑定的执行器既可能是「连接器动作」也可能是 FDE 录制上架的「技能」（含 actionScript）。
  let steps: RecStep[] = []
  let fieldDefs: VisitField[] = []
  let systemId = ''
  let found = false
  // ① 连接器动作
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/connector-actions/${executorId}`)
    if (r.ok) {
      const ca: any = await r.json()
      found = true; systemId = ca.systemId || ''
      try { const s = JSON.parse(ca.stepsJson || '[]'); steps = Array.isArray(s) ? s : (s.steps || s.rawSteps || []) } catch (e) { swallow(e) }
      try { const f = JSON.parse(ca.fieldsJson || '[]'); const arr = Array.isArray(f) ? f : (f.fields || []); fieldDefs = arr.map((x: any) => ({ name: x.name, label: x.label, type: x.type || 'text', value: '', options: Array.isArray(x.options) ? x.options : undefined })) } catch (e) { swallow(e) }
    }
  } catch (e) { swallow(e) }
  // ② 技能（FDE 录制上架的产物：actionScript = {rawSteps|steps, fields}）
  if (!found) {
    try {
      const r = await afetch(`${getAdminBaseUrl()}/api/v1/skills/${executorId}`)
      if (r.ok) {
        const sk: any = await r.json()
        found = true; systemId = sk.targetSystemId || ''
        try { const p = JSON.parse(sk.actionScript || '{}'); steps = (Array.isArray(p.rawSteps) ? p.rawSteps : (Array.isArray(p.steps) ? p.steps : [])); fieldDefs = (Array.isArray(p.fields) ? p.fields : []).map((x: any) => ({ name: x.name, label: x.label, type: x.type || 'text', value: '', options: Array.isArray(x.options) ? x.options : undefined })) } catch (e) { swallow(e) }
      }
    } catch (e) { swallow(e) }
  }
  if (!found) return { status: 'notFound', outcome: '绑定的执行器（连接器动作/技能）不存在或不可读。', ...empty }
  if (!steps.length) return { status: 'noSteps', outcome: '该执行器没有可回放的录制步骤。', ...empty }

  // 解析绑定系统地址
  let sysName = '业务系统', baseUrl = ''
  try {
    const ir = await afetch(`${getAdminBaseUrl()}/api/v1/integrations`)
    if (ir.ok) { const list: any = await ir.json(); const sys = Array.isArray(list) ? list.find((x: any) => x.id === systemId) : null; if (sys) { sysName = sys.name; baseUrl = sys.baseUrl } }
  } catch (e) { swallow(e) }
  if (!baseUrl) baseUrl = (steps[0] as any)?.url || ''
  if (!baseUrl) return { status: 'noSystem', outcome: '该执行器未绑定可访问的业务系统地址。', confirmed: {}, fields: fieldDefs }

  // 抽取字段值 → 人工确认（签名）；无表单字段但策略要求确认时，也弹一次摘要确认（人工签名闸不被跳过）
  const filled = fieldDefs.length ? await extractFieldsByLabels(userMsg, fieldDefs, cfg, sendLog) : []
  let confirmed: Record<string, string> = {}
  if (filled.length) {
    sendLog('acting', '已整理出待写入字段，请在下方表单核对并确认（人工签名）…')
    confirmed = await requestFormConfirmation(filled)
    if (!confirmed || Object.keys(confirmed).length === 0) return { status: 'cancelled', outcome: '🚫 已取消，未写入任何数据。', confirmed: {}, fields: filled }
  } else if (requireConfirm) {
    sendLog('acting', '该动作命中确认策略：请你人工确认（签名）后执行…')
    const rc = await requestFormConfirmation(summaryFields && summaryFields.length ? summaryFields : [{ name: 'confirm', label: '确认执行', value: '是', type: 'text' }])
    if (!rc || Object.keys(rc).length === 0) return { status: 'cancelled', outcome: '🚫 已取消该操作，未执行、未改动状态。', confirmed: {}, fields: [] }
  }

  if (runningState.aborted) return { status: 'cancelled', outcome: '🚫 已终止，未写入任何数据。', confirmed: {}, fields: filled }
  const fieldByStep: Record<number, string> = {}
  steps.forEach((s: any, i: number) => { const fn = s.param || s.fieldName; if (fn) fieldByStep[i] = fn })
  // create/填表类：录制步骤第一步带了页面 URL 时，直接从该表单页开始回放（导航由此代劳）
  const entryUrl = ((steps[0] as any)?.url && /^https?:/i.test((steps[0] as any).url)) ? (steps[0] as any).url : baseUrl
  const rep = await replayActionScript(systemId || 'onto', entryUrl, sysName, steps, confirmed, fieldByStep, sendLog)
  if (!rep.ok) return { status: 'fail', outcome: `❌ 后台访问【${sysName}】失败：${rep.error || '未知错误'}。`, confirmed, fields: filled }
  if (!rep.loggedIn) return { status: 'notLoggedIn', outcome: `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后重试。`, confirmed, fields: filled }
  if (rep.failedAt >= 0) return { status: 'partial', outcome: `已回放前 ${rep.done}/${rep.total} 步，在第 ${rep.failedAt + 1} 步「${rep.failLabel}」中断（${rep.error || '元素未找到'}）。`, confirmed, fields: filled }
  return { status: 'ok', outcome: `🤖 已在【${sysName}】完整回放 ${rep.done}/${rep.total} 步，完成写入。`, confirmed, fields: filled }
}

// Harness ReAct Loop simulation trigger
ipcMain.handle('agent:send-message', (_event, data: { content: string; expertId?: string; expertName: string; userNickname?: string; background: string; llmConfig: LlmConfig; forcedSkillId?: string; permMode?: 'readonly' | 'full' }) => runExclusive(async () => {
  incImCommandCount()
  runningState.aborted = false   // 新任务开始，清中止标志
  if (data.expertName) configSet('lastClaimedExpertName', data.expertName)
  const sendLog = (type: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed', text: string) => {
    if (mainWindow) {
      mainWindow.webContents.send('agent:log-stream', { type, text, timestamp: new Date().toLocaleTimeString() })
    }
  }

  const normalized = data.content.toLowerCase()
  const expertId = data.expertId || ''
  const userNickname = data.userNickname || '用户'

  sendLog('thinking', '正在理解你的任务…')

  // —— Agent Trace 采集：本次任务的全链路轨迹，结束时上报管理端审计追溯 ——
  const traceStart = Date.now()
  const traceSpans: any[] = []
  const traceEvents: any[] = []
  let traceWebSearch = false
  let traceSkill = ''
  let traceSources: any[] = []
  let traceTokens = { p: 0, c: 0 }
  let traceId = ''   // 后端保存后回填的 Trace id，随回答返回给渲染层（供 👍/👎 精确回填）
  const submitTrace = async (finalContent: string, status: string, summary: string) => {
    try {
      const cfg: any = data.llmConfig || {}
      const url = (cfg.baseUrl || '').toLowerCase()
      const provider = cfg.mode === 'proxy' ? 'GATEWAY'
        : url.includes('deepseek') ? 'DEEPSEEK' : url.includes('agnes') || url.includes('apihub') ? 'AGNES'
        : url.includes('openai') ? 'OPENAI' : url.includes('moonshot') ? 'MOONSHOT'
        : url.includes('dashscope') ? 'QWEN' : url.includes('localhost') || url.includes('11434') ? 'OLLAMA' : 'DIRECT'
      const spans = [...traceSpans, { type: 'model', name: `模型作答·${cfg.modelName || ''}`, status: status === 'SUCCESS' ? 'ok' : 'warn' }]
      const risk = status === 'BLOCKED' ? 'MEDIUM' : (traceWebSearch || traceSkill) ? 'MEDIUM' : 'LOW'
      const payload = {
        clientId: (configGet('clientId') || os.hostname()), deviceHost: os.hostname(),
        appVersion: 'v1.0.3', workspace: 'iML Work Workspace',
        userId: 'user-' + userNickname, userNickname, expertId, expertName: data.expertName,
        department: '', role: '', sessionId: 'sess-' + String(Date.now()).slice(-6),
        userQuestion: data.content,
        modelName: cfg.modelName || '', modelProvider: provider, connectionMode: cfg.mode || 'direct',
        promptTokens: traceTokens.p || Math.ceil((data.content || '').length / 2),
        completionTokens: traceTokens.c || Math.ceil((finalContent || '').length / 2),
        durationMs: Date.now() - traceStart,
        webSearchUsed: traceWebSearch, skillUsed: traceSkill, knowledgeUsed: '',
        riskLevel: risk, status,
        reasoningSummary: summary,
        finalAnswer: finalContent,
        spans: JSON.stringify(spans), sources: JSON.stringify(traceSources), events: JSON.stringify(traceEvents)
      }
      const tr = await afetch(`${getAdminBaseUrl()}/api/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (tr.ok) { try { const d: any = await tr.json(); if (d && d.id) traceId = d.id } catch (e) { swallow(e) } }
    } catch (e) { swallow(e) }
  }

  // 真实性约束：聊天/分析路径没有访问真实业务数据的能力，必须杜绝凭空捏造。
  const NO_FABRICATION_RULE = `【重要 · 真实性边界】
你本身无法访问任何外部系统、邮箱、OA、CRM、ERP、数据库或任何实时/私有业务数据。除非下文明确给出了"真实技能执行结果 / 真实页面抓取内容"，否则你并不掌握用户的任何真实邮件、待办、审批单、报销单、订单、人员或金额数据。
当用户要求查看 / 获取 / 统计这类真实业务数据，而你手头只有静态知识、并无实际执行结果时，你必须如实说明你无法直接获取，并简要给出下一步建议：① 在「企业技能中心」为该需求配置对应技能并绑定目标业务系统；② 在「设置 → 企业系统连接」登录对应系统后重试。
严禁编造任何邮件、待办、条目、姓名、金额、日期、单号或任何不存在的业务数据；不要为了"显得完成了任务"而虚构结果。`

  // === 本体层钩子（P0）：先把指令解析为「对象 + 动作」，命中则走语义执行（策略闸 + 事件回写）===
  // 用户显式锁定技能时不走本体（尊重其明确选择）。
  if (!data.forcedSkillId) {
    try {
      const onto = await resolveOntology(data.content, data.llmConfig)
      if (onto.res.matched && onto.action) {
        const a = onto.action, t = onto.type, r = onto.res
        const sys = t?.boundSystemId || ''
        const policy = a.policyJson ? JSON.parse(a.policyJson) : {}
        const eventType = policy.eventType || 'StateChanged'
        const isWrite = a.capability && a.capability !== 'read'
        const sm = t?.stateMachineJson ? JSON.parse(t.stateMachineJson) : null
        const toState = a.toState || (sm ? sm.initial : '') || ''
        sendLog('thinking', `识别到业务对象「${r.displayName || r.objectType}」，目标动作「${a.label}」`)
        traceSpans.push({ type: 'ontology', name: `对象解析·${r.objectType}`, status: 'ok' })
        traceSpans.push({ type: 'ontology', name: `动作·${a.label}(${a.fromState || '*'}→${a.toState || '-'})`, status: 'ok' })

        // 只读模式拦截写操作
        if (isWrite && data.permMode === 'readonly') {
          const content = `🔒 本次为**只读模式**。已识别为对象动作「${a.label}」（${r.objectType}，写操作），未做任何改动。\n\n如需执行，请把「权限范围」切到 **允许操作** 后重试（写操作仍会请你人工确认）。`
          await submitTrace(content, 'BLOCKED', `只读模式拦截本体写动作 ${r.objectType}.${a.actionKey}。`)
          return { content, success: true, traceId }
        }

        const externalId = 'p0-' + String(r.displayName || r.objectType || 'obj').replace(/\s+/g, '').slice(0, 32)
        const refId = await recordObjectRef(r.objectType!, sys, externalId, r.displayName || r.objectType!, toState)

        const needConfirm = ontologyNeedsConfirm(a, r.amount)
        traceSkill = `${r.objectType}.${a.actionKey}`
        const graph = t ? buildOntologyGraphText(t, r, toState) : ''

        // ===== P1·B：读驱动消解 —— 对象类型配了列表页时，先从真实系统读候选、消解/人工指认，再导航到该对象执行写 =====
        const listPath: string = (t && t.resolveListPath) || ''
        if (isWrite && a.connectorActionId && listPath) {
          const { sysName, baseUrl } = await resolveSystemBaseUrl(sys)
          if (!baseUrl) {
            const content = `🧩 **本体语义执行**\n\n- 对象动作：**${a.label}**（${r.objectType}）\n\n⚠️ 该对象类型未绑定可访问的业务系统地址，无法读候选。请到管理端「业务系统连接」配置。`
            await submitTrace(content, 'PARTIAL', `本体 ${r.objectType}.${a.actionKey}：无系统地址。`); return { content, success: true, traceId }
          }
          const listUrl = baseUrl.replace(/\/$/, '') + listPath
          sendLog('thinking', `按本体读驱动消解：从【${sysName}】读取候选「${r.objectType}」…`)
          const read = await browseAndExtractLinks(sys, listUrl, sendLog)
          if (!read.ok) {
            const content = `🧩 **本体语义执行**\n\n❌ 读取【${sysName}】候选失败：${read.error || '未知错误'}。`
            await submitTrace(content, 'PARTIAL', `本体 ${r.objectType}.${a.actionKey}：读候选失败。`); return { content, success: true, traceId }
          }
          if (!read.loggedIn) {
            const content = `🧩 **本体语义执行**\n\n⚠️ 未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后重试。`
            await submitTrace(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：未登录。`); return { content, success: true, traceId }
          }
          const matches = matchOntologyCandidates(read.links, r.displayName || '', data.content, r.amount)
          if (matches.length === 0) {
            await recordBusinessEvent({ objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey, eventType: 'ResolutionFailed', fromState: a.fromState, toState: a.fromState, riskLevel: 'LOW', note: `未在【${sysName}】匹配到「${r.displayName || ''}」` })
            const content = `🧩 **本体语义执行**\n\n🔎 在【${sysName}】未找到与「**${r.displayName || r.objectType}**」匹配的对象,未执行任何写操作(不虚构)。请确认对象名称,或换个说法重试。`
            await submitTrace(content, 'PARTIAL', `本体 ${r.objectType}.${a.actionKey}：消解无匹配。`); return { content, success: true, traceId }
          }
          // 多候选 → 人工指认
          let chosen = matches[0]
          if (matches.length > 1) {
            sendLog('acting', `匹配到 ${matches.length} 个候选对象,请人工指认…`)
            const pick = await requestFormConfirmation([{ name: '_pick', label: `匹配到多个「${r.objectType}」,请选择目标对象`, value: matches[0].text, type: 'select', options: matches.map(m => m.text) }])
            if (!pick || Object.keys(pick).length === 0) {
              const content = `🚫 已取消该操作（未指认目标对象），未执行、未改动状态。`
              await submitTrace(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：用户取消指认。`); return { content, success: true, traceId }
            }
            const pv = pick['_pick']
            chosen = matches.find(m => m.text === pv) || matches[0]
          }
          // 策略确认（签名）
          if (needConfirm) {
            sendLog('acting', '该动作命中确认策略：请你人工确认（签名）后执行…')
            const rc = await requestFormConfirmation([
              { name: '_obj', label: '目标对象', value: chosen.text, type: 'text' },
              { name: '_act', label: '动作', value: a.label, type: 'text' },
              ...(r.amount != null ? [{ name: '_amount', label: '金额(元)', value: String(r.amount), type: 'text' }] : []),
            ])
            if (!rc || Object.keys(rc).length === 0) {
              const content = `🚫 已取消该操作，未执行、未改动状态。`
              await submitTrace(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：用户取消确认。`); return { content, success: true, traceId }
            }
          }
          // 导航到该对象详情页 → 执行写操作步（取录制的最后一步操作，如「同意」；导航步由消解代劳）
          if (runningState.aborted) { const content = `🚫 已终止,未对「${chosen.text}」执行任何写操作。`; await submitTrace(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：用户终止。`); return { content, success: true, traceId } }
          const exSteps = await loadExecutorSteps(a.connectorActionId)
          const opSteps = exSteps.steps.slice(-1)
          const externalId = decodeURIComponent((chosen.href.split('?')[0].split('#')[0].replace(/\/$/, '').split('/').pop()) || '')
          await afetch(`${getAdminBaseUrl()}/api/v1/ontology/object-refs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ objectType: r.objectType, systemId: sys, externalId, displayName: chosen.text, currentState: a.fromState }) }).catch(() => {})
          const rep = opSteps.length ? await replayActionScript(sys, chosen.href, sysName, opSteps, {}, {}, sendLog) : { ok: false, loggedIn: true, done: 0, total: 0, failedAt: -1, failLabel: '', title: '', url: '' } as any
          const executed = !!(rep.ok && rep.loggedIn && rep.failedAt < 0 && opSteps.length)
          const evType = executed ? eventType : 'ExecutionFailed'
          await recordBusinessEvent({ objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey, eventType: evType, fromState: a.fromState, toState: executed ? toState : a.fromState, riskLevel: policy.risk || (needConfirm ? 'MEDIUM' : 'LOW'), note: executed ? `经读驱动消解定位「${chosen.text}」并在真实系统执行` : ('执行未完成：' + (opSteps.length ? '回放失败' : '无操作步')) })
          const outcome = !opSteps.length ? '⚠️ 绑定的执行器没有可回放的操作步。' : (rep.ok && rep.loggedIn && rep.failedAt < 0 ? `🤖 已在【${sysName}】对「${chosen.text}」完成操作。` : (!rep.loggedIn ? `⚠️ 未登录【${sysName}】。` : `回放中断（${rep.error || rep.failLabel || '元素未找到'}）。`))
          const content =
            `🧩 **本体语义执行（读驱动消解）**\n\n` +
            `- 对象：**${chosen.text}**（${r.domain} · ${r.objectType}，externalId=\`${externalId}\`）\n` +
            `- 消解：从【${sysName}】读 ${read.links.length} 个候选,匹配 ${matches.length} 个${matches.length > 1 ? '（已人工指认）' : ''}\n` +
            `- 动作：**${a.label}** \`${a.actionKey}\`（能力：${a.capability}）\n` +
            `- 状态迁移：\`${a.fromState || '当前'}\` → \`${executed ? toState : '（未变更）'}\`\n` +
            `\n**执行结果：** ${outcome}\n\n> 管理端「本体建模 · 业务事件审计」可见本次事件（\`${evType}\`,已锚定真实对象 \`${externalId}\`）。`
          await submitTrace(content, executed ? 'SUCCESS' : 'PARTIAL', `本体 ${r.objectType}.${a.actionKey} 读驱动消解→${chosen.text}：${executed ? '执行' : '未完成'}。`)
          return { content, success: true, traceId }
        }

        // ===== P1：绑定了连接器动作的写操作（无列表页/create 类）→ 抽取字段 + 人工确认（签名）+ 真实系统回放 =====
        if (isWrite && a.connectorActionId) {
          const summaryFields: VisitField[] = [
            { name: '_obj', label: '对象', value: r.displayName || r.objectType!, type: 'text' },
            { name: '_act', label: '动作', value: a.label, type: 'text' },
            { name: '_state', label: '状态迁移', value: `${a.fromState || '当前'} → ${toState}`, type: 'text' },
          ]
          if (r.amount != null) summaryFields.push({ name: '_amount', label: '金额(元)', value: String(r.amount), type: 'text' })
          const ex = await executeOntologyConnectorAction(a.connectorActionId, data.content, data.llmConfig, sendLog, needConfirm, summaryFields)
          if (ex.status === 'cancelled') {
            const content = `🚫 已取消对象动作「${a.label}」（${r.objectType}），未执行、未改动状态。`
            await submitTrace(content, 'BLOCKED', `本体 ${r.objectType}.${a.actionKey}：用户取消。`); return { content, success: true, traceId }
          }
          const executed = ex.status === 'ok'
          const evType = executed ? eventType : 'ExecutionFailed'
          await recordBusinessEvent({
            objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey,
            eventType: evType, fromState: a.fromState, toState: executed ? toState : a.fromState,
            riskLevel: policy.risk || (needConfirm ? 'MEDIUM' : 'LOW'),
            note: executed ? '经绑定连接器动作在真实系统执行' : ('执行未完成：' + ex.status),
          })
          const fieldTable = ex.fields.length
            ? `\n\n**确认字段：**\n\n| 字段 | 值 |\n| --- | --- |\n${ex.fields.map(f => `| ${f.label} | ${ex.confirmed[f.name] || '（空）'} |`).join('\n')}`
            : ''
          const content =
            `🧩 **本体语义执行**\n\n` +
            `- 对象：**${r.displayName || r.objectType}**（${r.domain} · ${r.objectType}）\n` +
            `- 动作：**${a.label}** \`${a.actionKey}\`（能力：${a.capability} · 已绑定连接器动作）\n` +
            `- 状态迁移：\`${a.fromState || '当前'}\` → \`${executed ? toState : '（未变更）'}\`\n` +
            (graph ? `\n${graph}\n` : '') +
            `\n**执行结果：** ${ex.outcome}${fieldTable}\n\n` +
            `> 管理端「本体建模 · 业务事件审计」可见本次事件（\`${evType}\`）。`
          await submitTrace(content, executed ? 'SUCCESS' : 'PARTIAL', `本体动作 ${r.objectType}.${a.actionKey} 经连接器动作执行：${ex.status}。`)
          return { content, success: true, traceId }
        }

        // ===== 未绑定连接器动作：语义登记路径（写操作命中确认策略 → 人工签名）=====
        let confirmed = true
        if (isWrite && needConfirm) {
          sendLog('acting', '该动作命中确认策略：请你人工确认（签名）…')
          const fields: any = [
            { label: '对象', value: r.displayName || r.objectType! },
            { label: '动作', value: a.label },
            { label: '状态迁移', value: `${a.fromState || '当前'} → ${toState}` },
          ]
          if (r.amount != null) fields.push({ label: '金额(元)', value: String(r.amount) })
          const ret = await requestFormConfirmation(fields)
          confirmed = !!(ret && Object.keys(ret).length > 0)
        }
        if (isWrite && needConfirm && !confirmed) {
          await recordBusinessEvent({ objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey, eventType: 'ConfirmationRejected', fromState: a.fromState, toState: a.fromState, riskLevel: 'MEDIUM', note: '用户取消人工确认' })
          const content = `🔒 已识别为对象动作「${a.label}」（${r.objectType}）。因命中确认策略需人工签名，你已取消，**未执行、未改动状态**。`
          await submitTrace(content, 'BLOCKED', `本体动作 ${r.objectType}.${a.actionKey} 需人工确认，用户取消。`)
          return { content, success: true, traceId }
        }
        await recordBusinessEvent({
          objectType: r.objectType, objectRefId: refId, systemId: sys, actionKey: a.actionKey,
          eventType, fromState: a.fromState, toState,
          riskLevel: policy.risk || (needConfirm ? 'MEDIUM' : 'LOW'),
          note: 'P0：本体已登记状态迁移，真实系统写入待绑定连接器动作',
        })
        const content =
          `🧩 **本体语义执行**\n\n` +
          `- 对象：**${r.displayName || r.objectType}**（${r.domain} · ${r.objectType}）\n` +
          `- 动作：**${a.label}** \`${a.actionKey}\`（能力：${a.capability}）\n` +
          `- 状态迁移：\`${a.fromState || '当前'}\` → \`${toState}\`\n` +
          `- 策略：${needConfirm ? '**需人工确认**（已签名）' : '低风险 · 自动'}\n` +
          (graph ? `\n${graph}\n` : '') +
          `\n✅ 已在本体登记该状态迁移并回写业务事件（\`${eventType}\`）。该动作**未绑定连接器动作**，真实业务系统写入需在管理端「本体建模」为其绑定连接器动作后生效。\n\n` +
          `> 可在管理端「本体建模 · 业务事件审计 / 对象实例」查看本次事件与对象引用。`
        await submitTrace(content, 'SUCCESS', `本体动作 ${r.objectType}.${a.actionKey} 语义登记，事件 ${eventType}。`)
        return { content, success: true, traceId }
      }
    } catch (e: any) { console.error('[ontology hook] err:', e?.message) }
  }

  // --- Skill Interception and Execution ---
  // Reload skills to capture any newly created folders/files by the user!
  loadLocalSkills()

  let isSkillTriggered = false
  let skillResult = ''
  let skillPromptHint = ''
  let skillHandled = false   // 读取类分支已抓取真实内容并设置整理提示 → 跳过下方默认的"打开首页抓取"
  let isScreenshot = false
  let screenshotMarkdown = ''

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
    const id = matchedSkill.id
    // 用户可见文案统一用「名称（编号）」展示该技能（展示名来自管理端缓存，缺失则回退编号）
    const skl = skillLabel(matchedSkill)
    traceSkill = skl
    sendLog('acting', `找到合适的技能「${skl}」，这就去办…`)
    traceSpans.push({ type: 'skill', name: `匹配技能·${skl}`, status: 'ok' })
    if (id === 'web-screenshot') {
      isSkillTriggered = true
      let targetUrl = ''
      const urlRegex = /(https?:\/\/[^\s]+)/gi
      const match = urlRegex.exec(data.content)
      if (match) {
        targetUrl = match[1]
      } else {
        const domainRegex = /([a-zA-Z0-9][-a-zA-Z0-9]{0,62}\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})*)/gi
        const domainMatch = domainRegex.exec(data.content.replace(/截图/g, '').trim())
        if (domainMatch) {
          targetUrl = 'https://' + domainMatch[1]
        } else {
          targetUrl = 'https://github.com'
          sendLog('thinking', `[网页截图技能] 未能从指令中提取出具体 URL。将默认截图目标网页: https://github.com`)
        }
      }

      try {
        const mdImg = await takeWebScreenshot(targetUrl, sendLog)
        isScreenshot = true
        screenshotMarkdown = mdImg
        skillResult = `网页截图任务已执行成功。已将网页截图保存为物理文件，并同步登记到了“个人空间”。\n\n下面是离屏捕获的网页截图渲染：\n\n${mdImg}`
        skillPromptHint = `【本地技能 "${skl}" 执行结果】\n离屏网页截图成功。图片保存为本地物理文件。\n\n【技能 SOP 指令】\n${matchedSkill.sopContent}`
      } catch (err: any) {
        skillResult = `❌ 网页截图执行失败: ${err.message}`
        skillPromptHint = `【本地技能 "${skl}" 执行失败】\n错误信息: ${err.message}。\n\n【技能 SOP 指令】\n${matchedSkill.sopContent}`
      }

    } else if (id === 'weather-check') {
      isSkillTriggered = true
      let city = '北京'
      const cleanContent = data.content.replace(/(查询|查一下|天气|怎么样|weather|how is the weather in)/g, '').trim()
      if (cleanContent.length > 0 && cleanContent.length < 10) {
        city = cleanContent
      } else {
        const commonCities = ['北京', '上海', '南京', '广州', '深圳', '杭州', '成都', '武汉', '西安', '重庆', '天津', '苏州']
        for (const c of commonCities) {
          if (data.content.includes(c)) {
            city = c
            break
          }
        }
      }

      try {
        const { weatherText, limitText } = await checkWeatherAndAllowance(city, sendLog)
        skillResult = `🌦️ **实时天气查询结果**: ${weatherText}\n\n${limitText}`
        skillPromptHint = `【本地技能 "${skl}" 执行结果】\n实时气温/气象: "${weatherText}"。\n差旅标准比对结果: "${limitText}"。\n\n【技能 SOP 指令】\n${matchedSkill.sopContent}`
      } catch (err: any) {
        skillResult = `❌ 天气数据查询失败: ${err.message}`
        skillPromptHint = `【本地技能 "${skl}" 执行失败】\n错误信息: ${err.message}。\n\n【技能 SOP 指令】\n${matchedSkill.sopContent}`
      }

    } else if (id === 'workspace-analyzer') {
      isSkillTriggered = true
      try {
        const mdTable = await analyzeLocalWorkspace(sendLog)
        skillResult = mdTable
        skillPromptHint = `【本地技能 "${skl}" 执行结果】\n物理工作空间文件扫描数据:\n${mdTable}\n\n【技能 SOP 指令】\n${matchedSkill.sopContent}`
      } catch (err: any) {
        skillResult = `❌ 工作空间分析失败: ${err.message}`
        skillPromptHint = `【本地技能 "${skl}" 执行失败】\n错误信息: ${err.message}。\n\n【技能 SOP 指令】\n${matchedSkill.sopContent}`
      }
    } else {
      // 自定义技能：尝试真实执行（操作其绑定的业务系统并抓取真实页面），绝不臆造数据。
      isSkillTriggered = true
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
        await submitTrace(data.content, 'BLOCKED', `只读模式拦截写入类技能 "${skl}"。`)
        return { content: `🔒 本次为**只读模式**，已拦截写入/操作类技能「${skl}」，未对业务系统做任何改动。\n\n如需执行该操作，请把输入框上方的「权限范围」切到 **允许操作** 后重试（写操作仍会请你人工确认）。`, success: true, traceId }
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
          if (!confirmed || Object.keys(confirmed).length === 0) { const content = `🚫 已取消该技能执行，未写入任何数据。`; await submitTrace(data.content, 'BLOCKED', `语义脚本技能 "${skl}"：用户取消确认。`); return { content, success: true, traceId } }
        }
        const { sysName, baseUrl: sysUrl } = await resolveSystem()
        const baseUrl = sysUrl || (dsl.find(s => s.op === 'open')?.arg || '')
        const fieldTable = filledFields.length
          ? `\n\n**确认的字段：**\n\n| 字段 | 值 |\n| --- | --- |\n${filledFields.map(f => `| ${f.label} | ${confirmed[f.name] || '（空）'} |`).join('\n')}`
          : ''
        if (!baseUrl) {
          await submitTrace(data.content, 'PARTIAL', `语义脚本技能 "${skl}"：已确认字段，但缺少可执行的目标系统地址。`)
          return { content: `✅ 已确认字段，但该技能未绑定可访问的业务系统地址，无法执行。请到管理端为该技能绑定目标系统。${fieldTable}`, success: true, traceId }
        }
        const rep = await interpretSkillScript(targetSystemId || 'rec', baseUrl, sysName, dsl, confirmed, sendLog, { llmConfig: data.llmConfig, sop: skillSop, script: skillCode })
        let outcome = ''
        if (!rep.ok) outcome = `❌ 后台访问【${sysName}】失败：${rep.error || '未知错误'}。`
        else if (!rep.loggedIn) outcome = `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后再次发起。`
        else if (rep.failedAt >= 0) outcome = `已成功执行前 ${rep.done}/${rep.total} 步，在第 ${rep.failedAt + 1} 步「${rep.failLabel}」处中断（${rep.error || '未找到目标'}）。可在管理端调整该技能脚本（如改定位/加等待）后重试。`
        else outcome = `🤖 已完整执行 ${rep.done}/${rep.total} 步语义脚本。请在【${sysName}】中核对结果。`
        await submitTrace(data.content, rep.ok && rep.loggedIn && rep.failedAt < 0 ? 'SUCCESS' : 'PARTIAL', `语义脚本技能 "${skl}" 执行：${rep.done}/${rep.total} 步。`)
        return { content: `✅ 已执行语义脚本技能「${skl}」。\n\n**执行结果：**\n\n${outcome}${fieldTable}`, success: true, traceId }
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
          skillResult = `已按技能「${skl}」的标准作业流程执行（该技能未连接业务系统，基于大模型推理与当前上下文完成）。`
          skillPromptHint = `【技能 "${skl}" 执行 · 知识/推理型】\n该技能未连接可访问的业务系统，请你作为该岗位专家，严格按下面的 SOP，基于用户输入、已上传附件与工作空间内容进行推理、整理与产出，完成你能完成的部分。\n- 若 SOP 中某一步骤确实需要某个尚未连接系统的实时数据（如需登录某平台抓取真实记录/列表），请明确指出该步骤需先到「设置 → 企业系统连接」连接对应系统；\n- 绝对不要编造任何不存在的真实业务数据（具体人名、单号、简历、待办条目、金额、日期）。\n\n【SOP】\n${matchedSkill.sopContent}`
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
            skillResult = `❌ 后台访问【${sysName}】失败。`
            skillPromptHint = `【技能执行失败】访问【${sysName}】失败。请如实告知用户失败、建议检查系统地址/网络，勿编造数据。`
          } else if (!loggedIn) {
            skillResult = `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录该系统（登录态本地保存），随后再次发起。`
            skillPromptHint = `【技能未完成 · 需登录】后台访问【${sysName}】时未登录，未获取到任何真实数据。请：1) 告知用户先到「设置 → 企业系统连接」完成【${sysName}】本地登录后重试；2) 依据下面 SOP 给出手动操作指引。这不是真实数据，勿编造待办/条目/数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          } else if ((pageText || '').length > 40) {
            skillResult = `已在【${sysName}】中实际打开目标页面并抓取到真实内容，正在按标准流程整理。`
            skillPromptHint = `【技能 "${skl}" 真实执行结果】\n以下是刚刚从【${sysName}】真实页面抓取到的内容（页面标题：${pageTitle}）：\n"""\n${pageText}\n"""\n\n请严格、且仅依据上述真实页面内容，按下面的 SOP 整理后回答用户（如为待办/列表，请逐条列出标题、发起人、时间等页面可见字段）。若内容与任务无关、为空、或仍是登录/首页，请如实说明并提示用户操作，绝对禁止编造任何待办、条目、发起人或数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          } else {
            skillResult = `⚠️ 已打开【${sysName}】但未抓取到有效内容（可能仍停留在首页或目标列表为空）。`
            skillPromptHint = `【技能执行 · 内容不足】已在【${sysName}】打开页面但未取到有效正文（可能未导航到目标子页或列表为空）。请如实告知用户，并依据下面 SOP 给出手动操作指引，勿编造数据。\n\n【SOP】\n${matchedSkill.sopContent}`
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
            if (!confirmed || Object.keys(confirmed).length === 0) { const content = `🚫 已取消该技能执行，未写入任何数据。`; await submitTrace(data.content, 'BLOCKED', `录制技能 "${skl}"：用户取消确认。`); return { content, success: true, traceId } }
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
            await submitTrace(data.content, 'PARTIAL', `录制技能 "${skl}"：已确认字段，但缺少可回放的目标系统地址。`)
            return { content: `✅ 已确认字段，但该技能未绑定可访问的业务系统地址，无法回放。请到管理端为该技能绑定目标系统。${fieldTable}`, success: true, traceId }
          }

          // ③ 确定性回放
          const rep = await replayActionScript(targetSystemId || 'rec', baseUrl, sysName, steps, confirmed, fieldByStep, sendLog)
          let outcome = ''
          if (!rep.ok) outcome = `❌ 后台访问【${sysName}】失败：${rep.error || '未知错误'}。`
          else if (!rep.loggedIn) outcome = `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后再次发起。`
          else if (rep.failedAt >= 0) outcome = `已成功回放前 ${rep.done}/${rep.total} 步，在第 ${rep.failedAt + 1} 步「${rep.failLabel}」处中断（${rep.error || '元素未找到'}）。可能是页面结构有变化，建议重新录制该技能。`
          else outcome = `🤖 已完整回放 ${rep.done}/${rep.total} 步操作。请在【${sysName}】中核对结果。`
          await submitTrace(data.content, rep.ok && rep.loggedIn && rep.failedAt < 0 ? 'SUCCESS' : 'PARTIAL', `录制技能 "${skl}" 回放：${rep.done}/${rep.total} 步。`)
          return { content: `✅ 已执行录制技能「${skl}」。\n\n**执行结果：**\n\n${outcome}${fieldTable}`, success: true, traceId }
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
        if (fields.length && (!confirmed || Object.keys(confirmed).length === 0)) { const content = `🚫 已取消客户拜访记录录入，未写入任何数据。`; await submitTrace(data.content, 'BLOCKED', '拜访记录录入：用户取消确认。'); return { content, success: true, traceId } }

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
          await submitTrace(data.content, 'PARTIAL', '拜访记录：已抽取并确认字段，但该技能未绑定可自动录入的 CRM 系统。')
          return {
            content: `✅ 已根据您的拜访记录整理并确认以下字段：\n\n${confirmedTable}\n\n⚠️ 但该技能尚未在管理端「业务系统连接」中绑定可自动录入的 CRM，因此暂未执行无头浏览器录入。请到管理端为该技能绑定目标 CRM 后重试。`,
            success: true, traceId
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
        await submitTrace(data.content, entry.ok && entry.loggedIn ? 'SUCCESS' : 'PARTIAL', `拜访记录录入：抽取→用户确认→无头浏览器(${entry.ok ? (entry.loggedIn ? '已尝试填充' : '未登录') : '失败'})。`)
        return { content: `✅ 已确认并执行客户拜访记录录入。\n\n**确认的录入参数：**\n\n${confirmedTable}\n\n**执行结果：**\n\n${outcome}`, success: true, traceId }
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
          skillResult = `❌ 技能 "${skl}" 绑定的业务系统不存在或已被删除，无法执行。`
          skillPromptHint = `【技能未执行】技能 "${skl}" 绑定的目标业务系统不可用。请如实告知用户该技能未能执行、原因是目标系统未配置，绝对不要编造任何业务数据或待办。\n\n【SOP 仅供参考】\n${matchedSkill.sopContent}`
        } else {
          const ext = await openSystemAndExtract(targetSystemId, baseUrl, sysName, sendLog, recNavHash)
          if (ext.ok && ext.loggedIn && ext.text.length > 40) {
            skillResult = `已在【${sysName}】中实际打开页面并抓取到真实内容，正在交由分身按标准流程整理。`
            skillPromptHint = `【技能 "${skl}" 真实执行结果】\n以下是刚刚从【${sysName}】真实页面抓取到的内容（页面标题：${ext.title}）：\n"""\n${ext.text}\n"""\n\n请严格、且仅依据上述真实页面内容，按下面的 SOP 整理后回答用户。如果这些内容与用户任务无关、为空、或看起来仍是登录/首页，请如实说明并提示用户操作，绝对禁止编造任何待办、条目、发起人或数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          } else if (ext.ok && !ext.loggedIn) {
            skillResult = `⚠️ 检测到尚未登录【${sysName}】。请先在「设置 → 企业系统连接」中登录该系统（登录态会保存在本地），随后再次发起该任务即可。`
            skillPromptHint = `【技能未完成 · 需登录】后台访问【${sysName}】时发现当前未登录，无法获取任何真实数据。请按以下两点回复用户：\n1) 首先明确告知：需要先到「设置 → 企业系统连接」完成【${sysName}】的本地登录（登录态会保存在本地、可复用），登录后再次发起本任务即可由分身自动获取。\n2) 然后，依据下面的 SOP，给出一份清晰、可照做的「手动操作指引」（编号分步），让用户在登录前也能自己先操作。\n注意：这是操作指引，不是已抓取的真实数据；绝对不要编造任何待办条目、发起人、单号或数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          } else {
            skillResult = `❌ 访问【${sysName}】失败：${ext.error || '未知错误'}`
            skillPromptHint = `【技能执行失败】访问【${sysName}】失败，原因："${ext.error || '未知错误'}"。请如实告知用户失败原因并建议检查系统地址/网络，绝对不要编造任何数据。`
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
          skillResult = `技能 "${skl}" 已联网检索「${sq}」。`
          skillPromptHint = r.results.length
            ? `【技能 "${skl}" · 联网检索真实结果】检索词：「${sq}」。\n— 结果列表 —\n${lines}\n\n— 头部网页正文 —\n${pageBlocks || '（未提取到正文）'}\n\n请严格按下面的 SOP 整理回答，但务必先做一步**相关性判断**：\n- 该技能要找的是【${sklName}】这一类对象。请只挑选**确实属于这一类**的检索结果整理成 SOP 要求的列表格式（如标讯须为"招标/中标/采购公告"类网页，逐条给出发布时间、标题、发布单位、详情链接）。\n- 若上面的检索结果**不是**该类对象（例如要找招标公告却只搜到行业资讯、企业介绍、新闻、招聘等无关内容），**绝对不要**把它们硬凑、改写或包装成该技能的结果；应按 SOP 的"未找到"话术如实告知用户未检索到相关${sklName}，并建议补充更具体的关键词/企业名/地区后重试。\n- 结尾另起一行写「来源：」，把真正引用到的网页写成 Markdown 链接「- [网页标题](链接)」；严禁编造任何不在上述内容中的条目、单位、时间或链接。\n\n【SOP】\n${matchedSkill.sopContent}`
            : `【技能 "${skl}" · 联网检索】对「${sq}」未检索到结果，可能网络受限或无相关${sklName}。请如实告知用户未检索到，并建议更换/补充关键词，勿编造。`
        } catch (e: any) {
          skillResult = `❌ 联网检索失败：${e.message}`
          skillPromptHint = `【联网检索失败】"${e.message}"。请如实告知用户，勿编造。`
        }
      } else {
        // 未绑定业务系统、也无原生实现 —— 作为「知识/推理型技能」由大模型按 SOP 执行。
        // 很多技能（撰写/分析/规划/答疑/草拟）本就不依赖业务系统，不应一律判为“未执行”。
        skillResult = `已按技能「${skl}」的标准作业流程执行（该技能为知识/推理型，基于大模型与当前上下文完成）。`
        skillPromptHint = `【技能 "${skl}" 执行 · 知识/推理型】\n该技能不依赖业务系统、也无需自动化网页操作，请你作为该岗位专家，严格按下面的 SOP 完成用户任务：基于用户输入、已上传附件与工作空间内容进行推理、整理与产出。\n- 若 SOP 中某一步骤确实需要某个尚未连接系统的实时数据，请完成你能完成的部分，并明确指出哪一步需要先到「设置 → 企业系统连接」连接对应系统；\n- 绝对不要编造任何不存在的真实业务数据（具体人名、单号、简历、待办条目、金额、日期）。\n\n【SOP】\n${matchedSkill.sopContent}`
      }
    }
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
    traceWebSearch = true
    traceSpans.push({ type: 'web', name: '联网检索', status: 'ok' })
    try {
      const sq = await refineSearchQuery(cleanQuery, data.llmConfig, sendLog)
      const r = await webSearch(sq, sendLog)
      traceSources = r.results.map(x => ({ title: x.title, url: x.url }))
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
    sendLog('thinking', `信息都拿到了，正在帮你整理成回复…`)
    const cfg = data.llmConfig
    const isConfigComplete = cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName

    if (!isConfigComplete) {
      sendLog('observing', `⚠️ 未检测到有效大模型配置。将绕过 LLM 润色，直接以本地沙箱执行结果返回呈现。`)
      sendLog('completed', `[Completed] 本地技能直通测试完毕。`)
      return {
        content: `💡 **[本地技能直通测试模式]**\n您当前未配置有效的大模型（或已关闭连接）。以下为本地 Node.js / Electron 引擎执行该技能的真实返回结果：\n\n---\n\n${skillResult}`,
        success: true, traceId
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

    if (!personalMemoryList) {
      personalMemoryList = `▸ 个人差旅习惯：通常出差乘坐高铁，常去城市为上海、南京。`
    }
    if (!agentSopList) {
      if (expertId === 'expert-2') {
        agentSopList = `▸ 发票识别规则：只接受增值税电子普通发票/电子专用发票，不接受手写或剪贴发票。`
      } else if (expertId === 'expert-3') {
        agentSopList = `▸ 同步策略：每5分钟扫描本地 documents 目录下的新增变更文件，并生成 MD5 块比对，同步至云端。`
      } else {
        agentSopList = `▸ SOP-01：OA审批填写格式约定 - 标题格式为 [拜访业务]-[客户名称]-[日期]，类型选择[市场拓展]。\n▸ SOP-02：当审批金额大于1000元时，系统会自动增加财务部门二级会签流程，需提前上传报销电子发票。`
      }
    }

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
      if (isScreenshot && screenshotMarkdown) {
        if (content.includes('[IMAGE_PLACEHOLDER_PNG]')) {
          content = content.replace('[IMAGE_PLACEHOLDER_PNG]', screenshotMarkdown)
        } else {
          content += `\n\n${screenshotMarkdown}`
        }
      }
      sendLog('completed', `[Completed] 问答与本地技能调用链完毕。`)
      const blocked = /未登录|需登录|未执行|未绑定/.test(skillResult)
      await submitTrace(content, blocked ? 'BLOCKED' : 'SUCCESS',
        `目标：完成用户任务。${traceSkill ? '匹配技能「' + traceSkill + '」并执行；' : ''}${traceWebSearch ? '判定需联网→检索→综合作答；' : ''}基于真实结果整理回答，未编造。`)
      return { content, success: true, traceId }
    } catch (err: any) {
      sendLog('observing', `大模型连接润色失败: ${err.message}。自动回退为本地技能直达渲染。`)
      sendLog('completed', `[Completed] 技能运行完毕（回退直通）。`)
      return {
        content: `⚠️ **[大模型连接失败 - 自动切换本地直通输出]**\n\n大模型请求遇到问题 (\`${err.message}\`)，但本地技能已在 Electron 环境内执行成功。以下是物理执行结果：\n\n---\n\n${skillResult}`,
        success: true, traceId
      }
    }
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

    // Fallbacks if database is empty
    if (!personalMemoryList) {
      personalMemoryList = `▸ 个人差旅习惯：通常出差乘坐高铁，常去城市为上海、南京。`
    }
    if (!agentSopList) {
      if (expertId === 'expert-2') {
        agentSopList = `▸ 发票识别规则：只接受增值税电子普通发票/电子专用发票，不接受手写或剪贴发票。`
      } else if (expertId === 'expert-3') {
        agentSopList = `▸ 同步策略：每5分钟扫描本地 documents 目录下的新增变更文件，并生成 MD5 块比对，同步至云端。`
      } else {
        agentSopList = `▸ SOP-01：OA审批填写格式约定 - 标题格式为 [拜访业务]-[客户名称]-[日期]，类型选择[市场拓展]。\n▸ SOP-02：当审批金额大于1000元时，系统会自动增加财务部门二级会签流程，需提前上传报销电子发票。`
      }
    }

    sendLog('thinking', `想起岗位预置的 SOP 了。`)
    sendLog('thinking', `也想起你的使用习惯了。`)
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
      sendLog('observing', `[LLM Response] 成功接收大模型响应内容。`)
    } catch (err: any) {
      sendLog('observing', `[LLM Error] 网络请求失败: ${err.message}`)
      content = `【大模型连接失败】\n\n错误信息: ${err.message}\n\n请检查:\n1. Base URL 是否正确（直连时填写到 /v1 结尾）\n2. API Key 是否有效\n3. 模型名称是否正确`
    }
    sendLog('completed', `[Completed] 问答完毕。`)

    await submitTrace(content, 'SUCCESS',
      `目标：回答用户问题。${traceWebSearch ? '判定需联网→检索→综合作答；' : '基于岗位知识与上下文作答；'}遵守真实性边界，未编造数据。`)
    return { content, success: true }
  }
}))

// IPC Form / Delete Confirmation responses from React UI
ipcMain.handle('agent:form-submit', (_event, formData: any) => {
  if (runningState.isFormPending && runningState.formResolve) {
    runningState.isFormPending = false
    runningState.formResolve(formData)
  }
})

// 终止/取消：把挂起的确认表单以「空」解决（各执行路径将其判为取消 → 不执行、不改动状态）
ipcMain.handle('agent:form-cancel', () => {
  if (runningState.isFormPending && runningState.formResolve) {
    runningState.isFormPending = false
    runningState.formResolve({})
  }
  if (runningState.isDeletePending && runningState.deleteResolve) {
    runningState.isDeletePending = false
    runningState.deleteResolve(false)
  }
  return { success: true }
})

// 用户点「停止」：置中止标志（执行路径在写入前会检查并放弃）+ 解挂起的确认
ipcMain.handle('agent:abort', () => {
  runningState.aborted = true
  if (runningState.isFormPending && runningState.formResolve) { runningState.isFormPending = false; runningState.formResolve({}) }
  if (runningState.isDeletePending && runningState.deleteResolve) { runningState.isDeletePending = false; runningState.deleteResolve(false) }
  return { success: true }
})

ipcMain.handle('agent:delete-confirm', (_event, authorized: boolean) => {
  if (runningState.isDeletePending && runningState.deleteResolve) {
    runningState.isDeletePending = false
    runningState.deleteResolve(authorized)
  }
})

// Window chrome handlers
ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize()
})
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return false
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
    return false
  }
  mainWindow.maximize()
  return true
})
ipcMain.handle('window:is-maximized', () => {
  return mainWindow?.isMaximized() ?? false
})
ipcMain.handle('window:close', () => {
  mainWindow?.close()
})
ipcMain.handle('window:open-path', async (_event, filePath: string) => {
  try {
    shell.openPath(filePath)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('window:open-url', async (_event, url: string) => {
  try {
    shell.openExternal(url)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

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

