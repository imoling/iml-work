// 联网检索：内置 Tavily / Bing API 及 Electron 离屏页面抓取，供分身判定需联网时补充事实。
import { BrowserWindow } from 'electron'
import { getAdminBaseUrl, afetch } from './http'
import { callLlm, type LlmConfig } from './llm'
import { swallow, sleep } from './util'
import type { SendLog } from './types'
import { buildWebSearchPrompt, parseWebSearchDecision, type KbHit, buildMaterialsNeedPrompt, searchTerms, relevantToAny, stripCarrierTerms, pagePublishDate, dateOutOfRange } from './web-search-core'

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
// query 可选：给了就按页面自述发布时间做日期纪律（与服务端深读同构）——本机兜底细读此前
// 没有任何日期核对，服务端拒掉的旧文被客户端原样读回（实锤：搜狐 2月旧文混进"本周足坛"）。
async function deepReadPages(results: WebSearchResult[], want: number, engine: string, sendLog: SendLog, query?: string): Promise<WebPage[]> {
  const candidates = results.slice(0, Math.min(results.length, want + 2))
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
  await pwCloseAll()   // 整轮结束才关 Playwright 实例（轮内复用）
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
  if (pwBrowser) return pwBrowser
  if (pwUnavailable) return null
  try {
    const { chromium }: any = await import('playwright')
    pwBrowser = await chromium.launch({ headless: true, channel: 'chrome' })
      .catch(async () => await chromium.launch({ headless: true }))
    return pwBrowser
  } catch (e) { swallow(e, 'pw-launch'); pwUnavailable = true; return null }
}
async function pwCloseAll(): Promise<void> {
  try { if (pwBrowser) await pwBrowser.close() } catch (e) { swallow(e) }
  pwBrowser = null; pwUnavailable = false
}
async function pwFetchText(url: string): Promise<string> {
  const b = await pwGet()
  if (!b) return ''
  let page: any = null
  try {
    page = await b.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await page.waitForTimeout(1200)
    const text: string = await page.evaluate(`(document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,2600)`)
    return (text || '').trim()
  } catch (e) { swallow(e, 'pw-fetch'); return '' }
  finally { try { if (page) await page.close() } catch (e) { swallow(e) } }
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
  if (engine === 'PLAYWRIGHT') {
    const t0 = await pwFetchText(url)
    if (t0) return t0
    errs.push('playwright:空/不可用')
  }
  let t = await offscreen(false)
  if (!t) t = await offscreen(true)
  if (!t && engine !== 'PLAYWRIGHT') {
    t = await pwFetchText(url)
    if (!t) errs.push('playwright:空/不可用')
  }
  if (!t && errOut) errOut(errs.join(' → ') || 'empty')
  return t
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
  } else {
    // 服务端没带正文（旧后端/单篇全失败）→ 本地浏览器并行深读兜底（多试几篇抵消个别失败）。
    pages.push(...await deepReadPages(results, cfg.deepReadCount, cfg.browserEngine, sendLog, query))
  }
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
  try {
    // 任何已配置的服务商（TAVILY/BING/SEARXNG/…）都走后端代理；仅 NONE 直接用浏览器兜底
    if (cfg.provider && cfg.provider !== 'NONE') {
      sendLog('acting', `正在联网搜索…`)
      const out = await proxySearch(query, cfg, sendLog)
      if (out) {
        sendLog('completed', `搜到 ${out.results.length} 条结果，细读成功 ${out.pages.length} 篇。`)
        return filterRelevant(out, sendLog, llmCfg)
      }
    }
  } catch (e: any) {
    sendLog('observing', `联网接口不通，改用浏览器搜…`)
  }
  // 回退：内置浏览器检索 + 并行深读（多试几篇抵消个别失败）
  sendLog('acting', `正在用浏览器联网搜索…`)
  const results = await browserSerp(query, cfg.maxResults)
  sendLog('observing', `搜到 ${results.length} 条结果`)
  const pages = await deepReadPages(results, cfg.deepReadCount, cfg.browserEngine, sendLog, query)
  sendLog('completed', `搜到 ${results.length} 条，深读了 ${pages.length} 篇网页。`)
  return filterRelevant({ query, results, pages }, sendLog, llmCfg)
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
  const prompt = `你是搜索查询改写助手。把用户请求改写成一个用于搜索引擎的精准、简洁的关键词查询，使其能搜到最相关、最具体的网页。\n${dateLine}规则：只输出最终查询关键词本身，不要任何解释、前缀或引号；不要凭空添加用户未提及的公司、品牌或产品名；补全有助于检索的关键词。\n${contextLine}${materialsLine}${skillLine}${sopLine}${company ? `用户所在公司：${company}（仅当用户指代"我司/本公司"时才用它替换）。\n` : ''}用户请求：${userMsg}`
  try {
    const out = await callLlm(prompt, cfg)
    let q = (out || '').trim().split('\n')[0].replace(/^["「『]+|["」』]+$/g, '').replace(/^(查询关键词|关键词|查询)[:：]\s*/, '').trim().slice(0, 80)
    if (forMaterials) q = stripCarrierTerms(q)   // 提示词之外的硬闸：改写再跑偏也进不了检索
    if (q) return q   // 检索词由 webSearch 统一叙述（此前这里也 log 一条，界面出现两条重复「正在联网搜」）
  } catch (e) { swallow(e) }
  return forMaterials ? stripCarrierTerms(userMsg) : userMsg
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

/** 由大模型自主判断该问题是否需要联网检索（已授权联网的分身）。
 *  prompt 与解析在叶子模块 web-search-core（离线校验共用同一套，零漂移）。 */
export async function shouldWebSearch(userMsg: string, cfg: LlmConfig, sendLog: SendLog, kbHits?: KbHit[]): Promise<boolean> {
  const hasCfg = !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)
  if (!hasCfg) return false
  try {
    const yes = parseWebSearchDecision(await callLlm(buildWebSearchPrompt(userMsg, kbHits), cfg))
    sendLog('thinking', yes ? '知识库不足以回答，需要联网查一下…' : '这个不用联网，直接答…')
    return yes
  } catch (_) { return false }
}

/** 生成类技能的「备料」判定：这份要生成的交付物，内容是否依赖外部事实数据（需先联网取回）。
 *  与问答判定分开——问答问"能不能答"，备料问"内容从哪来"。prompt 在叶子模块 web-search-core。 */
export async function shouldFetchMaterials(userMsg: string, cfg: LlmConfig, sendLog: SendLog, kbHits?: KbHit[]): Promise<boolean> {
  const hasCfg = !!(cfg && cfg.baseUrl && cfg.apiKey && cfg.modelName)
  if (!hasCfg) return false
  try {
    const yes = parseWebSearchDecision(await callLlm(buildMaterialsNeedPrompt(userMsg, kbHits), cfg))
    sendLog('thinking', yes ? '这份材料的内容要靠外部数据，先联网取回来…' : '手头资料够写这份材料，不用联网。')
    return yes
  } catch (_) { return false }
}

// 判断任务是否需要联网检索。
export function isWebSearchIntent(content: string): boolean {
  const s = content.toLowerCase()
  return /(联网|上网|网上|搜索|搜一下|搜一搜|查一下网|网上查|检索一下|最新消息|最新动态|新闻|百度|谷歌|google|bing|搜索引擎|查查网上|联网查)/.test(s)
}

// 时效性数据意图：内容点名"今天/最新/行情/新闻"这类只能来自外部实时数据的对象。
// 备料判定曾交模型裁量,同一句话时而搜时而不搜(抽风一次=素材为零=NO_DATA 拒产出),
// 命中时效词的生成任务改为**确定性触发**联网备料,不再掷骰子。
export function isTimeSensitive(content: string): boolean {
  return /(今天|今日|昨日|昨天|本周|上周|最新|实时|行情|股价|股市|大盘|指数|新闻|热点|发布会|汇率|油价|金价|天气)/.test(content)
}
