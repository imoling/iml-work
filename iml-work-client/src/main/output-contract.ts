// 输出契约（叶子纯函数，零依赖）：识别用户指令中的**显式格式约束**，并给出注入提示词的铁律块。
//
// 为什么需要：人设包装（"康Sir，您好"开场、markdown 装饰、结尾建议）会破坏硬格式约束——
// IFEval 实测 40% vs 行业 93~95%，段落数/禁逗号/全小写/两段回答类约束全灭（2026-07 基准测试）。
// 企业场景对应「按模板出东西」：用户明说了格式，格式就是需求本体，人设让位。
//
// 设计：确定性正则检测（中英双语），命中才注入铁律并抑制称呼装饰——不命中时人设照旧，
// 绝不为了考试题把日常对话的人格阉了。

const PATTERNS: RegExp[] = [
  // 长度类：字数/词数/句数/段落数（中英）
  /\b(at (least|most)|exactly|fewer than|less than|more than|around) \d+ (words?|sentences?|paragraphs?|bullet points?|sections?|highlights?|placeholders?)\b/i,
  /\d+\s*(个)?(字以内|字以上|字左右|句话|段落?|个要点|条要点)/,
  /(不超过|至少|恰好|少于|多于)\s*\d+\s*(字|词|句|段|条|个)/,
  // 结构类：分隔符/分节/标题/两段回答
  /\*{3}|\*{6}|divider|separated by|two (different )?responses|markdown divider/i,
  /(用|以)\s*(\*{3}|\*{6}|分隔符|分割线)/,
  /<<[^\n]*>>|double angular brackets|wrap.{0,30}title/i,
  /\bsection \d+|分节|小节标题/i,
  // 标点/大小写/字母类（门禁须与 collectFormatViolations 覆盖一致，否则约束匹配不上→既不注入铁律也不校验）
  /\b(no|without|not|never|refrain from using|avoid using|do ?n['o]?t|don't)\b[^.?!]{0,24}\b(commas?|periods?|exclamation (marks?|points?)|question marks?)\b/i,
  /(不要|不得|禁止|不能)(使用|出现|带)?(逗号|句号|感叹号|问号)/,
  /\b(all|entirely|only) (lowercase|capital letters|uppercase)\b/i,
  /\ball of the letters are lowercase\b|\bletters are (all )?lowercase\b|\blowercase (letters )?only\b|\bcapital letters only\b|\bin lowercase\b/i,
  /(全部?)(小写|大写)/,
  // 内容标记类：占位符/附言/引号包裹/JSON/首尾句
  /placeholders? represented by square brackets|\[address\]|\[name\]/i,
  /\bp\.?\s?s\.?\b.{0,20}(postscript|结尾|附言)|postscript/i,
  /wrap.{0,40}double quotation marks|(整个|全文).{0,10}引号/i,
  /\b(valid|format(ted)? (as|in)|output) json\b|json 格式输出|以 json/i,
  /\b(start|begin|end|finish) (your |the )?(answer|response|reply).{0,30}(with|by)\b/i,
  /(以|用)「?[^\n」]{1,30}」?(开头|结尾|收尾)/,
  /repeat (the )?(request|prompt|question)( word for word)?|一字不差地?重复/i,
  // 词汇类：必须包含/禁止出现某词、某词出现 N 次
  /\b(include|contain|mention) (the )?(keywords?|words?)\b.{0,60}\b(in your (response|answer)|at least)\b/i,
  /\bword\b.{0,20}\bshould appear\b|\bappear (at least|exactly) \d+ times\b/i,
  /(必须包含|不得出现|禁止出现|至少出现)\s*[「"']?[^\n」"']{1,20}[」"']?\s*(一词|这个词|\d+\s*次)?/,
  /\bdo not (use|say|include|mention) (the )?(words?|keywords?)\b/i,
  /\bforbidden words?\b/i,
  // 语言类：全英文/全中文回答
  /\b(respond|answer|reply|write) (only |entirely )?in (english|chinese|spanish|french|german|japanese|korean|italian|portuguese|russian|arabic|hindi)\b/i,
  /(用|以)(英文|英语|全英文)(回答|回复|作答|写)/,
]

/** 用户指令是否携带显式输出格式约束（命中任一模式即算）。 */
export function hasExplicitFormatConstraints(text: string): boolean {
  const t = text || ''
  return PATTERNS.some(p => p.test(t))
}

/**
 * 生成后**确定性**校验：从用户指令文本反推出「能程序化判定」的那部分格式约束，
 * 逐条核对回答是否违反，返回违规项的人话描述（供定向重写）。只覆盖可无歧义判定的子集
 * （禁标点/大小写/两段回答/引号包裹/附言/JSON/整数字数句数段落数）——参数从用户文本就近解析，
 * 解析不到就不校验该项（宁可漏判不可误判）。IFEval 实测这几类是人设装饰破坏的重灾区（2026-07）。
 */
export function collectFormatViolations(userText: string, resp: string): string[] {
  const u = userText || ''
  const r = resp || ''
  const v: string[] = []
  const has = (re: RegExp) => re.test(u)

  // 禁逗号：否定词 + 就近出现 comma/逗号（覆盖 no/without/don't/do not use any/avoid/refrain from ... commas）
  if (has(/\b(no|without|not|never|avoid|refrain|prohibit(ed)?|forbidden|do ?n['o]?t|don't)\b[^.?!]{0,24}\bcommas?\b|不(要|得|准|能|可)?[^。？！]{0,10}逗号|禁止[^。？！]{0,6}逗号|逗号[^。？！]{0,6}(禁止|不允许|不能用)/i)) {
    if (r.includes(',') || r.includes('，')) v.push('要求不含任何逗号，但回答里出现了逗号')
  }
  // 全小写（覆盖 "all lowercase" / "all of the letters are lowercase" / "letters are lowercase" / "in lowercase"）
  if (has(/\ball lowercase\b|\ball of the letters are lowercase\b|\bletters are (all )?lowercase\b|\bentirely lowercase\b|\blowercase (letters )?only\b|\bin lowercase\b|全部?小写|小写字母表达/i)) {
    const letters = r.match(/[A-Za-z]/g) || []
    if (letters.some(c => c !== c.toLowerCase())) v.push('要求全部小写，但回答里有大写字母')
  }
  // 全大写
  if (has(/\ball (capital|uppercase)\b|\bin all caps\b|\bcapital letters only\b|全部?大写/i)) {
    const letters = r.match(/[A-Za-z]/g) || []
    if (letters.some(c => c !== c.toUpperCase())) v.push('要求全部大写，但回答里有小写字母')
  }
  // 两段回答（IFEval 约定用 ****** 分隔）
  if (has(/\btwo (different )?responses\b|两[个种](不同的?)?回[答复]|给出两[个种]/i)) {
    if (!r.includes('******')) v.push('要求给出两段不同回答、用 6 个星号 ****** 分隔，但回答里没有这个分隔符')
  }
  // 整篇用双引号包裹
  if (has(/wrap (your |the )?(entire |whole )?(response|answer).{0,20}(double )?quotation marks|用双引号(把|将)?(整个|全部)/i)) {
    const s = r.trim()
    if (!(s.startsWith('"') && s.endsWith('"'))) v.push('要求整篇回答用双引号包裹，但回答首尾没有双引号')
  }
  // 附言 P.S. / P.P.S.
  const psMark = /\bp\.?\s?p\.?\s?s\.?\b|\bpostscript\b/i.test(u) ? 'P.P.S.' : (/\bp\.?\s?s\.?\b|附言|又及/i.test(u) ? 'P.S.' : '')
  if (psMark) {
    if (!/\bp\.?\s?p?\.?\s?s\.?/i.test(r) && !/附言|又及/.test(r)) v.push(`要求包含以「${psMark}」开头的附言，但回答里没有`)
  }
  // JSON 格式
  if (has(/\b(valid|format(ted)? (as|in)|output|respond (with|in)) json\b|json 格式(输出)?|以 json/i)) {
    const body = r.trim().replace(/^```(json)?\s*|\s*```$/g, '').trim()
    try { JSON.parse(body) } catch { v.push('要求输出合法 JSON，但回答不是可解析的 JSON') }
  }
  // 精确句数（"exactly N sentences" / "N 句话"）
  const sentM = u.match(/exactly (\d+) sentences?|(\d+)\s*句话?/i)
  if (sentM) {
    const n = Number(sentM[1] || sentM[2])
    const cnt = (r.match(/[.!?。！？]+(?=\s|$|["'」』])/g) || []).length || r.split(/[.!?。！？]+/).filter(s => s.trim()).length
    if (n && Math.abs(cnt - n) > 0) v.push(`要求恰好 ${n} 句，但回答约为 ${cnt} 句`)
  }
  // 精确段落数（"exactly N paragraphs" / "N 段"）——IFEval 用 *** 分隔段落
  const paraM = u.match(/exactly (\d+) paragraphs?|(\d+)\s*个?段落?/i)
  if (paraM) {
    const n = Number(paraM[1] || paraM[2])
    const byStar = r.split('***').filter(s => s.trim()).length
    const byBlank = r.split(/\n\s*\n/).filter(s => s.trim()).length
    const cnt = /\*\*\*/.test(r) ? byStar : byBlank
    if (n && cnt !== n) v.push(`要求恰好 ${n} 段，但回答约为 ${cnt} 段`)
  }
  // 禁词：从"do not use/include the word(s) X, Y"里抽出被禁词，逐个核对未出现（大小写不敏感，词边界）
  const forbidM = u.match(/\b(?:do\s+not|don['o]?t|never|avoid|refrain from|without)\s+(?:the\s+)?(?:use\s+(?:of\s+)?|using\s+|include\s+|including\s+|mention\s+|mentioning\s+|say\s+|saying\s+|contain\s+)?(?:the\s+)?(?:word[s]?|keyword[s]?|term[s]?)\s*[:："'“”]?\s*([A-Za-z][A-Za-z ,'"“”and]*)/i)
  if (forbidM) {
    const words = (forbidM[1].match(/[A-Za-z]{2,}/g) || []).filter(w => !/^(and|the|word|words|keyword|keywords|term|terms|or)$/i.test(w))
    const hit = words.filter(w => new RegExp(`\\b${w}\\b`, 'i').test(r))
    if (hit.length) v.push(`要求不出现「${hit.join('、')}」等词，但回答里出现了`)
  }
  // 词频：the word "X" should appear at least/exactly/less than N times
  const freqM = u.match(/(?:the\s+)?(?:word|keyword|term)\s+["'"]?([A-Za-z]+)["'"]?\s+should\s+appear\s+(at least|exactly|less than|more than|fewer than|no more than|no less than)\s+(\d+)\s+times?/i)
    || u.match(/["'"]([A-Za-z]+)["'"]\s*(?:这个词|一词)\s*(?:至少|恰好|不超过|不少于|最多|最少)?\s*出现\s*(\d+)\s*次/)
  if (freqM) {
    const word = freqM[1]; const n = Number(freqM[3] ?? freqM[2])
    const rel = (freqM[3] ? freqM[2] : '至少')
    const c = (r.match(new RegExp(`\\b${word}\\b`, 'ig')) || []).length
    const ok = /at least|不少于|最少|至少/i.test(rel) ? c >= n
      : /exactly|恰好/i.test(rel) ? c === n
      : /(less than|fewer than|no more than|不超过|最多)/i.test(rel) ? c <= n
      : /more than/i.test(rel) ? c > n : true
    if (!ok) v.push(`要求「${word}」出现${rel} ${n} 次，但回答里出现了 ${c} 次`)
  }
  // 字数下限/上限（英文按单词计）："at least/less than N words"
  const wordM = u.match(/(at least|less than|fewer than|more than|no more than|no less than|around|about)\s+(\d+)\s+words?/i)
  if (wordM) {
    const rel = wordM[1].toLowerCase(); const n = Number(wordM[2])
    const wc = (r.match(/[A-Za-z']+/g) || []).length
    const ok = rel === 'at least' || rel === 'no less than' ? wc >= n
      : rel === 'less than' || rel === 'fewer than' ? wc < n
      : rel === 'more than' ? wc > n
      : rel === 'no more than' ? wc <= n
      : Math.abs(wc - n) <= Math.max(15, n * 0.15)   // around/about：±15% 容差
    if (!ok) v.push(`要求 ${rel} ${n} 词，但回答约 ${wc} 词`)
  }
  return v
}

/** 生成定向重写提示：把检出的违规逐条列清，要求在内容不变前提下只修格式。 */
export function buildFormatRewritePrompt(userText: string, resp: string, violations: string[]): string {
  return `你上一版回答**违反了用户明确要求的输出格式**，具体违规如下：\n${violations.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n【用户的原始要求】\n${userText}\n\n【你上一版的回答】\n${resp}\n\n请在**保持答案内容与事实不变**的前提下，仅修正上述格式问题，重新输出**完整**回答。只输出修正后的回答本身，不要任何解释、不要称呼或开场白。`
}

/**
 * 命中格式约束时注入的铁律块（放在系统提示词末尾、用户指令之前）。
 * 语气必须压过人设规则——称呼/问候/建议都属于"约束外内容"。
 */
export const FORMAT_CONTRACT_RULE = `
【输出契约 · 最高优先级】用户本次指令中包含**显式的输出格式约束**（如字数/句数/段落数、分隔符、标点限制、大小写、JSON、以某句开头/结尾、重复原文、必含/禁用某词、指定回答语言等）。铁律：
- 这些格式约束的优先级**高于上文一切人设与风格规则**，必须逐字满足；
- **不要**添加称呼、问候语、开场白、结尾建议、署名等任何约束之外的内容（这类装饰会直接破坏格式约束）；
- 除非约束本身要求，**不要**使用 markdown 标题/加粗/列表等装饰；
- 若格式约束与"称呼用户"冲突，一律以格式约束为准（本轮可以不称呼用户）。`
