// P1 工具集：把现有能力薄封装成 agent 循环可临场调用的工具。
// 全是**只读/只算**工具（web_search / python / read_page）——自主执行安全，写操作不在此列
//（业务系统写仍走确认+一次性令牌闸）。P2 加 read_file、P3 加 browse，只需往这里加 make* 工厂。
import fs from 'fs'
import path from 'path'
import type { AgentTool } from './agent-loop'
import type { LlmConfig } from './llm'
import { webSearch, outcomeBlock, fetchOnePage } from './web-search'
import { execViaBackendSandbox, extractSandboxPackages, saveSandboxFiles } from './skill-exec'
import { sourceTier } from './web-search-core'
import { workspaceDir, scanWorkspace, extractFileText, downloadToWorkspace } from './workspace-files'
import { swallow } from './util'
import { makeBrowseTool } from './agent-browse'

// read_file 单次返回的字符上限。附件自动注入那条路径用 9000（保守，因为是无条件注入），
// 这里放宽到 12000：模型是**明确要读这份文件**才调的工具，给太少会逼它反复重读。
const READ_FILE_CAP = 12000

/** 联网来源收集回调：结果卡的「联网来源」列表要用（不收集就只进文本、UI 上消失——实测反馈）。 */
export type OnWebSources = (sources: { title: string; url: string }[]) => void

/** web_search：联网检索（复用已调优的 webSearch：多引擎代理 + 深读 + 信源分级）。
 *  默认**轻检索**（只有结果列表+摘要，秒级）：长尾事实题的标题+摘要往往已够作答（合成纪律
 *  本就承认摘要是有效素材），没必要每次都付 4~6 篇深读正文的 20s+。要正文时模型传 deep=true
 *  （命中缓存则只补深读、不重新检索），或对单条结果用 read_page。 */
export function makeWebSearchTool(cfg: LlmConfig, onSources?: OnWebSources): AgentTool {
  return {
    name: 'web_search',
    description: '联网检索一个查询词，返回结果的标题/摘要/链接。默认轻检索（只有结果列表，快）——标题与摘要已能回答就直接作答；确需通读网页正文（综述/多数字核对/近期动态汇总）时传 deep="true" 同时取回头部网页正文，或对最相关的一条结果用 read_page。用于查具体事实、人名、日期、数据。一次只查一个明确的问题；需要多个事实就分多步查。',
    argsHint: '{"query":"具体检索词（越具体越好，可含实体名/年份）","deep":"是否深读正文：默认 false（只要结果列表，快）；需要通读网页正文再答时传 true"}',
    run: async (args, sendLog) => {
      const q = String(args.query || '').trim()
      if (!q) return '（web_search 需要 query 参数）'
      const deep = args.deep === true || String(args.deep).trim().toLowerCase() === 'true'
      const r = await webSearch(q, sendLog, cfg, { mode: deep ? 'deep' : 'light' })
      if (!r.results.length) return `检索「${q}」未返回结果（可能网络受限或该问法太偏），换个更具体/更常见的说法再试。`
      // 深读过正文的页面优先（真正被引用的来源），一条没有就退回结果列表头部
      const src = (r.pages.length ? r.pages : r.results.slice(0, 5)).map(x => ({ title: x.title || x.url, url: x.url }))
      if (src.length) onSources?.(src)
      const block = outcomeBlock(`检索「${q}」的结果`, r)
      // 轻检索要显式告知"这只是摘要层"：不说明的话，模型可能把"没有正文"当成"查过了没查到"
      return r.pages.length
        ? block
        : `${block}\n\n（轻检索：以上为结果列表与摘要。摘要已能回答就直接作答并标注来源；不够时对最相关的链接用 read_page 读正文，或再调一次 web_search 传 deep="true" 补正文。）`
    },
  }
}

/**
 * python：把代码送后端一次性沙箱执行（网络隔离），返回 stdout/stderr + 产出文件。
 *
 * 描述里必须写明两条**运行时约定**，否则模型只能猜（实测猜错的代价）：
 * ① 每次调用都是全新容器——模型把 PPT 存进 /tmp，下一次调用去读就 FileNotFoundError；
 * ② 产物只有写进 /out 才会被回传——它辛苦生成了 46KB 的 pptx，然后告诉用户"沙箱限制无法下载"。
 * onFiles：把回传的产物落进工作空间并告知调用方（旧实现直接丢弃 res.files，文件等于白生成）。
 */
export function makePythonTool(onFiles?: (files: { name: string; sizeBytes: number }[]) => void): AgentTool {
  return {
    name: 'python',
    description: '在隔离沙箱里运行一段 Python 代码，返回它 print 的输出。用于任何算术/计数/求和/日期差/排序/数据处理——务必用它真算，不要心算。'
      + '\n【重要 · 沙箱约定】① 每次调用都是**全新的一次性容器**，上一次留下的文件、变量、装的包都不在了，需要什么就在本次代码里一次做完；'
      + '② 要交给用户的产出文件**必须保存到 /out 目录**（如 /out/报告.pptx），只有 /out 里的文件会被取回并交付；存到 /tmp 或当前目录的文件会随容器一起消失。'
      + '③ 沙箱无网络，不能联网取数；装依赖包需在出网白名单内。'
      + '\n注意：生成 PPT/Word/Excel 这类**交付文件**，优先用 run_skill 调对应技能（它们带排版模板与成熟脚本，效果远好于临场手写）；python 用于计算与数据处理。',
    argsHint: '{"code":"print(1927 + 62)"}',
    run: async (args) => {
      const code = String(args.code || '')
      if (!code.trim()) return '（python 需要 code 参数）'
      const pkgs = extractSandboxPackages(code)
      const res = await execViaBackendSandbox(code, pkgs, {})
      if (!res) return '沙箱不可用或执行失败（后端未配置沙箱/网络问题）。'
      if (!res.ok) return `执行报错：${res.error || ''}\nstderr:\n${(res.stderr || '').slice(0, 600)}`
      const out = (res.stdout || '').trim()
      // 产物落地：旧实现整个丢弃了 res.files，模型生成的文件根本到不了用户手上。
      let fileLine = ''
      if (res.files?.length) {
        const saved = saveSandboxFiles(res.files, 'python')
        if (saved.length) {
          onFiles?.(saved)
          fileLine = `\n已产出文件并交付给用户：${saved.map(f => f.name).join('、')}`
          // 文本类产物读回节选：模型不知道文件里最终写了什么，交付时只会说"已生成 CSV"——
          // 用户还得自己点开看（实测反馈）。带上真实内容，并要求正文先概述再给文件。
          const textFile = saved.find(f => /\.(csv|md|markdown|txt|json)$/i.test(f.name))
          if (textFile) {
            try {
              const raw = fs.readFileSync(path.join(workspaceDir(), textFile.name), 'utf-8')
              fileLine += `\n【产物「${textFile.name}」的真实内容节选】\n${raw.slice(0, 1200)}\n`
                + '【交付纪律】向用户交付时，先用几句话（或一个小表格）概述文件里的关键内容，再提文件本身；'
                + '概述只依据上面的真实节选，不要只说"已生成文件"。'
            } catch (e) { swallow(e, 'python-peek') }
          }
        }
      }
      if (out) return `stdout:\n${out}${fileLine}`
      return fileLine
        ? fileLine.trim()
        : '（代码执行成功但没有 print 任何输出，也没有产出文件——要给用户的文件请存到 /out 目录）'
    },
  }
}

/** read_page：直接抓取一个已知 URL 的正文。
 *  ⚠️ 别退回"拿 URL 当检索词再走一遍 webSearch"的老写法——那样一次要 23 秒（搜索+排序+深读 N 篇），
 *  而这里要的只是这一页。fetchOnePage 复用同一套引擎降级链，省掉整条检索链路。 */
export function makeReadPageTool(onSources?: OnWebSources): AgentTool {
  return {
    name: 'read_page',
    description: '读取一个具体网页 URL 的正文内容。当 web_search 结果里某条链接看起来正好有答案、但摘要不够时，用它取该页更完整的正文。',
    argsHint: '{"url":"https://..."}',
    run: async (args, sendLog) => {
      const url = String(args.url || '').trim()
      if (!/^https?:\/\//i.test(url)) return '（read_page 需要合法的 http(s) URL）'
      const r = await fetchOnePage(url, sendLog)
      if (r.text) {
        onSources?.([{ title: url, url }])
        return `【${url}｜信源级别：${sourceTier(url)}】\n${r.text}`
      }
      return `未能读取该页正文（${r.error}）。可以换一条搜索结果里的链接再试，或改用 web_search 换个检索词。`
    },
  }
}

/** read_file（P2）：读取工作空间内一个文件的内容（docling 解析 xlsx/pdf/docx/pptx/csv/图片OCR，本地兜底）。
 *  任务附带了数据文件、需要从中取数/查值/计算时用它。安全：只允许读工作空间内文件（防目录穿越）。 */
export function makeReadFileTool(): AgentTool {
  return {
    name: 'read_file',
    description: '读取工作空间里一个文件的内容（xlsx/pdf/docx/pptx/csv/txt/图片OCR…），返回其文本与表格。当任务附带了数据文件、需要从中取数/查值/统计时用它；读回内容后如需计算再用 python。'
      + 'PDF 很长时可传 page 只看某一页（如要查"第 11 页"的内容）——不传则返回全文并逐页标注页码。',
    argsHint: '{"path":"文件名（工作空间内，如 data.xlsx）","page":"可选，只看第几页（PDF）"}',
    run: async (args) => {
      const raw = String(args.path || '').trim()
      if (!raw) return '（read_file 需要 path 参数）'
      const wsRoot = path.resolve(workspaceDir())
      const abs = path.resolve(wsRoot, raw)
      if (abs !== wsRoot && !abs.startsWith(wsRoot + path.sep)) return '只能读取工作空间内的文件。'
      if (!fs.existsSync(abs)) {
        const avail = scanWorkspace().map(f => f.name).slice(0, 20)
        return `文件「${raw}」不存在。工作空间可用文件：${avail.join('、') || '（空）'}`
      }
      const pageNum = Number(args.page) || 0
      const text = await extractFileText(abs, pageNum > 0 ? { page: pageNum } : undefined)
      if (!text || !text.trim()) return `未能解析「${raw}」的内容（不支持的格式或空文件；老式 .doc/.ppt/.xls 二进制不支持，请转新格式）。`
      // 工具结果整段进上下文：一份几十页的 PDF 解析出十几万字符，不截断就是一次把窗口撑爆
      // （其余两个消费端早有截断，唯独这条模型主动调用的路径没有）。截断要**显式告知模型**，
      // 否则它会把残缺内容当全文，去断言"文档里没有提到 X"。
      if (text.length > READ_FILE_CAP) {
        return `【文件 ${raw} 的内容（前 ${READ_FILE_CAP} 字，全文约 ${text.length} 字，已截断）】\n${text.slice(0, READ_FILE_CAP)}\n`
          + `\n（以上仅为前半部分。这是 PDF 的话，可以再调一次 read_file 并传 page 精确读某一页；`
          + `否则请如实告诉用户这份文档超长、你只读到了前 ${READ_FILE_CAP} 字，不要就未读到的部分下结论。）`
      }
      return `【文件 ${raw} 的内容${pageNum > 0 ? ` · 第 ${pageNum} 页` : ''}】\n${text}`
    },
  }
}

/**
 * fetch_document（P2）：把网上的文档拉进工作空间并解析成文本。
 *
 * 补的是一个**断链**：web_search 搜到 `https://…/report.pdf` 之后，read_page 只会用浏览器抓
 * HTML 正文（PDF 抓不到文字），read_file 又只读工作空间内已有的文件——于是"搜到了 PDF 却读不了"，
 * 一整类"下载报告/白皮书/年报再回答"的任务就此断掉（GAIA 实测两道题栽在这）。
 *
 * page 参数直通 pdfjs 的页级定位：问"第 11 页倒数第二段的尾注"时，把 40 页拼成一段是答不出的。
 */
export function makeFetchDocumentTool(): AgentTool {
  return {
    name: 'fetch_document',
    description: '下载一个网络文档（PDF/Word/Excel/PPT/CSV/TXT…）到工作空间并读出其文本内容。'
      + '当检索结果里的链接指向文档文件（尤其是 .pdf），或用户直接给了文档链接时用它——read_page 只能读网页正文，读不了 PDF。'
      + '文档很长时可传 page 只看某一页（仅 PDF 有效），比如要查"第 11 页"的内容。',
    argsHint: '{"url":"https://example.com/report.pdf","page":"可选，只看第几页（PDF）"}',
    run: async (args, sendLog) => {
      const url = String(args.url || '').trim()
      if (!url) return '（fetch_document 需要 url 参数）'
      const got = await downloadToWorkspace(url, sendLog)
      if ('error' in got) return `未能获取该文档：${got.error}`

      const pageNum = Number(args.page) || 0
      const text = await extractFileText(got.absPath, pageNum > 0 ? { page: pageNum } : undefined)
      if (!text || !text.trim()) {
        return `已下载「${got.name}」到工作空间，但未能解析出文本`
          + `（可能是扫描件/图片型 PDF，或老式 .doc/.ppt/.xls 二进制格式）。请如实告知用户读不到内容，不要臆测其内容。`
      }
      const head = `【已下载并解析「${got.name}」${pageNum > 0 ? ` · 第 ${pageNum} 页` : ''}】\n`
      // 与 read_file 同一个截断纪律：整段进上下文，不截断就是一次把窗口撑爆
      if (text.length > READ_FILE_CAP) {
        return head + text.slice(0, READ_FILE_CAP)
          + `\n\n（全文约 ${text.length} 字，以上为前 ${READ_FILE_CAP} 字。要看后面的内容，请用 fetch_document 指定 page，或用 read_file 读工作空间里的「${got.name}」。）`
      }
      return head + text
    },
  }
}

/** 工作空间可用文件清单（供 agent 任务上下文告知有哪些文件可 read_file）。 */
export function workspaceFileList(): string[] {
  try { return scanWorkspace().map(f => f.name) } catch { return [] }
}

/** P1 默认只读工具集（web_search + python + read_page + fetch_document）。
 *  fetch_document 属于 P1：检索型任务撞到 PDF 链接是常态，没有它整条链在那里就断了。 */
export function defaultP1Tools(cfg: LlmConfig): AgentTool[] {
  return [makeWebSearchTool(cfg), makePythonTool(), makeReadPageTool(), makeFetchDocumentTool()]
}

/** P2 工具集：P1 + read_file（任务附带文件时用）。 */
export function defaultP2Tools(cfg: LlmConfig): AgentTool[] {
  return [makeWebSearchTool(cfg), makePythonTool(), makeReadPageTool(), makeReadFileTool(), makeFetchDocumentTool()]
}

/** P3 工具集：P2 + browse（开放式浏览器操作，WebArena 类任务用）。
 *  ⚠️ browse 依赖真实 Electron 离屏窗口，在桩了 electron 的 bench harness 里不可用——
 *  需真实 Electron E2E harness 才能端到端跑（见 docs/arch-general-agent-loop.md P3）。
 *  browseOpts.partition：指令命中已登记业务系统时传 `persist:bizsys-<id>`，让 browse **复用该系统登录态**
 *  （「打开讯飞OA看待办」这类裸 browse 任务不卡登录页）；开放网页任务不传，用默认 `agent-browse` 无登录态分区。 */
export function defaultP3Tools(cfg: LlmConfig, browseOpts?: { partition?: string }): AgentTool[] {
  return [makeWebSearchTool(cfg), makePythonTool(), makeReadPageTool(), makeReadFileTool(), makeFetchDocumentTool(), makeBrowseTool(browseOpts)]
}

/** 企业系统 browse 专用工具集：只给 browse（带该系统登录态）+ python（计数/统计），**不含 web_search/read_page/read_file**。
 *  为什么收敛：操作内部业务系统不该联网检索——曾致 agent 拿内部 URL（portal.example.com/?ticket=…）去 web_search、
 *  "联网接口不通"又退到"用浏览器联网搜索"，65 步/337 秒过程混乱且答非所问（用户实测「看讯飞OA考勤」教训）。
 *  焦点收窄到"在这个系统里读页面 + 需要时算个数"，干净、快、不跑偏。
 *  ⚠️ onWriteConfirm 必传（体检 P1-2）：读路径挂了真实企业登录态，词表误判"读"时模型仍可能点到写按钮——
 *  工具层写前签字是最后一道闸，不依赖路由词表判对。 */
export function enterpriseBrowseTools(browseOpts?: { partition?: string; onWriteConfirm?: import('./agent-browse').WriteConfirm }): AgentTool[] {
  return [makeBrowseTool(browseOpts), makePythonTool()]
}
