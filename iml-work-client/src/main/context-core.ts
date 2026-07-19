// 会话上下文核心（叶子模块：纯函数，不 import electron——运行时与离线校验共用同一套）。
// 机制：逐字窗口按 **token 预算**选取（不再按固定轮数），窗口外的轮次**滚动折叠**进
// 会话级持久摘要（存本地库 KV，跨重启保留）——50 轮之外不再彻底丢失。

export interface Turn { role: 'user' | 'assistant'; content: string }

/** 粗粒度 token 估算：CJK ≈ 1 字/token，其余 ≈ 4 字符/token。宁可高估，预算更保守。 */
export function estTokens(s: string): number {
  if (!s) return 0
  let cjk = 0, other = 0
  for (const ch of s) {
    if (/[　-〿㐀-鿿豈-﫿＀-￯]/.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/** 头尾保留式截断：分身消息的提议/待办通常在结尾（用户回"好的"确认的就是它），只留开头会把提议切掉。 */
export function clipTurn(text: string, cap: number): string {
  const t = (text || '').replace(/\s+/g, ' ').trim()
  if (t.length <= cap) return t
  return t.slice(0, Math.floor(cap * 0.4)) + ' ……(中间省略)…… ' + t.slice(-Math.ceil(cap * 0.6))
}

/**
 * 按 token 预算选逐字窗口起点（返回相对 turns 的下标）：
 * 从最新往回累计（按截断后的开销），预算耗尽即止；但至少保留 minTurns 轮。
 * 起点对齐 step 边界（相对 floorIdx）——折叠边界每 step 轮才推进一次，
 * 摘要合并的模型调用保持低频（对齐余数轮次落在逐字窗口里，不丢也不重复摘）。
 * floorIdx = 已折叠进持久摘要的边界，起点绝不早于它（那些轮次已在摘要里）。
 */
export function chooseVerbatimStart(turns: Turn[], opts: { budget: number; minTurns: number; step: number; floorIdx: number; cap: number; lastCap: number }): number {
  const { budget, minTurns, step, floorIdx, cap, lastCap } = opts
  let used = 0
  let start = turns.length
  for (let i = turns.length - 1; i >= floorIdx; i--) {
    const cost = estTokens(clipTurn(turns[i]?.content || '', i === turns.length - 1 ? lastCap : cap))
    if (used + cost > budget && turns.length - i >= minTurns) break
    used += cost
    start = i
  }
  const aligned = floorIdx + Math.floor((start - floorIdx) / step) * step
  return Math.min(turns.length, Math.max(floorIdx, aligned))
}

/** 滚动摘要合并：已有要点 + 新折叠轮次 → 更新后的要点（常量成本，与会话总长无关）。 */
export function buildSummaryMergePrompt(prevSummary: string, turns: Turn[]): string {
  const transcript = turns
    .map(h => `${h.role === 'user' ? '用户' : '分身'}：${(h.content || '').replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n')
  return `把「已有要点」与「新增对话」合并成一份更新后的要点摘要，供后续对话延续上下文用。只保留：用户明确交代过的事实/偏好/约定（如称呼、抬头、口径）、已产出的文件名、已达成的决定、尚未完成的待办；新增内容与已有要点冲突时以新增为准。用简短陈述句，每条一行，不超过 10 行；没有可留存的就输出「（无）」。不要解释、不要复述寒暄。

【已有要点】
${prevSummary || '（无）'}

【新增对话】
${transcript}

【更新后的要点摘要】：`
}
