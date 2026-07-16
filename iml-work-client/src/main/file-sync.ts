// 本地文件同步：监听工作目录（documents），md5 差量上传管理端归档，
// 并维护「个人空间文件列表」共享状态（getLocalFiles 暴露给 IPC 层）。
// 同步成功后的个人知识库入库经 onFileSynced 回调注入，避免依赖 main.ts。
import path from 'path'
import { appDataRoot } from './app-paths'
import fs from 'fs'
import crypto from 'crypto'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { configGet, configSet } from './db'
import { getAdminBaseUrl, afetch } from './http'
import { emitToRenderer } from './window-ref'
import { swallow } from './util'

const DOCUMENTS_DIR = path.join(appDataRoot(), 'documents')
let fileWatcher: FSWatcher | null = null
let onFileSyncedCb: ((absPath: string) => void) | null = null

// 个人空间文件列表：只由本模块监听真实工作目录填充——不预置任何演示假文件。
// 返回内部可变数组引用：IPC 层（files:list / files:sync / attach:pick）直接读写。
export type LocalFileEntry = { name: string; path: string; summary?: string; synced: boolean }
const localFiles: LocalFileEntry[] = []

export function getLocalFiles(): LocalFileEntry[] {
  return localFiles
}

function emitSyncEvent(payload: Record<string, any>) {
  emitToRenderer('filesync:event', payload)
}

export function md5OfFile(filePath: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex')
}

export function stopFileSyncWatcher() {
  if (fileWatcher) { void fileWatcher.close(); fileWatcher = null }
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
    if (onFileSyncedCb) onFileSyncedCb(filePath)
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
// onFileSynced：同步成功后的回调（main.ts 注入个人知识库入库），避免本模块 import main。
export function startFileSyncWatcher(onFileSynced?: (absPath: string) => void) {
  onFileSyncedCb = onFileSynced || null
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
