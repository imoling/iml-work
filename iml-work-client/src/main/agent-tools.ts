// P1 工具集：把现有能力薄封装成 agent 循环可临场调用的工具。
// 全是**只读/只算**工具（web_search / python / read_page）——自主执行安全，写操作不在此列
//（业务系统写仍走确认+一次性令牌闸）。P2 加 read_file、P3 加 browse，只需往这里加 make* 工厂。
import fs from 'fs'
import path from 'path'
import type { AgentTool } from './agent-loop'
import type { LlmConfig } from './llm'
import { webSearch, outcomeBlock } from './web-search'
import { execViaBackendSandbox, extractSandboxPackages } from './skill-exec'
import { sourceTier } from './web-search-core'
import { workspaceDir, scanWorkspace, extractFileText } from './workspace-files'
import { makeBrowseTool } from './agent-browse'

/** web_search：联网检索（复用已调优的 webSearch：多引擎代理 + 深读 + 信源分级）。 */
export function makeWebSearchTool(cfg: LlmConfig): AgentTool {
  return {
    name: 'web_search',
    description: '联网检索一个查询词，返回若干结果的标题/摘要/链接，以及头部网页的正文节选。用于查具体事实、人名、日期、数据。一次只查一个明确的问题；需要多个事实就分多步查。',
    argsHint: '{"query":"具体检索词（越具体越好，可含实体名/年份）"}',
    run: async (args, sendLog) => {
      const q = String(args.query || '').trim()
      if (!q) return '（web_search 需要 query 参数）'
      const r = await webSearch(q, sendLog, cfg)
      if (!r.results.length) return `检索「${q}」未返回结果（可能网络受限或该问法太偏），换个更具体/更常见的说法再试。`
      return outcomeBlock(`检索「${q}」的结果`, r)
    },
  }
}

/** python：把代码送后端一次性沙箱执行（网络隔离），返回 stdout/stderr。用于计算/计数/求和/日期差/数据处理。 */
export function makePythonTool(): AgentTool {
  return {
    name: 'python',
    description: '在隔离沙箱里运行一段 Python 代码并返回它 print 的输出。用于任何算术/计数/求和/日期差/排序/数据处理——务必用它真算，不要心算。代码要 print 出最终结果。沙箱无网络，不能联网取数。',
    argsHint: '{"code":"print(1927 + 62)"}',
    run: async (args) => {
      const code = String(args.code || '')
      if (!code.trim()) return '（python 需要 code 参数）'
      const pkgs = extractSandboxPackages(code)
      const res = await execViaBackendSandbox(code, pkgs, {})
      if (!res) return '沙箱不可用或执行失败（后端未配置沙箱/网络问题）。'
      if (!res.ok) return `执行报错：${res.error || ''}\nstderr:\n${(res.stderr || '').slice(0, 600)}`
      const out = (res.stdout || '').trim()
      return out ? `stdout:\n${out}` : '（代码执行成功但没有 print 任何输出——请在代码里 print 出你要的结果）'
    },
  }
}

/** read_page：抓取一个已知 URL 的正文（复用 webSearch 的深读链路对该站再查一次并取正文）。
 *  轻量实现：以 URL 作为检索词能把该页拉回并深读；P3 的 browse 工具会提供真正的 goto+read。 */
export function makeReadPageTool(cfg: LlmConfig): AgentTool {
  return {
    name: 'read_page',
    description: '读取一个具体网页 URL 的正文内容。当 web_search 结果里某条链接看起来正好有答案、但摘要不够时，用它取该页更完整的正文。',
    argsHint: '{"url":"https://..."}',
    run: async (args, sendLog) => {
      const url = String(args.url || '').trim()
      if (!/^https?:\/\//i.test(url)) return '（read_page 需要合法的 http(s) URL）'
      const r = await webSearch(url, sendLog, cfg)
      const page = r.pages.find(p => p.url === url) || r.pages[0]
      if (page && page.text) return `【${page.title || url}｜信源级别：${page.tier || sourceTier(page.url)}】\n${page.text}`
      const hit = r.results.find(x => x.url === url) || r.results[0]
      if (hit) return `未能取到该页全文，仅有摘要：\n${hit.title}\n${hit.snippet}`
      return `未能读取该 URL 的内容（可能反爬或已失效）。`
    },
  }
}

/** read_file（P2）：读取工作空间内一个文件的内容（docling 解析 xlsx/pdf/docx/pptx/csv/图片OCR，本地兜底）。
 *  任务附带了数据文件、需要从中取数/查值/计算时用它。安全：只允许读工作空间内文件（防目录穿越）。 */
export function makeReadFileTool(): AgentTool {
  return {
    name: 'read_file',
    description: '读取工作空间里一个文件的内容（xlsx/pdf/docx/pptx/csv/txt/图片OCR…），返回其文本与表格。当任务附带了数据文件、需要从中取数/查值/统计时用它；读回内容后如需计算再用 python。',
    argsHint: '{"path":"文件名（工作空间内，如 data.xlsx）"}',
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
      const text = await extractFileText(abs)
      if (!text || !text.trim()) return `未能解析「${raw}」的内容（不支持的格式或空文件；老式 .doc/.ppt/.xls 二进制不支持，请转新格式）。`
      return `【文件 ${raw} 的内容】\n${text}`
    },
  }
}

/** 工作空间可用文件清单（供 agent 任务上下文告知有哪些文件可 read_file）。 */
export function workspaceFileList(): string[] {
  try { return scanWorkspace().map(f => f.name) } catch { return [] }
}

/** P1 默认只读工具集（web_search + python + read_page）。 */
export function defaultP1Tools(cfg: LlmConfig): AgentTool[] {
  return [makeWebSearchTool(cfg), makePythonTool(), makeReadPageTool(cfg)]
}

/** P2 工具集：P1 + read_file（任务附带文件时用）。 */
export function defaultP2Tools(cfg: LlmConfig): AgentTool[] {
  return [makeWebSearchTool(cfg), makePythonTool(), makeReadPageTool(cfg), makeReadFileTool()]
}

/** P3 工具集：P2 + browse（开放式浏览器操作，WebArena 类任务用）。
 *  ⚠️ browse 依赖真实 Electron 离屏窗口，在桩了 electron 的 bench harness 里不可用——
 *  需真实 Electron E2E harness 才能端到端跑（见 docs/arch-general-agent-loop.md P3）。
 *  browseOpts.partition：指令命中已登记业务系统时传 `persist:bizsys-<id>`，让 browse **复用该系统登录态**
 *  （「打开讯飞OA看待办」这类裸 browse 任务不卡登录页）；开放网页任务不传，用默认 `agent-browse` 无登录态分区。 */
export function defaultP3Tools(cfg: LlmConfig, browseOpts?: { partition?: string }): AgentTool[] {
  return [makeWebSearchTool(cfg), makePythonTool(), makeReadPageTool(cfg), makeReadFileTool(), makeBrowseTool(browseOpts)]
}

/** 企业系统 browse 专用工具集：只给 browse（带该系统登录态）+ python（计数/统计），**不含 web_search/read_page/read_file**。
 *  为什么收敛：操作内部业务系统不该联网检索——曾致 agent 拿内部 URL（in.iflytek.com/?ticket=…）去 web_search、
 *  "联网接口不通"又退到"用浏览器联网搜索"，65 步/337 秒过程混乱且答非所问（用户实测「看讯飞OA考勤」教训）。
 *  焦点收窄到"在这个系统里读页面 + 需要时算个数"，干净、快、不跑偏。 */
export function enterpriseBrowseTools(browseOpts?: { partition?: string }): AgentTool[] {
  return [makeBrowseTool(browseOpts), makePythonTool()]
}
