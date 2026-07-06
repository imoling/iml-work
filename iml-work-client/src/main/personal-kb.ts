// 个人知识库自动入库：用户处理的文件（工作空间/附件）自动经服务端 docling 解析后
// 进「个人库」(owner 隔离)，让分身越用越懂你的资料。可全局关闭(kb-autoingest)、
// 可按文件排除(kb-exclude:<name>)。只把用户显式引用/放入工作空间的文档送后端，
// 绝不上传登录态/凭证。IPC 编排留在 main.ts。
import path from 'path'
import fs from 'fs'
import { configGet, configSet } from './db'
import { getAdminBaseUrl, afetch, getOwnerId } from './http'
import { emitToRenderer } from './window-ref'
import { md5OfFile } from './file-sync'

export function kbAutoIngestOn(): boolean { return configGet('kb-autoingest') !== '0' }

export function kbEmit(payload: unknown) { emitToRenderer('kb:changed', payload) }

export async function ingestToPersonalKB(absPath: string, opts?: { force?: boolean }): Promise<{ ok: boolean; docId?: string; reason?: string }> {
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
