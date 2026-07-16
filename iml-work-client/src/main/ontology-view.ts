// 「本体执行」的唯一渲染器（叶子模块：纯函数，无副作用）——同时产出**对话正文**与**详情卡**。
//
// 为什么收成一处：这两段文字原先在 agent-ontology 里手拼了三四份，每加一条分支抄一遍，格式必然漂移
// （曾把 ASCII 关系图塞进 markdown 列表后面，围栏渲染坏掉，卡里只剩两个孤零零的反引号 + 一片空白）。
//
// 分工：
//   - 正文（气泡）= 说给人听的一句话：做成了什么、写了哪些关键值、现在什么状态。不出现 typeKey/actionKey。
//   - 详情卡 = 执行凭证，三段式：**① 结果 → ② 本体执行情况 → ③ 写入的值**。本体术语在这里全给
//     （objectType / actionKey / capability / 状态迁移 / 执行方式 / 审计事件），但每个都配人话标签。

export type OntologyOutcome = 'ok' | 'partial' | 'blocked'

export interface OntologyDetailParts {
  outcome: OntologyOutcome
  /** 一句话结论（卡片首行）。**纯文本**——外层会整句加粗，自带 ** 会撑坏嵌套。 */
  headline: string
  // ── 对象 ──
  objectLabel: string          // 业务名：「差旅审批单」/「宝钢钢铁数字化项目采购合同」——绝不用 typeKey 顶替
  domain?: string              // OA
  typeKey?: string             // TravelApproval
  typeLabel?: string           // 类型的中文名（本体建模里的 label，如「差旅审批单」）
  relations?: string           // 'targets → Contract'
  externalId?: string          // 真实系统里的单号
  // ── 动作 ──
  actionLabel: string          // 提交差旅申请
  actionKey: string            // create
  capability?: string          // create / update
  fromState?: string
  fromStateLabel?: string       // fromState 的人话名。曾只翻终点不翻起点，卡里出现「`pending` → 已通过」半中半英
  toState?: string
  stateLabel?: string           // toState 的人话名（本体状态机 labels，如 pending→待审批）
  // ── 执行 ──
  executor?: string            // 录制回放 / API 直调 / SOP 智能体 / 语义登记（未绑定连接器）
  systemName?: string
  stepsDone?: number
  stepsTotal?: number
  resolveNote?: string         // 读驱动消解：从列表页读了几个候选、怎么定位到这一条
  detail?: string              // 失败原因 / 补充说明
  // ── 数据 ──
  fields?: { label: string; value: string }[]
  // ── 审计 ──
  eventType?: string
}

const ICON: Record<OntologyOutcome, string> = { ok: '✅', partial: '⚠️', blocked: '🚫' }

/**
 * 对话气泡里的正文：说人话。
 * 反例（改之前）：「已对『TravelApproval』完成『提交差旅申请』。」——把类型键甩给了业务人员看。
 * 正例：「已在【Mock OA (演示)】帮你提交了差旅审批单：北京 · 2026-07-19 出发 · 预算 5000 元。当前状态：待审批。」
 */
export function renderOntologyReply(p: OntologyDetailParts): string {
  if (p.outcome !== 'ok') return `${ICON[p.outcome]} ${p.headline}。${p.detail ? '\n\n' + p.detail : ''}`

  const where = p.systemName ? `在【${p.systemName}】` : ''
  // 作用于**已有单据**时点名它（"把宝钢那份合同批了"）；**新建**一张单子时不必重复对象名——
  // 动作名（"提交差旅申请"）本身已经说清是什么单子，再缀一句「差旅审批单」纯属啰嗦。
  const isNew = p.capability === 'create'
  const target = p.externalId ? `「${p.objectLabel}」（${p.externalId}）` : `「${p.objectLabel}」`
  let s = isNew && !p.externalId
    ? `✅ 已${where}帮你完成「${p.actionLabel}」。`
    : `✅ 已${where}对${target}完成「${p.actionLabel}」。`

  // 关键值摘要：只摘有值的前 3 个，让人一眼确认"写对了没"，不必展开详情卡。
  const filled = (p.fields || []).filter(f => f.value && f.value.trim())
  if (filled.length) {
    s += `\n\n写入的内容：${filled.slice(0, 3).map(f => `${f.label} **${f.value}**`).join('、')}`
    if (filled.length > 3) s += `，另有 ${filled.length - 3} 项`
    s += '。'
  }
  // 状态给**人话名**（本体状态机的 labels，数据驱动）。没配 labels 才退回原始状态键——
  // 直接甩「pending」给业务人员看，和甩「TravelApproval」是同一种错。
  if (p.toState) s += `\n\n当前状态：**${p.stateLabel || p.toState}**。`
  return s
}

/** 「本体执行」详情卡（markdown）。渲染在 `.onto-detail` 里，紧凑排版由 CSS 负责。
 *
 * 排版铁律（用户拍板）：
 *   1. **三段对齐** —— ① 执行结果 / ② 本体执行情况 / ③ 写入的值，一律「加粗段标题 + 内容」，
 *      不允许某段有标题某段没有（曾经 ① 是孤零零一行加粗句子，和 ②③ 长得不像一家人）。
 *   2. **中文先行，英文键退居括号** —— 本体键（typeKey/actionKey/状态键/事件键）是专业性的一部分，
 *      要保留，但只能跟在中文名后面的 `code` 括号里。曾把 `OA.TravelApproval`、`pending` → `approved`
 *      当正文主体甩给业务人员看，可读性极差。中文名一律来自本体建模的 label（数据驱动，代码不写死领域词）。
 */
export function renderOntologyDetail(p: OntologyDetailParts): string {
  // ① 执行结果
  let md = `**执行结果**\n\n${ICON[p.outcome]} ${p.headline}\n\n`
  if (p.detail) md += `${p.detail}\n\n`

  // ② 本体执行情况
  const rows: string[] = []
  const typeRef = [p.domain, p.typeKey].filter(Boolean).join('.')
  // 对象：业务名 + 类型中文名（类型键）。三者相同时不重复；没配 typeLabel 才让类型键顶上。
  const typeCn = p.typeLabel && p.typeLabel !== p.objectLabel ? p.typeLabel : ''
  const typePart = typeCn
    ? `${typeCn}${typeRef ? `（\`${typeRef}\`）` : ''}`
    : (typeRef && p.objectLabel !== p.typeKey ? `\`${typeRef}\`` : '')
  const objCell = [
    p.objectLabel === p.typeKey && typeRef ? `**${p.objectLabel}**（\`${typeRef}\`）` : `**${p.objectLabel}**`,
    p.objectLabel === p.typeKey ? '' : typePart,
    p.externalId ? `单号 ${p.externalId}` : '',
    p.relations ? `关系 ${p.relations}` : '',
  ].filter(Boolean).join(' · ')
  rows.push(`| 对象 | ${objCell} |`)

  const CAP_CN: Record<string, string> = { create: '新建', update: '修改', read: '读取', delete: '删除' }
  const capCn = p.capability ? (CAP_CN[p.capability] || p.capability) : ''
  rows.push(`| 动作 | **${p.actionLabel}**${capCn ? `（${capCn}类）` : ''}${p.actionKey ? ` · \`${p.actionKey}\`` : ''} |`)

  if (p.fromState || p.toState) {
    if (p.toState) {
      const fromCn = p.fromStateLabel || p.fromState || '新建'
      const toCn = p.stateLabel || p.toState
      const tech = p.fromState ? `\`${p.fromState} → ${p.toState}\`` : `\`${p.toState}\``
      rows.push(`| 状态迁移 | ${fromCn} → **${toCn}**（${tech}） |`)
    } else {
      rows.push(`| 状态迁移 | 未变更（执行未完成，状态保持「${p.fromStateLabel || p.fromState}」） |`)
    }
  }
  const execCell = [
    p.executor || '',
    p.systemName || '',
    p.stepsTotal ? `${p.stepsDone ?? 0}/${p.stepsTotal} 步` : '',
  ].filter(Boolean).join(' · ')
  if (execCell) rows.push(`| 执行方式 | ${execCell} |`)
  if (p.resolveNote) rows.push(`| 对象消解 | ${p.resolveNote} |`)

  md += `**本体执行情况**\n\n| 环节 | 内容 |\n| --- | --- |\n${rows.join('\n')}\n`

  // ③ 写入的值
  if (p.fields && p.fields.length) {
    md += `\n**写入的值**\n\n| 字段 | 值 |\n| --- | --- |\n`
    md += p.fields.map(f => `| ${f.label} | ${f.value?.trim() ? f.value : '_（留空·未提及，不虚构）_'} |`).join('\n') + '\n'
  }

  if (p.eventType) {
    md += `\n> 已登记审计事件 \`${p.eventType}\`${p.externalId ? `，锚定真实对象 ${p.externalId}` : ''}；管理端「本体建模 · 业务事件审计」可查。\n`
  }
  return md
}
