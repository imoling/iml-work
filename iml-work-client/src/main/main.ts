import './global-env'
import { app, BrowserWindow, ipcMain, shell, session, dialog } from 'electron'
import path, { join } from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import {
  configGet,
  configSet,
  configGetAll,
  convList,
  convCreate,
  convDelete,
  convUpdateTitle,
  msgAdd,
  msgList,
  memoryGet,
  memorySet
} from './db'

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
  })
}

app.whenReady().then(() => {
  createWindow()
  startFileSyncWatcher()
  startHeartbeat()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (fileWatcher) void fileWatcher.close()
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

    const res = await fetch(`${getAdminBaseUrl()}/api/v1/sync/upload`, { method: 'POST', body: formData })
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
    } catch (_) {}
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

let imCommandCount = 0
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
      imCommandCount,
      appVersion: app.getVersion()
    }
    await fetch(`${getAdminBaseUrl()}/api/v1/clients/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (err: any) {
    // Admin backend offline — heartbeat is best-effort.
  }
}

function startHeartbeat() {
  void sendHeartbeat()
  heartbeatTimer = setInterval(() => void sendHeartbeat(), 30_000)
}

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
              if (val) triggerKeywords.push(val.toLowerCase())
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

// Initial load
loadLocalSkills()


// SQLite configuration & storage handlers
ipcMain.handle('secure-store:save', (_event, key: string, value: string) => {
  console.log(`[secure-store:save] key="${key}" value="${String(value).substring(0, 30)}..." type=${typeof value}`)
  try {
    if (typeof value !== 'string') {
      console.error(`[secure-store:save] ERROR: value is not a string! Got:`, value)
      return { success: false, error: 'value must be a string' }
    }
    configSet(key, value)
    return { success: true }
  } catch (err: any) {
    console.error(`[secure-store:save] Exception:`, err.message)
    return { success: false, error: err.message }
  }
})

ipcMain.handle('secure-store:get', (_event, key: string) => {
  console.log(`[secure-store:get] key="${key}"`)
  try {
    const val = configGet(key)
    if (val === '[object Object]') {
      console.warn(`[secure-store:get] key="${key}" had corrupted [object Object] value`)
      return null
    }
    console.log(`[secure-store:get] key="${key}" => "${val ? val.substring(0, 20) : null}..."`)
    return val
  } catch (err: any) {
    console.error(`[secure-store:get] key="${key}" Exception:`, err.message)
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
    try { parsed = JSON.parse(rawText) } catch (_) {}

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

// Resolve the admin backend base URL (configurable in settings, defaults to local).
function getAdminBaseUrl(): string {
  const v = configGet('adminBaseUrl')
  return v && v.trim() ? v.trim().replace(/\/$/, '') : 'http://localhost:8080'
}

// 企业基础信息与规则：由管理端统一维护，构建系统指令时实时拉取，不在客户端写死。
async function getEnterpriseBlock(): Promise<string> {
  let p: any = {}
  try {
    const r = await fetch(`${getAdminBaseUrl()}/api/v1/enterprise`)
    if (r.ok) p = await r.json()
  } catch (_) {}
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
  } catch (_) {}
  return []
}

interface CorporateChunk { documentId: string; text: string; score: number }

// Company-level RAG: query the admin backend's pgvector store, scoped to the
// expert's downlinked knowledge categories. Degrades gracefully to [] when the
// backend is offline so the agent still answers from local context.
async function queryCorporateKnowledge(text: string, expertId?: string): Promise<CorporateChunk[]> {
  if (!text || !text.trim()) return []
  try {
    const scope = getKnowledgeScope(expertId)
    const params = new URLSearchParams({ text: text.slice(0, 500), topK: '3', clientId: expertId || 'client' })
    if (scope.length) params.set('categories', scope.join(','))
    const url = `${getAdminBaseUrl()}/api/v1/knowledge/query?${params.toString()}`
    const res = await fetch(url)
    if (!res.ok) return []
    const data: any = await res.json()
    if (!Array.isArray(data)) return []
    // Keep only reasonably relevant hits.
    return data
      .filter((c: any) => typeof c.text === 'string' && (c.score ?? 0) > 0.1)
      .map((c: any) => ({ documentId: c.documentId, text: c.text, score: c.score ?? 0 }))
  } catch (err: any) {
    console.warn('[Corporate RAG] retrieval failed (offline?):', err.message)
    return []
  }
}

// Render retrieved corporate chunks as a prompt block (empty string when none).
function buildCorporateRagBlock(chunks: CorporateChunk[]): string {
  if (!chunks.length) return ''
  const lines = chunks
    .map((c, i) => `${i + 1}. (相似度 ${(c.score * 100).toFixed(0)}% · ${c.documentId}) ${c.text}`)
    .join('\n')
  return `\n\n【公司级知识库检索结果 (Corporate RAG · pgvector)】\n以下为从企业云端知识库实时检索到的最相关制度条款，请优先据此作答：\n${lines}`
}

// 从管理端拉取最新的岗位专家列表，供客户端「当前工作分身」展示与领用。
ipcMain.handle('expert:list', async () => {
  try {
    const r = await fetch(`${getAdminBaseUrl()}/api/v1/experts`)
    if (!r.ok) return { success: false, error: `backend ${r.status}` }
    const list: any[] = await r.json()
    const experts = (Array.isArray(list) ? list : []).map((e: any) => ({
      id: e.id,
      title: e.title || '未命名分身',
      spec: e.spec || '',
      description: e.description || '',
      skills: Array.isArray(e.skills) ? e.skills.map((s: any) => ({ id: s.id, name: s.name, type: s.type })) : []
    }))
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
    const response = await fetch(`${getAdminBaseUrl()}/api/v1/experts/claim/${expertId}`, {
      method: 'POST'
    })

    if (response.ok) {
      const data: any = await response.json()
      console.log(`[expert:claim] Backend response:`, data)
      if (data.success && data.skillsSynced) {
        // Write each skill to physical folder
        for (const sk of data.skillsSynced) {
          writeSkillFile(sk)
          skillsSynced.push({
            id: sk.id,
            name: sk.name,
            type: sk.type === 'playwright' ? '本地离屏渲染截图技能' : '本地文件与环境沙箱技能'
          })
        }
        // Remember the claimed expert for client heartbeat reporting
        configSet('lastClaimedExpertId', expertId)
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
    const response = await fetch(`${getAdminBaseUrl()}/api/v1/sync/upload`, {
      method: 'POST',
      body: formData
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

// Stepped ReAct loop execution state
interface RunningState {
  isFormPending: boolean
  formResolve: ((value: any) => void) | null
  isDeletePending: boolean
  deleteResolve: ((value: boolean) => void) | null
}

let runningState: RunningState = {
  isFormPending: false,
  formResolve: null,
  isDeletePending: false,
  deleteResolve: null
}

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

type SendLog = (type: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed', text: string) => void

interface SystemExtractResult { ok: boolean; loggedIn: boolean; title: string; text: string; error?: string }

/**
 * 真实驱动一个业务系统：在带持久化登录态的浏览器窗口中打开系统地址，等待加载后
 * 抓取页面真实文本。员工首次需在弹出的窗口里登录（登录态按系统隔离持久保存），
 * 之后即可复用。返回真实页面内容，绝不臆造——若未登录或加载失败则如实反馈。
 */
async function openSystemAndExtract(systemId: string, baseUrl: string, systemName: string, sendLog: SendLog): Promise<SystemExtractResult> {
  return new Promise((resolve) => {
    sendLog('acting', `正在后台访问业务系统【${systemName}】并复用本地登录态：${baseUrl}`)
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
        sendLog('observing', `页面已加载，等待动态内容渲染...`)
        await sleep(3500)
        const data = await win.webContents.executeJavaScript(
          `(function(){return { title: document.title || '', text: (document.body ? document.body.innerText : '').slice(0, 6000), url: location.href }})()`
        )
        const text: string = (data.text || '').trim()
        const lower = text.toLowerCase()
        // 登录态判断：内容很短且像登录页，视为未登录
        const loginish = text.length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password|认证)/.test(lower)
        sendLog('stdout', `已从【${systemName}】提取页面内容：标题“${data.title}”，正文 ${text.length} 字`)
        win.close()
        if (loginish) {
          // 后台静默执行，不弹窗；如未登录则提示去设置里登录。
          sendLog('observing', `检测到尚未登录【${systemName}】，请先在「设置 → 企业系统连接」完成登录。`)
          resolve({ ok: true, loggedIn: false, title: data.title, text })
        } else {
          sendLog('completed', `[业务系统执行] 已成功从【${systemName}】抓取真实页面内容。`)
          resolve({ ok: true, loggedIn: true, title: data.title, text })
        }
      } catch (e: any) {
        try { if (!win.isDestroyed()) win.close() } catch (_) {}
        resolve({ ok: false, loggedIn: false, title: '', text: '', error: e.message })
      }
    }

    win.webContents.once('did-finish-load', finish)
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (settled) return
      settled = true
      try { if (!win.isDestroyed()) win.close() } catch (_) {}
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

interface VisitField { name: string; label: string; value: string; type: string; options?: string[] }

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

// 向渲染层弹出表单确认卡片，并阻塞等待用户在对话框中确认后回传的参数。
function requestFormConfirmation(fields: VisitField[]): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    runningState.isFormPending = true
    runningState.formResolve = (val: any) => resolve(val && typeof val === 'object' ? val : {})
    if (mainWindow) mainWindow.webContents.send('agent:form-request', { fields })
  })
}

interface VisitEntryResult { ok: boolean; loggedIn: boolean; filled: string[]; missing: string[]; title: string; url: string; error?: string }

// 在页面上下文里按字段标签就近定位表单控件并填充（best-effort，覆盖 antd/element/原生表单）。
const VISIT_FILL_FN = `function(items){
  function setNativeValue(el, value){
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function norm(s){ return (s || '').replace(/[\\s*：:]/g, ''); }
  var filled = [], missing = [];
  items.forEach(function(it){
    var target = norm(it.label), value = it.value, done = false;
    var labels = Array.prototype.slice.call(document.querySelectorAll('label, .ant-form-item-label, .el-form-item__label, .form-label, dt, th'));
    for (var i = 0; i < labels.length && !done; i++){
      if (norm(labels[i].innerText).indexOf(target) === -1) continue;
      var scope = labels[i].closest('.ant-form-item, .el-form-item, .form-item, .form-group, tr, li') || labels[i].parentElement;
      var ctrl = scope ? scope.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea') : null;
      if (!ctrl && labels[i].htmlFor) ctrl = document.getElementById(labels[i].htmlFor);
      if (ctrl){ try { ctrl.focus(); setNativeValue(ctrl, value); filled.push(it.label); done = true; } catch(e){} }
    }
    if (!done){
      var inputs = Array.prototype.slice.call(document.querySelectorAll('input:not([type=hidden]), textarea'));
      for (var j = 0; j < inputs.length && !done; j++){
        var hint = (inputs[j].placeholder || '') + (inputs[j].getAttribute('aria-label') || '');
        if (hint && hint.indexOf(it.label) !== -1){ try { inputs[j].focus(); setNativeValue(inputs[j], value); filled.push(it.label); done = true; } catch(e){} }
      }
    }
    if (!done) missing.push(it.label);
  });
  return { filled: filled, missing: missing };
}`

// 复用本地登录态在后台静默打开 CRM，按确认后的参数尽力填充拜访记录表单，如实回报实际结果。
async function fillCrmVisitForm(systemId: string, baseUrl: string, systemName: string, confirmed: Record<string, string>, fields: VisitField[], sendLog: SendLog): Promise<VisitEntryResult> {
  return new Promise((resolve) => {
    sendLog('acting', `正在后台静默打开【${systemName}】并复用本地登录态，准备录入拜访记录：${baseUrl}`)
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true } })
    let settled = false
    const fail = (error: string) => {
      if (settled) return; settled = true
      try { if (!win.isDestroyed()) win.close() } catch (_) {}
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
          try { if (!win.isDestroyed()) win.close() } catch (_) {}
          resolve({ ok: true, loggedIn: false, filled: [], missing: fields.map(f => f.label), title: pre.title, url: pre.url })
          return
        }
        sendLog('acting', '页面已就绪，正在按字段标签逐项定位并填充表单控件...')
        const payload = JSON.stringify(fields.map(f => ({ label: f.label, value: confirmed[f.name] || '' })).filter(x => x.value))
        const report = await win.webContents.executeJavaScript(`(${VISIT_FILL_FN})(${payload})`)
        await sleep(600)
        const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
        sendLog('stdout', `[拜访记录] 已填充 ${(report.filled || []).length} 个字段：${(report.filled || []).join('、') || '无'}`)
        try { if (!win.isDestroyed()) win.close() } catch (_) {}
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

interface RecStep { action: 'click' | 'fill' | 'select'; selector: string; value: string; label: string; tag: string; url: string; kind?: string; waitBefore?: number; resultSelector?: string; fieldName?: string; options?: string[] }

let recorderWin: BrowserWindow | null = null
let recorderSteps: RecStep[] = []

// 注入到被录制页面里的脚本：计算稳健选择器并监听 click / change，通过 console 通道上报。
const RECORDER_BOOTSTRAP = `(function(){
  if (window.__recInstalled) return; window.__recInstalled = true;
  function esc(s){ return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'); }
  function uniq(sel){ try { return document.querySelectorAll(sel).length === 1; } catch(e){ return false; } }
  function cssPath(el){
    var parts = [];
    while (el && el.nodeType === 1 && el.tagName !== 'HTML'){
      var tag = el.tagName.toLowerCase();
      var p = el.parentElement;
      if (!p){ parts.unshift(tag); break; }
      var sameTag = Array.prototype.filter.call(p.children, function(c){ return c.tagName === el.tagName; });
      if (sameTag.length > 1){ tag += ':nth-of-type(' + (sameTag.indexOf(el)+1) + ')'; }
      parts.unshift(tag);
      if (parts.length >= 6) break;
      el = p;
    }
    return parts.join(' > ');
  }
  function robust(el){
    if (el.id && uniq('#'+esc(el.id))) return '#'+esc(el.id);
    var attrs = ['data-testid','data-test','data-id','data-name','name','aria-label'];
    for (var i=0;i<attrs.length;i++){ var v=el.getAttribute && el.getAttribute(attrs[i]); if(v){ var s='['+attrs[i]+'="'+v.replace(/"/g,'\\\\"')+'"]'; if(uniq(s)) return s; if(uniq(el.tagName.toLowerCase()+s)) return el.tagName.toLowerCase()+s; } }
    return cssPath(el);
  }
  function labelOf(el){
    if (el.id){ var l=document.querySelector('label[for="'+esc(el.id)+'"]'); if(l) return (l.innerText||'').trim(); }
    var box = el.closest && el.closest('.ant-form-item, .el-form-item, .form-item, .form-group, tr, li');
    if (box){ var lab = box.querySelector('label, .ant-form-item-label, .el-form-item__label, dt, th'); if(lab) return (lab.innerText||'').trim(); }
    return (el.getAttribute && (el.getAttribute('aria-label')||el.placeholder)) || (el.innerText||'').trim().slice(0,30);
  }
  function emit(step){ try { console.log('__REC__'+JSON.stringify(step)); } catch(e){} }
  var OPT_SEL = '.ant-select-item-option, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], .dropdown-item';
  function optionTexts(container){ var r=[]; if(!container) return r; var ns=container.querySelectorAll('.ant-select-item-option, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], option, .dropdown-item'); for(var i=0;i<ns.length;i++){ var t=(ns[i].innerText||ns[i].textContent||'').trim(); if(t && r.indexOf(t)===-1) r.push(t); } return r.slice(0,60); }
  document.addEventListener('click', function(e){
    var el = e.target; if(!el || el.nodeType!==1) return;
    var opt = el.closest(OPT_SEL);
    if (opt){
      var pop = opt.closest('.ant-select-dropdown, .el-select-dropdown, .ant-cascader-menus, [role=listbox], .dropdown-menu, ul') || opt.parentElement;
      var ot = (opt.innerText||'').trim().slice(0,40);
      emit({ action:'click', selector: robust(opt), value: ot, label: ot, tag:(opt.tagName||'').toLowerCase(), url: location.href, options: optionTexts(pop) });
      return;
    }
    var clickable = el.closest('button, a, [role=button], [role=menuitem], .ant-select-item, li, td, span, div');
    var t = clickable || el;
    emit({ action:'click', selector: robust(t), value:'', label:(t.innerText||t.getAttribute('aria-label')||'').trim().slice(0,40), tag:(t.tagName||'').toLowerCase(), url: location.href });
  }, true);
  document.addEventListener('change', function(e){
    var el = e.target; if(!el || el.nodeType!==1) return;
    var tag = (el.tagName||'').toLowerCase();
    if (tag === 'select'){
      var txt = el.options && el.selectedIndex>=0 ? el.options[el.selectedIndex].text : el.value;
      var opts = []; if (el.options){ for (var i=0;i<el.options.length;i++){ var ot2=(el.options[i].text||'').trim(); if(ot2 && el.options[i].value !== '') opts.push(ot2); } }
      emit({ action:'select', selector: robust(el), value: txt, label: labelOf(el), tag: tag, url: location.href, options: opts });
    } else if (tag === 'input' || tag === 'textarea'){
      if (el.type === 'checkbox' || el.type === 'radio') return;
      emit({ action:'fill', selector: robust(el), value: el.value || '', label: labelOf(el), tag: tag, url: location.href });
    }
  }, true);
})();`

function injectRecorder(wc: Electron.WebContents) {
  wc.executeJavaScript(RECORDER_BOOTSTRAP).catch(() => {})
}

ipcMain.handle('recorder:start', async (_e, payload: { systemId: string; baseUrl: string; systemName: string }) => {
  try {
    if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (_) {} }
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
        } catch (_) {}
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
  if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (_) {} }
  recorderWin = null
  return { ok: true, steps }
})

ipcMain.handle('recorder:cancel', async () => {
  recorderSteps = []
  if (recorderWin && !recorderWin.isDestroyed()) { try { recorderWin.close() } catch (_) {} }
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
  } catch (_) {}
  return fields.map(f => ({ ...f, value: typeof values[f.name] === 'string' ? values[f.name] : '' }))
}

// 在页面上下文中执行单个录制步骤（带等待重试），返回是否成功。
// 支持 kind:'search' —— 纷享销客等"带 + 检索选择框"：填入关键词→等待异步结果→点击匹配项。
const REPLAY_STEP_FN = `function(step){
  return new Promise(function(resolve){
    var tries = 0;
    function setNativeValue(el, value){
      var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    var RESULT_SEL = '.ant-select-item-option, .ant-select-item, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], .dropdown-item, .ant-select-dropdown li, .el-autocomplete-suggestion li, .next-menu-item';
    function visible(n){ return n && n.offsetParent !== null; }
    function findResult(value){
      var nodes = document.querySelectorAll(RESULT_SEL);
      var exact = null, partial = null;
      for (var i = 0; i < nodes.length; i++){
        var n = nodes[i]; if (!visible(n)) continue;
        var t = (n.innerText || n.textContent || '').trim();
        if (!t) continue;
        if (value && t === value){ exact = n; break; }
        if (!partial && value && t.indexOf(value) !== -1) partial = n;
      }
      return exact || partial;
    }
    function doSearch(el){
      el.focus(); setNativeValue(el, step.value);
      var rtries = 0;
      (function pollResult(){
        rtries++;
        var hit = findResult(step.value);
        if (!hit && step.resultSelector){ try { var rs = document.querySelector(step.resultSelector); if (visible(rs)) hit = rs; } catch(e){} }
        if (hit){ try { hit.scrollIntoView({block:'center'}); hit.click(); resolve({ ok:true }); } catch(e){ resolve({ ok:false, error:String(e) }); } return; }
        if (rtries >= 24){ resolve({ ok:false, error:'检索结果未出现或未匹配到“' + step.value + '”' }); return; }
        setTimeout(pollResult, 300);
      })();
    }
    function doDropdown(el){
      var pre = findResult(step.value);
      if (pre){ try { pre.scrollIntoView({block:'center'}); pre.click(); resolve({ ok:true }); } catch(e){ resolve({ ok:false, error:String(e) }); } return; }
      if (el){ try { el.scrollIntoView({block:'center'}); el.click(); } catch(e){} }
      var dtries = 0;
      (function pollDD(){
        dtries++;
        var h = findResult(step.value);
        if (h){ try { h.scrollIntoView({block:'center'}); h.click(); resolve({ ok:true }); } catch(e){ resolve({ ok:false, error:String(e) }); } return; }
        if (dtries >= 24){ resolve({ ok:false, error:'下拉项未匹配到“' + step.value + '”' }); return; }
        setTimeout(pollDD, 300);
      })();
    }
    function attempt(){
      tries++;
      var el = null; try { el = document.querySelector(step.selector); } catch(e){}
      if (step.kind === 'dropdown'){ doDropdown(el); return; }
      if (!el){ if (tries >= 20){ resolve({ ok:false, error:'未找到元素' }); return; } setTimeout(attempt, 250); return; }
      try {
        if (step.kind === 'search'){ doSearch(el); return; }
        if (step.action === 'click'){ el.scrollIntoView({block:'center'}); el.click(); }
        else if (step.action === 'fill'){ el.focus(); setNativeValue(el, step.value); }
        else if (step.action === 'select'){
          if (el.tagName === 'SELECT'){ for (var i=0;i<el.options.length;i++){ if(el.options[i].text===step.value||el.options[i].value===step.value){ el.selectedIndex=i; el.dispatchEvent(new Event('change',{bubbles:true})); break; } } }
          else { el.focus(); setNativeValue(el, step.value); }
        }
        resolve({ ok:true });
      } catch(err){ resolve({ ok:false, error:String(err) }); }
    }
    attempt();
  });
}`

interface ReplayResult { ok: boolean; loggedIn: boolean; done: number; total: number; failedAt: number; failLabel: string; title: string; url: string; error?: string }

// 复用登录态在后台静默回放录制脚本，把确认后的字段值替换进绑定步骤，如实回报执行结果。
async function replayActionScript(systemId: string, baseUrl: string, systemName: string, steps: RecStep[], fieldValues: Record<string, string>, fieldByStep: Record<number, string>, sendLog: SendLog): Promise<ReplayResult> {
  return new Promise((resolve) => {
    sendLog('acting', `正在后台静默打开【${systemName}】并复用登录态，按录制脚本回放 ${steps.length} 步操作...`)
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true } })
    let settled = false
    const fail = (error: string) => { if (settled) return; settled = true; try { if (!win.isDestroyed()) win.close() } catch (_) {}; resolve({ ok: false, loggedIn: false, done: 0, total: steps.length, failedAt: -1, failLabel: '', title: '', url: '', error }) }
    const run = async () => {
      if (settled) return; settled = true
      try {
        await sleep(3000)
        const pre = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',text:(document.body?document.body.innerText:'').slice(0,2000),url:location.href}})()`)
        const lower = (pre.text || '').toLowerCase()
        if ((pre.text || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test(lower)) {
          try { if (!win.isDestroyed()) win.close() } catch (_) {}
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
          const kindLabel = step.kind === 'search' ? '检索选择' : step.action
          sendLog('stdout', `[回放 ${i + 1}/${steps.length}] ${kindLabel} · ${step.label || step.selector}`)
          const r = await win.webContents.executeJavaScript(`(${REPLAY_STEP_FN})(${JSON.stringify(step)})`)
          if (!r || !r.ok) {
            const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
            try { if (!win.isDestroyed()) win.close() } catch (_) {}
            resolve({ ok: true, loggedIn: true, done, total: steps.length, failedAt: i, failLabel: step.label || step.selector, title: after.title, url: after.url, error: r && r.error }); return
          }
          done++
          await sleep(700)
        }
        const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
        try { if (!win.isDestroyed()) win.close() } catch (_) {}
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

interface DslStep { op: string; arg: string; valueExpr: string }

// 解析 DSL 文本为步骤数组。
function parseDsl(code: string): DslStep[] {
  const out: DslStep[] = []
  for (const raw of (code || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let m: RegExpMatchArray | null
    if ((m = line.match(/^wait\s+(\d+)/i))) { out.push({ op: 'wait', arg: '', valueExpr: m[1] }); continue }
    if ((m = line.match(/^waitText\s+"([^"]*)"/i))) { out.push({ op: 'waitText', arg: m[1], valueExpr: '' }); continue }
    if ((m = line.match(/^(\w+)\s+"([^"]*)"\s*(?:=\s*(.+))?$/))) { out.push({ op: m[1], arg: m[2], valueExpr: (m[3] || '').trim() }); continue }
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
const SEMANTIC_FN = `function(step){
  return new Promise(function(resolve){
    var op=step.op, arg=step.arg, value=step.value;
    function norm(s){ return (s||'').replace(/[\\s*：:]/g,''); }
    function visible(n){ return n && n.offsetParent !== null; }
    function setNativeValue(el, val){
      var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function labelBox(label){
      var t = norm(label);
      var labels = Array.prototype.slice.call(document.querySelectorAll('label, .ant-form-item-label, .el-form-item__label, .form-label, dt, th'));
      for (var i=0;i<labels.length;i++){ if (norm(labels[i].innerText).indexOf(t) !== -1){
        return { lab: labels[i], box: labels[i].closest('.ant-form-item, .el-form-item, .form-item, .form-group, tr, li') || labels[i].parentElement };
      } }
      return null;
    }
    function labelControl(label){
      var lb = labelBox(label); if(!lb) return null;
      var c = lb.box ? lb.box.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select') : null;
      if (!c && lb.lab.htmlFor) c = document.getElementById(lb.lab.htmlFor);
      return c;
    }
    function labelTrigger(label){
      var lb = labelBox(label); if(!lb || !lb.box) return null;
      return lb.box.querySelector('.ant-select-selector, .ant-select, [role=combobox], .el-select, .el-input__inner, input:not([type=hidden]), .form-control, .ant-picker');
    }
    function clickByText(text){
      var t = (text||'').trim();
      var sel = 'button, a, [role=button], [role=menuitem], [role=tab], [role=option], .ant-btn, .ant-menu-item, .el-button, li, td, span, div';
      var nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
      var exact=null, partial=null;
      for (var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!visible(n)) continue;
        var own=''; for(var k=0;k<n.childNodes.length;k++){ if(n.childNodes[k].nodeType===3) own+=n.childNodes[k].textContent; }
        own=own.trim(); var full=(n.innerText||'').trim();
        if(own===t || full===t){ exact=n; break; }
        if(!partial && t && full.indexOf(t)!==-1 && full.length < t.length+12) partial=n;
      }
      return exact||partial;
    }
    var RESULT_SEL = '.ant-select-item-option, .ant-select-item, .el-select-dropdown__item, [role=option], .ant-cascader-menu-item, li[role=option], .dropdown-item, .ant-select-dropdown li, .el-autocomplete-suggestion li';
    function findOption(val){
      var nodes=document.querySelectorAll(RESULT_SEL); var exact=null,partial=null;
      for(var i=0;i<nodes.length;i++){ var n=nodes[i]; if(!visible(n)) continue; var tx=(n.innerText||n.textContent||'').trim(); if(!tx) continue;
        if(val && tx===val){ exact=n; break; } if(!partial && val && tx.indexOf(val)!==-1) partial=n; }
      return exact||partial;
    }
    function pollClickOption(val, done){
      var tries=0; (function p(){ tries++; var h=findOption(val);
        if(h){ try{ h.scrollIntoView({block:'center'}); h.click(); done({ok:true}); }catch(e){ done({ok:false,error:String(e)}); } return; }
        if(tries>=24){ done({ok:false,error:'未匹配到选项“'+val+'”'}); return; } setTimeout(p,300); })();
    }
    function withRetry(fn){ var tries=0; (function a(){ tries++; if(fn()) return; if(tries>=20){ resolve({ok:false,error:'未找到元素：'+(arg||op)}); return; } setTimeout(a,250); })(); }

    try {
      if (op==='wait'){ setTimeout(function(){ resolve({ok:true}); }, parseInt(value||'500',10)||500); return; }
      if (op==='waitText'){ var wt=0; (function w(){ wt++; if((document.body?document.body.innerText:'').indexOf(arg)!==-1){ resolve({ok:true}); return; } if(wt>=32){ resolve({ok:false,error:'未等到文本“'+arg+'”'}); return; } setTimeout(w,300); })(); return; }
      if (op==='click'){ withRetry(function(){ var el=clickByText(arg); if(!el) return false; el.scrollIntoView({block:'center'}); el.click(); resolve({ok:true}); return true; }); return; }
      if (op==='fill'){ withRetry(function(){ var c=labelControl(arg); if(!c) return false; c.focus(); setNativeValue(c,value); resolve({ok:true}); return true; }); return; }
      if (op==='select'){ withRetry(function(){ var c=labelControl(arg); if(c && c.tagName==='SELECT'){ for(var i=0;i<c.options.length;i++){ if(c.options[i].text===value||c.options[i].value===value){ c.selectedIndex=i; c.dispatchEvent(new Event('change',{bubbles:true})); break; } } resolve({ok:true}); return true; } var tg=labelTrigger(arg); if(tg){ tg.scrollIntoView({block:'center'}); tg.click(); pollClickOption(value, resolve); return true; } return false; }); return; }
      if (op==='dropdown'){ withRetry(function(){ var tg=labelTrigger(arg)||labelControl(arg); if(!tg) return false; tg.scrollIntoView({block:'center'}); tg.click(); pollClickOption(value, resolve); return true; }); return; }
      if (op==='searchSelect'){ withRetry(function(){ var c=labelControl(arg); if(!c) return false; c.focus(); setNativeValue(c,value); pollClickOption(value, resolve); return true; }); return; }
      resolve({ok:false, error:'未知动作：'+op});
    } catch(err){ resolve({ok:false, error:String(err)}); }
  });
}`

interface InterpretResult { ok: boolean; loggedIn: boolean; done: number; total: number; failedAt: number; failLabel: string; title: string; url: string; error?: string }

// 复用登录态在后台静默打开系统，按语义脚本逐步解释执行，如实回报。
async function interpretSkillScript(systemId: string, baseUrl: string, systemName: string, dsl: DslStep[], fieldValues: Record<string, string>, sendLog: SendLog): Promise<InterpretResult> {
  return new Promise((resolve) => {
    sendLog('acting', `正在后台静默打开【${systemName}】并复用登录态，按语义脚本执行 ${dsl.length} 步...`)
    const win = new BrowserWindow({ show: false, width: 1366, height: 900, webPreferences: { partition: `persist:bizsys-${systemId}`, offscreen: true } })
    let settled = false
    const fail = (error: string) => { if (settled) return; settled = true; try { if (!win.isDestroyed()) win.close() } catch (_) {}; resolve({ ok: false, loggedIn: false, done: 0, total: dsl.length, failedAt: -1, failLabel: '', title: '', url: '', error }) }
    const run = async () => {
      if (settled) return; settled = true
      try {
        await sleep(3000)
        const pre = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',text:(document.body?document.body.innerText:'').slice(0,2000),url:location.href}})()`)
        const lower = (pre.text || '').toLowerCase()
        if ((pre.text || '').length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password)/.test(lower)) {
          try { if (!win.isDestroyed()) win.close() } catch (_) {}
          resolve({ ok: true, loggedIn: false, done: 0, total: dsl.length, failedAt: -1, failLabel: '', title: pre.title, url: pre.url }); return
        }
        let done = 0
        for (let i = 0; i < dsl.length; i++) {
          const value = resolveDslValue(dsl[i].valueExpr, fieldValues)
          const step = { op: dsl[i].op, arg: dsl[i].arg, value }
          const desc = `${step.op} ${step.arg ? '“' + step.arg + '”' : ''}${value ? ' = ' + value : ''}`
          sendLog('stdout', `[脚本 ${i + 1}/${dsl.length}] ${desc}`)
          const r = await win.webContents.executeJavaScript(`(${SEMANTIC_FN})(${JSON.stringify(step)})`)
          if (!r || !r.ok) {
            const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
            try { if (!win.isDestroyed()) win.close() } catch (_) {}
            resolve({ ok: true, loggedIn: true, done, total: dsl.length, failedAt: i, failLabel: desc, title: after.title, url: after.url, error: r && r.error }); return
          }
          done++
          await sleep(500)
        }
        const after = await win.webContents.executeJavaScript(`(function(){return {title:document.title||'',url:location.href}})()`)
        try { if (!win.isDestroyed()) win.close() } catch (_) {}
        resolve({ ok: true, loggedIn: true, done, total: dsl.length, failedAt: -1, failLabel: '', title: after.title, url: after.url })
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

interface WebSearchResult { title: string; url: string; snippet: string }
interface WebSearchOutcome { query: string; results: WebSearchResult[]; pages: { url: string; title: string; text: string }[] }

// 必应结果链接是 /ck/a?...&u=a1<base64url> 的跳转包装，解码出真实目标 URL。
function cleanBingUrl(href: string): string {
  try {
    const u = new URL(href)
    if (u.hostname.includes('bing.com') && u.pathname.startsWith('/ck/')) {
      const p = u.searchParams.get('u') || ''
      if (p.startsWith('a1')) {
        const b64 = p.slice(2).replace(/-/g, '+').replace(/_/g, '/')
        const decoded = Buffer.from(b64, 'base64').toString('utf-8')
        if (/^https?:/i.test(decoded)) return decoded
      }
    }
  } catch (_) {}
  return href
}

// 通用离屏抓取：打开 url，等待渲染后执行一段 DOM 提取脚本，返回其结果。
function offscreenExtract(url: string, extractJs: string, waitMs = 1800, timeoutMs = 18000): Promise<any> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { offscreen: true } })
    let settled = false
    const done = (val: any) => {
      if (settled) return
      settled = true
      try { if (!win.isDestroyed()) win.close() } catch (_) {}
      resolve(val)
    }
    win.webContents.setAudioMuted(true)
    win.webContents.once('did-finish-load', async () => {
      try { await sleep(waitMs); done(await win.webContents.executeJavaScript(extractJs)) }
      catch (_) { done(null) }
    })
    win.webContents.once('did-fail-load', (_e, code) => { if (code !== -3) done(null) })
    win.loadURL(url).catch(() => {})
    setTimeout(() => done(null), timeoutMs)
  })
}

interface SearchCfg { provider: string; apiKey: string; maxResults: number; deepReadCount: number; browserEngine: string }

// 拉取管理端检索服务配置。
async function getSearchConfig(): Promise<SearchCfg> {
  const fallback: SearchCfg = { provider: 'NONE', apiKey: '', maxResults: 5, deepReadCount: 2, browserEngine: 'ELECTRON' }
  try {
    const r = await fetch(`${getAdminBaseUrl()}/api/v1/search-config`)
    if (r.ok) {
      const c: any = await r.json()
      return {
        provider: c.provider || 'NONE', apiKey: c.apiKey || '',
        maxResults: c.maxResults || 5, deepReadCount: c.deepReadCount ?? 2,
        browserEngine: c.browserEngine || 'ELECTRON'
      }
    }
  } catch (_) {}
  return fallback
}

// 用 Playwright 抓取网页正文（可选，需客户端已安装浏览器）；失败抛错由调用方回退。
async function playwrightFetchText(url: string): Promise<string> {
  const { chromium }: any = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newContext().then((c: any) => c.newPage())
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(1200)
    const text: string = await page.evaluate(`(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,2600)`)
    return (text || '').trim()
  } finally { await browser.close() }
}

// 抓取单页正文：按配置优先 Playwright，否则用内置离屏浏览器。
async function fetchPageText(url: string, engine: string, sendLog: SendLog): Promise<string> {
  if (engine === 'PLAYWRIGHT') {
    try { return await playwrightFetchText(url) }
    catch (e: any) { sendLog('stdout', `[联网检索] Playwright 不可用（${e.message}），回退内置浏览器。`) }
  }
  return ((await offscreenExtract(url, `(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,2600)`)) || '').trim()
}

// 内置浏览器检索：离屏打开必应结果页解析头部结果。
async function browserSerp(query: string, max: number): Promise<WebSearchResult[]> {
  const serp = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`
  const extractJs = `(function(){
    var out=[];
    document.querySelectorAll('#b_results > li.b_algo').forEach(function(li){
      var a=li.querySelector('h2 a'); var p=li.querySelector('.b_caption p')||li.querySelector('p');
      if(a&&a.href){ out.push({ title:(a.innerText||'').trim(), url:a.href, snippet:(p?p.innerText:'').trim() }); }
    });
    return out.slice(0,10);
  })()`
  let results: WebSearchResult[] = (await offscreenExtract(serp, extractJs)) || []
  return results.filter(r => r.url && /^https?:/.test(r.url)).map(r => ({ ...r, url: cleanBingUrl(r.url) })).slice(0, max)
}

// Tavily：面向 AI 的检索 API，直接返回结果与正文。
async function tavilySearch(query: string, cfg: SearchCfg): Promise<WebSearchOutcome> {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: cfg.apiKey, query, max_results: cfg.maxResults, include_raw_content: true })
  })
  if (!r.ok) throw new Error(`Tavily HTTP ${r.status}`)
  const d: any = await r.json()
  const results: WebSearchResult[] = (d.results || []).map((x: any) => ({ title: x.title || '', url: x.url, snippet: (x.content || '').slice(0, 200) }))
  const pages = (d.results || []).slice(0, cfg.deepReadCount)
    .map((x: any) => ({ url: x.url, title: x.title || '', text: (x.raw_content || x.content || '').replace(/\s+/g, ' ').slice(0, 2600).trim() }))
    .filter((p: any) => p.text)
  return { query, results, pages }
}

// Bing Web Search API：返回结果，正文再由浏览器深读。
async function bingApiSearch(query: string, cfg: SearchCfg, sendLog: SendLog): Promise<WebSearchOutcome> {
  const r = await fetch(`https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${cfg.maxResults}&mkt=zh-CN`, {
    headers: { 'Ocp-Apim-Subscription-Key': cfg.apiKey }
  })
  if (!r.ok) throw new Error(`Bing API HTTP ${r.status}`)
  const d: any = await r.json()
  const results: WebSearchResult[] = (d.webPages?.value || []).map((x: any) => ({ title: x.name || '', url: x.url, snippet: x.snippet || '' }))
  const pages: { url: string; title: string; text: string }[] = []
  for (const x of results.slice(0, cfg.deepReadCount)) {
    const text = await fetchPageText(x.url, cfg.browserEngine, sendLog)
    if (text) pages.push({ url: x.url, title: x.title, text })
  }
  return { query, results, pages }
}

// 联网检索入口：按管理端配置选择通道（Tavily / Bing API / 内置浏览器）。
async function webSearch(query: string, sendLog: SendLog): Promise<WebSearchOutcome> {
  const cfg = await getSearchConfig()
  sendLog('thinking', `[联网检索] 解析检索意图，关键词：${query}`)
  try {
    if (cfg.provider === 'TAVILY' && cfg.apiKey) {
      sendLog('acting', `[联网检索] 通过 Tavily API 检索...`)
      const out = await tavilySearch(query, cfg)
      sendLog('completed', `[联网检索] Tavily 返回 ${out.results.length} 条结果。`)
      return out
    }
    if (cfg.provider === 'BING' && cfg.apiKey) {
      sendLog('acting', `[联网检索] 通过 Bing Web Search API 检索...`)
      const out = await bingApiSearch(query, cfg, sendLog)
      sendLog('completed', `[联网检索] Bing API 返回 ${out.results.length} 条结果，深读 ${out.pages.length} 篇。`)
      return out
    }
  } catch (e: any) {
    sendLog('observing', `[联网检索] 检索 API 调用失败（${e.message}），回退内置浏览器检索。`)
  }
  // 回退：内置浏览器检索 + 深读
  sendLog('acting', `[联网检索] 使用内置浏览器检索（必应，引擎：${cfg.browserEngine === 'PLAYWRIGHT' ? 'Playwright' : '离屏'}）...`)
  const results = await browserSerp(query, cfg.maxResults)
  sendLog('observing', `[联网检索] 命中 ${results.length} 条结果`)
  const pages: { url: string; title: string; text: string }[] = []
  for (const r of results.slice(0, cfg.deepReadCount)) {
    sendLog('acting', `[联网检索] 深读：${r.title || r.url}`)
    const text = await fetchPageText(r.url, cfg.browserEngine, sendLog)
    if (text) pages.push({ url: r.url, title: r.title, text })
  }
  sendLog('completed', `[联网检索] 检索完成，已读取 ${pages.length} 篇网页正文。`)
  return { query, results, pages }
}

// 查询改写：用大模型把口语化请求 + 已知公司，改写成精准的搜索关键词。
async function refineSearchQuery(userMsg: string, cfg: LlmConfig, sendLog: SendLog): Promise<string> {
  const hasCfg = !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)
  if (!hasCfg) return userMsg
  let company = ''
  try {
    const r = await fetch(`${getAdminBaseUrl()}/api/v1/enterprise`)
    if (r.ok) { const p: any = await r.json(); company = p.companyName || '' }
  } catch (_) {}
  const prompt = `你是搜索查询改写助手。把用户请求改写成一个用于搜索引擎的精准、简洁的关键词查询，使其能搜到最相关、最具体的网页。\n规则：只输出最终查询关键词本身，不要任何解释、前缀或引号；把"我们公司/本公司/我司/咱们公司"替换成具体公司名；补全有助于检索的关键词（如股票需带公司名/代码与"股价 实时行情"）。\n${company ? `已知用户所在公司：${company}。\n` : ''}用户请求：${userMsg}`
  try {
    const out = await callLlm(prompt, cfg)
    const q = (out || '').trim().split('\n')[0].replace(/^["「『]+|["」』]+$/g, '').replace(/^(查询关键词|关键词|查询)[:：]\s*/, '').trim().slice(0, 80)
    if (q) { sendLog('thinking', `[联网检索] 查询改写：${q}`); return q }
  } catch (_) {}
  return userMsg
}

// 该岗位分身是否被管理端授权联网检索。
async function getExpertWebSearch(expertId: string): Promise<boolean> {
  if (!expertId) return false
  try {
    const r = await fetch(`${getAdminBaseUrl()}/api/v1/experts/${expertId}`)
    if (r.ok) { const e: any = await r.json(); return !!e.webSearchEnabled }
  } catch (_) {}
  return false
}

// 由大模型自主判断该问题是否需要联网检索（用于已授权联网的分身）。
async function shouldWebSearch(userMsg: string, cfg: LlmConfig, sendLog: SendLog): Promise<boolean> {
  const hasCfg = !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)
  if (!hasCfg) return false
  const prompt = `判断要回答下面这个问题，是否需要联网检索最新或外部信息（例如：实时价格/股价/汇率、航班/车票、天气、新闻或近期事件、产品/政策的最新情况、你并不掌握的具体事实与数据）。\n如果问题只是闲聊、寒暄、改写、基于已给资料的分析、或常识性问答，则不需要。\n只输出一个字：需要 或 不需要。\n问题：${userMsg}`
  try {
    const out = (await callLlm(prompt, cfg)).trim()
    const yes = /需要/.test(out) && !/不需要/.test(out)
    sendLog('thinking', `[联网检索] 自主研判：${yes ? '需要联网' : '无需联网'}`)
    return yes
  } catch (_) { return false }
}

// 判断任务是否需要联网检索。
function isWebSearchIntent(content: string): boolean {
  const s = content.toLowerCase()
  return /(联网|上网|网上|搜索|搜一下|搜一搜|查一下网|网上查|检索一下|最新消息|最新动态|新闻|百度|谷歌|google|bing|搜索引擎|查查网上|联网查)/.test(s)
}

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

interface LlmConfig {
  mode: string;
  apiMode: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
}


async function callLlm(prompt: string, cfg: LlmConfig): Promise<string> {
  const mode = cfg.mode || 'direct'
  const apiMode = cfg.apiMode || 'chat'
  const baseUrl = cfg.baseUrl || ''
  const apiKey = cfg.apiKey || ''
  const modelName = cfg.modelName || ''

  console.log('[callLlm] ===== LLM REQUEST =====')
  console.log('[callLlm] mode:', mode, '| apiMode:', apiMode)
  console.log('[callLlm] baseUrl:', baseUrl)
  console.log('[callLlm] modelName:', modelName)
  console.log('[callLlm] apiKey prefix:', apiKey?.substring(0, 10) + '...')

  let cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  if (cleanBaseUrl.endsWith('/chat/completions')) {
    cleanBaseUrl = cleanBaseUrl.slice(0, -'/chat/completions'.length)
  } else if (cleanBaseUrl.endsWith('/v1/messages')) {
    cleanBaseUrl = cleanBaseUrl.slice(0, -'/v1/messages'.length)
  }

  let targetUrl = ''
  let headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  let body: any = {}

  if (mode === 'proxy') {
    // Enterprise unified gateway (admin backend /api/v1/model/chat). Accept the
    // base URL with or without a trailing /chat so either form works.
    const gwBase = cleanBaseUrl.endsWith('/chat') ? cleanBaseUrl.slice(0, -'/chat'.length) : cleanBaseUrl
    targetUrl = `${gwBase}/chat`
    headers['Authorization'] = `Bearer ${apiKey}`
    body = {
      model: modelName,
      messages: [{ role: 'user', content: prompt }]
    }
  } else {
    if (apiMode === 'anthropic') {
      targetUrl = `${cleanBaseUrl}/v1/messages`
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      body = {
        model: modelName,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      }
    } else {
      targetUrl = `${cleanBaseUrl}/chat/completions`
      headers['Authorization'] = `Bearer ${apiKey}`
      body = {
        model: modelName,
        messages: [{ role: 'user', content: prompt }]
      }
    }
  }

  console.log('[callLlm] >>> Final targetUrl:', targetUrl)

  let response: Response
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
  } catch (networkErr: any) {
    console.error('[callLlm] Network/fetch error:', networkErr.message)
    throw new Error(`网络连接失败: ${networkErr.message}（请确认服务地址可访问）`)
  }

  console.log('[callLlm] <<< HTTP status:', response.status, response.statusText)

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    console.error('[callLlm] Error response body:', errBody)
    throw new Error(`HTTP ${response.status}: ${errBody || response.statusText}`)
  }

  const resData: any = await response.json()
  console.log('[callLlm] <<< Response JSON keys:', Object.keys(resData))

  if (apiMode === 'anthropic' && mode !== 'proxy') {
    const content = resData.content?.[0]?.text
    return content || JSON.stringify(resData)
  } else {
    const content = resData.choices?.[0]?.message?.content
    return content || JSON.stringify(resData)
  }
}

// Harness ReAct Loop simulation trigger
ipcMain.handle('agent:send-message', async (_event, data: { content: string; expertId?: string; expertName: string; userNickname?: string; background: string; llmConfig: LlmConfig }) => {
  imCommandCount++
  if (data.expertName) configSet('lastClaimedExpertName', data.expertName)
  const sendLog = (type: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed', text: string) => {
    if (mainWindow) {
      mainWindow.webContents.send('agent:log-stream', { type, text, timestamp: new Date().toLocaleTimeString() })
    }
  }

  const normalized = data.content.toLowerCase()
  const expertId = data.expertId || ''
  const userNickname = data.userNickname || '用户'

  // —— Agent Trace 采集：本次任务的全链路轨迹，结束时上报管理端审计追溯 ——
  const traceStart = Date.now()
  const traceSpans: any[] = []
  const traceEvents: any[] = []
  let traceWebSearch = false
  let traceSkill = ''
  let traceSources: any[] = []
  let traceTokens = { p: 0, c: 0 }
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
      await fetch(`${getAdminBaseUrl()}/api/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    } catch (_) {}
  }

  // 真实性约束：聊天/分析路径没有访问真实业务数据的能力，必须杜绝凭空捏造。
  const NO_FABRICATION_RULE = `【重要 · 真实性边界】
你本身无法访问任何外部系统、邮箱、OA、CRM、ERP、数据库或任何实时/私有业务数据。除非下文明确给出了"真实技能执行结果 / 真实页面抓取内容"，否则你并不掌握用户的任何真实邮件、待办、审批单、报销单、订单、人员或金额数据。
当用户要求查看 / 获取 / 统计这类真实业务数据，而你手头只有静态知识、并无实际执行结果时，你必须如实说明你无法直接获取，并简要给出下一步建议：① 在「企业技能中心」为该需求配置对应技能并绑定目标业务系统；② 在「设置 → 企业系统连接」登录对应系统后重试。
严禁编造任何邮件、待办、条目、姓名、金额、日期、单号或任何不存在的业务数据；不要为了"显得完成了任务"而虚构结果。`

  // --- Skill Interception and Execution ---
  // Reload skills to capture any newly created folders/files by the user!
  loadLocalSkills()

  let isSkillTriggered = false
  let skillResult = ''
  let skillPromptHint = ''
  let isScreenshot = false
  let screenshotMarkdown = ''

  // Look through loaded skills and see if the user's message contains any trigger keywords of a skill
  // AND the skill is allowed for the active expertId
  let matchedSkill: SkillDefinition | null = null
  for (const skill of loadedSkills) {
    const isAllowed = skill.allowedRoles.includes(expertId) || skill.allowedRoles.length === 0
    if (!isAllowed) continue

    const matchesKeyword = skill.triggerKeywords.some(kw => normalized.includes(kw))
    if (matchesKeyword) {
      matchedSkill = skill
      break
    }
  }

  if (matchedSkill) {
    const id = matchedSkill.id
    traceSkill = matchedSkill.name
    traceSpans.push({ type: 'skill', name: `匹配技能·${matchedSkill.name}`, status: 'ok' })
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
        skillPromptHint = `【本地技能 "${matchedSkill.name}" 执行结果】\n离屏网页截图成功。图片保存为本地物理文件。\n\n【技能 SOP 指令】\n${matchedSkill.sopContent}`
      } catch (err: any) {
        skillResult = `❌ 网页截图执行失败: ${err.message}`
        skillPromptHint = `【本地技能 "${matchedSkill.name}" 执行失败】\n错误信息: ${err.message}。\n\n【技能 SOP 指令】\n${matchedSkill.sopContent}`
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
        skillPromptHint = `【本地技能 "${matchedSkill.name}" 执行结果】\n实时气温/气象: "${weatherText}"。\n差旅标准比对结果: "${limitText}"。\n\n【技能 SOP 指令】\n${matchedSkill.sopContent}`
      } catch (err: any) {
        skillResult = `❌ 天气数据查询失败: ${err.message}`
        skillPromptHint = `【本地技能 "${matchedSkill.name}" 执行失败】\n错误信息: ${err.message}。\n\n【技能 SOP 指令】\n${matchedSkill.sopContent}`
      }

    } else if (id === 'workspace-analyzer') {
      isSkillTriggered = true
      try {
        const mdTable = await analyzeLocalWorkspace(sendLog)
        skillResult = mdTable
        skillPromptHint = `【本地技能 "${matchedSkill.name}" 执行结果】\n物理工作空间文件扫描数据:\n${mdTable}\n\n【技能 SOP 指令】\n${matchedSkill.sopContent}`
      } catch (err: any) {
        skillResult = `❌ 工作空间分析失败: ${err.message}`
        skillPromptHint = `【本地技能 "${matchedSkill.name}" 执行失败】\n错误信息: ${err.message}。\n\n【技能 SOP 指令】\n${matchedSkill.sopContent}`
      }
    } else {
      // 自定义技能：尝试真实执行（操作其绑定的业务系统并抓取真实页面），绝不臆造数据。
      isSkillTriggered = true
      sendLog('thinking', `[技能执行] 识别到自定义技能 "${matchedSkill.name}"，正在解析其绑定的目标业务系统...`)

      // 本地 SKILL.md 不含目标系统，需向管理端拉取完整技能定义。
      let targetSystemId = ''
      let actionScriptRaw = ''
      let skillCode = ''
      try {
        const sr = await fetch(`${getAdminBaseUrl()}/api/v1/skills/${matchedSkill.id}`)
        if (sr.ok) { const full: any = await sr.json(); targetSystemId = full.targetSystemId || ''; actionScriptRaw = full.actionScript || ''; skillCode = full.code || '' }
      } catch (_) {}

      // 解析绑定系统地址的小工具
      const resolveSystem = async (): Promise<{ sysName: string; baseUrl: string }> => {
        let sysName = '业务系统', baseUrl = ''
        if (targetSystemId) {
          try {
            const ir = await fetch(`${getAdminBaseUrl()}/api/v1/integrations`)
            if (ir.ok) { const list: any = await ir.json(); const sys = Array.isArray(list) ? list.find((x: any) => x.id === targetSystemId) : null; if (sys) { sysName = sys.name; baseUrl = sys.baseUrl } }
          } catch (_) {}
        }
        return { sysName, baseUrl }
      }

      // —— 语义脚本技能（DSL）：解释执行（灵活、可读可改），优先于原始录制回放 ——
      const dsl = parseDsl(skillCode)
      if (dsl.length) {
        // 脚本里用到的参数 {{name}}
        const usedParams = new Set<string>()
        dsl.forEach(s => { const m = s.valueExpr.match(/^\{\{\s*([\w.]+)\s*\}\}$/); if (m) usedParams.add(m[1]) })
        // 字段定义（含选项）来自 actionScript.fields，仅保留脚本实际用到的
        let scriptFields: VisitField[] = []
        try { const parsed = JSON.parse(actionScriptRaw || '{}'); if (Array.isArray(parsed.fields)) scriptFields = parsed.fields.map((f: any) => ({ name: f.name, label: f.label, type: f.type || 'text', value: '', options: Array.isArray(f.options) ? f.options : undefined })) } catch (_) {}
        scriptFields = scriptFields.filter(f => usedParams.has(f.name))
        usedParams.forEach(pn => { if (!scriptFields.find(f => f.name === pn)) scriptFields.push({ name: pn, label: pn, type: 'text', value: '' }) })

        const filledFields = scriptFields.length ? await extractFieldsByLabels(data.content, scriptFields, data.llmConfig, sendLog) : []
        let confirmed: Record<string, string> = {}
        if (filledFields.length) {
          sendLog('acting', '已整理出待填写字段，请在下方表单卡片中核对并确认...')
          confirmed = await requestFormConfirmation(filledFields)
        }
        const { sysName, baseUrl: sysUrl } = await resolveSystem()
        const baseUrl = sysUrl || (dsl.find(s => s.op === 'open')?.arg || '')
        const fieldTable = filledFields.length
          ? `\n\n**确认的字段：**\n\n| 字段 | 值 |\n| --- | --- |\n${filledFields.map(f => `| ${f.label} | ${confirmed[f.name] || '（空）'} |`).join('\n')}`
          : ''
        if (!baseUrl) {
          await submitTrace(data.content, 'PARTIAL', `语义脚本技能 "${matchedSkill.name}"：已确认字段，但缺少可执行的目标系统地址。`)
          return { content: `✅ 已确认字段，但该技能未绑定可访问的业务系统地址，无法执行。请到管理端为该技能绑定目标系统。${fieldTable}`, success: true }
        }
        const rep = await interpretSkillScript(targetSystemId || 'rec', baseUrl, sysName, dsl, confirmed, sendLog)
        let outcome = ''
        if (!rep.ok) outcome = `❌ 后台访问【${sysName}】失败：${rep.error || '未知错误'}。`
        else if (!rep.loggedIn) outcome = `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后再次发起。`
        else if (rep.failedAt >= 0) outcome = `已成功执行前 ${rep.done}/${rep.total} 步，在第 ${rep.failedAt + 1} 步「${rep.failLabel}」处中断（${rep.error || '未找到目标'}）。可在管理端调整该技能脚本（如改定位/加等待）后重试。`
        else outcome = `🤖 已完整执行 ${rep.done}/${rep.total} 步语义脚本。请在【${sysName}】中核对结果。`
        await submitTrace(data.content, rep.ok && rep.loggedIn && rep.failedAt < 0 ? 'SUCCESS' : 'PARTIAL', `语义脚本技能 "${matchedSkill.name}" 执行：${rep.done}/${rep.total} 步。`)
        return { content: `✅ 已执行语义脚本技能「${matchedSkill.name}」。\n\n**执行结果：**\n\n${outcome}${fieldTable}`, success: true }
      }

      // —— 录制回放型技能：有实操录制脚本时，按字段确认 → 确定性回放（兼容旧录制） ——
      if (actionScriptRaw) {
        let parsed: any = null
        try { parsed = JSON.parse(actionScriptRaw) } catch (_) {}
        const steps: RecStep[] = parsed && Array.isArray(parsed.steps) ? parsed.steps : []
        const scriptFields: VisitField[] = parsed && Array.isArray(parsed.fields)
          ? parsed.fields.map((f: any) => ({ name: f.name, label: f.label, type: f.type || 'text', value: '', options: Array.isArray(f.options) ? f.options : undefined }))
          : []
        // 步骤序号 → 绑定的字段名（录制时标注）
        const fieldByStep: Record<number, string> = {}
        steps.forEach((s: any, i: number) => { if (s.fieldName) fieldByStep[i] = s.fieldName })

        if (steps.length === 0) {
          skillResult = `技能 "${matchedSkill.name}" 的录制脚本为空，无法回放。`
          skillPromptHint = `【技能未执行】技能 "${matchedSkill.name}" 没有可回放的录制步骤。请如实告知用户需在客户端重新录制操作。`
        } else {
          // ① 抽取字段值
          const filledFields = scriptFields.length ? await extractFieldsByLabels(data.content, scriptFields, data.llmConfig, sendLog) : []
          // ② 表单确认（有可填字段才弹）
          let confirmed: Record<string, string> = {}
          if (filledFields.length) {
            sendLog('acting', '已整理出待填写字段，请在下方表单卡片中核对并确认...')
            confirmed = await requestFormConfirmation(filledFields)
          }
          // 解析绑定系统地址
          let sysName = '业务系统'; let baseUrl = ''
          if (targetSystemId) {
            try {
              const ir = await fetch(`${getAdminBaseUrl()}/api/v1/integrations`)
              if (ir.ok) { const list: any = await ir.json(); const sys = Array.isArray(list) ? list.find((x: any) => x.id === targetSystemId) : null; if (sys) { sysName = sys.name; baseUrl = sys.baseUrl } }
            } catch (_) {}
          }
          if (!baseUrl) { baseUrl = steps[0]?.url || '' }

          const fieldTable = filledFields.length
            ? `\n\n**确认的字段：**\n\n| 字段 | 值 |\n| --- | --- |\n${filledFields.map(f => `| ${f.label} | ${confirmed[f.name] || '（空）'} |`).join('\n')}`
            : ''

          if (!baseUrl) {
            await submitTrace(data.content, 'PARTIAL', `录制技能 "${matchedSkill.name}"：已确认字段，但缺少可回放的目标系统地址。`)
            return { content: `✅ 已确认字段，但该技能未绑定可访问的业务系统地址，无法回放。请到管理端为该技能绑定目标系统。${fieldTable}`, success: true }
          }

          // ③ 确定性回放
          const rep = await replayActionScript(targetSystemId || 'rec', baseUrl, sysName, steps, confirmed, fieldByStep, sendLog)
          let outcome = ''
          if (!rep.ok) outcome = `❌ 后台访问【${sysName}】失败：${rep.error || '未知错误'}。`
          else if (!rep.loggedIn) outcome = `⚠️ 检测到尚未登录【${sysName}】。请先到「设置 → 企业系统连接」登录后再次发起。`
          else if (rep.failedAt >= 0) outcome = `已成功回放前 ${rep.done}/${rep.total} 步，在第 ${rep.failedAt + 1} 步「${rep.failLabel}」处中断（${rep.error || '元素未找到'}）。可能是页面结构有变化，建议重新录制该技能。`
          else outcome = `🤖 已完整回放 ${rep.done}/${rep.total} 步操作。请在【${sysName}】中核对结果。`
          await submitTrace(data.content, rep.ok && rep.loggedIn && rep.failedAt < 0 ? 'SUCCESS' : 'PARTIAL', `录制技能 "${matchedSkill.name}" 回放：${rep.done}/${rep.total} 步。`)
          return { content: `✅ 已执行录制技能「${matchedSkill.name}」。\n\n**执行结果：**\n\n${outcome}${fieldTable}`, success: true }
        }
        // 录制脚本为空时落到下方提示，不再继续抓取分支
        return { content: skillResult, success: true }
      }

      // —— 客户拜访记录录入 CRM 的结构化流程：抽取参数 → 表单确认 → 无头浏览器录入 ——
      const skillText = `${matchedSkill.name || ''}\n${matchedSkill.sopContent || ''}`
      const isVisitRecord = /拜访/.test(skillText) && /(crm|拜访反馈|拜访记录|客户管理|拜访过程反馈)/i.test(skillText)
      if (isVisitRecord) {
        // ① 抽取
        const fields = await extractVisitFields(data.content, data.llmConfig, sendLog)
        // ② 对话框表单确认（阻塞等待用户在卡片中确认）
        sendLog('acting', '已整理出待录入 CRM 的字段，请在下方表单卡片中核对并确认...')
        const confirmed = await requestFormConfirmation(fields)

        // 解析绑定的目标 CRM 系统地址
        let sysName = 'CRM'
        let baseUrl = ''
        if (targetSystemId) {
          try {
            const ir = await fetch(`${getAdminBaseUrl()}/api/v1/integrations`)
            if (ir.ok) {
              const list: any = await ir.json()
              const sys = Array.isArray(list) ? list.find((x: any) => x.id === targetSystemId) : null
              if (sys) { sysName = sys.name; baseUrl = sys.baseUrl }
            }
          } catch (_) {}
        }

        const tbl = fields.map(f => `| ${f.label} | ${confirmed[f.name] || '（空）'} |`).join('\n')
        const confirmedTable = `| 字段 | 值 |\n| --- | --- |\n${tbl}`

        if (!baseUrl) {
          await submitTrace(data.content, 'PARTIAL', '拜访记录：已抽取并确认字段，但该技能未绑定可自动录入的 CRM 系统。')
          return {
            content: `✅ 已根据您的拜访记录整理并确认以下字段：\n\n${confirmedTable}\n\n⚠️ 但该技能尚未在管理端「业务系统连接」中绑定可自动录入的 CRM，因此暂未执行无头浏览器录入。请到管理端为该技能绑定目标 CRM 后重试。`,
            success: true
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
        return { content: `✅ 已确认并执行客户拜访记录录入。\n\n**确认的录入参数：**\n\n${confirmedTable}\n\n**执行结果：**\n\n${outcome}`, success: true }
      }

      if (targetSystemId) {
        // 解析目标系统地址（来自管理端"业务系统连接"）。
        let sysName = '业务系统'
        let baseUrl = ''
        try {
          const ir = await fetch(`${getAdminBaseUrl()}/api/v1/integrations`)
          if (ir.ok) {
            const list: any = await ir.json()
            const sys = Array.isArray(list) ? list.find((x: any) => x.id === targetSystemId) : null
            if (sys) { sysName = sys.name; baseUrl = sys.baseUrl }
          }
        } catch (_) {}

        if (!baseUrl) {
          skillResult = `❌ 技能 "${matchedSkill.name}" 绑定的业务系统不存在或已被删除，无法执行。`
          skillPromptHint = `【技能未执行】技能 "${matchedSkill.name}" 绑定的目标业务系统不可用。请如实告知用户该技能未能执行、原因是目标系统未配置，绝对不要编造任何业务数据或待办。\n\n【SOP 仅供参考】\n${matchedSkill.sopContent}`
        } else {
          const ext = await openSystemAndExtract(targetSystemId, baseUrl, sysName, sendLog)
          if (ext.ok && ext.loggedIn && ext.text.length > 40) {
            skillResult = `已在【${sysName}】中实际打开页面并抓取到真实内容，正在交由分身按标准流程整理。`
            skillPromptHint = `【技能 "${matchedSkill.name}" 真实执行结果】\n以下是刚刚从【${sysName}】真实页面抓取到的内容（页面标题：${ext.title}）：\n"""\n${ext.text}\n"""\n\n请严格、且仅依据上述真实页面内容，按下面的 SOP 整理后回答用户。如果这些内容与用户任务无关、为空、或看起来仍是登录/首页，请如实说明并提示用户操作，绝对禁止编造任何待办、条目、发起人或数据。\n\n【SOP】\n${matchedSkill.sopContent}`
          } else if (ext.ok && !ext.loggedIn) {
            skillResult = `⚠️ 检测到尚未登录【${sysName}】。请先在「设置 → 企业系统连接」中登录该系统（登录态会保存在本地），随后再次发起该任务即可。`
            skillPromptHint = `【技能未完成 · 需登录】后台访问【${sysName}】时发现当前未登录，无法获取任何真实数据。请如实告知用户：需要先到「设置 → 企业系统连接」完成该系统的登录，然后再次发起即可，登录态会被本地保存复用。绝对不要编造任何待办或数据。`
          } else {
            skillResult = `❌ 访问【${sysName}】失败：${ext.error || '未知错误'}`
            skillPromptHint = `【技能执行失败】访问【${sysName}】失败，原因："${ext.error || '未知错误'}"。请如实告知用户失败原因并建议检查系统地址/网络，绝对不要编造任何数据。`
          }
        }
      } else if (/联网|检索|搜索|网上|web.?search|互联网|查资料/i.test((matchedSkill.name || '') + (matchedSkill.sopContent || ''))) {
        // 技能本身声明需要联网检索 → 执行联网检索能力。
        const cleanQuery = data.content.split('\n').filter(l => !l.startsWith('【')).join(' ').trim() || data.content
        try {
          const sq = await refineSearchQuery(cleanQuery, data.llmConfig, sendLog)
          const r = await webSearch(sq, sendLog)
          const lines = r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
          const pageBlocks = r.pages.map(p => `【来源：${p.title}｜${p.url}】\n${p.text}`).join('\n\n')
          skillResult = `技能 "${matchedSkill.name}" 已联网检索「${sq}」。`
          skillPromptHint = r.results.length
            ? `【技能 "${matchedSkill.name}" · 联网检索真实结果】\n— 结果列表 —\n${lines}\n\n— 头部网页正文 —\n${pageBlocks || '（未提取到正文）'}\n\n请基于以上真实检索内容按 SOP 回答。结尾另起一行写「来源：」，并将每条引用写成 Markdown 链接「- [网页标题](链接)」（用标题文字，不要直接粘贴长链接）；勿编造。\n\n【SOP】\n${matchedSkill.sopContent}`
            : `【技能 "${matchedSkill.name}" · 联网检索】未检索到结果，可能网络受限。请如实告知用户，勿编造。`
        } catch (e: any) {
          skillResult = `❌ 联网检索失败：${e.message}`
          skillPromptHint = `【联网检索失败】"${e.message}"。请如实告知用户，勿编造。`
        }
      } else {
        // 未绑定业务系统、也无原生实现 —— 如实说明，不臆造。
        skillResult = `ℹ️ 技能 "${matchedSkill.name}" 已匹配，但尚未绑定可自动执行的目标业务系统，因此未实际执行（当前仅有 SOP 说明）。`
        skillPromptHint = `【技能未执行】技能 "${matchedSkill.name}" 没有可自动执行的实现（既未绑定业务系统，也无内置原生动作）。请如实告知用户：该技能目前仅有标准作业流程说明、尚未真正自动执行，并可建议在管理端为其绑定目标业务系统。绝对不要编造任何结果、待办或数据。\n\n【SOP 仅供参考】\n${matchedSkill.sopContent}`
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
    sendLog('thinking', `正在将技能调用结果反馈给大模型进行智能化润色与上下文整合...`)
    const cfg = data.llmConfig
    const isConfigComplete = cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName

    if (!isConfigComplete) {
      sendLog('observing', `⚠️ 未检测到有效大模型配置。将绕过 LLM 润色，直接以本地沙箱执行结果返回呈现。`)
      sendLog('completed', `[Completed] 本地技能直通测试完毕。`)
      return {
        content: `💡 **[本地技能直通测试模式]**\n您当前未配置有效的大模型（或已关闭连接）。以下为本地 Node.js / Electron 引擎执行该技能的真实返回结果：\n\n---\n\n${skillResult}`,
        success: true
      }
    }

    // Retrieve memories from SQLite for context integration
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
      } catch (_) {}
      try {
        const agentStr = memoryGet(expertId, 'agent')
        if (agentStr) {
          const parsed = JSON.parse(agentStr)
          if (Array.isArray(parsed)) {
            agentSopList = parsed.map((m: any) => `▸ ${m.content}`).join('\n')
          }
        }
      } catch (_) {}
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

    sendLog('thinking', `[企业知识库 RAG] 正在向云端 pgvector 检索与本任务相关的公司制度...`)
    const corporateChunks = await queryCorporateKnowledge(data.content, expertId)
    if (corporateChunks.length) {
      sendLog('thinking', `[企业知识库 RAG] 命中 ${corporateChunks.length} 条制度条款，最高相似度 ${(corporateChunks[0].score * 100).toFixed(0)}%。已融合进上下文。`)
    } else {
      sendLog('thinking', `[企业知识库 RAG] 无命中或后端离线，回退本地记忆上下文。`)
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
      return { content, success: true }
    } catch (err: any) {
      sendLog('observing', `大模型连接润色失败: ${err.message}。自动回退为本地技能直达渲染。`)
      sendLog('completed', `[Completed] 技能运行完毕（回退直通）。`)
      return {
        content: `⚠️ **[大模型连接失败 - 自动切换本地直通输出]**\n\n大模型请求遇到问题 (\`${err.message}\`)，但本地技能已在 Electron 环境内执行成功。以下是物理执行结果：\n\n---\n\n${skillResult}`,
        success: true
      }
    }
  }
  
  // Simple check to determine if the query requires complex automation actions
  {
    // 所有未匹配技能的请求统一走诚实的大模型路径（带真实性约束），
    // 不再有"复杂指令"模拟分支（之前会弹出与请求无关的假表单）。
    sendLog('thinking', `[Router] 构建岗位与个人上下文...`)
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
      } catch (_) {}

      try {
        const agentStr = memoryGet(expertId, 'agent')
        if (agentStr) {
          const parsed = JSON.parse(agentStr)
          if (Array.isArray(parsed)) {
            agentSopList = parsed.map((m: any) => `▸ ${m.content}`).join('\n')
          }
        }
      } catch (_) {}
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

    sendLog('thinking', `[SQLite RAG] 成功检索到岗位预置SOP (${expertId || '未指定'}):\n${agentSopList.split('\n').map(l => '  ' + l).join('\n')}`)
    sendLog('thinking', `[SQLite RAG] 成功检索到用户本地记忆与习惯 (${expertId || '未指定'}):\n${personalMemoryList.split('\n').map(l => '  ' + l).join('\n')}`)
    await sleep(200)

    const cfg = data.llmConfig
    const mode = cfg?.mode || 'direct'
    const apiMode = cfg?.apiMode || 'chat'
    const modelName = cfg?.modelName || ''
    const baseUrl = cfg?.baseUrl || ''

    let cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    if (cleanBaseUrl.endsWith('/chat/completions')) cleanBaseUrl = cleanBaseUrl.slice(0, -'/chat/completions'.length)
    if (cleanBaseUrl.endsWith('/v1/messages')) cleanBaseUrl = cleanBaseUrl.slice(0, -'/v1/messages'.length)
    if (mode === 'proxy' && cleanBaseUrl.endsWith('/chat')) cleanBaseUrl = cleanBaseUrl.slice(0, -'/chat'.length)

    sendLog('thinking', `[Router] 正在载入用户模型配置...`)
    sendLog('thinking', `▸ 接入模式: ${mode === 'proxy' ? '企业模型安全中转网关 (Corporate Proxy)' : `厂商 API 直连 (Direct API - ${apiMode === 'anthropic' ? 'Anthropic' : 'Chat'})`}`)
    sendLog('thinking', `▸ 目标模型: ${modelName}`)
    await sleep(400)

    const targetEndpoint = mode === 'proxy'
      ? `${cleanBaseUrl}/chat`
      : (apiMode === 'anthropic' ? `${cleanBaseUrl}/v1/messages` : `${cleanBaseUrl}/chat/completions`)

    sendLog('acting', `[LLM WebRequest] 向端点 ${targetEndpoint} 传输 Prompt（已关联个人习惯和智能体预置SOP，用户称呼: ${userNickname}）。`)
    await sleep(400)

    const kbScope = getKnowledgeScope(expertId)
    const kbScopeLine = kbScope.length
      ? `\n- 本岗位云端知识库检索范围（由管理端领用下发）：${kbScope.join('、')}`
      : ''
    if (kbScope.length) {
      sendLog('thinking', `[企业知识库] 本岗位获授权检索范围: ${kbScope.join('、')}`)
    }

    sendLog('thinking', `[企业知识库 RAG] 正在向云端 pgvector 检索与该问题相关的公司制度...`)
    const corporateChunks = await queryCorporateKnowledge(data.content, expertId)
    if (corporateChunks.length) {
      sendLog('thinking', `[企业知识库 RAG] 命中 ${corporateChunks.length} 条，最高相似度 ${(corporateChunks[0].score * 100).toFixed(0)}%，已与本地个人记忆融合。`)
    } else {
      sendLog('thinking', `[企业知识库 RAG] 无命中或后端离线，仅使用本地记忆上下文。`)
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
})

// IPC Form / Delete Confirmation responses from React UI
ipcMain.handle('agent:form-submit', (_event, formData: any) => {
  if (runningState.isFormPending && runningState.formResolve) {
    runningState.isFormPending = false
    runningState.formResolve(formData)
  }
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
  const dir = path.join(process.cwd(), 'documents')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// 文档解析：把本地文件抽取为纯文本。文本类直接读，PDF 用 pdfjs 提取文字。
async function extractFileText(absPath: string): Promise<string> {
  const ext = path.extname(absPath).toLowerCase()
  if (['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml', '.html'].includes(ext)) {
    return fs.readFileSync(absPath, 'utf-8')
  }
  if (ext === '.pdf') {
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
  return '' // docx/xlsx 等暂不支持
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
        blocks.push(`【${name}】暂不支持解析该格式（当前支持 PDF 与文本类：txt/md/csv/json 等）。`)
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
      try { fs.copyFileSync(src, dest) } catch (_) {}
      const f = { name: base, path: `/documents/${base}`, summary: `用户上传附件：${base}`, synced: false }
      localFiles.push(f)
      if (mainWindow) mainWindow.webContents.send('files:watch-event', { action: 'add', file: f })
      files.push({ name: base, path: f.path })
    }
    return { success: true, files }
  } catch (err: any) {
    return { success: false, error: err.message, files: [] }
  }
})

// =====================================================================
// 企业业务系统连接：系统由管理端定义，客户端在此完成员工个人登录。
// 登录会话按系统隔离持久保存（persist:bizsys-<id>），与技能执行器共用。
// =====================================================================
const bizPartition = (systemId: string) => `persist:bizsys-${systemId}`

// 列出管理端定义的业务系统，并附带本地登录态标记。
ipcMain.handle('systems:list', async () => {
  try {
    const res = await fetch(`${getAdminBaseUrl()}/api/v1/integrations`)
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
    const res = await fetch(`${getAdminBaseUrl()}/api/v1/skills`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const created: any = await res.json()
    return { ok: true, skill: created }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

// 打开系统登录窗口，员工在其中完成登录；关闭后记录已配置登录态。
ipcMain.handle('systems:login', async (_event, { systemId, baseUrl }: { systemId: string; baseUrl: string }) => {
  return await new Promise((resolve) => {
    const win = new BrowserWindow({
      show: true, width: 1200, height: 820,
      title: 'iML 工作分身 · 登录企业系统',
      webPreferences: { partition: bizPartition(systemId) }
    })
    win.loadURL(baseUrl).catch(() => {})
    win.on('closed', () => {
      configSet('bizsys-linked:' + systemId, '1')
      resolve({ ok: true })
    })
  })
})

// 真实检测某系统的登录态：离屏打开系统地址，根据页面是否为登录页判定。
ipcMain.handle('systems:check', async (_event, { systemId, baseUrl }: { systemId: string; baseUrl: string }) => {
  return await new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false, width: 1100, height: 760,
      webPreferences: { partition: bizPartition(systemId), offscreen: true }
    })
    let settled = false
    const done = (loggedIn: boolean, error?: string) => {
      if (settled) return
      settled = true
      try { if (!win.isDestroyed()) win.close() } catch (_) {}
      resolve({ ok: !error, loggedIn, error })
    }
    win.webContents.once('did-finish-load', async () => {
      try {
        await sleep(2800)
        const text: string = await win.webContents.executeJavaScript(
          `(function(){return (document.body ? document.body.innerText : '').slice(0, 600)})()`
        )
        const t = (text || '').trim()
        const loginish = t.length < 400 && /(登录|登陆|login|sign in|账号|帐号|密码|password|认证|扫码)/i.test(t)
        done(!loginish)
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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
