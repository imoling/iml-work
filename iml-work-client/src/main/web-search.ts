// 联网检索：内置 Tavily / Bing API 及 Electron 离屏页面抓取，供分身判定需联网时补充事实。
import { BrowserWindow } from 'electron'
import { getAdminBaseUrl, afetch } from './http'
import { callLlm, type LlmConfig } from './llm'
import { swallow, sleep } from './util'
import type { SendLog } from './types'

interface WebSearchResult { title: string; url: string; snippet: string }
interface WebPage { url: string; title: string; text: string }
interface WebSearchOutcome { query: string; results: WebSearchResult[]; pages: WebPage[] }

// 外部/后端 JSON 解析边界的窄形状（字段可空，取用即兜底），避免 `any` 掩盖字段拼写/结构错误。
interface SearchConfigResp { provider?: string; maxResults?: number; deepReadCount?: number; browserEngine?: string }
interface RawResult { title?: string; url: string; snippet?: string }
interface RawPage { url: string; title?: string; text?: string }
interface ProxySearchResp { provider?: string; results?: RawResult[]; pages?: RawPage[] }
interface EnterpriseResp { companyName?: string }
interface ExpertResp { webSearchEnabled?: boolean }

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
  } catch (e) { swallow(e) }
  return href
}

// 通用离屏抓取：打开 url，等待渲染后执行一段 DOM 提取脚本，返回其结果。
function offscreenExtract<T>(url: string, extractJs: string, waitMs = 1800, timeoutMs = 18000): Promise<T | null> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { offscreen: true } })
    let settled = false
    const done = (val: T | null) => {
      if (settled) return
      settled = true
      try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
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

// 检索通道选择配置（不含密钥——密钥留后端，检索经 /api/v1/search 代理）。
interface SearchCfg { provider: string; maxResults: number; deepReadCount: number; browserEngine: string }

// 拉取管理端检索服务配置（仅通道/条数等，apiKey 已不下发）。
async function getSearchConfig(): Promise<SearchCfg> {
  const fallback: SearchCfg = { provider: 'NONE', maxResults: 5, deepReadCount: 4, browserEngine: 'ELECTRON' }
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/search-config`)
    if (r.ok) {
      const c = await r.json() as SearchConfigResp
      return {
        provider: c.provider || 'NONE',
        maxResults: c.maxResults || 5, deepReadCount: c.deepReadCount ?? 4,
        browserEngine: c.browserEngine || 'ELECTRON'
      }
    }
  } catch (e) { swallow(e) }
  return fallback
}

// 并行深读候选网页：多试几篇以抵消个别抓取失败（超时/反爬/空正文），保留有正文的，最多 want 篇。
// 修复"搜到 5 篇却只读 1 篇"——旧实现顺序读 slice(0,want)，任一篇失败就少一篇、且串行慢。
async function deepReadPages(results: WebSearchResult[], want: number, engine: string, sendLog: SendLog): Promise<WebPage[]> {
  const candidates = results.slice(0, Math.min(results.length, want + 2))
  const settled = await Promise.all(candidates.map(async (r) => {
    sendLog('acting', `正在细读：${r.title || r.url}`)
    const text = await fetchPageText(r.url, engine, sendLog)
    return text ? ({ url: r.url, title: r.title, text } as WebPage) : null
  }))
  return settled.filter((p): p is WebPage => !!p).slice(0, want)
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
  return ((await offscreenExtract<string>(url, `(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,2600)`)) || '').trim()
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
  const results: WebSearchResult[] = (await offscreenExtract<WebSearchResult[]>(serp, extractJs)) || []
  return results.filter(r => r.url && /^https?:/.test(r.url)).map(r => ({ ...r, url: cleanBingUrl(r.url) })).slice(0, max)
}

// 联网检索走后端代理：客户端只发查询词，后端用保管的 Tavily/Bing 密钥执行检索，密钥不下发本机。
// Tavily 后端直出正文；Bing 后端只返结果，正文由本地浏览器深读（抓公开页无需密钥）。
async function proxySearch(query: string, cfg: SearchCfg, sendLog: SendLog): Promise<WebSearchOutcome | null> {
  const r = await afetch(`${getAdminBaseUrl()}/api/v1/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, maxResults: cfg.maxResults })
  })
  if (!r.ok) return null
  const d = await r.json() as ProxySearchResp
  if (!d || d.provider === 'NONE' || !(d.results || []).length) return null
  const results: WebSearchResult[] = (d.results || []).map((x): WebSearchResult => ({ title: x.title || '', url: x.url, snippet: x.snippet || '' }))
  const pages: WebPage[] = (d.pages || [])
    .map((p): WebPage => ({ url: p.url, title: p.title || '', text: p.text || '' }))
    .filter(p => p.text)
  if (!pages.length) {
    // Bing 分支：后端只返结果，正文由本地浏览器并行深读头部网页（多试几篇抵消个别失败）。
    pages.push(...await deepReadPages(results, cfg.deepReadCount, cfg.browserEngine, sendLog))
  }
  return { query, results, pages }
}

// 联网检索入口：按管理端配置选择通道（Tavily / Bing API / 内置浏览器）。
export async function webSearch(query: string, sendLog: SendLog): Promise<WebSearchOutcome> {
  const cfg = await getSearchConfig()
  sendLog('thinking', `正在联网搜：${query}`)
  try {
    if (cfg.provider === 'TAVILY' || cfg.provider === 'BING') {
      sendLog('acting', `正在联网搜索…`)
      const out = await proxySearch(query, cfg, sendLog)
      if (out) {
        sendLog('completed', `搜到 ${out.results.length} 条结果，正在细读 ${out.pages.length} 篇。`)
        return out
      }
    }
  } catch (e: any) {
    sendLog('observing', `联网接口不通，改用浏览器搜…`)
  }
  // 回退：内置浏览器检索 + 并行深读（多试几篇抵消个别失败）
  sendLog('acting', `正在用浏览器联网搜索…`)
  const results = await browserSerp(query, cfg.maxResults)
  sendLog('observing', `搜到 ${results.length} 条结果`)
  const pages = await deepReadPages(results, cfg.deepReadCount, cfg.browserEngine, sendLog)
  sendLog('completed', `搜到 ${results.length} 条，深读了 ${pages.length} 篇网页。`)
  return { query, results, pages }
}

// 查询改写：用大模型把口语化请求 + 已知公司，改写成精准的搜索关键词。
export async function refineSearchQuery(userMsg: string, cfg: LlmConfig, sendLog: SendLog, skillHint?: string, skillSop?: string): Promise<string> {
  const hasCfg = !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)
  if (!hasCfg) return userMsg
  let company = ''
  // 仅当用户确实在指代「自己公司」时才注入公司名，避免对无关查询（如"大模型"）过度联想到本司产品。
  const refersOwnCompany = /(我们公司|本公司|我司|咱们公司|我们单位|本单位|公司内部)/.test(userMsg)
  if (refersOwnCompany) {
    try {
      const r = await afetch(`${getAdminBaseUrl()}/api/v1/enterprise`)
      if (r.ok) { const p = await r.json() as EnterpriseResp; company = p.companyName || '' }
    } catch (e) { swallow(e) }
  }
  // 技能意图（如「标讯查询」）并入改写上下文；若技能 SOP 给出了检索策略，必须严格据此构建检索词，
  // 否则只会泛泛搜原词（如查"标讯"却搜成行业概况）。
  const skillLine = skillHint ? `当前技能：${skillHint}。\n` : ''
  const sopLine = skillSop ? `该技能规定的标准检索策略如下，请严格据此构建检索词（保留其要求的限定词，如"招标公告/中标/政府采购"等，而不是只搜原始关键词）：\n"""\n${skillSop.slice(0, 900)}\n"""\n` : ''
  const now = new Date()
  const ym = `${now.getFullYear()}年${now.getMonth() + 1}月`
  const timeSensitive = /(最新|今日|今天|近期|近日|现在|目前|实时|新闻|动态|资讯|进展|快讯|发布)/.test(userMsg)
  const dateLine = `当前日期：${ym}${now.getDate()}日。` + (timeSensitive
    ? `本次请求涉及时效性——请在查询里带上当前年月「${ym}」等限定，以搜到当下最新内容，避免搜成往年回顾。\n`
    : '\n')
  const prompt = `你是搜索查询改写助手。把用户请求改写成一个用于搜索引擎的精准、简洁的关键词查询，使其能搜到最相关、最具体的网页。\n${dateLine}规则：只输出最终查询关键词本身，不要任何解释、前缀或引号；不要凭空添加用户未提及的公司、品牌或产品名；补全有助于检索的关键词。\n${skillLine}${sopLine}${company ? `用户所在公司：${company}（仅当用户指代"我司/本公司"时才用它替换）。\n` : ''}用户请求：${userMsg}`
  try {
    const out = await callLlm(prompt, cfg)
    const q = (out || '').trim().split('\n')[0].replace(/^["「『]+|["」』]+$/g, '').replace(/^(查询关键词|关键词|查询)[:：]\s*/, '').trim().slice(0, 80)
    if (q) { sendLog('thinking', `正在联网搜：${q}`); return q }
  } catch (e) { swallow(e) }
  return userMsg
}

// 该岗位分身是否被管理端授权联网检索。
export async function getExpertWebSearch(expertId: string): Promise<boolean> {
  if (!expertId) return false
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/experts/${expertId}`)
    if (r.ok) { const e = await r.json() as ExpertResp; return !!e.webSearchEnabled }
  } catch (e) { swallow(e) }
  return false
}

// 由大模型自主判断该问题是否需要联网检索（用于已授权联网的分身）。
export async function shouldWebSearch(userMsg: string, cfg: LlmConfig, sendLog: SendLog): Promise<boolean> {
  const hasCfg = !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)
  if (!hasCfg) return false
  const prompt = `判断要回答下面这个问题，是否需要联网检索最新或外部信息（例如：实时价格/股价/汇率、航班/车票、天气、新闻或近期事件、产品/政策的最新情况、你并不掌握的具体事实与数据）。\n如果问题只是闲聊、寒暄、改写、基于已给资料的分析、或常识性问答，则不需要。\n只输出一个字：需要 或 不需要。\n问题：${userMsg}`
  try {
    const out = (await callLlm(prompt, cfg)).trim()
    const yes = /需要/.test(out) && !/不需要/.test(out)
    sendLog('thinking', `${yes ? '这个需要联网查一下…' : '这个不用联网，直接答…'}`)
    return yes
  } catch (_) { return false }
}

// 判断任务是否需要联网检索。
export function isWebSearchIntent(content: string): boolean {
  const s = content.toLowerCase()
  return /(联网|上网|网上|搜索|搜一下|搜一搜|查一下网|网上查|检索一下|最新消息|最新动态|新闻|百度|谷歌|google|bing|搜索引擎|查查网上|联网查)/.test(s)
}
