// 联网检索：内置 Tavily / Bing API 及 Electron 离屏页面抓取，供分身判定需联网时补充事实。
import { BrowserWindow } from 'electron'
import { getAdminBaseUrl, afetch } from './http'
import { callLlm, type LlmConfig } from './llm'
import { swallow, sleep } from './util'
import type { SendLog } from './types'
import { buildWebSearchPrompt, parseWebSearchDecision, type KbHit, buildMaterialsNeedPrompt, searchTerms, relevantToAny, stripCarrierTerms, stripTaskVerbs, pagePublishDate, dateOutOfRange, historyGist, looksLikeJunkPage, looksLikeJunkResult, looksBlockedPage, sourceTier, anchoredInMaterials } from './web-search-core'

// tier=后端按分级名单标注的信源级别(权威/专业/一般/自媒体)——单一来源;
// 本地 sourceTier 仅在旧后端/浏览器兜底路径没有标注时补标。
interface WebSearchResult { title: string; url: string; snippet: string; tier?: string }
interface WebPage { url: string; title: string; text: string; tier?: string }
interface WebSearchOutcome { query: string; results: WebSearchResult[]; pages: WebPage[] }

// 外部/后端 JSON 解析边界的窄形状（字段可空，取用即兜底），避免 `any` 掩盖字段拼写/结构错误。
interface SearchConfigResp { provider?: string; maxResults?: number; deepReadCount?: number; browserEngine?: string }
interface RawResult { title?: string; url: string; snippet?: string; tier?: string }
interface RawPage { url: string; title?: string; text?: string; tier?: string }
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
// opts.direct=绕过系统代理的独立分区（细读失败常因本机代理不稳；仅公开网页、不带任何登录态）；
// opts.poll=就绪轮询（SPA 首采常为空，最多再等 ~6s 直到取到实质文本）；opts.onErr=失败原因回传（可诊断）。
function offscreenExtract<T>(url: string, extractJs: string, waitMs = 1800, timeoutMs = 18000,
  opts?: { direct?: boolean; poll?: boolean; onErr?: (e: string) => void }): Promise<T | null> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { offscreen: true, ...(opts?.direct ? { partition: 'deepread-direct' } : {}) } })
    let settled = false
    let lastErr = ''
    const done = (val: T | null) => {
      if (settled) return
      settled = true
      if ((val === null || val === undefined || val === '' as unknown) && opts?.onErr) opts.onErr(lastErr || 'empty')
      try { if (!win.isDestroyed()) win.close() } catch (e) { swallow(e) }
      resolve(val)
    }
    win.webContents.setAudioMuted(true)
    if (opts?.direct) { void win.webContents.session.setProxy({ mode: 'direct' }).catch((e) => swallow(e, 'deepread-direct-proxy')) }
    win.webContents.once('did-finish-load', async () => {
      try {
        await sleep(waitMs)
        let val = (await win.webContents.executeJavaScript(extractJs)) as T | null
        if (opts?.poll) {
          const deadline = Date.now() + 6000
          while (!settled && (!val || (typeof val === 'string' && (val as string).trim().length < 200)) && Date.now() < deadline) {
            await sleep(900)
            try { val = (await win.webContents.executeJavaScript(extractJs)) as T | null } catch (e) { swallow(e) }
          }
        }
        if (!val || (typeof val === 'string' && !(val as string).trim())) lastErr = '正文为空(反爬壳/未渲染)'
        done(val)
      } catch (_) { lastErr = '提取脚本执行失败'; done(null) }
    })
    win.webContents.once('did-fail-load', (_e, code, desc) => { if (code !== -3) { lastErr = `加载失败 ${code} ${desc || ''}`.trim(); done(null) } })
    win.loadURL(url).catch(() => {})
    setTimeout(() => { if (!lastErr) lastErr = '超时'; done(null) }, timeoutMs)
  })
}

// 检索通道选择配置（不含密钥——密钥留后端，检索经 /api/v1/search 代理）。
interface SearchCfg { provider: string; maxResults: number; deepReadCount: number; browserEngine: string }

// 拉取管理端检索服务配置（仅通道/条数等，apiKey 已不下发）。
// 60s TTL 缓存：一次任务里检索+多跳补查会反复调它，每次都是一个后端 GET 纯浪费时延；
// 配置变更 ≤60s 生效，对管理端调参足够及时。
let searchCfgCache: { cfg: SearchCfg; at: number } | null = null
async function getSearchConfig(): Promise<SearchCfg> {
  if (searchCfgCache && Date.now() - searchCfgCache.at < 60000) return searchCfgCache.cfg
  const fallback: SearchCfg = { provider: 'NONE', maxResults: 5, deepReadCount: 4, browserEngine: 'ELECTRON' }
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/search-config`)
    if (r.ok) {
      const c = await r.json() as SearchConfigResp
      const cfg = {
        provider: c.provider || 'NONE',
        maxResults: c.maxResults || 5, deepReadCount: c.deepReadCount ?? 4,
        browserEngine: c.browserEngine || 'ELECTRON'
      }
      searchCfgCache = { cfg, at: Date.now() }
      return cfg
    }
  } catch (e) { swallow(e) }
  return fallback
}

// 并行深读候选网页：多试几篇以抵消个别抓取失败（超时/反爬/空正文），保留有正文的，最多 want 篇。
// 修复"搜到 5 篇却只读 1 篇"——旧实现顺序读 slice(0,want)，任一篇失败就少一篇、且串行慢。
// query 可选：给了就按页面自述发布时间做日期纪律（与服务端深读同构）——本机兜底细读此前
// 没有任何日期核对，服务端拒掉的旧文被客户端原样读回（实锤：搜狐 2月旧文混进"本周足坛"）。
const TIER_RANK: Record<string, number> = { '权威': 0, '专业': 1, '一般': 2, '自媒体': 3 }

async function deepReadPages(results: WebSearchResult[], want: number, engine: string, sendLog: SendLog, query?: string): Promise<WebPage[]> {
  // 深读名额按**信源分级**优先（同级保持引擎原序）：以前按引擎原始排序取前几条，
  // SEO 页占掉名额、权威/专业大站根本轮不到读——素材质量从源头就输了。
  const ranked = results
    .map((r, i) => ({ r, i, k: TIER_RANK[String(r.tier || sourceTier(r.url))] ?? 2 }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map(x => x.r)
  const candidates = ranked.slice(0, Math.min(ranked.length, want + 2))
  const errors: string[] = []
  const out: (WebPage | null)[] = new Array(candidates.length).fill(null)
  // 并发上限 4：一次开 8 个离屏窗口既重又容易触发站点限流；失败原因逐条收集供聚合播报
  let next = 0
  const workers = Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (next < candidates.length) {
      const i = next++
      const r = candidates[i]
      sendLog('acting', `正在细读：${r.title || r.url}`)
      const text = await fetchPageText(r.url, engine, sendLog, (e) => errors.push(e))
      if (!text) continue
      const pd = pagePublishDate(text)
      if (pd && query && dateOutOfRange(pd, query)) {
        sendLog('observing', `跳过旧文：《${(r.title || r.url).slice(0, 32)}》页面发布于 ${pd}，与询问的时间范围不符`)
        continue
      }
      out[i] = { url: r.url, title: r.title, text: pd ? `【页面发布时间：${pd}】${text}` : text }
    }
  })
  await Promise.all(workers)
  schedulePwIdleClose()   // 常驻复用：不立即关，空闲 5 分钟自动回收（多跳补查轮间免重复启动）
  const pages = out.filter((p): p is WebPage => !!p).slice(0, want)
  // 如实汇报细读战果：全军覆没时带上失败原因样本——否则界面上一串"正在细读"紧跟"细读 0 篇"，
  // 用户以为是统计 bug，其实是本机网络/反爬把抓取拦了。
  const errBrief = errors.length ? `；失败原因样本：${errors.slice(0, 2).join('；')}` : ''
  sendLog(pages.length ? 'completed' : 'observing',
    `细读成功 ${pages.length}/${candidates.length} 篇${pages.length ? '' : `（正文全部抓取失败，素材退化为标题+摘要，内容会偏薄${errBrief}）`}`)
  return pages
}

// Playwright 真 Chrome 抓取：整轮细读复用一个浏览器实例（每篇一启太重），channel:'chrome'
// 用系统真 Chrome（playwright 内置 chromium 客户机普遍没下载）。不可用则整轮内不再重试。
let pwBrowser: any = null
let pwUnavailable = false
async function pwGet(): Promise<any | null> {
  // 常驻实例断连自愈：chrome 崩溃/被系统回收后 isConnected()=false，旧引用还在但已死——
  // 直接复用会抛「Target closed」并可能冒泡成未捕获异常带崩进程。检测到断连即丢弃重启。
  if (pwBrowser) {
    try { if (pwBrowser.isConnected && pwBrowser.isConnected()) return pwBrowser } catch (e) { swallow(e, 'pw-alive') }
    pwBrowser = null
  }
  if (pwUnavailable) return null
  try {
    const { chromium }: any = await import('playwright')
    pwBrowser = await chromium.launch({ headless: true, channel: 'chrome' })
      .catch(async () => await chromium.launch({ headless: true }))
    // 断连事件也清引用（下次 pwGet 重启），并吞掉 disconnect 事件避免它成未捕获异常
    try { pwBrowser?.on?.('disconnected', () => { pwBrowser = null }) } catch (e) { swallow(e, 'pw-on-disc') }
    return pwBrowser
  } catch (e) { swallow(e, 'pw-launch'); pwUnavailable = true; return null }
}
async function pwCloseAll(): Promise<void> {
  try { if (pwBrowser) await pwBrowser.close() } catch (e) { swallow(e) }
  pwBrowser = null; pwUnavailable = false
}

// 常驻复用：每轮细读后不再立即关闭（整轮启停一次 Chrome 太重，多跳补查一题能启停 3~4 次），
// 改为空闲 5 分钟自动回收——既保住轮间复用的速度，又不留常驻 Chrome 僵尸。
let pwIdleTimer: ReturnType<typeof setTimeout> | null = null
function schedulePwIdleClose(): void {
  if (pwIdleTimer) clearTimeout(pwIdleTimer)
  pwIdleTimer = setTimeout(() => { void pwCloseAll() }, 300000)
  if (typeof pwIdleTimer.unref === 'function') pwIdleTimer.unref()
}
async function pwFetchText(url: string): Promise<string> {
  const b = await pwGet()
  if (!b) return ''
  let ctx: any = null
  try {
    // 伪装真实浏览器指纹（UA/语言/视口）：无头默认特征是大站反爬的第一道识别，channel:'chrome' 也不例外
    ctx = await b.newContext({
      locale: 'zh-CN',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 860 }
    })
    const page = await ctx.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(1200)
    const text: string = await page.evaluate(`(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,2600)`)
    return (text || '').trim()
  } catch (e) { swallow(e, 'pw-fetch'); return '' }
  finally { try { if (ctx) await ctx.close() } catch (e) { swallow(e) } }
}

// 抓取单页正文：三级降级链——按配置的首选引擎起步，任一档拿到正文即返回。
//   ELECTRON:  离屏浏览器 → 直连重试(绕系统代理) → Playwright 真 Chrome
//   PLAYWRIGHT: Playwright 真 Chrome → 离屏浏览器 → 直连重试
// errOut 汇总各档失败原因（细读全败时聚合播报，别再让用户猜）。
async function fetchPageText(url: string, engine: string, _sendLog: SendLog, errOut?: (e: string) => void): Promise<string> {
  const errs: string[] = []
  const JS = `(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,2600)`
  const offscreen = async (direct: boolean) =>
    ((await offscreenExtract<string>(url, JS, 1500, direct ? 15000 : 18000, { direct, poll: true, onErr: (e) => errs.push((direct ? '直连:' : '离屏:') + e) })) || '').trim()
  // 每档做**可用性**判定，不再"非空即成功"：反爬拦截页/JS 渲染前的骨架短文都算失败，
  // 继续降级到下一档引擎（实锤：大站拦截壳页被当正文返回，Playwright 档从未触发）。
  let best = ''
  const usable = (t: string, tag: string): boolean => {
    if (!t) { errs.push(tag + ':空'); return false }
    if (looksBlockedPage(t)) { errs.push(tag + ':反爬拦截页'); return false }   // 拦截文本绝不入 best
    if (t.length > best.length) best = t
    if (t.length < 80) { errs.push(tag + `:正文过短(${t.length}字)`); return false }
    return true
  }
  if (engine === 'PLAYWRIGHT') {
    const t0 = await pwFetchText(url)
    if (usable(t0, 'playwright')) return t0
  }
  let t = await offscreen(false)
  if (usable(t, '离屏')) return t
  t = await offscreen(true)
  if (usable(t, '直连')) return t
  if (engine !== 'PLAYWRIGHT') {
    t = await pwFetchText(url)
    if (usable(t, 'playwright')) return t
  }
  // 全档不达标：返回最长的**非拦截**文本兜底（薄总比没有强）；连兜底都没有才报失败原因
  if (!best && errOut) errOut(errs.join(' → ') || 'empty')
  return best
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
  const results: WebSearchResult[] = (d.results || []).map((x): WebSearchResult => ({ title: x.title || '', url: x.url, snippet: x.snippet || '', tier: x.tier }))
  const pages: WebPage[] = (d.pages || [])
    .map((p): WebPage => ({ url: p.url, title: p.title || '', text: p.text || '', tier: p.tier }))
    .filter(p => p.text)
  if (pages.length) {
    // 服务端已深读随响应带回——逐篇播报保住"过程感"（如实：服务器确实逐篇读了正文）
    for (const p of pages) sendLog('acting', `已细读：《${(p.title || p.url).slice(0, 40)}》· 正文 ${p.text.length} 字`)
  }
  // 服务端没带正文时**不在这里就地深读**：先回 webSearch 做相关性把关，只深读把关幸存者
  //（旧序是垃圾页读完才被剔除=时延白付。实锤：补查轮细读了热水器帖/伊斯兰艺术博物馆页）。
  return { query, results, pages }
}

// ── 行情快照直采（经后端代理腾讯行情接口）────────────────────────────────
// 为什么:当日指数点位/涨跌幅这类硬数字,新闻检索只能拿到转述(旧文自称"今日"、自媒体隔日转抄
// 都实锤出过错数事故);接口直采是确定性数据源,素材块标注「权威·接口直采」,采信红线优先取它。
const MARKET_INTENT = /A股|大盘|股市|指数|收盘|开盘|涨跌|行情|沪指|深成指|创业板|北证|两市|三大指数/

export function isMarketQuery(text: string): boolean { return MARKET_INTENT.test(text || '') }

interface QuoteResp { symbol?: string; name?: string; price?: number; prevClose?: number; change?: number; changePct?: number; time?: string }

export async function fetchMarketQuotes(sendLog: SendLog): Promise<string | null> {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/search/quotes`)
    if (!r.ok) return null
    const list = await r.json() as QuoteResp[]
    if (!Array.isArray(list) || !list.length) return null
    const sign = (n: number) => `${n >= 0 ? '+' : ''}${n}`
    // 带上昨收：盘中问"昨天收盘"时，price 是实时价、昨收才是答案——两个都给，模型按行情时间自行取用
    const lines = list
      .filter(q => q.name && typeof q.price === 'number')
      .map(q => `${q.name}: ${q.price}（${sign(q.change ?? 0)}，${sign(q.changePct ?? 0)}%${typeof q.prevClose === 'number' ? `；昨收 ${q.prevClose}` : ''}）`)
    if (!lines.length) return null
    const t = list[0].time || ''
    sendLog('completed', `已直采实时行情快照（${lines.length} 项指数 · ${t}）`)
    return `【实时行情快照｜腾讯行情接口直采｜信源级别：权威｜行情时间：${t}】\n${lines.join('\n')}\n（指数点位、涨跌幅等硬数字一律以本快照为准；检索文章与本快照冲突时，采用本快照数值并可注明"截至${t}"）`
  } catch (e) {
    swallow(e, 'market-quotes')   // 行情源/后端不通 → 无快照,走纯检索路径
    return null
  }
}

// 联网检索入口：按管理端配置选择通道（Tavily / Bing API / 内置浏览器）。
// llmCfg 可选：给了就用大模型做语义相关性把关（懂"足坛=足球"），没给退回词法过滤。
export async function webSearch(query: string, sendLog: SendLog, llmCfg?: LlmConfig): Promise<WebSearchOutcome> {
  const cfg = await getSearchConfig()
  sendLog('thinking', `正在联网搜：${query}`)
  let out: WebSearchOutcome | null = null
  try {
    // 任何已配置的服务商（TAVILY/BING/SEARXNG/…）都走后端代理；仅 NONE 直接用浏览器兜底
    if (cfg.provider && cfg.provider !== 'NONE') {
      sendLog('acting', `正在联网搜索…`)
      out = await proxySearch(query, cfg, sendLog)
    }
  } catch (e) {
    swallow(e, 'proxy-search')
    sendLog('observing', `联网接口不通，改用浏览器搜…`)
  }
  if (!out) {
    // 回退：内置浏览器检索（正文同样等把关后再深读）
    sendLog('acting', `正在用浏览器联网搜索…`)
    const results = await browserSerp(query, cfg.maxResults)
    sendLog('observing', `搜到 ${results.length} 条结果`)
    out = { query, results, pages: [] }
  }
  // 相关性/垃圾把关**前置到深读之前**：无关与垃圾结果先剔掉，深读名额只花给幸存者
  //（旧序是"读完 6 篇再剔除"——正确性没事，时延白付，单题最长拖到 227s）。
  out = dropJunkPages(await filterRelevant(out, sendLog, llmCfg), sendLog)
  if (!out.pages.length && out.results.length) {
    out = { ...out, pages: await deepReadPages(out.results, cfg.deepReadCount, cfg.browserEngine, sendLog, query) }
    out = dropJunkPages(out, sendLog)   // 新读回的正文再过一遍垃圾特征闸
  }
  sendLog('completed', `搜到 ${out.results.length} 条结果，细读成功 ${out.pages.length} 篇。`)
  return out
}

// SEO/赌球/广告页剔除（双层）：① 结果级——标题冒充大站署名/自称官方平台/博彩硬词，不深读也拦
// （结果列表与「联网来源」卡都要干净）；② 正文级——占位赛况/广告话术特征。
// 语义把关只筛"明显无关"，关键词堆砌的营销页轻松穿透——必须按特征再筛一道。
function dropJunkPages(out: WebSearchOutcome, sendLog: SendLog): WebSearchOutcome {
  const junkUrls = new Set<string>()
  for (const x of out.results) if (looksLikeJunkResult(x.title, x.url, x.snippet)) junkUrls.add(x.url)
  for (const p of out.pages) if (looksLikeJunkPage(p.text, p.title)) junkUrls.add(p.url)
  if (!junkUrls.size) return out
  sendLog('observing', `[联网检索] 剔除 ${junkUrls.size} 条疑似 SEO/赌球/广告页（冒充官方标题、博彩话术或占位赛况特征）`)
  return { ...out, results: out.results.filter(r => !junkUrls.has(r.url)), pages: out.pages.filter(p => !junkUrls.has(p.url)) }
}

export interface FollowUp { query: string; out: WebSearchOutcome }

/**
 * 多跳补查：首轮素材 → 提取**新获知的关键实体** + 盘点缺口 → 生成 ≤3 个带实体的补查词并逐个检索。
 * 对标"先搜出决赛对阵=西班牙vs阿根廷，再带着队名挖晋级之路/首发"的检索方式——
 * 单轮单词检索拿不到这种**二跳信息**（实锤：世界杯决赛模拟只搜到一轮泛词结果，对阵双方都没拿到）。
 * 素材已足够时模型输出 NONE 短路，简单问题不多付检索成本；跨轮按 URL 去重。
 */
export async function followUpSearches(task: string, materialsText: string, seenUrls: Set<string>, cfg: LlmConfig, sendLog: SendLog, maxQueries = 3, onHop?: (q: string, out: WebSearchOutcome, ms: number) => void): Promise<FollowUp[]> {
  const hasCfg = !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)
  if (!hasCfg) return []
  let queries: string[] = []
  try {
    const out = await callLlm(
      `任务：${task}\n\n已取得素材（节选）：\n"""${(materialsText || '').slice(-4500)}"""\n\n`
      + `先从素材中提取完成任务所需、且是**素材里新获知**的关键事实实体（如对阵双方、涉事公司、产品名等具体名称）；再盘点素材缺口。补查优先级：\n`
      + `① **核实决定性事实**：素材对"对阵双方/当事方/最终结果"这类决定性事实只有**单一来源**、或来源间说法不一时，先生成核实类补查词（把素材声称的实体写进去查证）；\n`
      + `② **补齐任务所需事实**：任务要用到、素材却没有的名单/首发/双方数据/时间地点，逐项补查。\n`
      + `③ **多跳链的下一跳**：若任务是一条链（"A 命名自 B、B 改编自 C、C 的作者是谁""X 的导演执导的另一部片""甲比乙早几年成立"），而首轮素材刚**新查到链上的中间实体**（如查到"乐队 Mudhoney 得名自 Russ Meyer 的电影《Mudhoney》"），就用这个**新实体**构造下一跳补查词（"电影 Mudhoney 改编自哪部小说 作者"）——一步步顺着链往终点查，不要停在中间实体。比较类问题（早几年/谁更高/差多少）则分别补查各方的那个具体属性。\n`
      + `检索词构造两条铁律：\n`
      + `· **带锚点词**：名单/阵容/人事类补查，在实体后附 1-2 个素材中已出现的**该实体关联人名**作锚点（如「2026世界杯 西班牙队阵容 亚马尔 佩德里」）——锚点能把搜索引擎拉向大名单/首发页，素词只会搜到泛新闻；名单类优先查**官方公布与实际比赛记录**（如「西班牙 26人大名单 官方公布」「西班牙 半决赛 法国 首发」），赛前预测文不足以支撑名单；\n`
      + `· **贴紧时间**：赛况/名单/动态类补查词必须带当前年份或届次（如"2026世界杯"），否则会搜到往届旧文。\n`
      + `输出最多 ${maxQueries} 个补查检索词（每行一个，≤22 字），**必须写入具体实体名**（真实名称，绝不用"对阵双方/球队A"等代称）；`
      + `不含"模拟/推演/预测/PPT/模板"这类任务词与载体词。\n`
      + `**宁可补查也别乐观**：只有素材已能直接支撑任务所需的**全部**关键事实（决定性事实有多源印证、名单/数据齐备）时，才输出 NONE。`,
      cfg, { temperature: 0 })
    queries = (out || '').split('\n')
      .map(s => s.trim().replace(/^[-\d.、\s]+/, '').replace(/^["「『]+|["」』]+$/g, '').trim())
      .filter(s => s && !/^NONE$/i.test(s) && s.length >= 4)
      .slice(0, maxQueries)
  } catch (e) { swallow(e, 'followup-plan'); return [] }
  // 补查词锚定校验：必须包含首轮素材中出现过的实体词，未锚定的直接丢弃（防检索跑偏，见 core 注释）
  const anchoredQs: string[] = []
  for (const q of queries) {
    if (anchoredInMaterials(q, materialsText || '')) anchoredQs.push(q)
    else sendLog('observing', `[补查] 丢弃未锚定素材实体的补查词「${q}」（防检索跑偏）`)
  }
  // 决策可见：不补查也要在执行详情里留痕，别让"没触发"和"判断不需要"混为一谈
  if (!anchoredQs.length) { sendLog('thinking', '素材盘点：现有素材已覆盖关键事实，未再补查。'); return [] }
  // 各跳并行检索（互相独立），结果按原顺序统一去重合入——串行时代 3 跳要排队 2 分钟+
  const hopResults = await Promise.all(anchoredQs.map(async (gq) => {
    sendLog('thinking', `素材盘点：带着已确认的信息补查「${gq}」…`)
    try {
      const t0 = Date.now()
      const r = await webSearch(stripTaskVerbs(gq), sendLog, cfg)
      return { gq, r, ms: Date.now() - t0 }
    } catch (e) { swallow(e, 'followup-search'); return null }
  }))
  const fills: FollowUp[] = []
  for (const hop of hopResults) {
    if (!hop) continue
    const results = hop.r.results.filter(x => !seenUrls.has(x.url))
    const pages = hop.r.pages.filter(p => !seenUrls.has(p.url))
    results.forEach(x => seenUrls.add(x.url)); pages.forEach(p => seenUrls.add(p.url))
    if (onHop) onHop(hop.gq, { ...hop.r, results, pages }, hop.ms)   // 每跳留痕（执行时间线子节点）
    if (results.length || pages.length) fills.push({ query: hop.gq, out: { ...hop.r, results, pages } })
  }
  return fills
}

/** 检索结果 → 标准素材块（结果列表带信源级别 + 深读正文），备料/QA/补查共用一种格式。 */
export function outcomeBlock(label: string, r: WebSearchOutcome): string {
  const lines = r.results.map((x, k) => `${k + 1}. [${x.tier || sourceTier(x.url)}] ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
  const pageBlocks = r.pages.map(p => `【来源：${p.title}｜${p.url}｜信源级别：${p.tier || sourceTier(p.url)}】\n${p.text}`).join('\n\n')
  return `— ${label} —\n${lines}${pageBlocks ? `\n\n${pageBlocks}` : ''}`
}

/**
 * 无「权威/专业」级信源时的硬警示块（拼在素材块最前，确定性生成，不靠模型自觉）。
 * 实锤：世界杯阶段问答只命中低信源 SEO 页（级别全为"一般"），作答纪律只防"自媒体"级，
 * 模型把占位赛况冠以"官方数据"整段引用。行情快照（接口直采）在场时不告警。
 */
export function lowTrustNotice(r: WebSearchOutcome, hasSnapshot = false): string {
  if (hasSnapshot || (!r.results.length && !r.pages.length)) return ''
  const tiers = [...r.pages.map(p => String(p.tier || sourceTier(p.url))), ...r.results.map(x => String(x.tier || sourceTier(x.url)))]
  if (tiers.some(t => t === '权威' || t === '专业')) return ''
  return `【⚠️ 信源可信度警示】本轮检索**未命中任何权威/专业级信源**——下方素材全部来自一般站点或自媒体（可能是聚合/营销页）。铁律：其中的**已发生事实**（比分/赛程阶段/点位/金额/单号/日期）一律不得当作事实陈述，只能以"有低可信来源称……尚无权威信源证实"的口吻提及，或如实告知用户本轮未检索到可靠信息；**绝不允许**冠以"官方数据/官方赛程/最新数据"等字样。\n\n`
}

// 语义相关性把关：词法子串匹配对中文同义改写天生脆（足坛↔足球打了三个补丁还在漏），
// 判相关本来就是模型的活——一次廉价调用批量**负向筛除**「明显无关」（撞名歧义/完全不同领域），
// 同义近义明确算相关、拿不准算相关（宁可多留，与词法路径"全灭即放行"同一哲学）。
// 模型没配/调用失败/输出不可解析/要求全灭 → 一律退回词法过滤或保留全部，检索链路绝不因此中断。
async function filterRelevant(out: WebSearchOutcome, sendLog: SendLog, llmCfg?: LlmConfig): Promise<WebSearchOutcome> {
  const hasCfg = !!(llmCfg && llmCfg.baseUrl && llmCfg.apiKey && llmCfg.modelName)
  if (!hasCfg || out.results.length < 2) return dropIrrelevant(out, sendLog)
  try {
    const list = out.results.map((r, i) => `${i + 1}. ${(r.title || '').slice(0, 60)}｜${(r.snippet || '').slice(0, 60)}`).join('\n')
    const prompt = `查询意图：「${out.query}」\n下面是该查询的搜索结果列表。找出与查询主题**明显无关**的序号——只有撞名歧义（如查"科大讯飞"出现"中国科学技术大学"）或完全不同领域才算无关。\n同义/近义表述一律算相关（足坛=足球、体坛=体育、车市=汽车行业）；日期或报道角度的差异不算无关；拿不准的一律算相关。\n只输出无关序号（逗号分隔，如「2,5」）；全部相关则只输出 NONE。\n\n${list}`
    const raw = ((await callLlm(prompt, llmCfg, { temperature: 0 })) || '').trim()
    if (/^NONE\b/i.test(raw)) return out
    const bad = new Set((raw.match(/\d+/g) || []).map(Number).filter(n => n >= 1 && n <= out.results.length))
    if (!bad.size || bad.size >= out.results.length) return out   // 解析不出 / 要求全灭 → 不过滤
    const badUrls = new Set(out.results.filter((_, i) => bad.has(i + 1)).map(r => r.url))
    const results = out.results.filter((_, i) => !bad.has(i + 1))
    const pages = out.pages.filter(p => !badUrls.has(p.url))
    sendLog('observing', `[联网检索] 语义把关：剔除 ${bad.size} 条与查询主题无关的结果`)
    return { ...out, results, pages }
  } catch (e) {
    swallow(e, 'relevance-llm')
    return dropIrrelevant(out, sendLog)   // 模型通道抖动 → 词法兜底
  }
}

// 相关性过滤：标题/摘要/正文都不含查询主体词的结果直接丢弃（撞名页面如「科大讯飞」
// 搜出「中国科学技术大学」）。全被滤光就返回空 → 上游按"没搜到"如实处理，绝不硬用无关素材。
function dropIrrelevant(out: WebSearchOutcome, sendLog: SendLog): WebSearchOutcome {
  // 多主体任一命中即算相关：单一"最长词"过滤曾把「AI 最新动态」的主体抽成泛化词,整轮滤光误报"未搜到"
  const terms = searchTerms(out.query)
  if (!terms.length) return out
  const pageByUrl = new Map(out.pages.map(p => [p.url, p]))
  const results = out.results.filter(r => relevantToAny(terms, r.title, r.snippet, pageByUrl.get(r.url)?.text))
  const pages = out.pages.filter(p => relevantToAny(terms, p.title, p.text))
  // 全灭即放行：本过滤只为"撞名歧义"（科大讯飞搜出中国科学技术大学）设计——那种场景只会滤掉一部分。
  // 滤成 0 的几乎都是中文同义改写躲开了子串匹配（足坛↔足球、体坛↔体育，实锤：细读成功却报"未搜到"），
  // 这时保留全部交给模型自己判别，绝不把真素材当垃圾扔掉。
  if (!results.length) {
    sendLog('observing', `[联网检索] 主体词「${terms.join('/')}」未在结果中直接命中（多为同义改写），保留全部结果交由模型综合判断`)
    return out
  }
  const dropped = out.results.length - results.length
  if (dropped > 0) sendLog('observing', `[联网检索] 已过滤 ${dropped} 条与「${terms.join('/')}」无关的结果`)
  return { ...out, results, pages }
}

// 查询改写：用大模型把口语化请求 + 已知公司，改写成精准的搜索关键词。
// forMaterials=true：生成类技能的「备料」检索——检索词只针对交付物的**内容数据**，
// 载体词（PPT/Word/模板…）会被提示词禁止 + stripCarrierTerms 硬剥离（双保险，见 web-search-core）。
export async function refineSearchQuery(userMsg: string, cfg: LlmConfig, _sendLog: SendLog, skillHint?: string, skillSop?: string, forMaterials = false, history?: { role: 'user' | 'assistant'; content: string }[]): Promise<string> {
  const hasCfg = !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)
  if (!hasCfg) return forMaterials ? stripCarrierTerms(userMsg) : userMsg
  // 指代性追问（"再查查/上网好好查下/查一下/帮我搜搜"）自身不含检索对象——必须从对话上文接续主题，
  // 否则会把"上网好好查下"改写成"信息查询平台"这种空转检索（实锤：世界杯话题追问丢了主题）。
  const recentCtx = (history || []).slice(-4)
    .map(h => `${h.role === 'user' ? '用户' : '助手'}：${(h.content || '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')
  const contextLine = recentCtx
    ? `【最近对话上文（仅用于补全指代/主题，不要去检索这些历史本身）】\n${recentCtx}\n若下面的"用户请求"没有明确的检索主题（像"再查查""上网好好查下""查一下""帮我搜搜"这类指代性追问），必须从上文推断用户真正要查的主题并据此构建检索词；请求本身已有明确主题时直接用它。\n`
    : ''
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
  const todayStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
  // 相对时间必须在这里**确定性换算**——交给模型自己算，它会拿训练时代的"今天"臆造日期
  // （实锤："昨天的AI动态"被检索成 2025年4月12日）。粒度分三档：
  //   日（今天/昨天/前天）→ 完整日期；周（本周/这周/上周）→ 年月+周限定词，**绝不能写成单日**
  //   （曾把"本周"强制成当天全日期，周报类内容全搜不到）；月（本月/这个月/上个月）→ 目标年月。
  const dayOff = /(昨天|昨日)/.test(userMsg) ? -1 : /前天/.test(userMsg) ? -2 : /(今天|今日|当天)/.test(userMsg) ? 0 : null
  const weekly = /(本周|这周|这个?星期|上周|近一周)/.test(userMsg)
  const monthOff = /(上个?月)/.test(userMsg) ? -1 : /(本月|这个?月)/.test(userMsg) ? 0 : null
  const dayTarget = dayOff !== null ? new Date(now.getTime() + dayOff * 86400000) : now
  const fullDate = `${dayTarget.getFullYear()}年${dayTarget.getMonth() + 1}月${dayTarget.getDate()}日`
  const monthTarget = new Date(now.getFullYear(), now.getMonth() + (monthOff ?? 0), 1)
  const ym = `${monthTarget.getFullYear()}年${monthTarget.getMonth() + 1}月`
  const timeSensitive = /(最新|今日|今天|近期|近日|现在|目前|实时|新闻|动态|资讯|进展|快讯|发布)/.test(userMsg)
  const dateLine = `当前日期：${todayStr}。` + (dayOff !== null
    // 指向"具体某天"(今天的股市/昨天的动态):检索词必须带完整日期——只带年月会搜到当月旧文
    ? `本次请求指向**具体日期**${dayOff ? `（用户所说的相对日期已按当前日期换算为「${fullDate}」）` : ''}——检索词必须带上完整日期「${fullDate}」（如「${fullDate} A股 行情」），不得使用其他日期，否则会搜到别的日子的内容。\n`
    : weekly
      ? `本次请求指向**最近一周**——检索词带上年月「${ym}」并可加"本周/一周"等限定词（如「${ym} 足球 一周要闻」）；**绝不能写成某个具体的单日日期**，那会漏掉本周其他日子的内容。\n`
      : monthOff !== null
        ? `本次请求指向**${monthOff ? '上个月' : '本月'}**——检索词必须带上目标年月「${ym}」（如「${ym} 行业月报」），不得写成单日日期或其他月份。\n`
        : timeSensitive
          ? `本次请求涉及时效性——请在查询里带上当前年月「${ym}」等限定，以搜到当下最新内容，避免搜成往年回顾。\n`
          : '\n')
  // 备料检索的关键规则：搜「内容」不搜「载体」。用户说"生成一个 ppt"，要搜的是行情/事实/数值，
  // 不是 PPT 模板——载体由本地技能生成。没有这条，改写会忠实带上"PPT模板"，搜回一堆模板站。
  const materialsLine = forMaterials
    ? `注意：用户请求里的交付物载体（PPT/Word/Excel/文档/报告等）只是产出格式，**不是检索目标**。检索词只针对这份材料需要的**内容数据**（如行情数值、事实、新闻、公告），绝不能包含「PPT」「模板」「幻灯片」「Word」等载体词。\n`
    : ''
  // 任务动词≠检索对象："模拟/推演"是要分身做的事，检索词应指向完成它所需的真实事实前提
  // （实锤：「根据世界杯比赛情况模拟下决赛」被改写成带"模拟 推演"的词，来源全是推演工具站）。
  const taskVerbLine = `任务动词不是检索对象：用户请求里的"模拟/推演/预演/沙盘/假设"是**要你完成的任务**，不是要搜索的内容——检索词必须指向完成任务所需的**真实事实前提**（已发生的赛果/对阵/名单/数据/事件），绝不能把"模拟""推演"写进检索词（那只会搜到模拟器和推演文章，拿不到真实事实）。仅当用户明确要找**别人发布的**预测/推演文章时才保留这些词。例："根据今年世界杯之前的比赛情况，模拟下决赛" → 检索「2026年世界杯 淘汰赛 赛果 决赛对阵」，而非「2026世界杯 决赛 模拟 推演」。\n`
  // 硬闸条件：用户是"要我做模拟"（而非"找模拟/预测内容"）
  const simulateTask = /(模拟|推演|沙盘|预演)/.test(userMsg) && !/(找|搜|查)[^。！？]{0,10}(模拟|推演|预测)/.test(userMsg)
  const prompt = `你是搜索查询改写助手。把用户请求改写成一个用于搜索引擎的精准、简洁的关键词查询，使其能搜到最相关、最具体的网页。\n${dateLine}规则：只输出最终查询关键词本身，不要任何解释、前缀或引号；不要凭空添加用户未提及的公司、品牌或产品名；补全有助于检索的关键词。\n${contextLine}${materialsLine}${taskVerbLine}${skillLine}${sopLine}${company ? `用户所在公司：${company}（仅当用户指代"我司/本公司"时才用它替换）。\n` : ''}用户请求：${userMsg}`
  try {
    const out = await callLlm(prompt, cfg)
    let q = (out || '').trim().split('\n')[0].replace(/^["「『]+|["」』]+$/g, '').replace(/^(查询关键词|关键词|查询)[:：]\s*/, '').trim().slice(0, 80)
    if (forMaterials) q = stripCarrierTerms(q)   // 提示词之外的硬闸：改写再跑偏也进不了检索
    if (simulateTask) q = stripTaskVerbs(q)      // 同上：任务动词绝不进检索词
    if (q) return q   // 检索词由 webSearch 统一叙述（此前这里也 log 一条，界面出现两条重复「正在联网搜」）
  } catch (e) { swallow(e) }
  const base = simulateTask ? stripTaskVerbs(userMsg) : userMsg
  return forMaterials ? stripCarrierTerms(base) : base
}

// 该岗位分身是否被管理端授权联网检索。
// 60s TTL 缓存：单次任务的判定/备料/自救路径会各查一次，同一岗位反复 GET 后端纯属浪费。
const expertWebSearchCache = new Map<string, { v: boolean; at: number }>()
export async function getExpertWebSearch(expertId: string): Promise<boolean> {
  if (!expertId) return false
  const hit = expertWebSearchCache.get(expertId)
  if (hit && Date.now() - hit.at < 60000) return hit.v
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/experts/${expertId}`)
    if (r.ok) {
      const e = await r.json() as ExpertResp
      const v = !!e.webSearchEnabled
      expertWebSearchCache.set(expertId, { v, at: Date.now() })
      return v
    }
  } catch (e) { swallow(e) }
  return false
}

/** 由大模型自主判断该问题是否需要联网检索（已授权联网的分身）。
 *  prompt 与解析在叶子模块 web-search-core（离线校验共用同一套，零漂移）。 */
export async function shouldWebSearch(userMsg: string, cfg: LlmConfig, sendLog: SendLog, kbHits?: KbHit[], history?: { role: 'user' | 'assistant'; content: string }[]): Promise<boolean> {
  const hasCfg = !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)
  if (!hasCfg) return false
  try {
    // 带上对话上文：多轮里"给老婆挑呢？"单看像闲聊，结合上文才能判出"受众切换→旧素材不覆盖→需重搜"
    const yes = parseWebSearchDecision(await callLlm(buildWebSearchPrompt(userMsg, kbHits, historyGist(history)), cfg))
    sendLog('thinking', yes ? '知识库不足以回答，需要联网查一下…' : '这个不用联网，直接答…')
    return yes
  } catch (_) { return false }
}

/** 生成类技能的「备料」判定：这份要生成的交付物，内容是否依赖外部事实数据（需先联网取回）。
 *  与问答判定分开——问答问"能不能答"，备料问"内容从哪来"。prompt 在叶子模块 web-search-core。 */
export async function shouldFetchMaterials(userMsg: string, cfg: LlmConfig, sendLog: SendLog, kbHits?: KbHit[], history?: { role: 'user' | 'assistant'; content: string }[]): Promise<boolean> {
  const hasCfg = !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)
  if (!hasCfg) return false
  try {
    // 同问答判定：受众/对象切换后的"再来一版"，旧素材不覆盖，需重新备料
    const yes = parseWebSearchDecision(await callLlm(buildMaterialsNeedPrompt(userMsg, kbHits, historyGist(history)), cfg))
    sendLog('thinking', yes ? '这份材料的内容要靠外部数据，先联网取回来…' : '手头资料够写这份材料，不用联网。')
    return yes
  } catch (_) { return false }
}

// 判断任务是否需要联网检索。英文侧只认**明确的检索意图短语**（search the web / look up online…），
// 裸词 "search" 会把"讨论搜索算法"也误触发。
export function isWebSearchIntent(content: string): boolean {
  const s = content.toLowerCase()
  return /(联网|上网|网上|搜索|搜一下|搜一搜|查一下网|网上查|检索一下|最新消息|最新动态|新闻|百度|谷歌|google|bing|搜索引擎|查查网上|联网查)/.test(s)
    || /\b(search (the )?(web|internet|online)|search online|look (it |this )?up online|check online|on the internet)\b/.test(s)
}

// 时效性数据意图：内容点名"今天/最新/行情/新闻"这类只能来自外部实时数据的对象。
// 备料判定曾交模型裁量,同一句话时而搜时而不搜(抽风一次=素材为零=NO_DATA 拒产出),
// 命中时效词的生成任务改为**确定性触发**联网备料,不再掷骰子。
export function isTimeSensitive(content: string): boolean {
  // 今年/本届/本赛季：锚定当前现实周期的事件（世界杯/财报季/赛程），只能来自外部实时数据
  //（实锤：「根据今年世界杯之前的比赛情况」不含旧词表任何词，判定掷骰子输了 → 全程没检索）
  if (/(今天|今日|昨日|昨天|本周|上周|下周|本月|今年|本届|这届|本赛季|本季度|近期|近日|最新|实时|行情|走势|股票|股价|股市|大盘|指数|新闻|热点|发布会|汇率|油价|金价|天气)/.test(content)) return true
  // 英文时效词（词边界匹配，防 "know" 命中 "now" 这类子串误触发）；与中文表同一职责：命中即确定性联网
  return /\b(today|tonight|yesterday|latest|current(ly)?|right now|breaking|news|real[- ]?time|stock price|share price|exchange rate|weather|forecast|this (week|month|year|season)|recent(ly)?)\b/i.test(content)
}
