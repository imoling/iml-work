// 录制演示 → 语义 SKILL 转译器（设计见 docs/design-recording-to-semantic-skill.md ②）。
//
// 定位：录制是「演示」，不是「脚本」。本模块在「结束录制」后把整场演示交给模型通盘分析，
// 产出技能真身——意图 + 参数表（AI 自动识别动态参数，录制值只是样例）+ SOP（browse 分步执行的可控计划）。
// 录制步骤自此降级为 hints（定位提示），绝不再当技能本体。
//
// 叶子纪律：不 import main / llm 本体（LlmConfig 仅 type-only，callModel 由调用方注入），与 browse 引擎同款。
import type { LlmConfig } from './llm'
import type { RecStep, SendLog } from './types'
import { swallow } from './util'

/** 语义 SKILL 的参数定义（AI 从演示自动识别；录制值只是 sample，执行时按用户需求动态取值）。 */
export interface SkillParam {
  name: string                                   // 简短中文语义名（日期/类型/原因/审批人…）
  type: 'text' | 'date' | 'select' | 'search'    // search=检索选人/选对象类控件
  sample: string                                 // 录制时的样例值（仅展示/兜底，不焊死）
  options?: string[]                             // 下拉候选（录制时抓到的真实选项）
  required?: boolean
}

/** AI 转译产物：语义 SKILL 草案（评审区给用户确认/微调）。 */
export interface TranspiledSkill {
  intent: string          // 一句话意图描述（存 description，供路由语义匹配）
  kind: 'read' | 'write'
  params: SkillParam[]
  sop: string             // 编号步骤 + {{参数}} 占位 + 提交步单列
  submitLabel?: string    // 最终提交按钮文字（执行侧写前签字的锚点）
}

export type CallModel = (prompt: string, cfg: LlmConfig, opts?: { temperature?: number; longRunning?: boolean }) => Promise<string>

// 步骤序列化（控 token）：值截断、候选限量、URL 只留 path+hash 尾部。
function briefSteps(steps: RecStep[]): string {
  const cut = (s: string, n: number) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
  return steps.slice(0, 80).map((s, i) => {
    const o: Record<string, unknown> = { i, act: s.action, label: cut(s.label, 40) }
    if (s.value) o.value = cut(s.value, 60)
    if (Array.isArray(s.options) && s.options.length) o.options = s.options.slice(0, 20).map(x => cut(String(x), 20))
    if (s.inputType) o.inputType = s.inputType
    try { const u = new URL(s.url || ''); o.page = cut(u.pathname + (u.hash || ''), 80) } catch (_) { /* 无效 URL 略过 */ }
    return JSON.stringify(o)
  }).join('\n')
}

function buildPrompt(steps: RecStep[], skillName: string, systemName: string): string {
  return `你是「企业自动化技能编译器」。用户在【${systemName}】里**演示**了一遍「${skillName}」操作，逐步记录如下（每行一个 JSON：i=序号, act=动作, label=控件标签, value=当时填/选的值, options=下拉候选, page=页面路径）。
你的任务：看懂这场演示的**业务意图**，把它编译成一个可复用的语义技能。

## 判定规则
1. **参数**（下次执行会变的值）：演示里这次填/选/检索的具体业务值——日期、类型选择、原因/备注文本、人名、审批人、单号、金额、检索选中的对象等。每个参数给：name（简短中文语义名，如"审批人"）、type（text|date|select|search）、sample（演示时的值）、options（若是下拉，抄录候选）、required（表单必填或流程关键则 true）。
2. **固定流程**（不参数化）：菜单名、按钮文字、导航路径、纯 UI 操作（打开弹窗/切页签）。
3. **归并**：连续的「fill 检索词 + click 含该词的结果项」或「click 打开选人/选对象框 + 后续点选」是一次**检索选择**，归并成一个 type=search 的参数（如 审批人），不要拆成两个。同一控件的重复输入只算一次。**type=search 的参数绝不要 options**（候选靠执行时现场检索，演示里弹层内容不完整不可信）；options 只给**封闭下拉（select）且演示记录里确实抄到完整候选**的参数，拿不准就不给。
4. **一个填写/选择控件一个参数**：不同控件即使这次演示填了**相同的值**（如「类型」和「原因说明」都填了"因公误时"），也必须**各自独立成参数**，绝不合并、绝不省略其一。
5. **无名步骤不能丢**：label 为空的 fill/click 也承载操作——结合值、前后步骤和页面推断它是什么（如表格里类型旁边的必填输入框多为「原因说明」；点无名表格行多是在**选择某条记录**）。
6. **选记录参数化**：点击表格行若是在选择某条日期/单据记录（label 常是行内容如日期时间），应参数化（如 {{日期}}），SOP 写成「找到 {{日期}} 对应的行并勾选/点击」——绝不写死"第N行"。
7. **kind**：演示含填写/选择/提交等改变业务状态的操作 → write；纯查看/导航 → read。
8. **sop**：编号步骤的自然语言操作计划（执行者是能看真实页面的自动化代理）：写"做什么"而非"点哪个选择器"；参数一律以 {{参数名}} 引用；提交/保存动作**单独作为最后一步**；步骤要能对着页面走通，**演示里出现过的每个填写/选择/选行操作都必须落进 SOP**（如先打开某应用/弹窗、选中日期行、填原因说明），一步都不许漏。
9. **submitLabel**：最终提交按钮的文字（如"提交"）；read 类可为空。
10. **intent**：一句话说清这个技能在什么系统做什么事（供语义路由匹配）。

## 演示记录
${briefSteps(steps)}

## 输出
只输出一个严格 JSON 对象，不要任何其它文字：
{"intent":"…","kind":"write|read","params":[{"name":"…","type":"text|date|select|search","sample":"…","options":["…"],"required":true}],"sop":"1. …\\n2. …","submitLabel":"…"}`
}

const PARAM_TYPES = new Set(['text', 'date', 'select', 'search'])

/** 把演示转译成语义 SKILL。模型失败/输出不合法 → 返回 null（调用方退回规则版兜底，不阻塞保存）。 */
export async function transpileRecording(steps: RecStep[], skillName: string, systemName: string, cfg: LlmConfig, callModel: CallModel, sendLog?: SendLog): Promise<TranspiledSkill | null> {
  if (!steps || !steps.length) return null
  try {
    sendLog?.('thinking', '[录制转译] AI 正在把这场演示整理成语义技能（识别动态参数 + 生成 SOP）…')
    const out = await callModel(buildPrompt(steps, skillName, systemName), cfg, { temperature: 0 })
    const a = (out || '').indexOf('{'), b = (out || '').lastIndexOf('}')
    if (a < 0 || b <= a) return null
    const j = JSON.parse(out.slice(a, b + 1))
    const sop = String(j.sop || '').trim()
    if (!sop) return null
    const params: SkillParam[] = (Array.isArray(j.params) ? j.params : [])
      .filter((p: any) => p && String(p.name || '').trim())
      .slice(0, 20)
      .map((p: any) => ({
        name: String(p.name).trim().slice(0, 24),
        type: (PARAM_TYPES.has(String(p.type)) ? String(p.type) : 'text') as SkillParam['type'],
        sample: String(p.sample ?? '').slice(0, 120),
        options: Array.isArray(p.options) && p.options.length ? p.options.slice(0, 40).map((x: any) => String(x)) : undefined,
        required: p.required === true,
      }))
    return {
      intent: String(j.intent || '').trim().slice(0, 200),
      kind: j.kind === 'read' ? 'read' : 'write',   // 存疑归 write（宁严勿漏：写类才有确认+签字闸）
      params,
      sop,
      submitLabel: String(j.submitLabel || '').trim().slice(0, 20) || undefined,
    }
  } catch (e) {
    swallow(e, 'skill-transpile')
    return null
  }
}
