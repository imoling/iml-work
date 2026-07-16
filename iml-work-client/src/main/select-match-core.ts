// 下拉选项的近似匹配（叶子模块：纯函数，无依赖）。
//
// 为什么需要：字段值是模型从用户口语里提炼的（"华东电网项目"），下拉选项是系统里的正式名
// （"华东电网巡检平台二期"）——两者几乎永远不完全相等。旧匹配只有「精确 / 选项包含值」两档，
// 这种近似情况必然失手，然后退到智能体读页面重试（多烧一轮模型调用、多等几秒）。
//
// 单一来源约定：
//   · 主进程直接 import 使用；注入脚本（browser-scripts.ts）用 fuzzyPickIndex.toString() 嵌入——同一实现。
//   · FDE 工作台 automation.ts 的 pickResult 按此同构复刻（跨仓库无法共包），改动必须两边同步。
//
// ⚠️ 函数体必须**自包含**（不引用模块内其它符号、不用 TS 语法），否则 toString() 嵌入页面后跑不了。
export function fuzzyPickIndex(value: string, texts: string[]): number {
  var v = String(value || '').replace(/\s+/g, '')
  if (v.length < 2 || !texts || !texts.length) return -1
  var grams: string[] = []
  for (var i = 0; i + 2 <= v.length; i++) grams.push(v.slice(i, i + 2))
  var best = -1, bestS = 0, second = 0
  for (var j = 0; j < texts.length; j++) {
    var t = String(texts[j] || '').replace(/\s+/g, '')
    if (!t) continue
    var hit = 0
    for (var k = 0; k < grams.length; k++) if (t.indexOf(grams[k]) !== -1) hit++
    var s = grams.length ? hit / grams.length : 0
    // 反向包含（用户说全称、选项是简称，如值"上海宝钢集团公司"vs 选项"宝钢集团"）给高分
    if (t.length >= 2 && v.indexOf(t) !== -1) s = s > 0.9 ? s : 0.9
    if (s > bestS) { second = bestS; bestS = s; best = j } else if (s > second) { second = s }
  }
  // 安全闸：这是写操作路径——必须有**明显唯一**的赢家才选（分数够高且甩开第二名），
  // 并列/都不像就返回 -1，让上层继续走智能体兜底，绝不硬猜。
  if (bestS >= 0.5 && bestS - second >= 0.2) return best
  return -1
}

/** 注入页面用的源码（与主进程同一实现）。 */
export const FUZZY_PICK_SRC = fuzzyPickIndex.toString()

// ── 写入类技能的「目标一致性闸」──────────────────────────────────────────────
// 血泪场景：用户说"审批下宝钢产线智能改造项目"，技能脚本里却写死 click "宝钢钢铁数字化项目采购合同"
// （录制时点的哪份就永远点哪份），结果**真把另一份合同批了**。
// 闸的职责：用户点名了具体对象、而脚本的固定点击目标和点名对不上 → 执行前拦下，绝不顶替。

const ACTION_WORDS = /^(?:请|麻烦|帮我|帮忙|给我|把|将|去|审批|审核|批准|批下|同意|通过|驳回|拒绝|处理|提交|确认|执行|操作|一下|下|那个|这个|这份|那份|的)+/

/** 用户消息里的「点名片段」：连续中文段，剥掉动作/虚词前缀后仍 ≥5 字才算点名（"审批下合同"剥完只剩"合同"→ 不算）。 */
export function namedSegments(userMsg: string): string[] {
  const segs = String(userMsg || '').split(/[^\u4e00-\u9fa5]+/).filter(Boolean)
  const out: string[] = []
  for (let seg of segs) {
    for (let i = 0; i < 5; i++) { const t = seg.replace(ACTION_WORDS, ''); if (t === seg) break; seg = t }
    seg = seg.replace(/(?:吧|呢|啊|了|哈)+$/, '')
    if (seg.length >= 5) out.push(seg)
  }
  return out
}

/** a 的中文二元组有多大比例出现在 b 里。 */
function bigramContainment(a: string, b: string): number {
  const grams: string[] = []
  for (let i = 0; i + 2 <= a.length; i++) { const g = a.slice(i, i + 2); if (/[\u4e00-\u9fa5]{2}/.test(g)) grams.push(g) }
  if (!grams.length) return 0
  let hit = 0
  for (const g of grams) if (b.includes(g)) hit++
  return hit / grams.length
}

/**
 * 点名与固定目标的冲突判定。返回 null = 放行；返回 {named, target} = 拦截。
 * 规则：存在点名片段 S 时，脚本的每个固定目标 T（≥6 字，参数化步骤不算）必须与**某个** S 对上
 * （互相包含，或二元组重合度 ≥0.6）；对不上（包括零重合，如点名华为、脚本写死宝钢）即冲突。
 * 用户没点名（泛指"审批下合同"）→ 不拦，走原有确认流程。
 */
export function namedTargetConflict(userMsg: string, fixedTargets: string[]): { named: string; target: string } | null {
  const names = namedSegments(userMsg)
  if (!names.length) return null
  for (const t0 of fixedTargets) {
    const t = String(t0 || '').replace(/\s+/g, '')
    if (t.length < 6) continue   // 短目标是菜单/按钮（"合同审批"/"同意"），不是具体单据
    const matched = names.some(sg => t.includes(sg) || sg.includes(t)
      || bigramContainment(sg, t) >= 0.6 || bigramContainment(t, sg) >= 0.6)
    if (!matched) return { named: names[0], target: t0 }
  }
  return null
}
