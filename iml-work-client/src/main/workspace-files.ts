// 工作空间与文档解析：工作目录定位/扫描、服务端 docling 解析、PDF 本地兜底、
// 附件文本抽取。只依赖 db/http/types 叶子模块；相关 IPC 编排留在 main.ts。
import path from 'path'
import os from 'os'
import { appDataRoot } from './app-paths'
import fs from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { configGet, configSet } from './db'
import { getAdminBaseUrl, afetch } from './http'
import { type SendLog } from './types'
import { currentRun } from './automation-runtime'
import { recentConvArtifacts, registerArtifact, uniqueArtifactName } from './artifact-index'
import { swallow } from './util'

const pexecFile = promisify(execFile)

// 本地工作空间目录（截图、附件、技能产物都落在这里）。
// 布局参照 WorkBuddy：任务产物放可见的 ~/imlwork（用户在访达/资源管理器直接能找到），
// 内部数据（库/技能/缓存）收在 ~/.imlwork（见 global-env 的 userData 改道）。
let workspaceMigrated = false   // 进程内只做一次合并检查（配合持久标记，避免每次调用都扫目录）

export function workspaceDir(): string {
  // 用户可指定工作目录（在「工作空间」里选）；未指定则用默认 ~/imlwork
  const override = configGet('workspaceDir')
  if (override && fs.existsSync(override)) return override
  const dir = path.join(os.homedir(), 'imlwork')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  // 一次性**合并**迁移：老默认目录（userData/documents）里的历史产出搬进新目录。
  // 血泪：最初只在「新目录不存在」时整目录 rename——目标目录恰好已存在就静默跳过，
  // 历史产出全留在旧目录 → 迭代/引用类生成从工作区收不到输入文件，
  // 沙箱脚本一律 NO_DATA「找不到输入文件」。合并按文件搬、重名跳过，跑一次即打标记。
  if (!workspaceMigrated && !configGet('workspaceMerged:v1')) {
    const legacy = path.join(appDataRoot(), 'documents')
    try {
      if (fs.existsSync(legacy)) {
        let moved = 0
        for (const name of fs.readdirSync(legacy)) {
          if (name.startsWith('.')) continue
          const from = path.join(legacy, name), to = path.join(dir, name)
          try {
            if (!fs.statSync(from).isFile() || fs.existsSync(to)) continue
            fs.renameSync(from, to); moved++
          } catch (e) { swallow(e, 'workspace-merge-file') }
        }
        if (moved > 0) console.log(`[workspace] 已从旧工作目录合并 ${moved} 个文件：${legacy} → ${dir}`)
      }
      configSet('workspaceMerged:v1', '1')
    } catch (e) { console.error('[workspace] 旧工作目录合并失败（下次启动重试）:', e) }
    workspaceMigrated = true
  }
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

// Office(OOXML) 本地兜底：docx/pptx/xlsx 本质是 zip+xml，用系统 unzip 抽出正文 xml 去标签取文本。
// 仅在服务端 docling 不可用时用——丢版式/表格结构，但拿得到文字，够"总结/分析附件"。老式二进制 .doc/.ppt/.xls 非 zip，不支持。
const OOXML_MEMBERS: Record<string, string[]> = {
  '.docx': ['word/document.xml'],
  '.pptx': ['ppt/slides/slide*.xml'],   // unzip 自身按通配匹配多张幻灯片 xml
  '.xlsx': ['xl/sharedStrings.xml'],     // 单元格文本主要在共享字符串表
}
function ooxmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<\/(w:p|a:p)>/g, '\n')            // docx/pptx 段落 → 换行
    .replace(/<(w:br|a:br)\b[^>]*\/?>/g, '\n')
    .replace(/<\/(si|t)>/g, ' ')                 // xlsx 共享字符串项 → 空格分隔
    .replace(/<[^>]+>/g, '')                      // 去所有标签
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
export async function extractOfficeLocal(absPath: string, ext: string): Promise<string> {
  const members = OOXML_MEMBERS[ext]
  if (!members) return ''
  try {
    const { stdout } = await pexecFile('unzip', ['-p', absPath, ...members], { maxBuffer: 48 * 1024 * 1024, encoding: 'utf-8' })
    return ooxmlToText(stdout)
  } catch { return '' }   // 无 unzip / 非法 zip → 交回上层报"未能解析"
}

// 文档解析：文本类直接读；复杂/二进制格式优先走服务端 docling，失败再本地兜底(PDF→pdfjs，docx/pptx/xlsx→unzip)。
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
    if (ext === '.docx' || ext === '.pptx' || ext === '.xlsx') return await extractOfficeLocal(absPath, ext)
    if (ext === '.html' || ext === '.htm') return fs.readFileSync(absPath, 'utf-8')
    return ''  // 老式 .doc/.ppt/.xls 二进制、图片 无本地兜底
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
// 迭代指代词（血泪：只收录「刚才」漏掉「刚刚」，一字之差整条兜底失效——同义词要收全）
export const ITER_INTENT = /(刚才|刚刚|方才|上面|上方|之前|上一[轮次条个]|这份|那份|这个|该文档|同一份|在原|基础上|继续|接着|续写|补充|追加|再加|加一?[节段章]|改一?下|修改|润色|调整|完善)/
// 文档操作动词 + 文档指称：如「格式化下 word 文件」「把这个 pdf 翻译一下」——没带指代词也显然在说已有文件
const DOC_OP = /(格式化|重?排版|转[成为]|翻译|校对|压缩|精简|扩写|重写)/
const DOC_REF = /(文档|文件|word|docx|pdf|ppt|pptx|表格|xlsx|附件)/i
/** 这句话是否在指认「已有文件」（迭代/加工意图）——决定要不要从产物索引/工作区兜底找输入。 */
export function refersToExistingDoc(content: string): boolean {
  const t = content || ''
  return ITER_INTENT.test(t) || (DOC_OP.test(t) && DOC_REF.test(t))
}

/** 消息里点名的文档类型 → 扩展名过滤：说「word 文件」就绝不把 PPT 挂上（真实翻车：
 *  上一轮同时产出 docx+pptx，兜底取"最新产物"拿到 PPT，格式化技能拿着 PPT 找 Word）。
 *  多个类型都被提到时取**先出现**的（「把word转成ppt」输入是 word）；没点名返回 null 不过滤。 */
export function wantedDocExts(content: string): RegExp | null {
  const t = (content || '').toLowerCase()
  const CANDS: [RegExp, RegExp][] = [
    [/word|docx?\b/, /\.docx?$/i],
    [/pptx?|演示文稿|幻灯片?/, /\.pptx?$/i],
    [/xlsx?|excel|csv/, /\.(xlsx?|csv)$/i],
    [/pdf/, /\.pdf$/i]
  ]
  let best: { idx: number; re: RegExp } | null = null
  for (const [m, re] of CANDS) {
    const i = t.search(m)
    if (i >= 0 && (!best || i < best.idx)) best = { idx: i, re }
  }
  return best ? best.re : null
}

/**
 * 从当前消息 + 会话上文里提取候选文件名（纯文本解析，不碰 fs）：
 *  ① 任意带文档扩展名的 token（裹在《》「」【】或裸露皆可，去掉包裹符）；
 *  ② 【附件】a、b（已加入工作空间）引用。
 * 近者优先、去重。这是"刚才那份"指代解析的第一路——单独导出以便单测（曾因只认固定话术而失效）。
 */
/** 解析消息里的附件名。新格式【附件】「a」「b」（已加入工作空间）——文件名用「」包住，
 *  因为旧格式拿顿号当多文件分隔符，文件名本身含顿号（如「A、B、C报告.docx」）会被剁碎，
 *  技能永远找不到输入文件。旧格式仍兼容解析（历史消息），碎片靠 resolveByFragment 兜底。
 *  渲染层 DialoguePanel.parseAttachments 有同构实现，改动需两边同步。 */
export function parseAttachmentNames(text: string): string[] {
  const m = (text || '').match(/【附件】([^\n]*?)（已加入工作空间）/)
  if (!m) return []
  const quoted = m[1].match(/「([^」]+)」/g)
  if (quoted && quoted.length) return quoted.map(s => s.slice(1, -1).trim()).filter(Boolean)
  return m[1].split(/、|,/).map(s => s.trim()).filter(Boolean)
}

/** 片段兜底：名字在工作区无精确命中时，找「文件名包含该片段」的真实文件
 * （旧格式附件名被顿号剁碎后，各碎片都指向同一个真实文件）。 */
function resolveByFragment(dir: string, fragment: string): string | null {
  const f = fragment.trim()
  if (f.length < 4) return null   // 太短的碎片（如"金融"）不猜，避免误挂无关文件
  try {
    const hits = fs.readdirSync(dir).filter(n => !n.startsWith('.') && n.includes(f))
    return hits.length ? hits[0] : null
  } catch { return null }
}

export function extractCandidateFilenames(content: string, history?: { role: string; content: string }[]): string[] {
  const names: string[] = []
  const push = (n: string) => { const t = n.trim().replace(/[《》「」【】'"]/g, ''); if (t && !names.includes(t)) names.push(t) }
  const scanFilenames = (text: string) => {
    const re = /[^\s《》「」【】、，,。；;:：]+?\.(?:docx?|pptx?|xlsx?|pdf|csv|md|txt)/gi
    const ms = (text || '').match(re)
    if (ms) ms.forEach(push)
  }
  const scanAttach = (text: string) => parseAttachmentNames(text).forEach(push)
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
  for (const n of names) {
    if (out.length >= 3) break
    if (take(n, path.join(dir, n))) continue
    // 精确名未命中 → 片段包含兜底（附件名含顿号被旧格式剁碎的场景）
    const real = resolveByFragment(dir, n)
    if (real) take(real, path.join(dir, real))
  }

  // 兜底：迭代意图 + 文本没解析出任何文件 → 先查产物索引（本会话最近产物，精确出处），
  // 索引无记录才退回整目录 mtime 猜测（旧启发式，输入/产物混池时可能拿错相邻任务的文件）。
  if (out.length === 0 && refersToExistingDoc(content)) {
    const extRe = wantedDocExts(content)   // 点名了类型就按类型过滤，别把 PPT 当 Word 挂上
    const convId = currentRun()?.runId || ''
    for (const a of recentConvArtifacts(convId)) {
      if (extRe && !extRe.test(a.name)) continue
      if (take(a.name, a.absPath)) break
    }
    if (out.length === 0) {
      const newest = newestDocFile(dir, extRe)
      if (newest) take(newest.name, newest.path)
    }
  }
  return out
}

/** 问答回复里嵌完整 HTML 文档时落盘成 .html 产物（正文只留说明，产物走文件卡）。
 *  血泪：用户说"用 html 做份介绍材料"，无技能可路由落进问答链，整屏源码直接糊在
 *  对话里——交付物必须是文件。守卫：完整文档（<html>+</html>、≥400 字）才落盘，
 *  教程里的小段示例代码不受影响。 */
export function materializeHtmlAnswer(content: string): { content: string; files?: { name: string; sizeBytes: number }[] } {
  const src = content || ''
  const m = src.match(/```html\s*\n([\s\S]*?)```/i) || src.match(/(<!DOCTYPE html>[\s\S]*<\/html>)/i)
  if (!m) return { content }
  const html = m[1].trim()
  if (!html || !/<html[\s>]/i.test(html) || !/<\/html>/i.test(html) || html.length < 400) return { content }
  const t = html.match(/<title>([^<]{1,60})<\/title>/i)
  const base = (t ? t[1].trim().replace(/[/\\:*?"<>|]/g, ' ').trim() : '') || '网页材料'
  const dir = workspaceDir()
  const name = uniqueArtifactName(dir, `${base}.html`)
  try {
    const abs = path.join(dir, name)
    fs.writeFileSync(abs, html, 'utf-8')
    registerArtifact({ name, absPath: abs, sizeBytes: Buffer.byteLength(html), source: '问答生成网页' })
  } catch (e) { swallow(e, 'materialize-html'); return { content } }
  const rest = src.replace(m[0], '').trim()
  const note = `已生成网页文件「${name}」，在下方文件卡「查看」即可浏览器打开预览。`
  return { content: rest ? `${rest}\n\n${note}` : note, files: [{ name, sizeBytes: Buffer.byteLength(html) }] }
}

/** 工作空间里按修改时间最新的文档文件（供"刚才那份"兜底解析）；extRe 非空时只认该类型。 */
function newestDocFile(dir: string, extRe?: RegExp | null): { name: string; path: string; mtime: number } | null {
  try {
    let best: { name: string; path: string; mtime: number } | null = null
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.') || !DOC_EXT.test(name)) continue
      if (extRe && !extRe.test(name)) continue
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
  const names = parseAttachmentNames(content)
  if (!names.length) return ''
  const dir = workspaceDir()
  const blocks: string[] = []
  const seen = new Set<string>()
  for (let name of names) {
    let abs = path.join(dir, name)
    if (!fs.existsSync(abs)) {
      // 片段包含兜底（旧格式附件名被顿号剁碎）
      const real = resolveByFragment(dir, name)
      if (real) { name = real; abs = path.join(dir, real) }
    }
    if (seen.has(abs)) continue   // 多个碎片解析到同一真实文件时只读一次
    seen.add(abs)
    if (!fs.existsSync(abs)) { blocks.push(`【${name}】未在工作空间找到该文件。`); continue }
    sendLog('acting', `[文档解析] 正在读取并解析附件：${name}`)
    try {
      let text = await extractFileText(abs)
      if (!text) {
        blocks.push(`【${name}】未能解析出文本（该文件可能是扫描件/图片型或空文档，服务端文档解析引擎也不可用）。请如实告知用户"暂时读不到这个附件的内容、无法据此总结"，并建议改传文本/PDF 或稍后重试；**绝对不要**用知识库里检索到的其它同名/相似文档冒充这个附件的内容来作答。`)
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
