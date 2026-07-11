// Workflow IR 编译器（文档 §9）：规则清洗 + 模型辅助 + 强类型校验。
// 把录制步骤编译成强类型 Workflow IR（输入/输出/能力/确认策略/异常分支/参数分类）。
import { modelChat } from '../services/api'
import { extractJson } from './ai'

export const IR_SCHEMA_VERSION = '1.0'
const CAPS = ['read', 'create', 'update', 'delete', 'batch']
export const PARAM_KIND = {
  fixed: { label: '固定配置', tag: 'gray' }, input: { label: '动态输入', tag: 'green' },
  secret: { label: '密钥引用', tag: 'red' }, output: { label: '运行输出', tag: 'blue' },
  test: { label: '测试数据', tag: 'amber' }, derived: { label: '派生字段', tag: 'blue' },
  needs_confirm: { label: '需 FDE 确认', tag: 'amber' }
}
const FILL_ACTS = ['fill', 'select', 'search']

// 规则层：清洗去噪（合并连续同字段填写、丢冗余 hover、去连续重复）
export function cleanSteps(steps) {
  const a = []
  for (let i = 0; i < (steps || []).length; i++) {
    const s = steps[i], prev = a[a.length - 1], sel = s.fp && s.fp.sel
    if (s.act === 'fill' && prev && prev.act === 'fill' && prev.fp && sel && prev.fp.sel === sel) { prev.value = s.value; continue }
    if (s.act === 'hover') { const nx = steps[i + 1]; if (nx && nx.fp && sel && nx.fp.sel === sel) continue }
    if (prev && prev.act === s.act && prev.fp && sel && prev.fp.sel === sel && prev.value === s.value) continue
    a.push({ ...s })
  }
  return a
}

// 强类型校验（轻量 Schema 校验）
export function validateIR(ir) {
  const e = []
  if (!ir || typeof ir !== 'object') return ['IR 为空']
  if (ir.schemaVersion !== IR_SCHEMA_VERSION) e.push('schemaVersion 不符')
  if (!ir.systemId) e.push('缺 systemId')
  if (!Array.isArray(ir.requiredCapabilities) || !ir.requiredCapabilities.every(c => CAPS.includes(c))) e.push('requiredCapabilities 非法')
  if (!Array.isArray(ir.inputs)) e.push('inputs 必须为数组')
  else ir.inputs.forEach((f, i) => { if (!f.name) e.push(`inputs[${i}] 缺 name`); if (!f.type) e.push(`inputs[${i}] 缺 type`) })
  if (!Array.isArray(ir.actions) || ir.actions.length === 0) e.push('actions 至少一个')
  return e
}

// 编译：规则骨架 + 模型辅助 + 强类型校验 → { ir, paramMap, errors }
export async function compileIR({ action, steps, systemId }) {
  const clean = cleanSteps(steps || [])
  const key = action.actionKey || ('act.' + (action.name || 'action').replace(/\s+/g, '_'))
  const fills = clean.map((s, idx) => ({ idx, act: s.act, label: s.label, value: s.value })).filter(f => FILL_ACTS.includes(f.act))

  // 模型辅助层：参数语义化 / 输入输出 / 异常分支 / 验收用例（只输出 JSON）
  let m: any = {}
  try {
    const system = '你是 SKILL 编译器。把录制步骤编译成强类型 Workflow IR 的关键部分。只输出 JSON，不要解释。'
    const prompt = `连接器动作：${action.name}（CRUD 能力：${action.capability}）\n系统：${systemId}\n清洗后的填写/选择步骤（带录制值）：\n${fills.map(f => `[${f.idx}] ${f.label || '(无标签)'} = ${f.value || ''}`).join('\n') || '（无填写步骤）'}\n\n请输出严格 JSON：\n{\n "inputs":[{"name":"英文标识","label":"中文名","type":"text|number|date|select|boolean","required":true,"fromStep":<上面的步骤号>}],\n "outputs":[{"name":"英文标识","label":"中文名","type":"text"}],\n "paramClassification":[{"stepIndex":<步骤号>,"label":"","kind":"fixed|input|secret|output|test|derived|needs_confirm"}],\n "errorBranches":[{"when":"触发条件","handle":"处理方式"}],\n "acceptanceCase":{"title":"用例名","inputSummary":"输入","expectedOutput":"期望输出"}\n}\n分类规则：密码/验证码 → secret；客户名/金额/日期等每次都变 → input；固定页面/按钮文案 → fixed；单据号/编号等结果 → output；测试用占位 → test；无法判断 → needs_confirm。只有 input 类才进 inputs 数组。`
    m = extractJson(await modelChat(prompt, system), {}) || {}
  } catch (_) { m = {} }

  // 规则骨架（确定性）+ 模型辅助合并
  const isWrite = ['create', 'update', 'delete', 'batch'].includes(action.capability)
  const ir = {
    schemaVersion: IR_SCHEMA_VERSION,
    systemId,
    requiredCapabilities: [CAPS.includes(action.capability) ? action.capability : 'read'],
    inputs: (Array.isArray(m.inputs) ? m.inputs : []).filter(f => f && f.name).map(f => ({ name: f.name, label: f.label || f.name, type: f.type || 'text', required: f.required !== false, fromStep: f.fromStep })),
    outputs: Array.isArray(m.outputs) ? m.outputs.filter(f => f && f.name) : [],
    actions: [{ key, name: action.name, capability: action.capability, stepCount: clean.length }],
    transitions: [{ from: 'start', to: key, type: 'sequence' }, { from: key, to: 'end', type: 'sequence' }],
    confirmationPolicies: isWrite ? [{ actions: [key], required: true, reason: '写操作需人工确认 + 一次性签名令牌' }] : [],
    errorBranches: Array.isArray(m.errorBranches) ? m.errorBranches : [],
    acceptanceCases: m.acceptanceCase && m.acceptanceCase.title ? [m.acceptanceCase] : [],
    paramClassification: (Array.isArray(m.paramClassification) ? m.paramClassification : []).filter(p => p && PARAM_KIND[p.kind])
  }

  // paramMap：input 类填写步骤 → 参数名（供执行时注入 fieldValues，替代回放字面值）
  const paramMap = {}
  ir.paramClassification.forEach(p => {
    if (p.kind === 'input') {
      const inp = ir.inputs.find(x => x.fromStep === p.stepIndex)
      paramMap[p.stepIndex] = inp ? inp.name : ('p' + p.stepIndex)
    }
  })

  return { ir, paramMap, errors: validateIR(ir), cleaned: clean.length, rawSteps: (steps || []).length }
}
