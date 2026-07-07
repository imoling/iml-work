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
 * 收集"本轮可作为迭代编辑输入"的工作空间文件。三路提取，近者优先：
 *  ① 当前消息/上文里出现的文档文件名（裹在《》「」【】或裸露皆可，如「WorkBuddy产品介绍.docx」）；
 *  ② 当前消息的【附件】引用；
 *  ③ 兜底：当前消息是「在刚才那份 / 上面那份 / 加一节 / 续写 / 改一下」这类迭代意图但没点名文件时，
 *     取工作空间里最新修改的文档文件——这是"刚才那份"最可靠的解析（用户往往刚生成完）。
 * 只取真实存在、单个 ≤2MB、合计 ≤4MB、最多 3 个（沙箱 tar 8MB 上限，给 bundle 留余量）。
 * 命中的文件铺进沙箱 /work/input/ 供脚本读旧改新。
 */
export const DOC_EXT = /\.(docx?|pptx?|xlsx?|pdf|csv|md|txt)$/i
export const ITER_INTENT = /(刚才|上面|上方|之前|这份|那份|该文档|同一份|在原|基础上|继续|接着|续写|补充|追加|再加|加一?[节段章]|改一?下|修改|润色|调整|完善)/

/**
 * 从当前消息 + 会话上文里提取候选文件名（纯文本解析，不碰 fs）：
 *  ① 任意带文档扩展名的 token（裹在《》「」【】或裸露皆可，去掉包裹符）；
 *  ② 【附件】a、b（已加入工作空间）引用。
 * 近者优先、去重。这是"刚才那份"指代解析的第一路——单独导出以便单测（曾因只认固定话术而失效）。
 */
export function extractCandidateFilenames(content: string, history?: { role: string; content: string }[]): string[] {
  const names: string[] = []
  const push = (n: string) => { const t = n.trim().replace(/[《》「」【】'"]/g, ''); if (t && !names.includes(t)) names.push(t) }
  const scanFilenames = (text: string) => {
    const re = /[^\s《》「」【】、，,。；;:：]+?\.(?:docx?|pptx?|xlsx?|pdf|csv|md|txt)/gi
    const ms = (text || '').match(re)
    if (ms) ms.forEach(push)
  }
  const scanAttach = (text: string) => {
    const m = (text || '').match(/【附件】([^\n]*?)（已加入工作空间）/)
    if (m) m[1].split('、').forEach(push)
  }
  scanAttach(content); scanFilenames(content)                                 // 当前消息优先
  for (const h of [...(history || [])].reverse()) { scanAttach(h.content); scanFilenames(h.content) }   // 上文近→远
  return names
}

export function collectSessionInputFiles(content: string, history?: { role: string; content: string }[]): { name: string; path: string }[] {
  const names = extractCandidateFilenames(content, history)
  const dir = workspaceDir()
  const out: { name: string; path: string }[] = []
  let total = 0
  const take = (name: string, p: string): boolean => {
    if (!p.startsWith(dir) || out.some(o => o.name === name)) return false   // 防逃逸 + 去重
    try {
      const st = fs.statSync(p)
      if (!st.isFile() || st.size > 2 * 1024 * 1024) return false
      if (total + st.size > 4 * 1024 * 1024) return false
      total += st.size; out.push({ name, path: p }); return true
    } catch { return false }
  }
  for (const n of names) { if (out.length >= 3) break; take(n, path.join(dir, n)) }

  // 兜底：迭代意图 + 文本没解析出任何文件 → 取工作空间最新修改的文档文件
  if (out.length === 0 && ITER_INTENT.test(content)) {
    const newest = newestDocFile(dir)
    if (newest) take(newest.name, newest.path)
  }
  return out
}

/** 工作空间里按修改时间最新的文档文件（供"刚才那份"兜底解析）。 */
function newestDocFile(dir: string): { name: string; path: string; mtime: number } | null {
  try {
    let best: { name: string; path: string; mtime: number } | null = null
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.') || !DOC_EXT.test(name)) continue
      const p = path.join(dir, name)
      try {
        const st = fs.statSync(p)
        if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { name, path: p, mtime: st.mtimeMs }
      } catch { /* skip */ }
    }
    return best
  } catch { return null }
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
