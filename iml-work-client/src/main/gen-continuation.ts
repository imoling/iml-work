// ============================================================================
// 超长产物的分段续写引擎（治本 2026-08-13）
//
// 问题：指导型技能（impeccable/ui-ux-pro-max 这类 bundle 全是方法论文档、无生成器脚本）
// 的交付物就是大量代码本身，「一次输出完整驱动脚本」必然撞单次输出上限（64k 含思考）——
// 上下文窗口 1M 管的是**读入**，救不了**单次写出**。渐进式要落在输出侧：
// 撞顶后带着全部已写内容续写下一段（1M 上下文正好用在这），直到代码围栏闭合。
//
// 续写轮显式关思考（reasoning:false → 网关 thinking disabled）：写什么第一轮已经想清楚了，
// 把整个输出预算留给正文，一轮可净产 ~60k token 内容。
//
// 叶子模块：零 import、call 依赖注入（与 skill-custom 的 callModel 注入同一模式）——
// 纯逻辑可单测，也能脱离 Electron 用真实网关做端到端验证。
// ============================================================================

export type LlmGenCall = (
  prompt: string,
  opts: { temperature?: number; longRunning?: boolean; reasoning?: boolean; maxTokens?: number },
) => Promise<string>

/** 续写轮数上限：首轮 + 3 轮续写 ≈ 200k+ token 正文，超过这个规模的产物该拆技能而不是继续续。 */
const MAX_CONTINUATION_ROUNDS = 3

/** 与 skill-exec 的 extractPyBlock 同一判据：有开栏、无闭栏 = 输出触顶被截断。 */
export function isFenceTruncated(raw: string): boolean {
  const t = (raw || '').trim()
  const open = t.match(/```(?:python|py)?\s*\n/)
  if (!open) return false
  return t.slice((open.index || 0) + open[0].length).lastIndexOf('\n```') < 0
}

/**
 * 续写回复的头部清洗：模型常无视指令重新开一个 ```python 围栏（有时还带一句"接着上文"），
 * 拼接前必须剥掉，否则最终文本出现两个开栏、extractPyBlock 会抠错块。
 * 只在头部小窗口（200 字符）内找开栏——正文中段合法出现的反引号不动。
 */
export function stripContinuationHead(cont: string): string {
  const t = (cont || '').replace(/^\s+/, '')
  const m = t.match(/```(?:python|py)?\s*\n/)
  if (m && (m.index || 0) < 200) return t.slice((m.index || 0) + m[0].length)
  return t
}

/**
 * 接缝哨兵：续写第一行被要求原样输出这一行（Python 注释，误留进代码也无害）。
 * 有它接缝就是**确定性**的——剥掉哨兵行取其后内容即可，不用猜模型有没有重复起笔；
 * 也天然兼容「源码里本来就有相邻重复行」的场景（行级去重在那会误剪）。
 */
export const CONTINUATION_SENTINEL = '# ==CONTINUE=='

/** 哨兵行之后的内容；前几行里找不到哨兵（模型没听话）返回 null，走行级去重回退。 */
export function afterSentinel(cont: string): string | null {
  const lines = (cont || '').split('\n')
  const idx = lines.slice(0, 5).findIndex(l => l.trim() === CONTINUATION_SENTINEL)
  return idx >= 0 ? lines.slice(idx + 1).join('\n') : null
}

/**
 * 行级接缝去重（哨兵缺席时的回退）：续写常从提示里展示过的尾部行重复起笔。
 * 「已写文本的最后 n 行 == 续写的前 n 行」（整行含缩进精确相等）→ 剪掉这 n 行。
 * 按整行比对而不是字符重叠：字符级会被短行卡阈值（"c = 3" 这类）或误剪合法前缀，
 * 整行精确相等基本只有「重复起笔」一种解释（相邻重复行的巧合由哨兵路径兜住）。
 */
export function trimOverlap(prev: string, next: string): string {
  const prevLines = prev.split('\n')
  const nextLines = next.split('\n')
  const maxN = Math.min(40, prevLines.length, nextLines.length)
  for (let n = maxN; n >= 1; n--) {
    let match = true
    for (let i = 0; i < n; i++) {
      if (prevLines[prevLines.length - n + i] !== nextLines[i]) { match = false; break }
    }
    if (match) return nextLines.slice(n).join('\n')
  }
  return next
}

function buildContinuationPrompt(basePrompt: string, written: string): string {
  return `【背景】你上一轮按照下面这份任务说明编写 Python 脚本，但输出在中途被长度上限截断，代码没有写完。现在需要你续写。

===== 原任务说明开始（仅供对照内容与要求；其中「只输出一个代码块」等输出格式要求，以本消息末尾的【续写要求】为准）=====
${basePrompt}
===== 原任务说明结束 =====

【你已写出的部分】（\`\`\`python 围栏已打开、尚未闭合；最末的不完整行已被截去）
${written}

【续写要求（最高优先级）】
- 你输出的第一行必须**原样**是：${CONTINUATION_SENTINEL}
- 从第二行起，输出紧接「已写出的部分」最后一行之后的**下一行代码**，无缝衔接；
- 绝不重复任何已写出的行；绝不重新输出 \`\`\`python 开栏；不要任何解释文字；
- 补完剩余全部代码后，最后单独一行输出 \`\`\` 闭合围栏。`
}

/**
 * 带续写的脚本生成：首轮正常生成（保留思考），撞顶则截到最后一个完整行、
 * 带全部已写内容续写（关思考），直到围栏闭合或轮数用尽。
 * 返回拼接后的原始文本，由调用方沿用 extractPyBlock/looksTruncated 做最终判定。
 */
export async function generateWithContinuation(
  basePrompt: string,
  call: LlmGenCall,
  opts: { maxTokens: number; onProgress?: (round: number, writtenChars: number) => void },
): Promise<string> {
  let full = await call(basePrompt, { temperature: 0, longRunning: true, maxTokens: opts.maxTokens })
  for (let round = 1; round <= MAX_CONTINUATION_ROUNDS && isFenceTruncated(full); round++) {
    // 截断点几乎必然落在行中间：丢掉可能不完整的最后一行，让模型从行边界续写——
    // 行级接缝远比字符级猜接缝可靠。
    const cut = full.lastIndexOf('\n')
    if (cut <= 0) break
    full = full.slice(0, cut)
    opts.onProgress?.(round, full.length)
    const cont = await call(buildContinuationPrompt(basePrompt, full), {
      temperature: 0, longRunning: true, reasoning: false, maxTokens: opts.maxTokens,
    })
    const head = stripContinuationHead(cont)
    const anchored = afterSentinel(head)
    full = full + '\n' + (anchored !== null ? anchored : trimOverlap(full, head))
  }
  return full
}
