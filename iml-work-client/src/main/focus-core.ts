// 岗位画像的核心纯函数（叶子模块：不 import electron/db —— 运行时与单测共用同一套逻辑）。
// 沉淀的存取在 db.ts（focusTouch/focusRecent），这里只放"怎么用画像"的可测逻辑。

export interface FocusLite {
  displayName: string
  externalId?: string
  lastSeen: number      // unixepoch 秒
  touchCount: number
  pinned?: number
}

/**
 * 读驱动消解的候选加权：最近接触过的对象排前面。
 *
 * 只排序、绝不改文案——下拉选中后靠 `find(m => m.text === pv)` 按原文回找，
 * 动了文案就找不回来了；也绝不自动替用户选（写操作的指认必须是人做的）。
 * 排序键：置顶 > 匹配上画像（新近度 + 接触频次）> 原始顺序（稳定排序保底）。
 */
export function rankByFocus<T extends { text: string }>(cands: T[], focus: FocusLite[], now = Math.floor(Date.now() / 1000)): T[] {
  if (!focus.length || cands.length < 2) return cands
  const score = (c: T): number => {
    const t = (c.text || '').trim()
    if (!t) return 0
    let best = 0
    for (const f of focus) {
      const name = (f.displayName || '').trim()
      if (!name || (!t.includes(name) && !name.includes(t))) continue
      // 新近度：7 天内线性衰减到 0；频次：对数压缩（避免一个刷了 50 次的对象永远霸榜）
      const ageDays = Math.max(0, (now - f.lastSeen) / 86400)
      const recency = Math.max(0, 1 - ageDays / 7)
      const freq = Math.log2(1 + Math.min(f.touchCount, 32)) / 5
      const s = (f.pinned ? 2 : 0) + recency + freq
      if (s > best) best = s
    }
    return best
  }
  // 稳定排序：分数相同保持原始顺序（列表页的自然顺序本身有意义）
  return cands
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map(x => x.c)
}

/** 画像摘要块（注入 prompt 用）：最近事件一行一条，必须带日期——本地沉淀是快照不是真值。 */
export function renderFocusBlock(displayName: string, lastState: string,
                                 events: { ts: number; summary: string }[],
                                 profileSummary?: string): string {
  if (!events.length && !profileSummary) return ''
  const d = (ts: number) => {
    const t = new Date(ts * 1000)
    return `${t.getMonth() + 1}/${t.getDate()}`
  }
  const lines = events.map(e => `- ${d(e.ts)}：${e.summary}`).join('\n')
  return `【你最近对「${displayName}」的操作记录（本地沉淀快照，非实时）】\n` +
    `${lastState ? `最近已知状态:${lastState}\n` : ''}` +
    `${profileSummary ? `跟进画像:${profileSummary}\n` : ''}${lines}`
}

/**
 * 用户消息是否点名了某个沉淀过的对象（QA 路径注入画像用）。
 * 中文没有词边界，用**二元组匹配**（与 ontology-core 的预闸同一思路）：
 * 对象名的任一连续两字出现在消息里即算提及（"宝钢那个合同" 命中 "上海 · 宝钢集团"）。
 * 允许少量误注入——画像块很短且标明是快照，污染代价远小于漏注入的价值。
 */
export function focusMentioned<T extends { displayName: string }>(userMsg: string, rows: T[], max = 2): T[] {
  const msg = (userMsg || '').trim()
  if (!msg || !rows.length) return []
  const hits: { r: T; n: number }[] = []
  for (const r of rows) {
    const name = (r.displayName || '').replace(/[\s·【】\[\]（）()「」，。、-]/g, '')
    if (name.length < 2) continue
    let n = 0
    for (let i = 0; i + 2 <= name.length; i++) {
      const bg = name.slice(i, i + 2)
      if (/[\u4e00-\u9fa5]{2}/.test(bg) && msg.includes(bg)) n++
    }
    // 全名直含（含英文/单号名）也算强命中
    if (r.displayName.trim() && msg.includes(r.displayName.trim())) n += 5
    if (n > 0) hits.push({ r, n })
  }
  return hits.sort((a, b) => b.n - a.n).slice(0, max).map(h => h.r)
}

/**
 * 技能确认字段 → 本体对象的沉淀映射（数据驱动，代码零领域词）。
 *
 * 背景：录制技能（录拜访/填表单）执行成功后，确认字段里往往藏着业务对象——
 * 「关联商机=华东电网巡检平台二期」「联系人=李主任」。以前这条链路完全不沉淀，
 * 用户录完拜访，「我的关注」里客户/商机毫无痕迹。
 *
 * 匹配规则（保守，宁缺勿滥）：**本体类型的中文标签整体出现在字段标签里**才算
 * （"商机"⊂"关联商机" ✓、"客户"⊂"客户名称" ✓）。不做模糊匹配——字段标签是建模者写的
 * 规范词，包含关系已足够；模糊只会把"拜访日期"这类字段错沉成对象。
 */
export interface FieldTypeMatch { typeKey: string; typeLabel: string; domain?: string; value: string; fieldLabel: string }

// 表单通用词排除：这些字段标签虽可能撞上类型标签（"预计**商机**金额"含"商机"），
// 但值是数字/日期/长文本，不是对象名——沉「50000」当商机是垃圾数据。属通用表单词汇，非领域语料。
const NON_OBJECT_FIELD = /金额|日期|时间|数量|次数|电话|手机|邮箱|编号|单号|备注|说明|纪要|描述|内容|原因|计划/
// 值形态守卫：纯数字/日期/金额形态的值不可能是对象名（对显式映射同样生效——配错了也不沉垃圾）
const NON_OBJECT_VALUE = /^[\d,，.。:：\-/¥￥%\s年月日时分]+$/

export function looksLikeObjectValue(fieldLabel: string, value: string): boolean {
  const v = (value || '').trim()
  return v.length >= 2 && !NON_OBJECT_FIELD.test(fieldLabel || '') && !NON_OBJECT_VALUE.test(v)
}

export function matchFieldsToTypes(
  fields: { label: string; value: string }[],
  types: { typeKey: string; label: string; domain?: string }[],
): FieldTypeMatch[] {
  const out: FieldTypeMatch[] = []
  for (const f of fields) {
    const v = (f.value || '').trim()
    const fl = (f.label || '').trim()
    if (!v || !fl || !looksLikeObjectValue(fl, v)) continue
    // 取标签最长的命中（"联系人"优先于"人"这类短标签，避免误挂）
    let best: { typeKey: string; label: string; domain?: string } | null = null
    for (const t of types) {
      const tl = (t.label || '').trim()
      if (tl.length < 2 || !fl.includes(tl)) continue
      if (!best || tl.length > best.label.length) best = t
    }
    if (best) out.push({ typeKey: best.typeKey, typeLabel: best.label, domain: best.domain, value: v, fieldLabel: fl })
  }
  return out
}
