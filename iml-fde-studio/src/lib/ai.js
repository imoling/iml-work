// AI 辅助：经企业模型中转站生成结构化结果（场景抽取 / 评分 / 流程建模 / 蓝图）。
import { modelChat } from '../services/api.js'

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
