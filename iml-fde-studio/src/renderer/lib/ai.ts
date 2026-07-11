// AI 辅助：经企业模型中转站生成结构化结果（场景抽取 / 评分 / 流程建模 / 蓝图）。
import { modelChat } from '../services/api'

// 从模型返回里稳健提取 JSON 对象/数组
export function extractJson(text, fallback) {
  if (!text) return fallback
  const s = String(text).replace(/```json/gi, '').replace(/```/g, '')
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  const c = s.indexOf('['), d = s.lastIndexOf(']')
  let slice = null
  if (a >= 0 && b > a && (c < 0 || a < c)) slice = s.slice(a, b + 1)
  else if (c >= 0 && d > c) slice = s.slice(c, d + 1)
  if (!slice) return fallback
  try { return JSON.parse(slice) } catch (_) { return fallback }
}

async function ask(system, prompt, fallback) {
  const out = await modelChat(prompt, system)
  return extractJson(out, fallback)
}

// 场景要素抽取（文档 §8.3 抽取结果区）
export async function extractFacts(scenario, materials) {
  const mat = [
    materials.description && `【业务描述】\n${materials.description}`,
    materials.interview && `【访谈纪要】\n${materials.interview}`,
    materials.sop && `【SOP 文档】\n${materials.sop}`,
    materials.systemNotes && `【系统页面说明】\n${materials.systemNotes}`,
    (materials.files || []).length && `【附件清单】${(materials.files || []).map(f => f.name).join('、')}`
  ].filter(Boolean).join('\n\n')
  const system = '你是企业 Agent 交付专家（FDE）。从客户业务材料中抽取可落地为 SKILL 的结构化场景要素。只输出 JSON，不要解释。'
  const prompt = `场景名称：${scenario.name}\n所属部门：${scenario.department || '未知'}\n业务角色：${scenario.businessRole || '未知'}\n\n业务材料：\n${mat || '（暂无材料，请基于场景名称合理推断）'}\n\n请抽取以下要素，输出严格 JSON（字段为字符串，多条用换行分隔；无法确定写"待确认"）：\n{\n  "businessGoal": "业务目标",\n  "triggerCondition": "触发条件",\n  "roles": "使用角色",\n  "systems": "涉及系统（每行一个）",\n  "inputs": "输入材料（每行一个）",\n  "outputs": "输出结果（每行一个）",\n  "keyRules": "关键业务规则（每行一条）",\n  "exceptions": "异常情况（每行一条）",\n  "riskActions": "风险动作（提交/付款/删除等，每行一条）",\n  "humanConfirmPoints": "需人工确认的点（每行一条）"\n}`
  return ask(system, prompt, null)
}

// 场景评分（文档 §8.2 评分维度，每维 1-5）
export async function scoreScenario(scenario, facts) {
  const system = '你是企业 Agent 交付专家。对业务场景做"是否适合 Agent 化"的多维评分。只输出 JSON。'
  const prompt = `场景：${scenario.name}（${scenario.department || ''} / ${scenario.businessRole || ''}）\n要素：${JSON.stringify(facts || {})}\n\n按以下 8 个维度各打 1-5 分（5 最高/最适合），并给推荐结论。输出严格 JSON：\n{\n  "frequency": <高频程度>,\n  "repeatability": <重复程度>,\n  "ruleClarity": <规则清晰度>,\n  "systemOperability": <系统可操作性>,\n  "dataAvailability": <数据可获得性>,\n  "riskControllability": <风险可控性>,\n  "auditNeed": <留痕必要性>,\n  "reusePotential": <复用潜力>,\n  "recommendation": "priority | pilot | need_more_materials | not_recommended",\n  "reason": "一句话理由"\n}`
  const r = await ask(system, prompt, null)
  if (r) {
    const dims = ['frequency', 'repeatability', 'ruleClarity', 'systemOperability', 'dataAvailability', 'riskControllability', 'auditNeed', 'reusePotential']
    r.total = dims.reduce((a, k) => a + (Number(r[k]) || 0), 0)
  }
  return r
}

// 流程建模：把场景要素拆成 Agent 可执行的有序流程节点（文档 §8.4）
export async function generateFlow(scenario, facts) {
  const system = '你是企业 Agent 流程设计专家。把业务场景拆解成有序、可执行的流程节点。只输出 JSON 数组。'
  const prompt = `场景：${scenario.name}\n要素：${JSON.stringify(facts || {})}\n\n请输出有序流程节点数组。节点 type 取值：start|user_input|system_action|data_extract|knowledge_lookup|rule_check|human_confirm|file_generate|notification|exception|end。executorType 取值：browser_automation|desktop_automation|api_call|file_processing|knowledge_lookup|script_runner|human_confirmation|scheduled_task|notification（start/end 可不填）。涉及"提交/付款/删除/审批"等动作必须 isSensitiveAction=true 且其后或其本身配 human_confirm。\n严格输出 JSON 数组：\n[{"type":"...","title":"节点名","goal":"该步目标","executorType":"...","inputs":"输入","outputs":"输出","requiresHumanConfirmation":false,"isSensitiveAction":false,"failureHandling":"失败如何处理"}]\n首节点 start、末节点 end。控制在 6-12 个节点。`
  const arr = await ask(system, prompt, null)
  if (!Array.isArray(arr)) return null
  return arr.map((n, i) => ({ id: 'n' + (i + 1), ...n }))
}

// SKILL 蓝图：从流程模型生成技能蓝图 + SKILL.md 草案（文档 §8.5）
export async function generateBlueprint(scenario, facts, nodes) {
  const system = '你是企业 SKILL 技能设计专家。把流程模型转化为一份可上架的 SKILL 蓝图。只输出 JSON。'
  const prompt = `场景：${scenario.name}（${scenario.department || ''} / ${scenario.businessRole || ''}）\n要素：${JSON.stringify(facts || {})}\n流程节点：${JSON.stringify((nodes || []).map(n => ({ type: n.type, title: n.title, executorType: n.executorType, sensitive: n.isSensitiveAction })))}\n\n请输出 SKILL 蓝图，严格 JSON（数组字段为字符串数组）：\n{\n "name":"技能名称","summary":"一句话技能简介",\n "applicableRoles":["适用岗位"],"departments":["适用部门"],"triggerKeywords":["触发词"],\n "prerequisites":["前置条件"],\n "inputParams":[{"name":"英文标识","label":"中文名","type":"text|number|date|file|select|boolean","required":true,"description":""}],\n "outputResults":["输出结果"],\n "knowledgeDependencies":["需要的知识/SOP"],"systemDependencies":["依赖的业务系统"],"fileDependencies":["依赖的文件"],\n "permissionBoundaries":["权限边界"],"sensitiveActions":["敏感动作"],"confirmationRules":["人工确认规则"],\n "acceptanceCases":[{"title":"用例名","inputSummary":"输入","expectedOutput":"期望输出","passCriteria":["通过标准"]}]\n}`
  const bp = await ask(system, prompt, null)
  if (bp) bp.markdownDraft = blueprintToMarkdown(bp, scenario)
  return bp
}

// 生成 SKILL.md 草案（文档 §8.5 结构）
export function blueprintToMarkdown(bp, scenario) {
  const b = bp || {}, list = (a) => (a || []).map(x => '- ' + (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') || '- 待补充'
  const meta = [
    '---',
    `name: ${b.name || scenario?.name || 'skill'}`,
    `description: ${b.summary || ''}`,
    'allowed_roles:', ...(b.applicableRoles || []).map(r => `  - ${r}`),
    'trigger_keywords:', ...(b.triggerKeywords || []).map(r => `  - ${r}`),
    'required_systems:', ...(b.systemDependencies || []).map(r => `  - ${r}`),
    'required_knowledge:', ...(b.knowledgeDependencies || []).map(r => `  - ${r}`),
    `risk_level: ${(b.sensitiveActions || []).length ? 'high' : 'low'}`,
    'human_confirmation:', `  required: ${(b.confirmationRules || []).length > 0}`,
    '---'
  ].join('\n')
  return `${meta}

# ${b.name || scenario?.name || ''}

## 适用场景
${b.summary || ''}

## 输入要求
${(b.inputParams || []).map(p => `- ${p.label || p.name}（${p.type}${p.required ? '，必填' : ''}）：${p.description || ''}`).join('\n') || '- 待补充'}

## 输出结果
${list(b.outputResults)}

## 执行流程
${list(b.prerequisites)}

## 关键规则
${list(b.confirmationRules)}

## 异常处理
- 待补充

## 人工确认
${list(b.confirmationRules)}

## 审计要求
- 记录每步执行过程与结果

## 验收用例
${(b.acceptanceCases || []).map((c, i) => `${i + 1}. ${c.title}：输入「${c.inputSummary}」→ 期望「${c.expectedOutput}」`).join('\n') || '- 待补充'}
`
}
