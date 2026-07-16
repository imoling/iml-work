// 技能路由的纯逻辑核心（无 electron/网络依赖）：prompt 构造 + 输出解析 + 目录格式化。
// 运行时（skill-exec.ts）与离线评测脚本（scripts/eval-router.ts）共用同一套，
// 保证「评测的就是线上真实 prompt」——改路由 prompt 不会与评测漂移。

export interface RouterSkill { id: string; name: string; description?: string; sopContent?: string }

/** 把技能目录渲染成 prompt 里的清单（描述截断 240 字，与运行时一致）。 */
export function formatCatalog(skills: RouterSkill[], displayName?: (id: string) => string | undefined): string {
  return skills.map(s =>
    `- id: ${s.id}\n  名称: ${(displayName && displayName(s.id)) || s.name}\n  描述: ${(s.description || s.sopContent || '').replace(/\s+/g, ' ').slice(0, 240)}`
  ).join('\n')
}

/** 最近对话上下文渲染（供路由判断承接语境）：取尾部几轮、每条截断，角色中文标注。 */
export function formatRouterContext(history?: { role: string; content: string }[], turns = 3): string {
  const tail = (history || []).slice(-turns)
  return tail.map(h => `${h.role === 'user' ? '用户' : '助手'}：${(h.content || '').replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')
}

/** 短确认（对上一轮提议的应答）：真实诉求在上文，本句无任何可路由信息。 */
export const SHORT_CONFIRM = /^\s*(同意|确认|确认提交|提交|通过|批准|可以|好的?|行|OK|ok|是的?|执行|继续)[\s。.!！~]*$/

/**
 * 路由输入文本（运行时与评测共用，杜绝漂移）：一般情况就是用户原话；
 * 但用户只说「同意/确认/提交」这类短确认时，真实操作诉求在上一轮助手的提议里——
 * 把它并进来，让技能真去系统里执行（红线：曾出现回「同意」→ 未跑任何自动化 → 却声称已提交审批）。
 */
export function buildRouteText(userText: string, history?: { role: string; content: string }[]): string {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant')
  if (!lastAssistant || !SHORT_CONFIRM.test(userText || '')) return userText
  // ⚠️ 只把上文诉求接上，绝不催逼模型"必须选出技能"——否则它会硬凑近似技能
  //（实测：差旅审批的确认曾被凑成"合同审批"技能去点宝钢合同的同意键）。
  // 执行错的写操作 >> 不执行：宁缺勿滥的优先级高于"接续执行"。
  return `${userText}\n（这是对上一轮提议的**确认指令**：用户同意执行上一轮里提到的那个操作。请据上文判定用户真正要执行的业务操作，再按既有规则选技能。\n**注意**：宁缺勿滥依然是最高准则——只有目录里存在与该操作【对象与动作都真正对应】的技能时才选它；对象不符（如上文要审批"差旅申请"，目录只有"合同审批"）一律返回空数组，绝不硬凑近似技能去执行错误的写操作。）\n【上一轮助手提议】${(lastAssistant.content || '').replace(/\s+/g, ' ').slice(0, 500)}`
}

/** 构造两步判定（产出形态 wants → 选技能）的路由 prompt。单一来源，勿在别处复制。
 *  recentContext：最近对话（formatRouterContext 产出），用于识别「承接语境」——用户在回答助手
 *  上一轮的提问/补充信息时，哪怕句中含业务词（出差/合同/报销…）也不是在发起业务操作。 */
export function buildRouterPrompt(userText: string, catalog: string, recentContext?: string): string {
  const ctxBlock = recentContext && recentContext.trim()
    ? `\n\n【最近对话】（用于判断承接语境）\n${recentContext}`
    : ''
  return `你是企业工作分身的技能路由器。分两步判定：\n第一步，判断用户要的【产出形态】wants：\n- "file"：要一份交付物文件（做/生成/导出/落成 文档、报告、表格、演示文稿等）。\n- "action"：要操作业务系统（在 OA/CRM/ERP 等系统里审批、录入、查询、提交、办理某事）。\n- "answer"：要的是对话里的内容——梳理、大纲、思路、建议、框架、点评、解释、问答。注意：句中出现"PPT/文档/报告"等字眼**不代表**要生成文件，"帮我梳理 PPT 大纲"要的是大纲文字，属于 answer。\n关键区分：涉及"在某业务系统里对某单据/对象执行操作"（如"把合同审批通过""录入拜访反馈""查我的待办"）一律是 action，不是 file。\n**承接语境**：若【最近对话】里助手正在提问或等待用户补充信息，而用户这句话是在回答/提供信息（哪怕句中出现"出差、合同、报销"等业务词），wants 一律为 "answer"、不选任何技能——回答助手的问题不是发起业务操作。\n第二步，仅当 wants 为 file 或 action 时，从技能目录选出所需的【全部】技能；wants 为 answer 时 skillIds 必须为空数组。\n\n【技能目录】\n${catalog}${ctxBlock}\n\n【用户请求】\n${userText}\n\n选技能的规则（wants=file/action 时）：\n- 要产出文档/报告/信函/表格/演示文稿等交付物 → 选对应的文档/生成类技能（哪怕没提"docx/word/ppt"字眼）。\n- 一句话要多种交付物（如"要 Word 报告和 PPT"）→ 同时选中对应的多个技能。\n- 操作业务系统 → 选对应业务技能。\n- **宁缺勿滥**：目录里没有与请求的对象/系统/能力真正对应的技能时，必须返回空数组——绝不要硬凑语义近似项（例如请求是"生产工单开工/排产"而目录只有"合同审批"→ 空；请求是"梳理产品价值"而目录只有"网页前端设计"→ 空）。\n- skillId 必须逐字取自目录中的 id。\n【示例1】"帮我起草一份致歉文书"（目录有 docx）→ {"wants":"file","skillIds":["<docx技能id>"]}\n【示例2】"准备季度汇报，要 Word 报告和 PPT"（目录有 docx、pptx）→ {"wants":"file","skillIds":["<docx技能id>","<pptx技能id>"]}\n【示例3】"帮我梳理一下培训的 PPT 大纲" → {"wants":"answer","skillIds":[]}（要的是大纲文字，不是文件）\n【示例4】"把这份大纲做成 PPT" → {"wants":"file","skillIds":["<pptx技能id>"]}\n【示例5】"这份方案帮我把把关，给点修改建议" → {"wants":"answer","skillIds":[]}\n【示例6】"在 OA 里把宝钢的合同审批通过"（目录有 合同审批技能）→ {"wants":"action","skillIds":["<合同审批技能id>"]}\n【示例7·承接语境】最近对话里助手问"要不要根据你的出差路线推荐点餐策略？"，用户答"我下周去北京、哈尔滨、上海出差" → {"wants":"answer","skillIds":[]}（在回答助手的提问，不是要办出差申请）\n只输出严格 JSON（不要解释、不要代码块标记）：{"wants":"file|action|answer","skillIds":["id1"]} 或 {"wants":"answer","skillIds":[]}`
}

/** 解析路由输出：返回 wants 与经目录校验后的 picked（answer 强制空——双保险）。 */
export function parseRouterOutput(outText: string, validIds: string[]): { wants: string; picked: string[] } {
  const m = (outText || '').match(/\{[\s\S]*?\}/)
  const parsed = m ? safeJson(m[0]) : null
  const wants = typeof parsed?.wants === 'string' ? parsed.wants : ''
  const arr = parsed?.skillIds
  let picked = Array.isArray(arr) ? arr.filter((id: any) => typeof id === 'string' && validIds.includes(id)) : []
  if (wants === 'answer') picked = []
  return { wants, picked }
}

function safeJson(s: string): any { try { return JSON.parse(s) } catch { return null } }
