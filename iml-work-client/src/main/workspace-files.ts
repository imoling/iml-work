// 工作空间与文档解析：工作目录定位/扫描、服务端 docling 解析、PDF 本地兜底、
// 附件文本抽取。只依赖 db/http/types 叶子模块；相关 IPC 编排留在 main.ts。
import path from 'path'
import os from 'os'
import { appDataRoot } from './app-paths'
import fs from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { configGet, configSet, convTitle } from './db'
import { getAdminBaseUrl, afetch } from './http'
import { type SendLog } from './types'
import { currentRun } from './automation-runtime'
import { recentConvArtifacts, registerArtifact, uniqueArtifactName } from './artifact-index'
import { swallow } from './util'
import { imageNamesInMessage, parseAttachmentNames } from '../shared/attachment'

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

/**
 * 按文件名解析工作空间里的绝对路径：先看根目录，再找会话子目录。
 *
 * 产物落进会话子目录后，用户/模型仍然会用**裸文件名**指代它（"把 报价单.docx 再改一版"），
 * 只按根目录拼路径就会"刚生成的文件立刻引用不到"。这个函数是所有"按名找文件"的单一入口。
 */
export function resolveWorkspaceFile(name: string): string | null {
  const clean = (name || '').trim()
  if (!clean) return null
  const root = workspaceDir()
  const direct = path.join(root, clean)
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct
  // 带目录前缀（scanWorkspace 给模型的就是这种）已被上面覆盖；这里按基名在子目录里找
  const base = path.basename(clean)
  const hit = scanWorkspace().find(f => path.basename(f.name) === base)
  return hit ? hit.path : null
}

/**
 * 会话产物目录：分身**生成**的东西归档到 `<工作目录>/<会话标题>-<短id>/`，
 * 用户自己放进来的素材仍留在根目录。
 *
 * 为什么不照搬"每会话一个沙箱目录"：iML 的工作空间语义是**员工的文件柜**（放进去的文档
 * 自动收录进个人知识库），跨会话可见是有意设计——"在上周那份报价单上改"这类迭代场景
 * 靠的就是它。物理隔离会把这条路打断。所以只隔离产物，不隔离素材。
 *
 * 目录名带 convId 后 4 位：标题会重复（"新对话"能有一打），带短 id 才唯一，
 * 且省掉"这个目录是不是本会话的"这种冲突检测。无会话上下文时退回根目录（保持旧行为）。
 */
export function convArtifactDir(convId: string): string {
  const root = workspaceDir()
  if (!convId) return root
  const raw = (convTitle(convId) || '').replace(/[\x00-\x1f<>:"/\\|?*]/g, '').trim()
  const safe = (raw || '会话').slice(0, 40)
  const dir = path.join(root, `${safe}-${convId.slice(-4)}`)
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) } catch (e) { swallow(e, 'conv-artifact-dir'); return root }
  return dir
}

/**
 * 实时扫描工作目录里的文件（供「工作空间」弹层展示与引用）。
 * **递归一层**：产物现在落在会话子目录里，只扫根目录的话模型就看不见自己刚生成的文件。
 * 子目录文件的 name 带上目录前缀（`报价单-a3f1/结果.docx`），read_file 能直接按它定位。
 */
export function scanWorkspace(): { name: string; path: string }[] {
  const dir = workspaceDir()
  const out: { name: string; path: string }[] = []
  const push = (name: string, abs: string) => { out.push({ name, path: abs }) }
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const abs = path.join(dir, entry.name)
      if (entry.isFile()) { push(entry.name, abs); continue }
      if (!entry.isDirectory()) continue
      try {
        for (const sub of fs.readdirSync(abs, { withFileTypes: true })) {
          if (sub.name.startsWith('.') || !sub.isFile()) continue
          push(`${entry.name}/${sub.name}`, path.join(abs, sub.name))
        }
      } catch (e) { swallow(e, 'scan-workspace-sub') }
    }
  } catch { return [] }
  return out.sort((a, b) => a.name.localeCompare(b.name))
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

/**
 * PDF 本地兜底解析（pdfjs 只抽文字流，丢表格/版式；仅在服务端 docling 不可用时用）。
 *
 * opts.page：只要某一页（1 基）。**页级定位是刚需**——"第 11 页倒数第二段的尾注"这类问题，
 * 把 40 页拼成一整段就永远答不出：模型既不知道页边界在哪，也没法只读那一页。
 * 不传则全文，并逐页打 `【第 N 页】` 分隔，让模型能自己定位。
 */
export async function extractPdfLocal(absPath: string, opts?: { page?: number }): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(fs.readFileSync(absPath))
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise

  const pageText = async (i: number): Promise<string> => {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    return tc.items.map((it: any) => ('str' in it ? it.str : '')).join(' ')
  }

  // 指定页：越界如实说明并给出总页数，别默默返回空或首页（模型会拿错页当答案）
  if (opts?.page) {
    const n = Math.floor(opts.page)
    if (n < 1 || n > doc.numPages) return `（该 PDF 共 ${doc.numPages} 页，没有第 ${n} 页）`
    return `【第 ${n} 页 / 共 ${doc.numPages} 页】\n${(await pageText(n)).trim()}`
  }

  const maxPages = Math.min(doc.numPages, 40)
  let out = ''
  for (let i = 1; i <= maxPages; i++) {
    out += `【第 ${i} 页】\n${await pageText(i)}\n`
  }
  if (doc.numPages > maxPages) {
    out += `\n…（共 ${doc.numPages} 页，仅解析前 ${maxPages} 页；要看后面的页请指定页码）`
  }
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

/**
 * 单个待解析文件的体积上限。超限直接拒绝，不做"先读进来再说"：
 * parseViaBackend 会 readFileSync 整个文件再上传，几百 MB 的文件足以让主进程 OOM，
 * 而解析出来的文本也必然远超任何上下文窗口。宁可明确告知读不了，也不要静默卡死。
 */
const MAX_PARSE_BYTES = 20 * 1024 * 1024

/** 从 URL / Content-Disposition 推断文件名并消毒（只留末段基名，杜绝 ../ 穿越与控制字符）。 */
function safeFileNameFrom(url: string, disposition: string | null): string {
  let raw = ''
  const m = (disposition || '').match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)
  if (m) { try { raw = decodeURIComponent(m[1]) } catch { raw = m[1] } }
  if (!raw) {
    try { raw = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '') } catch { raw = '' }
  }
  raw = path.basename(raw || '').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').trim()
  if (!raw || raw === '.' || raw === '..') raw = `下载文件-${Date.now()}`
  return raw.slice(0, 120)
}

/** 按 Content-Type 兜底补扩展名——没有扩展名 extractFileText 认不出格式，等于下了个读不了的文件。 */
function extFromContentType(ct: string): string {
  const t = (ct || '').toLowerCase()
  if (t.includes('pdf')) return '.pdf'
  if (t.includes('wordprocessingml')) return '.docx'
  if (t.includes('presentationml')) return '.pptx'
  if (t.includes('spreadsheetml')) return '.xlsx'
  if (t.includes('csv')) return '.csv'
  if (t.includes('json')) return '.json'
  if (t.includes('html')) return '.html'
  if (t.includes('text/plain')) return '.txt'
  return ''
}

/**
 * 把一个网络文件下载进工作空间，返回落地文件名。
 *
 * 为什么必须**裸 fetch 而不是 afetch**：afetch 会自动附带企业 JWT（authHeaders），
 * 拿它去下载任意第三方 URL 等于把员工登录态送给对方站点——红线。这里只发匿名请求。
 *
 * 落工作空间而非临时目录：用户在「文件」页能看见分身下载了什么（可审计），
 * 后续 read_file / 技能也能直接复用同一份文件，不必重下。
 */
/**
 * base64 直接落工作空间（少数上游只回 b64 不给直链）。
 * 与下载走同一套归档：会话子目录 + 重名防覆盖 + 产物索引，产物在文件卡里的表现完全一致。
 */
export function saveBase64ToWorkspace(b64: string, fallbackName: string, source: string): { name: string; absPath: string; sizeBytes: number } {
  const buf = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64')
  const dir = convArtifactDir(currentRun()?.runId || '')
  const name = uniqueArtifactName(dir, fallbackName)
  const absPath = path.join(dir, name)
  fs.writeFileSync(absPath, buf)
  registerArtifact({ name, absPath, sizeBytes: buf.length, source })
  return { name, absPath, sizeBytes: buf.length }
}

export async function downloadToWorkspace(
  url: string,
  sendLog?: SendLog,
  opts?: { maxBytes?: number; source?: string },
): Promise<{ name: string; absPath: string; sizeBytes: number } | { error: string }> {
  // 默认沿用解析上限（下载多是为了读）；生成的视频远大于文档，由调用方显式放宽。
  const cap = opts?.maxBytes || MAX_PARSE_BYTES
  let u: URL
  try { u = new URL(url) } catch { return { error: '不是合法的 URL' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: `只支持 http/https，收到 ${u.protocol}` }

  sendLog?.('acting', `[下载] ${url.slice(0, 90)}`)
  let res: Response
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) })
  } catch (e: any) {
    return { error: `下载失败：${e?.message || e}` }
  }
  if (!res.ok) return { error: `下载失败：HTTP ${res.status}` }

  // 先看声明长度快速拒绝；没有声明的边读边计数，绝不"先下完再说"（几百 MB 足以打爆内存）
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared && declared > cap) {
    return { error: `文件 ${(declared / 1024 / 1024).toFixed(1)}MB，超过 ${cap / 1024 / 1024}MB 上限，未下载` }
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > cap) {
    return { error: `文件 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过 ${cap / 1024 / 1024}MB 上限，已丢弃` }
  }

  const ct = res.headers.get('content-type') || ''
  let name = safeFileNameFrom(url, res.headers.get('content-disposition'))
  if (!path.extname(name)) name += extFromContentType(ct)

  // 下载来的文档同样算本次会话的产物，归档进会话子目录
  const dir = convArtifactDir(currentRun()?.runId || '')
  name = uniqueArtifactName(dir, name)
  const absPath = path.join(dir, name)
  try { fs.writeFileSync(absPath, buf) } catch (e: any) { return { error: `写入工作空间失败：${e?.message || e}` } }

  registerArtifact({ name, absPath, sizeBytes: buf.length, source: opts?.source || 'download' })
  sendLog?.('observing', `[下载] 已保存到工作空间：${name}（${(buf.length / 1024).toFixed(0)}KB）`)
  return { name, absPath, sizeBytes: buf.length }
}

/**
 * 文档解析：文本类直接读；复杂/二进制格式优先走服务端 docling，失败再本地兜底(PDF→pdfjs，docx/pptx/xlsx→unzip)。
 *
 * opts.page：只对 PDF 有意义——指定页时**跳过 docling 直接走 pdfjs**。docling 返回的是整篇
 * Markdown、没有页边界，拿它没法只给某一页；而"第 N 页的某段"正是要页级定位的场景。
 */
export async function extractFileText(absPath: string, opts?: { page?: number }): Promise<string> {
  const ext = path.extname(absPath).toLowerCase()
  try {
    const size = fs.statSync(absPath).size
    if (size > MAX_PARSE_BYTES) {
      const mb = (size / 1024 / 1024).toFixed(1)
      return `（该文件 ${mb}MB，超过 ${MAX_PARSE_BYTES / 1024 / 1024}MB 解析上限，未读取。请拆分后再试，或告知用户改用更小的文件。）`
    }
  } catch (e) { swallow(e, 'extract-size-check') }
  // 纯文本类：直读最快，无需绕服务端
  if (['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml'].includes(ext)) {
    return fs.readFileSync(absPath, 'utf-8')
  }
  // 指定页码：只有 pdfjs 能按页取，docling 的整篇 Markdown 没有页边界
  if (opts?.page && ext === '.pdf') return await extractPdfLocal(absPath, { page: opts.page })
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
/** 消息里能识别的图片扩展名（与 llm.ts 出站时支持的 MIME 保持一致，两处不一致会"收集到却发不出去"）。 */

/**
 * 本轮消息点名的**图片**文件（工作空间内的绝对路径），供多模态出站给视觉模型看。
 *
 * 与附件正文（extractAttachmentText）的关系：那条路把图片交给 docling 做 OCR 拿文字，
 * 这条路把原图交给视觉模型看版面。**两者并存是有意的**——OCR 给准确文字（截图里的数字/单号），
 * 视觉给版面理解（这是张什么表、红框圈的是哪一项），互补而非重复。
 */
export function collectMessageImages(content: string, opts?: { includeMentions?: boolean }): string[] {
  const out: string[] = []
  // 两个来源的**授权含义完全不同**，不能一起开关：
  //   · 【附件】块 = 用户这一轮亲手递过来的文件，本身就是"你看一下"的明确意图；
  //   · 正文里的裸提及（"看下 报错截图.png"）= 让模型去工作空间里找，属于翻文件。
  // 以前两者一起被"工作空间访问"开关挡掉，结果用户关掉开关后连自己发的图都不看，
  // 模型只拿到一个文件名，就写 python 去沙箱里满世界找（实测截图 2026-08-03）。
  for (const n of imageNamesInMessage(content, opts)) {
    const abs = resolveWorkspaceFile(n)
    if (abs && !out.includes(abs)) out.push(abs)
  }
  return out.slice(0, 4)   // 与出站侧 IMAGE_MAX_PER_MSG 对齐，多收集也是白收
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
  const dir = workspaceDir()   // 仅用于「防逃逸」判定；按名取文件走 resolveWorkspaceFile（会找子目录）
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
    // 按名解析走 resolveWorkspaceFile：产物在会话子目录里，只拼根目录会"刚生成就引用不到"
    const hit = resolveWorkspaceFile(n)
    if (hit && take(n, hit)) continue
    // 精确名未命中 → 片段包含兜底（附件名含顿号被旧格式剁碎的场景）
    const real = resolveByFragment(dir, n)
    if (real) take(real, resolveWorkspaceFile(real) || path.join(dir, real))
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
  const dir = convArtifactDir(currentRun()?.runId || '')   // 抓存的网页材料也是本次会话的产物
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
  const blocks: string[] = []
  const seen = new Set<string>()
  for (let name of names) {
    const dir = workspaceDir()
    let abs = resolveWorkspaceFile(name) || path.join(dir, name)
    if (!fs.existsSync(abs)) {
      // 片段包含兜底（旧格式附件名被顿号剁碎）
      const real = resolveByFragment(dir, name)
      if (real) { name = real; abs = resolveWorkspaceFile(real) || path.join(dir, real) }
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
