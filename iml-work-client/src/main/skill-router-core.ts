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

/** 构造两步判定（产出形态 wants → 选技能）的路由 prompt。单一来源，勿在别处复制。 */
export function buildRouterPrompt(userText: string, catalog: string): string {
  return `你是企业工作分身的技能路由器。分两步判定：\n第一步，判断用户要的【产出形态】wants：\n- "file"：要一份交付物文件（做/生成/导出/落成 文档、报告、表格、演示文稿等）。\n- "action"：要操作业务系统（在 OA/CRM/ERP 等系统里审批、录入、查询、提交、办理某事）。\n- "answer"：要的是对话里的内容——梳理、大纲、思路、建议、框架、点评、解释、问答。注意：句中出现"PPT/文档/报告"等字眼**不代表**要生成文件，"帮我梳理 PPT 大纲"要的是大纲文字，属于 answer。\n关键区分：涉及"在某业务系统里对某单据/对象执行操作"（如"把合同审批通过""录入拜访反馈""查我的待办"）一律是 action，不是 file。\n第二步，仅当 wants 为 file 或 action 时，从技能目录选出所需的【全部】技能；wants 为 answer 时 skillIds 必须为空数组。\n\n【技能目录】\n${catalog}\n\n【用户请求】\n${userText}\n\n选技能的规则（wants=file/action 时）：\n- 要产出文档/报告/信函/表格/演示文稿等交付物 → 选对应的文档/生成类技能（哪怕没提"docx/word/ppt"字眼）。\n- 一句话要多种交付物（如"要 Word 报告和 PPT"）→ 同时选中对应的多个技能。\n- 操作业务系统 → 选对应业务技能。\n- **宁缺勿滥**：目录里没有与请求的对象/系统/能力真正对应的技能时，必须返回空数组——绝不要硬凑语义近似项（例如请求是"生产工单开工/排产"而目录只有"合同审批"→ 空；请求是"梳理产品价值"而目录只有"网页前端设计"→ 空）。\n- skillId 必须逐字取自目录中的 id。\n【示例1】"帮我起草一份致歉文书"（目录有 docx）→ {"wants":"file","skillIds":["<docx技能id>"]}\n【示例2】"准备季度汇报，要 Word 报告和 PPT"（目录有 docx、pptx）→ {"wants":"file","skillIds":["<docx技能id>","<pptx技能id>"]}\n【示例3】"帮我梳理一下培训的 PPT 大纲" → {"wants":"answer","skillIds":[]}（要的是大纲文字，不是文件）\n【示例4】"把这份大纲做成 PPT" → {"wants":"file","skillIds":["<pptx技能id>"]}\n【示例5】"这份方案帮我把把关，给点修改建议" → {"wants":"answer","skillIds":[]}\n【示例6】"在 OA 里把宝钢的合同审批通过"（目录有 合同审批技能）→ {"wants":"action","skillIds":["<合同审批技能id>"]}\n只输出严格 JSON（不要解释、不要代码块标记）：{"wants":"file|action|answer","skillIds":["id1"]} 或 {"wants":"answer","skillIds":[]}`
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
