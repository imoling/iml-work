// 联网检索判定的核心（叶子模块：纯函数，不 import electron —— 运行时与离线校验共用同一套 prompt）。
// 抽出来的理由和 ontology-core / skill-router-core 一样：判定逻辑必须可离线验证，否则测的是另一套。

export interface KbHit { filename?: string; text: string; score?: number }

/** 企业知识库「足以作答」的分数线：高于此分直接跳过联网（连判定这次模型调用都省了）。
 *  比相关性下限（RAG_MIN_SCORE=0.62）更高一档——过了下限只说明"相关"，够不够作答还要模型看一眼。
 *  ⚠️ 与下限一样，**跟着 embedding 模型走，换模型必须重新标定**（bge-m3 实测真命中 0.655~0.790）。 */
// ── 检索结果相关性过滤 ─────────────────────────────────────────────────────
// 血泪：远端未配检索服务商时走本机 Bing 兜底，「科大讯飞 股票」搜回一堆
// 「中国科学技术大学」页面（"科大"撞名）——无关素材混进生成链路，PPT 拿大学简介
// 硬凑"股票分析"。按查询主体词过滤：相关页面几乎必然含主体词，全滤光=检索失败如实报缺。

/** 查询主体词：最长的非日期连续中英文串（≥3 字）。全是短词时返回空串=不过滤（保守）。 */
// 泛化修饰词不配当主体："最新动态/行业要闻"这类查询修饰几乎不会原样出现在文章标题里，
// 拿它当过滤词会把整轮结果滤光（实锤："昨天 AI 最新动态"主体被抽成「最新动态」→ 全滤 →
// 明明细读了 8 篇却回复"未返回任何结果"）。时间词同理。复合词（行业要闻/最新行业动态）
// 靠枚举堵不完 → 判据改为：剥掉所有泛化子词后没剩东西，就是纯修饰复合。
const GENERIC_STRIP = /最新|动态|新闻|资讯|要闻|热点|进展|消息|情况|信息|详情|内容|行业|领域|方面|相关|汇报|报告|总结|分析|盘点|回顾|概况|概述|介绍|发布|公告|数据|结果|清单|列表|排行|排名|大全|今天|今日|昨天|昨日|前天|本周|上周|近期|近日/g

/** 主体词组（最多 4 个，按长度降序）：中文 ≥2 字、英文 ≥2 字母（AI/GPT 这类短主体不能漏），
 *  剔除日期串与泛化修饰词。复合词同时收录"剥掉泛化子词后的残核"——「汽车行业」的正文标题
 *  多半只写「汽车」,拿整词做子串匹配必漏(实锤:汽车行业新闻细读成功却全被滤光)。
 *  空数组=没有可靠主体，调用方应放弃过滤。 */
export function searchTerms(query: string): string[] {
  const runs = (query || '').match(/[一-龥]{2,}|[A-Za-z][A-Za-z0-9+]+/g) || []
  const out: string[] = []
  for (const r of runs) {
    if (/^[\d年月日号点时分]+$/.test(r)) continue
    if (/[A-Za-z]/.test(r)) { out.push(r); continue }
    const core = r.replace(GENERIC_STRIP, '')
    if (core === '') continue                       // 纯泛化复合（最新动态/行业要闻）
    out.push(r)
    if (core !== r && core.length >= 2) out.push(core)   // 残核并列参与任一命中
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length).slice(0, 4)
}

export function primarySearchTerm(query: string): string {
  return searchTerms(query)[0] || ''
}

/** 文本组里任一段命中**任一**主体词即视为相关（英文不区分大小写）；无主体词 → 不过滤。 */
export function relevantToAny(terms: string[], ...texts: (string | undefined)[]): boolean {
  if (!terms.length) return true
  const joined = texts.map(t => t || '').join('\n').toLowerCase()
  return terms.some(t => joined.includes(t.toLowerCase()))
}

export function relevantToTerm(term: string, ...texts: (string | undefined)[]): boolean {
  if (!term || term.length < 3) return true
  return relevantToAny([term], ...texts)
}

/**
 * 载体词剥离：生成类技能「备料」检索只找**内容数据**，不找载体/样式。
 * 血泪：「帮我分析今天的股市并生成一个ppt」被改写成「…股市分析 PPT模板」→
 * 搜回来全是 PPT 模板站 → 相关性红线全滤光 → 素材不足拒产出（生产实锤）。
 * 载体（PPT/Word/表格）由本地技能生成，绝不需要上网找模板。全剥空则退回原词（宁可搜歪不搜空）。
 */
export function stripCarrierTerms(query: string): string {
  const stripped = (query || '')
    .replace(/(PPT|PPTX|WORD|DOCX|EXCEL|XLSX|PDF)?\s*(模板|范文|样例|样式)/gi, ' ')
    .replace(/\b(PPT|PPTX|WORD|DOCX|EXCEL|XLSX)\b/gi, ' ')
    .replace(/幻灯片|演示文稿/g, ' ')
    .replace(/\s+/g, ' ').trim()
  return stripped || (query || '').trim()
}

export const KB_CONFIDENT = 0.70

/** 知识库最高命中分。 */
export function kbTopScore(hits?: KbHit[]): number {
  return hits && hits.length ? Math.max(...hits.map(h => h.score || 0)) : 0
}

/**
 * 联网判定提示词。
 *
 * ⚠️ 必须把**企业知识库的检索结果**一起交给模型。
 * 曾经这个判定是在**信息真空**里做的：链路上"决定要不要联网"发生在"查企业知识库"**之前**，
 * 提示词又只说"你并不掌握的具体事实" —— 于是问「iML Work 的总体架构」时模型想：这是我不掌握的
 * 具体事实 → 需要联网。它压根不知道企业知识库里就躺着那份白皮书。
 * 代价：白跑一次搜索（2 次模型调用 + 抓网页），还在客户面前端出"腾讯云/夸智网"这种毫不相干的来源，
 * 而最终答案根本来自知识库。**内部问题跑去外网搜，对企业客户是硬伤。**
 */
export function buildWebSearchPrompt(userMsg: string, kbHits?: KbHit[]): string {
  const kbBlock = kbHits && kbHits.length
    ? `\n\n【已检索企业知识库 · 命中 ${kbHits.length} 条】\n` +
      kbHits.slice(0, 3).map(c => `- ${c.filename ? `《${c.filename}》：` : ''}${c.text.replace(/\s+/g, ' ').slice(0, 160)}…`).join('\n') +
      `\n若上面这些内部资料已足以回答该问题，就回答「不需要」——**内部问题不该跑去外网搜**。`
    : `\n\n【已检索企业知识库】未命中任何相关内容。`
  return `判断要回答下面这个问题，是否需要联网检索最新或外部信息（例如：实时价格/股价/汇率、航班/车票、天气、新闻或近期事件、产品/政策的最新情况、你并不掌握的具体事实与数据）。
如果问题只是闲聊、寒暄、改写、基于已给资料的分析、或常识性问答，则不需要。
只输出一个字：需要 或 不需要。
问题：${userMsg}${kbBlock}`
}

/**
 * 生成类技能的「备料」判定：这份**要生成的交付物**，内容是否依赖外部事实数据？
 *
 * ⚠️ 不能复用上面那个问答判定。它问的是"要**回答**这个问题需不需要联网"——
 * 面对「生成股票信息汇报的 word 和 ppt」，模型把它读成"一个我会做的文档任务"，答"不需要"。
 * 于是技能在信息真空里开工，沙箱又是网络隔离的，最后交出一份写满「待填充」「暂无数据」的空壳文档。
 * 备料要问的是另一件事：**这份材料的内容从哪来** —— 依赖行情/新闻/公告/实时数值吗？
 */
export function buildMaterialsNeedPrompt(userMsg: string, kbHits?: KbHit[]): string {
  const kbBlock = kbHits && kbHits.length
    ? `\n\n【已检索企业知识库 · 命中 ${kbHits.length} 条】\n` +
      kbHits.slice(0, 3).map(c => `- ${c.filename ? `《${c.filename}》：` : ''}${c.text.replace(/\s+/g, ' ').slice(0, 160)}…`).join('\n') +
      `\n若这些内部资料已足够写出这份交付物，就回答「不需要」——内部资料够用就别跑去外网搜。`
    : `\n\n【已检索企业知识库】未命中任何相关内容。`
  return `用户要求生成一份交付物（文档 / PPT / 表格 / 报告）。请判断：**这份交付物里要写的内容**，是否依赖你并不掌握的外部事实数据？
外部事实数据指：股价与行情、市场与行业动态、新闻或近期事件、公司公告与财报、政策/产品的最新情况、任何实时数值。
- 依赖 → 回答「需要」。**必须先联网取回真实数据**，否则只能写出「待填充」「暂无数据」的空壳，等于没干活。
- 不依赖 → 回答「不需要」。例如：通用模板（请假条/合同范本）、基于用户已提供的资料或输入文件、对上文已有产物做格式转换或改写、纯常识性内容。
注意：用户不会明说"联网"二字。要看的是**内容从哪来**，不是他有没有提检索。
只输出一个字：需要 或 不需要。
用户请求：${userMsg}${kbBlock}`
}

/** 解析判定输出。含"不需要"优先——避免 "不需要联网" 被 /需要/ 误判成需要。 */
export function parseWebSearchDecision(out: string): boolean {
  const t = (out || '').trim()
  return /需要/.test(t) && !/不需要/.test(t)
}

/** 信源权威分级(四档,对齐主流标准)——与后端 WebSearchService 的 TIER_OFFICIAL/TIER_PRO/TIER_UGC
 *  **同构**(后端负责检索结果重排,这里负责给素材块打标签,改任一侧必须同步另一侧)。
 *  T0 权威=政府/学术/交易所/官媒/国际组织;T1 专业=垂直行业媒体与智库研报;T2 一般=未识别默认;
 *  T3 自媒体=UGC/问答/公众号/社交。为什么要标:自媒体"复盘"常滞后一天且互相转抄,数字从它们采信
 *  是"7月17日报告用了7月16日数据"事故的温床;打上标签,事实提炼提示词才能执行采信红线。 */
const TIER_OFFICIAL_HOSTS = ['.gov.cn', '.edu.cn', 'sse.com.cn', 'szse.cn', 'bse.cn',
  'xinhuanet.com', 'news.cn', 'people.com.cn', 'cctv.com', 'cnr.cn',
  'gmw.cn', 'chinanews.com', 'china.com.cn', 'ce.cn',
  'cnki.net', 'nature.com', 'science.org', 'ieee.org', 'nih.gov',
  'who.int', 'un.org', 'worldbank.org', 'imf.org']
const TIER_PRO_HOSTS = [
  // 金融/证券/财经
  'stcn.com', 'cnstock.com', 'cs.com.cn', 'caixin.com', 'yicai.com', '21jingji.com',
  'jiemian.com', 'wallstreetcn.com', 'cls.cn', 'nbd.com.cn', 'eastmoney.com',
  '10jqka.com.cn', 'finance.sina.com.cn', 'cngold.org', 'hexun.com', 'jrj.com.cn',
  'cnfol.com', 'bloomberg.com', 'reuters.com', 'ft.com',
  // 科技/AI
  '36kr.com', 'tmtpost.com', 'leiphone.com', 'jiqizhixin.com', 'qbitai.com',
  'infoq.cn', 'geekpark.net', 'techcrunch.com', 'theverge.com',
  // 综合新闻专业媒体
  'bjnews.com.cn', 'thepaper.cn', 'caijing.com.cn',
  // 咨询/智库/行业研报
  'mckinsey.com', 'bcg.com', 'gartner.com', 'idc.com', 'iresearch.com.cn',
  'analysys.cn', 'iyiou.com', 'qianzhan.com', 'chyxx.com', '199it.com', 'cbndata.com',
  'askci.com', 'chinairn.com',
  // 医疗健康
  'dxy.cn', 'cn-healthcare.com', 'medsci.cn', 'pharmnet.com.cn',
  // 汽车 / 教育 / 能源 / 地产
  'gasgoo.com', 'd1ev.com', 'eol.cn', 'jiemodui.com', 'bjx.com.cn', 'cricchina.com',
  // 体育（垂直资讯，赛事赛果时效性强于综合门户）
  'zhibo8.cc', 'dongqiudi.com', 'titan24.com']
const TIER_UGC_HOSTS = ['zhihu.com', 'baijiahao.baidu.com', 'xueqiu.com', 'jianshu.com', 'csdn.net', 'sohu.com',
  '163.com/dy', 'toutiao.com', 'weibo.com', 'tieba.baidu.com', 'aigupiao.com', 'bilibili.com', 'douyin.com', 'zhuanlan.',
  'zhidao.baidu.com', 'mp.weixin.qq.com', 'wenda.so.com', 'iask.sina.com.cn', 'baike.baidu.com',
  // 专业站的 UGC 子域(先于专业档判定,实现子域覆盖):东财股吧/博客/财富号、新浪博客
  'guba.eastmoney.com', 'blog.eastmoney.com', 'caifuhao.eastmoney.com', 'blog.sina.com.cn']

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

/** 域名条目匹配(与后端 domainHit 同构):".gov.cn"=主机后缀;"zhuanlan."=主机前缀;
 *  含"/"=整 URL 包含(163.com/dy 网易号);其余=主机全等或以 ".域名" 结尾。
 *  不能用裸 contains——血泪:insurance.cngold.org 含子串 "ce.cn" 被误判成权威档。 */
function domainHit(url: string, host: string, d: string): boolean {
  if (d.includes('/')) return url.includes(d)
  if (d.startsWith('.')) return host.endsWith(d)
  if (d.endsWith('.')) return host.startsWith(d)
  return host === d || host.endsWith('.' + d)
}

// ── 页面发布时间纪律（与后端 WebSearchService.fetchPage **同构**，改一侧必须同步另一侧）──
// 本机兜底细读此前没有任何日期核对：服务端拒掉的旧文被客户端原样读回（实锤：搜狐 2026-02-01
// 旧文混进"本周足坛"素材）。发布时间几乎总在标题与正文之间——扫头部即可。
const PAGE_DATE_RE = /(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/

/** 从页面文本头部提取自述发布时间，返回 'YYYY-MM-DD'；没有则 null。 */
export function pagePublishDate(text: string): string | null {
  const m = (text || '').slice(0, 1800).match(PAGE_DATE_RE)
  if (!m) return null
  const y = +m[1], mo = +m[2], d = +m[3]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** 发布时间与查询时间范围是否明显不符：查询带完整日期→偏离超1天；只带年月→偏离超1个月；无日期→不判。 */
export function dateOutOfRange(pubIso: string, query: string): boolean {
  const pm = pubIso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!pm) return false
  const pub = new Date(+pm[1], +pm[2] - 1, +pm[3])
  const qFull = (query || '').match(PAGE_DATE_RE)
  if (qFull) {
    const want = new Date(+qFull[1], +qFull[2] - 1, +qFull[3])
    return Math.abs(pub.getTime() - want.getTime()) > 86400000 * 1.5   // ±1 天放行（盘前/隔夜稿常前晚发）
  }
  const qYm = (query || '').match(/(20\d{2})\s*[-/年]\s*(\d{1,2})\s*月/)
  if (qYm) {
    const months = Math.abs((pub.getFullYear() - +qYm[1]) * 12 + (pub.getMonth() + 1 - +qYm[2]))
    return months > 1   // 跨月边界放行（"6月总结"常7月初发）
  }
  return false
}

export function sourceTier(url: string): '权威' | '专业' | '一般' | '自媒体' {
  const u = (url || '').toLowerCase()
  const h = hostOf(u)
  for (const d of TIER_OFFICIAL_HOSTS) if (domainHit(u, h, d)) return '权威'
  for (const d of TIER_UGC_HOSTS) if (domainHit(u, h, d)) return '自媒体'   // UGC 先于专业判:网易号/知乎专栏等有交叠
  for (const d of TIER_PRO_HOSTS) if (domainHit(u, h, d)) return '专业'
  return '一般'
}
