// 本体解析核心（叶子模块：纯函数，不 import electron/db/main —— 运行时与离线评测共用同一套 prompt）。
// 抽出来的理由和 skill-router-core 一样：评测引擎必须与执行同构，否则测的是另一套 prompt，测了也白测。
// 改这里的任何一个字，都要跑 `npm run eval:ontology` 防过拟合。

export interface OntologyActionHint {
  actionKey: string; label: string; domain?: string; objectType?: string
  description?: string; capability?: string; policyJson?: string
  fromState?: string; toState?: string; connectorActionId?: string
  allowedExperts?: string[]   // 岗位授权：空=不限；非空=只有列出的岗位可执行
  [k: string]: unknown
}
export interface OntologyTypeHint {
  typeKey: string; label: string; domain?: string
  description?: string   // 消歧语料（"差旅审批单，区别于合同审批"）——必须进解析提示词，否则管理端写了也不生效
  relationsJson?: string; stateMachineJson?: string; resolveListPath?: string
  boundSystemId?: string
  [k: string]: unknown
}
export interface OntologyHints { types: OntologyTypeHint[]; actions: OntologyActionHint[] }
export interface OntologyResolution {
  matched: boolean; domain?: string; objectType?: string; actionKey?: string
  displayName?: string; externalId?: string; amount?: number | null; reason?: string
}

/** 便宜的预门：指令里和本体八竿子打不着就跳过 LLM 解析，避免每句闲聊都掏模型。
 *
 *  **只放宽不收紧**——这是本函数的第一原则：
 *  误放行只多花一次解析调用（真正的把关在 prompt 的"宁缺勿滥"上），误拦截却让本体**静默失灵**，
 *  用户看到的是"分身怎么不干活"，而且毫无线索。已经栽过两次：
 *    ① 门里只有"审批"没有"批" → "帮我把出差申请批了" 连模型都没进；
 *    ② 只按**整个标签**做子串匹配 → "下周去北京出差，预算5000元" 里既没有"差旅审批单"这五个字、
 *       也没有任何通用动词，被判无关，一路落到问答 + 联网搜索，端回来一堆"北京旅游攻略"。
 *
 *  修法不是往代码里再塞几个词（那又把领域语料写进了代码），而是让预门**认本体自己的语料**：
 *  把类型/动作的 label + description 拼成语料，再看用户这句话里的任一「中文二元组」是否出现在语料里。
 *  "出差""预算"都写在 TravelApproval 的 description 里 → 自动放行。**改本体即生效，不必改代码。**
 */
export function ontologyMightMatch(userMsg: string, hints: OntologyHints): boolean {
  const msg = userMsg || ''
  // 通用动作词根（与领域无关，兜底用）
  const VERBS = ['批', '通过', '同意', '驳回', '退回', '拒绝', '申请', '录入', '登记', '拜访', '推进', '风险']
  for (const w of VERBS) if (msg.includes(w)) return true

  // 本体语料（领域语料的唯一来源：建模时维护在 label/description 里）
  let corpus = ''
  for (const t of hints.types || []) corpus += `${t.label || ''}${t.description || ''}`
  for (const a of hints.actions || []) corpus += `${a.label || ''}${a.description || ''}`
  corpus = corpus.replace(/\s+/g, '')
  if (!corpus) return false

  const isCjk = (ch: string) => ch >= '一' && ch <= '龥'
  for (let i = 0; i + 1 < msg.length; i++) {
    const bigram = msg.slice(i, i + 2)
    if (isCjk(bigram[0]) && isCjk(bigram[1]) && corpus.includes(bigram)) return true
  }
  return false
}

/** 岗位业务域侧重：优先只用侧重域的本体（"生产计划岗说工单、销售岗说商机"各自命中）；该域为空则退回全量。 */
export function scopeHintsByDomains(all: OntologyHints, expertDomains?: string[]): OntologyHints {
  if (!expertDomains || !expertDomains.length) return all
  const scoped = {
    types: (all.types || []).filter(t => t.domain && expertDomains.includes(t.domain)),
    actions: (all.actions || []).filter(a => a.domain && expertDomains.includes(a.domain)),
  }
  return scoped.actions.length ? scoped : all
}

/** 岗位是否有权执行该动作。空授权 = 不限岗位（向后兼容既有本体）。
 *
 *  为什么必须有：本体动作原先**没有权限概念**——只要业务域侧重命中（如 PLANT），
 *  一线「装置操作工」的分身就能执行 ProductionOrder.approve、**批准生产指令**。
 *  技能有 allowedRoles，本体动作却裸奔。危化行业里这是事故级漏洞。 */
export function expertMayRun(action: OntologyActionHint, expertId?: string): boolean {
  const allow = action.allowedExperts
  if (!Array.isArray(allow) || allow.length === 0) return true
  return !!expertId && allow.includes(expertId)
}

export function formatOntologyCatalog(hints: OntologyHints): { typeList: string; actionList: string } {
  // 对象类型目录带 description——它是**消歧语料的唯一载体**（如"差旅审批单，区别于合同审批"）。
  // 曾漏传 description、只给 label，导致管理端在描述里写的区分说明对模型完全不可见（写了也白写）。
  const typeList = (hints.types || []).map(t => {
    let rel = ''
    try { const rs = t.relationsJson ? JSON.parse(t.relationsJson) : []; rel = rs.map((r: { name: string; targetType: string }) => `${r.name}→${r.targetType}`).join(',') } catch { /* 关系是可选装饰，坏了不影响消歧 */ }
    const desc = t.description ? ` 说明=${String(t.description).replace(/\s+/g, ' ').slice(0, 100)}` : ''
    return `- domain=${t.domain} objectType=${t.typeKey} 标签=${t.label}${rel ? ' 关系=' + rel : ''}${desc}`
  }).join('\n')
  // 动作目录带 description——领域语料由建模时维护在本体里（数据驱动，代码不写死领域示例）
  const actionList = (hints.actions || []).map(a =>
    `- domain=${a.domain} objectType=${a.objectType} actionKey=${a.actionKey} 标签=${a.label} 能力=${a.capability}${a.description ? ` 说明=${String(a.description).replace(/\s+/g, ' ').slice(0, 80)}` : ''}`).join('\n')
  return { typeList, actionList }
}

/**
 * 本体解析提示词。
 *
 * ⚠️ 红线：这里**不得**写死任何领域映射。曾硬编过一句"『审批合同』是对合同关联的审批任务(ApprovalTask)
 * 执行 approve"当通用规则，结果用户说"审批王磊的差旅"，模型见"审批"二字就往 ApprovalTask 上靠，
 * 摆出一堆**合同**让人批（差点批错单）。领域语料只放本体的 label/description，代码里只留通用规则。
 */
export function buildOntologyPrompt(userMsg: string, hints: OntologyHints, expertDomains?: string[]): string {
  const { typeList, actionList } = formatOntologyCatalog(hints)
  const domainLine = expertDomains && expertDomains.length ? `\n当前岗位业务域侧重：${expertDomains.join('、')}（优先在该域内匹配）。` : ''
  return `你是企业本体解析器。
【对象类型】
${typeList}

【对象动作】
${actionList}${domainLine}
用户指令："${userMsg}"

判断该指令是否明确对应上面某一个对象动作。规则：
- **先定对象、再定动作**：用户说的业务对象（差旅/合同/工单/商机…）必须与某个对象类型的「标签/说明」真正对上。动作词（审批/通过/驳回…）**只用来选动作，绝不能用来推断对象**——多个对象类型可能都有"审批通过"，凭动作词挑类型必错。
- **宁缺勿滥**：用户说的对象在类型目录里没有对应项时（哪怕动作词很像），必须 matched=false。匹配到一个对象类型不符的动作，会导致对**无关单据执行写操作**，后果严重——宁可不匹配，也不要匹配错。
- 用户常用「对象的名字/编号 + 类型词 + 动作词」表达（如"把〈产品名〉工单〈动作〉""把〈单号〉〈动作〉"）——结合类型与动作的标签、说明理解。
- displayName 抽指令里的对象名/单号（如 CL-2026-0007 / PO-2026-0115 / 王磊）。
只输出 JSON（不要任何解释）：
{"matched":true或false,"domain":"","objectType":"该动作所属的 objectType","actionKey":"","displayName":"","amount":金额数字或null,"reason":"一句话理由"}
matched=true 仅当【对象与动作都真正对应】某 actionKey；objectType 必须填动作真正所属的类型；amount 抽取金额(元)否则 null。`
}

/** 解析模型输出；拿不到合法 JSON 或目录里查无此动作 → 一律当未匹配（宁缺勿滥）。 */
export function parseOntologyOutput(out: string, hints: OntologyHints): { res: OntologyResolution; action: OntologyActionHint | null; type: OntologyTypeHint | null } {
  const none = { res: { matched: false } as OntologyResolution, action: null, type: null }
  const m = (out || '').match(/\{[\s\S]*\}/)
  if (!m) return none
  let res: OntologyResolution
  try { res = JSON.parse(m[0]) } catch { return none }
  if (!res.matched) return none
  // 模型可能报出目录里不存在的组合（幻觉）——必须回目录里核实，查无此项则当未匹配。
  const action = (hints.actions || []).find(a => a.domain === res.domain && a.objectType === res.objectType && a.actionKey === res.actionKey) || null
  if (!action) return none
  const type = (hints.types || []).find(t => t.domain === res.domain && t.typeKey === res.objectType) || null
  return { res, action, type }
}
