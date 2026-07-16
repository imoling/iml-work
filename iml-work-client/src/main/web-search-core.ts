// 联网检索判定的核心（叶子模块：纯函数，不 import electron —— 运行时与离线校验共用同一套 prompt）。
// 抽出来的理由和 ontology-core / skill-router-core 一样：判定逻辑必须可离线验证，否则测的是另一套。

export interface KbHit { filename?: string; text: string; score?: number }

/** 企业知识库「足以作答」的分数线：高于此分直接跳过联网（连判定这次模型调用都省了）。
 *  比相关性下限（RAG_MIN_SCORE=0.62）更高一档——过了下限只说明"相关"，够不够作答还要模型看一眼。
 *  ⚠️ 与下限一样，**跟着 embedding 模型走，换模型必须重新标定**（bge-m3 实测真命中 0.655~0.790）。 */
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
