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

/** 判定共用的对话上文摘要（最近 turns 轮、每轮截断，格式与检索词改写器同构）。
 *  多轮里判定绝不能上下文盲判：「给老婆挑呢？」单看像闲聊，结合上文才知道是
 *  "受众切换后的推荐请求"——旧素材不是为新对象检索的，需要重新联网。 */
export function historyGist(history?: { role: string; content: string }[], turns = 4, each = 200): string {
  if (!history || !history.length) return ''
  return history.slice(-turns)
    .map(h => `${h.role === 'user' ? '用户' : '助手'}：${(h.content || '').replace(/\s+/g, ' ').slice(0, each)}`).join('\n')
}

/** 判定提示词共用的上文规则块：素材覆盖判断 + 对象/受众切换需重搜（实锤：电影推荐多轮
 *  中途切换成"给老婆挑"，判定盲判成"基于已给资料"不联网，靠旧素材硬答质量明显下滑）。 */
function ctxBlock(ctx?: string): string {
  return ctx
    ? `\n\n【最近对话上文（摘要）】\n${ctx}\n结合上文判断**本轮**：若上文已包含此前联网取回的素材，且本轮只是对**同一对象、同一维度**的追问/改写/整理——不需要再联网；但若本轮**引入了上文素材未覆盖的新对象/新受众/新维度**（如从"推荐电影"切到"给老婆/给孩子挑"、从 A 公司切到 B 公司、从要数字切到问原因），必须回答「需要」——旧素材不是为新对象检索的，硬套会答偏。`
    : ''
}

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
/**
 * 是否**自足的算术应用题**（GSM8K 类）：题面自带全部数字、要求把它们算出一个结果——联网毫无意义还分心
 * （2026-07 Round3 实锤：gs21「…population of Chile now」命中时效词"now"、gs22「recent floods…」命中"recent"
 *  被误触发联网检索，然后没直接算数、反而去搜"洪水记录"，把两道能算对的题搞错）。
 * 命中特征：① 有明确的"求一个数值"的问法（how many/how much/calculate/what is the total/多少/几…）
 *          ② 题面数字密集（≥3 个数字，应用题的典型密度）。两条同时满足 → 判为自足算术题，不联网。
 * 保守从严：只在两条都命中时才判定，避免误伤"今天股价是多少"这类真需外部数据的问题
 *（后者数字通常 <3 个、且问的是外部实时值而非题内数字的组合）。
 */
export function isSelfContainedMath(text: string): boolean {
  const t = text || ''
  const asksNumber = /\b(how many|how much|how old|how far|how long|how fast|calculate|compute|what is the (total|sum|product|difference|average|value|result|remainder|number)|find the (total|number|value|sum|difference|amount)|what will be|will .+ have|does .+ have left|are (there )?left|remain(ing)?|altogether|in total)\b/i.test(t)
    || /(一共|总共|总和|加起来|还剩|剩下|剩多少|多少[个只件张元米天年岁块本条根份]|几[个只件张米天年岁]|平均|求[出得]?.{0,4}(是多少|等于|结果|总数|数量))/.test(t)
  if (!asksNumber) return false
  // 数字密度：阿拉伯数字 + 英文数字词（six/half/twice…）+ 中文数字都计入——GSM8K 题常把数量写成词
  //（gs21「Six years… half as old… 3000 times」只有 2 个阿拉伯数字，但 six/half 也是数量）。
  const digits = (t.match(/\d+(?:[.,]\d+)?/g) || []).length
  const numWords = (t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|hundred|thousand|million|half|twice|double|triple|dozen|quarter)\b/gi) || []).length
  return digits + numWords >= 3
}

/**
 * 是否**多跳/比较/聚合**问题（需要顺链补查）。单跳事实题（"某年发布某表""某人的本名"）答案在首轮
 * 就有，跑多跳补查是纯时延浪费（2026-07 Round3：SimpleQA 单事实题白付一轮补查 ~40s）。
 * 只有命中多跳特征才做补查——FRAMES 类链式/比较题保留，SimpleQA 类单事实题跳过。
 */
export function isMultiHopQuestion(text: string): boolean {
  const t = (text || '').toLowerCase()
  // 英文多跳/比较/聚合信号
  if (/\b(compared? (to|with)|than|between .+ and |how many .+ (than|between|apart)|difference|older|younger|taller|earlier|later|before .+ (born|died|founded|released)|after .+ (born|died|founded)|the (director|author|founder|creator) of .+ (also|other)|which .+ (both|and))\b/.test(t)) return true
  // "A 的 B 的 C"链：英文两个及以上 of/'s 从属
  if ((t.match(/\bof\b/g) || []).length >= 2 || (t.match(/'s\b/g) || []).length >= 2) return true
  // 中文多跳/比较/聚合信号
  if (/相比|比.+(早|晚|多|少|高|矮|大|小)|之间|差(多少|几)|谁(更|的.+更)|的.+的.+(是|叫|为)|一共|总共|加起来|哪.+同时/.test(text || '')) return true
  return false
}

/**
 * 是否**需要通用 agent 循环**（P1）：多步"检索→用结果再检索/计算"才能回答的复杂题，
 * 单趟"搜一次+综合"够不着（GAIA L2/L3、FRAMES 聚合题的典型形态）。
 * 保守触发：必须**同时**是多跳/比较题 **且** 带聚合/计算诉求——只吃明确复杂的那一档，
 * 简单事实问答（"某年发布某表"）继续走已调优的快路径，不被 agent 循环劫持。
 * 自足算术题（题面自带全部数字）走本地计算，不进这里。
 */
export function needsAgentLoop(text: string): boolean {
  if (isSelfContainedMath(text)) return false   // 题面自带全部数字 → 本地算，不走循环
  const t = (text || '')
  // 「求派生数值」信号：答案是一个需要**组合多个查到的事实再算**的值（搜事实 A → 用 A 定位 B → python 真算）。
  const derived =
    // 比较/多寡：how many more/fewer … than、older/earlier … than
    /\bhow many (more|fewer|additional)\b|\b(more|fewer|older|younger|earlier|later|greater|larger|smaller|higher|lower|longer|shorter) than\b/i.test(t)
    // 年龄/时长派生：how old / what age / how long（配合 when/at/on/after/before 时间锚）
    || /\b(how old|what age|how long|how many (days|years|months|weeks|hours))\b/i.test(t)
    // 聚合：sum/total/combined/difference/average of|between
    || /\b(sum|total|combined|difference|average|aggregate) (of|between|for)\b/i.test(t)
    // 中文派生/比较/聚合
    || /相差(多少|几)?|差(多少|几)[年天岁个]|比.+(早|晚|多|少|高|矮|大|小)(几|多少)|多少(年|天|岁)后|之和|总和|一共.+(多少|几)|平均.+(是多少|为)|谁(更|的.+更)(大|老|高|多|早|晚)/.test(t)
  // 放宽（2026-07-20，实测教训）：不再要求"求派生数值"——FRAMES/GAIA 的主体是"多跳找实体"
  //（"Who won X in the year that Y"、"What movie debuted the same year that Z"），需多步查证但答案不是"算一个数"。
  // 旧门槛只吃派生数值 → 40 道 FRAMES/GAIA 只触发 2 道，循环价值测不到。故 **多跳 或 求派生数值** 都进循环。
  // 多跳信号：isMultiHop 之外，补 FRAMES 高频的"在同一年/同一地发生 X 的那个 Y"结构（结构模式，非记具体答案）——
  // "Who won X in the same year that Y"、"a president born the same year the Treaty was signed" 需先定位从句年份再查主句。
  const multiHop = isMultiHopQuestion(t)
    || /\bthe same (year|day|month|decade|season|city|place|team|club|company|school|award) (that|as|when|in which)\b/i.test(t)
  if (!(derived || multiHop)) return false
  // 但必须"确需外部查证"：锚定真实命名实体/年份/事件。这道闸是安全关键——
  // GSM8K 的应用题（gs05/06/25…）isMultiHop=true（多个 of/than）却自足、无需联网，用虚构角色+日常物品、
  // 无真实实体锚 → 被此闸挡住，不误进循环、不回退 96.7%。FRAMES/GAIA 多跳题必锚真实实体/年份 → 放行。
  //（注意：不再把 isMultiHop 本身当 lookup 信号，否则自足算术应用题会漏进来。）
  const hasEntity = /\b(19|20)\d{2}\b/.test(t)                     // 年份
    || /[A-Z][a-z]+ [A-Z][a-z]+/.test(t)                          // 连续双专名（真实人名/地名/作品）
    || /[A-Z][a-z]+ of [A-Z][a-z]+/.test(t)                       // "Treaty of Resht"/"Battle of Sobraon" 型专名（含小写 of）
    || /[一-鿿]{2,}(公司|大学|城市|事件|奥运|战争|条约|作品|电影|专辑|球队|王朝|地区|车站|铁路|球员|总统|歌手|演员|导演|乐队|机构|组织|赛季|锦标赛)/.test(t)
  return hasEntity
}

/**
 * 是否需要**开放式浏览器操作**（P3 · browse）：任务要在一个真实网站里**多步动手办成**
 * （导航→点击/填写/提交/下单/预约/登录…），对标 WebArena。这类单靠检索/读页够不着，必须真开浏览器操作。
 * **极保守触发**：只吃出现**明确交互动作**信号的任务（登录/填表/提交/下单/购物车/预约/"在某网站上点或填"），
 * 而非"读某页取个事实"（那走 read_page/web_search）。browse 重且需真实 Electron、桩 harness 里跑不了，
 * 宁可漏判走快路径、绝不滥判把普通问答拖进浏览器。
 */
export function needsBrowseAgent(text: string): boolean {
  const t = text || ''
  const lower = t.toLowerCase()
  // 交互场景信号（英文）：登录/表单/下单/购物车/预订
  if (/\b(log ?in|sign ?in|fill (out|in)|add to cart|check ?out|place an order|reserve a |book a )\b/i.test(lower)) return true
  if (/\bsubmit\b.{0,24}\b(form|order|application|request)\b|\bmake a (booking|reservation|appointment)\b/i.test(lower)) return true
  // 交互场景信号（中文）：登录网站/加入购物车/下单/预约/填表提交
  if (/(登录|登陆).{0,12}(网站|系统|网页|账[号户]|后台)|加入购物车|结算下单|下单购买|预约挂号|填写(表单|表格|申请)|提交(表单|申请|订单)/.test(t)) return true
  // "在/去/打开某网站/网页/系统 … + 操作动词"
  if (/(在|去|到|打开|进入).{0,24}(网站|网页|页面|系统|后台).{0,24}(点击|点选|填写|填入|提交|搜索|勾选|选择|翻页|发布|新建|下单|购买|预约|操作)/.test(t)) return true
  // 显式给了 URL 且要求在该页**操作**（非仅读取）
  if (/https?:\/\/\S+/i.test(t) && /(点击|填写|提交|下单|登录|勾选|操作|\bclick\b|\bfill\b|\bsubmit\b|\blog ?in\b)/i.test(lower)) return true
  return false
}

/**
 * 补查词是否锚定在首轮素材里：英文按 ≥4 位字母数字词命中（忽略大小写），中文按任一连续 2-gram 命中。
 * 为什么：补查词生成偶尔脱离素材自由联想，搜回来整轮无关页（实锤：HR7004 的补查词漂移后
 * 拉回伊斯兰艺术博物馆/网文小说页）。未锚定的补查词直接丢弃，比搜完再靠语义把关剔除省一整轮时延。
 */
export function anchoredInMaterials(q: string, materials: string): boolean {
  if (!materials || !materials.trim()) return true   // 无素材可校验时不拦
  const m = materials.toLowerCase()
  for (const w of (q.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [])) {
    if (m.includes(w)) return true
  }
  for (const run of (q.match(/[一-鿿]{2,}/g) || [])) {
    for (let i = 0; i + 1 < run.length; i++) {
      if (m.includes(run.slice(i, i + 2))) return true
    }
  }
  return false
}

export function buildWebSearchPrompt(userMsg: string, kbHits?: KbHit[], ctx?: string): string {
  const kbBlock = kbHits && kbHits.length
    ? `\n\n【已检索企业知识库 · 命中 ${kbHits.length} 条】\n` +
      kbHits.slice(0, 3).map(c => `- ${c.filename ? `《${c.filename}》：` : ''}${c.text.replace(/\s+/g, ' ').slice(0, 160)}…`).join('\n') +
      `\n若上面这些内部资料已足以回答该问题，就回答「不需要」——**内部问题不该跑去外网搜**。`
    : `\n\n【已检索企业知识库】未命中任何相关内容。`
  return `判断要回答下面这个问题，是否需要联网检索最新或外部信息（例如：实时价格/股价/汇率、航班/车票、天气、新闻或近期事件、产品/政策的最新情况、你并不掌握的具体事实与数据）。
如果问题只是闲聊、寒暄、改写、基于已给资料的分析、或常识性问答，则不需要。
注意：**话题落在正在进行或近期的现实事件上**（体育赛事/决赛、行情、发布会、时事、人物近况），即使问法像闲聊或征求观点（"XX 你怎么看""聊聊 XX"），也**需要**——先取回最新事实，观点才有据可依（实锤：「世界杯决赛你怎么看」被当闲聊没联网，答复只能空谈）。
注意：问题在询问**具体的长尾事实**——某个人名/日期/年份/地点/数字/型号/编号/名次，或某部作品、某家机构、某个条目的具体属性（中外皆算、新旧皆算）——除非答案是妇孺皆知的常识，一律**需要**：凭记忆答错长尾事实的代价远高于多搜一次（实锤：「精工首款300米潜水表哪年发布」被当常识、凭记忆答错年份还编造了型号）。例：「某决议是哪天引入的」「某艺术家以什么名号更为人知」「某生态村位于哪个县」→ 都需要。
只输出一个字：需要 或 不需要。
问题：${userMsg}${kbBlock}${ctxBlock(ctx)}`
}

/**
 * 生成类技能的「备料」判定：这份**要生成的交付物**，内容是否依赖外部事实数据？
 *
 * ⚠️ 不能复用上面那个问答判定。它问的是"要**回答**这个问题需不需要联网"——
 * 面对「生成股票信息汇报的 word 和 ppt」，模型把它读成"一个我会做的文档任务"，答"不需要"。
 * 于是技能在信息真空里开工，沙箱又是网络隔离的，最后交出一份写满「待填充」「暂无数据」的空壳文档。
 * 备料要问的是另一件事：**这份材料的内容从哪来** —— 依赖行情/新闻/公告/实时数值吗？
 */
export function buildMaterialsNeedPrompt(userMsg: string, kbHits?: KbHit[], ctx?: string): string {
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
用户请求：${userMsg}${kbBlock}${ctxBlock(ctx)}`
}

/**
 * 能力否认检测：回答文本里出现"我无法联网/无法访问网络/无法获取实时信息"这类话术。
 * 系统明明具备联网检索（岗位授权 + 后端代理），判定层漏放行时模型会自称无能力——
 * 当着用户面自砍产品能力（实锤：世界杯决赛问答）。命中且本轮未检索 → 管线补检索重答。
 */
export function deniesNetworkAccess(text: string): boolean {
  if (!text) return false
  // 三类话术：①明说不能联网；②"无法获取…真实/实时/最新…数据"（实锤变体："我无法直接获取
  // 2026年世界杯任何一场真实比赛的数据"——不含"联网"二字，旧正则漏接）；③拿"能力边界"当挡箭牌。
  return /(无法|不能|不可|没法|没有办法|不具备)[^。！？\n]{0,8}(联网|上网|(接入|访问|连接)[^。！？\n]{0,6}(网络|互联网))/.test(text)
    || /没有联网(能力|权限)/.test(text)
    || /(无法|不能|没法)[^。！？\n]{0,6}(获取|访问|查询|取得|拿到)[^。！？\n]{0,14}(实时|最新|真实|外部|任何)[^。！？\n]{0,12}(信息|数据|资讯|资料|赛果|行情|结果)/.test(text)
    || /能力边界/.test(text)
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

/**
 * SEO/广告模板页检测（实锤：「世界杯到什么阶段」命中 SEO 模板页，正文是"东道主 vs 挑战者"
 * "传统强队 2-1 黑马队伍"这类**占位符赛况**——真报道绝不会拿"挑战者/黑马队伍/球队A"当队名——
 * 语义把关只筛"明显无关"筛不掉它们，模型把占位文案冠以"官方数据"整段引用，答案全错）。
 * 强特征（占位符对阵/比分）单独命中即判垃圾；弱特征（广告话术/入口导航）须 ≥2 类，宁可漏过不误杀。
 */
export function looksLikeJunkPage(text: string, title?: string): boolean {
  const t = `${title || ''} ${text || ''}`
  if (/(东道主|传统强队|主队)\s*(vs|VS|对阵|\d+\s*[-:比]\s*\d+)\s*(挑战者|黑马(队伍)?|客队)/.test(t)) return true
  if (/球队\s*[ABab]\s*(vs|VS|对阵|\d+\s*[-:比]\s*\d+)|示例(数据|内容|文案)/.test(t)) return true
  // 赌球页正文强特征：博彩硬词 + 开户/存款话术同现（真报道极少两类并存；反赌 PSA 误伤可接受）
  if (/(投注|下注|滚球|让球盘|独赢|串关|博彩|娱乐城)/.test(t) && /(开户|存款|彩金|注册送|首存)/.test(t)) return true
  let weak = 0
  if (/(点击|立即|扫码)\s*(下载|注册|开户|领取)|下载\s*APP\s*(领|抢|送)|注册(即)?送|开户(福利|礼包)/.test(t)) weak++
  if (/(官网|官方)\s*(备用|导航|入口|地址|线路)|(备用|最新)\s*(网址|入口|线路)/.test(t)) weak++
  if (/(在线客服|加微信|联系客服).{0,12}(咨询|领取|办理)/.test(t)) weak++
  return weak >= 2
}

/**
 * 任务动词剥离：用户要分身**做**模拟/推演时，这些词是任务不是检索对象——混进检索词只会
 * 搜到"模拟器/推演平台/预测计算器"站点，真实事实一条拿不到（实锤：「根据今年世界杯之前的
 * 比赛情况，模拟下决赛」被改写成带"模拟 推演"的检索词，来源全是推演工具站）。
 * 不剥"预测"——"机构预测/天气预测"常是正当检索对象。全剥空则退回原词。
 */
export function stripTaskVerbs(query: string): string {
  const stripped = (query || '')
    .replace(/模拟器?|推演|沙盘|假想|预演/g, ' ')
    .replace(/\s+/g, ' ').trim()
  return stripped || (query || '').trim()
}

/** 大站品牌的「站点署名」→ 官方域：SERP 标题末尾挂"- 腾讯体育"这类署名、域名却对不上 = 冒充。
 *  只匹配**结尾署名位**，不匹配正文提及（"FIFA官网公布名单"这类新闻标题不能误杀）。 */
const BRAND_SUFFIX: [RegExp, string[]][] = [
  [/[-_|｜·—]\s*腾讯(体育|网|新闻)?\s*$/, ['qq.com']],
  [/[-_|｜·—]\s*新浪(体育|网|新闻)?\s*$/, ['sina.com.cn', 'sina.cn']],
  [/[-_|｜·—]\s*网易(体育|新闻)?\s*$/, ['163.com', '126.com']],
  [/[-_|｜·—]\s*搜狐(体育|网)?\s*$/, ['sohu.com']],
  [/[-_|｜·—]\s*(央视网|CCTV)\s*$/i, ['cctv.com', 'cntv.cn', 'cctv.cn']],
  [/[-_|｜·—]\s*懂球帝\s*$/, ['dongqiudi.com']],
  [/[-_|｜·—]\s*虎扑\s*$/, ['hupu.com']],
  [/[-_|｜·—]\s*FIFA(世界杯)?\s*$/i, ['fifa.com']],
]

/**
 * 搜索结果级垃圾判定（只看标题/域名/摘要，不深读也能拦——结果列表与「联网来源」卡都要干净）。
 * 实锤：世界杯问答的来源全链是赌球 SEO 页，标题清一色「中文指定官方平台 - 腾讯体育」
 * 「官方中文网站」，域名却是杂牌——不是用户电脑中毒，是百度/必应 SERP 被赌球产业污染。
 * ① 标题末尾冒充大站署名、域名对不上；② 自称"(指定)官方平台/官方中文官网"却非权威/专业域
 * （真官方都在权威名单里）；③ 标题/摘要含博彩硬词。
 */
export function looksLikeJunkResult(title: string, url: string, snippet?: string): boolean {
  const t = (title || '').trim()
  const u = (url || '').toLowerCase()
  const h = hostOf(u)
  for (const [re, domains] of BRAND_SUFFIX) {
    if (re.test(t) && !domains.some(d => domainHit(u, h, d))) return true
  }
  const tier = sourceTier(url)
  if (/(指定|授权)官方(平台|网站|官网|网址|入口)|中文指定官方|官方(中文)?(官网|网站|平台|网址|入口)/.test(t)
      && tier !== '权威' && tier !== '专业') return true
  const ts = `${t} ${snippet || ''}`
  return /(投注|下注|滚球|让球盘|独赢|串关|博彩|娱乐城|首存|彩金)/.test(ts)
}

/**
 * 反爬/人机验证拦截页检测：抓到了"正文"但内容是验证壳页——等于没抓到，必须触发下一档引擎重试
 * （实锤：大站深读拿回"请开启JavaScript/Just a moment"短壳页，旧链条视为"抓取成功"直接返回，
 * Playwright 档根本没机会出场，最后素材只剩 SEO 页）。限长 <600：真报道正文里提到"验证码"不算。
 */
export function looksBlockedPage(text: string): boolean {
  const t = (text || '').trim()
  if (!t || t.length >= 600) return false
  return /(请开启|请启用|开启并刷新).{0,8}JavaScript|enable\s+JavaScript|Just a moment|Checking your browser|Verifying you are human|人机验证|安全验证|访问(验证|异常)|请完成.{0,8}验证|(访问|请求)过于频繁|403 Forbidden|Access Denied|需要开启\s*Cookie|正在(跳转|加载中)…?$/i.test(t)
}

export function sourceTier(url: string): '权威' | '专业' | '一般' | '自媒体' {
  const u = (url || '').toLowerCase()
  const h = hostOf(u)
  for (const d of TIER_OFFICIAL_HOSTS) if (domainHit(u, h, d)) return '权威'
  for (const d of TIER_UGC_HOSTS) if (domainHit(u, h, d)) return '自媒体'   // UGC 先于专业判:网易号/知乎专栏等有交叠
  for (const d of TIER_PRO_HOSTS) if (domainHit(u, h, d)) return '专业'
  return '一般'
}
