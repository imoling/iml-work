// 个人空间文件 / 后端沙箱直调 / 工作空间 / 附件 / 个人知识库 IPC。纯搬迁自 main.ts。
import { ipcMain, shell, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import { configGet, configSet } from '../db'
import { getAdminBaseUrl, afetch, getOwnerId } from '../http'
import { swallow } from '../util'
import { getMainWindow, emitToRenderer } from '../window-ref'
import { workspaceDir, scanWorkspace } from '../workspace-files'
import { listArtifactGroups, artifactNameSet } from '../artifact-index'
import { getLocalFiles } from '../file-sync'
import { kbAutoIngestOn, kbEmit, ingestToPersonalKB } from '../personal-kb'
import { getKnowledgeScope } from '../corporate-rag'
import { execViaBackendSandbox } from '../skill-exec'
import {  } from '../file-sync'

// 后端 /knowledge/docs 返回的文档形状（字段多可空）——替 any 给知识库 IPC 载荷类型边界。
interface KbDoc { id?: string; filename?: string; title?: string; category?: string; updatedAt?: string; createdAt?: string }

export function registerFilesKbHandlers(): void {
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
    const w = getMainWindow()
    if (process.platform === 'darwin' && w) w.previewFile(abs, name)
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
        emitToRenderer('files:sync-progress', { name: fileName, progress: 100 })
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

ipcMain.handle('workspace:files', () => ({ dir: workspaceDir(), files: scanWorkspace() }))
// 任务成果：按任务(会话)分组的产物索引（个人空间「任务成果」视图 + 对话框 @ 引用）。
ipcMain.handle('artifacts:groups', () => ({ ok: true, groups: listArtifactGroups() }))

// 数据字典：某类型的启用取值（如 knowledge_category 企业知识分类，归档提名下拉用）。
// 后端不可达时返回空数组，渲染层自行兜底内置值。
ipcMain.handle('dict:list', async (_e, type: string) => {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/dicts/${encodeURIComponent(String(type || ''))}`)
    if (!r.ok) return { ok: false, labels: [] }
    const items: any = await r.json()
    return { ok: true, labels: Array.isArray(items) ? items.map((i: any) => String(i.label || '')).filter(Boolean) : [] }
  } catch (e) { swallow(e, 'dict-list'); return { ok: false, labels: [] } }
})
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
      emitToRenderer('files:watch-event', { action: 'add', file: f })
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
  let docs: KbDoc[] = []
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/knowledge/docs?scope=PERSONAL&ownerId=${encodeURIComponent(ownerId)}`)
    if (r.ok) { const d = await r.json() as KbDoc[]; if (Array.isArray(d)) docs = d }
  } catch (e) { swallow(e) }
  // 以文件名关联本地状态；isArtifact=任务产物（登记在册），资料库视图与 KB 自动摄取据此分类
  const artifacts = artifactNameSet()
  const files = scanWorkspace().map(f => ({
    name: f.name,
    excluded: configGet('kb-exclude:' + f.name) === '1',
    docId: configGet('kb-doc:' + f.name) || '',
    doc: docs.find(d => d.filename === f.name) || null,
    isArtifact: artifacts.has(f.name)
  }))
  return { ok: true, ownerId, autoIngest, files, personalDocs: docs }
})
// 记忆面板·企业知识级：拉取本岗位可检索的企业知识库范围（分类）+ 该范围下的真实文档清单。
// 只读真实数据（不硬编造事实）；问答时由 queryCorporateKnowledge 现查现用 RAG 召回。
ipcMain.handle('memory:enterprise', async (_e, expertId?: string) => {
  const categories = getKnowledgeScope(expertId)
  let docs: KbDoc[] = []
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/knowledge/docs?scope=ENTERPRISE`)
    if (r.ok) { const d = await r.json() as KbDoc[]; if (Array.isArray(d)) docs = d }
  } catch (e) { swallow(e, 'memory-enterprise') }
  // 有范围则按分类过滤（岗位只看得到授权范围）；无范围则全部企业文档
  const inScope = categories.length ? docs.filter(d => categories.includes(d.category ?? '')) : docs
  const list = inScope.map(d => ({ name: d.filename || d.title || d.id || '', category: d.category || '未分类', updatedAt: d.updatedAt || d.createdAt || '' }))
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
}
