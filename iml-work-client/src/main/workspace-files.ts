// 工作空间与文档解析：工作目录定位/扫描、服务端 docling 解析、PDF 本地兜底、
// 附件文本抽取。只依赖 db/http/types 叶子模块；相关 IPC 编排留在 main.ts。
import path from 'path'
import fs from 'fs'
import { configGet } from './db'
import { getAdminBaseUrl, afetch } from './http'
import { type SendLog } from './types'

// 本地工作空间目录（截图、附件、技能产物都落在这里）。
export function workspaceDir(): string {
  // 用户可指定工作目录（在「工作空间」里选）；未指定则用默认 documents
  const override = configGet('workspaceDir')
  if (override && fs.existsSync(override)) return override
  const dir = path.join(process.cwd(), 'documents')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// 实时扫描当前工作目录里的文件（供「工作空间」弹层展示与引用）
export function scanWorkspace(): { name: string; path: string }[] {
  const dir = workspaceDir()
  try {
    return fs.readdirSync(dir)
      .filter(n => { if (n.startsWith('.')) return false; try { return fs.statSync(path.join(dir, n)).isFile() } catch { return false } })
      .map(n => ({ name: n, path: path.join(dir, n) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch { return [] }
}

// 服务端 docling 解析：把文件传给后端 /api/v1/parse/document，拿规整 Markdown。
// 重活(PDF 版面/表格/OCR、docx/xlsx/pptx)放服务端跑，终端不吃算力；不可达时返回 null 由调用方回退。
// 仅上传用户显式引用的文档，绝不上传登录态/凭证。
export const DOCLING_EXTS = ['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp']

export async function parseViaBackend(absPath: string): Promise<string | null> {
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
export async function extractPdfLocal(absPath: string): Promise<string> {
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
export async function extractFileText(absPath: string): Promise<string> {
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

/**
 * 收集"本轮可作为迭代编辑输入"的工作空间文件：当前消息的显式附件引用 + 会话上文里
 * 分身产出（"保存到工作空间：a、b。"）与用户附件引用的文件名。近者优先、只取真实存在的
 * 文件、单个 ≤2MB 且最多 3 个（沙箱 tar 总量 8MB 上限，给 bundle 留余量）。
 * 让"把刚才那份改一下"有真实指代：这些文件会铺进沙箱 /work/input/ 供脚本读取增量修改。
 */
export function collectSessionInputFiles(content: string, history?: { role: string; content: string }[]): { name: string; path: string }[] {
  const names: string[] = []
  const push = (n: string) => { const t = n.trim(); if (t && !names.includes(t)) names.push(t) }
  const scanAttach = (text: string) => {
    const m = (text || '').match(/【附件】([^\n]*?)（已加入工作空间）/)
    if (m) m[1].split('、').forEach(push)
  }
  const scanOutputs = (text: string) => {
    const segs = (text || '').match(/保存到工作空间[：:]\s*([^。\n]+)/g)
    if (segs) for (const seg of segs) seg.replace(/^.*?[：:]\s*/, '').split('、').forEach(push)
  }
  scanAttach(content); scanOutputs(content)                                   // 当前消息优先
  for (const h of [...(history || [])].reverse()) { scanAttach(h.content); scanOutputs(h.content) }   // 上文近→远

  const dir = workspaceDir()
  const out: { name: string; path: string }[] = []
  let total = 0
  for (const n of names) {
    const p = path.join(dir, n)
    if (!p.startsWith(dir)) continue   // 防路径逃逸
    try {
      const st = fs.statSync(p)
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue
      if (total + st.size > 4 * 1024 * 1024) break
      total += st.size
      out.push({ name: n, path: p })
    } catch { /* 文件已不存在，跳过 */ }
    if (out.length >= 3) break
  }
  return out
}

// 解析消息里 “【附件】a、b（已加入工作空间）” 引用的文件，抽取其真实文本。
export async function extractAttachmentText(content: string, sendLog: SendLog): Promise<string> {
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
