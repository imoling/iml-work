// agent:send-message 编排链路的共享类型：任务入参与统一返回结构。
// 把编排子步骤（本体钩子 / 技能执行）拆成独立函数时，用这两个类型对齐入参与早返回。
import type { LlmConfig } from './llm'

// agent:send-message 的任务入参（与 IPC 传入的 data 结构一致）。
export interface AgentTaskData {
  content: string
  expertId?: string
  expertName: string
  userNickname?: string
  background: string
  llmConfig: LlmConfig
  forcedSkillId?: string
  permMode?: 'readonly' | 'full'
  history?: { role: 'user' | 'assistant'; content: string }[]   // 近几轮对话上文（单会话多轮上下文）
}

// 知识溯源条目：随回答返回渲染层,以角标+悬浮卡展示(不进正文,不进 LLM 上下文)。
export interface KnowledgeSource {
  seq: number
  name: string
  scope?: string
  score: number
  excerpt?: string
}

// 联网检索来源：随回答返回渲染层，以「联网来源」卡展示（区别于知识来源，可点开原网页）。
export interface WebSource {
  title: string
  url: string
}

// 技能产出的文件（沙箱执行落工作空间）：随回答返回渲染层，以文件卡展示（查看/打开所在位置）。
export interface SkillFile {
  name: string
  sizeBytes: number
}

// ── 自动化/本体链路里 JSON.parse 出来的松形状（字段随录制引擎/后端演进，取用即兜底）──
// 替代散落的 `s: any / f: any / list: any`，给技能执行链路的数据边界一个单一来源。

// 录制脚本里的一步动作（action/act/op 命名并存；label/text/value 供意图判定；url/nav 供导航）。
export interface AutomationStep {
  action?: string; act?: string; op?: string; kind?: string
  fieldName?: string; param?: string
  label?: string; text?: string; value?: string
  url?: string; nav?: string; arg?: string; selector?: string
  options?: string[]
}

// 表单字段定义（从 actionScript/fields JSON 解析；喂动态表单卡）。
export interface FieldDef {
  name?: string; label?: string; type?: string
  value?: string; options?: string[]
}

// 后端 /systems（业务系统登记）列表条目——按 id 匹配取名称与地址。
export interface SystemInfo {
  id?: string; name?: string; baseUrl?: string
}

// 后端 /connector-actions/{id} 详情（replay/api/sop 三形态；字段全可空，取用即兜底）。
export interface ConnectorActionDetail {
  systemId?: string; kind?: string
  apiMethod?: string; apiPath?: string; apiBodyTemplate?: string; outputDesc?: string
  stepsJson?: string; fieldsJson?: string
  sopHint?: string; entryHash?: string   // kind=sop：标准流程描述 + 入口锚点（免录制智能体执行）
}

// 后端 /skills/{id} 详情（FDE 录制上架的技能：actionScript={rawSteps|steps,fields}，及代码/SOP/引擎类型等）。
export interface SkillDetail {
  id?: string; name?: string; type?: string; skillKind?: string
  targetSystemId?: string; actionScript?: string
  code?: string; sopContent?: string; navHash?: string; bundle?: string
}

// 编排每个分支的统一返回：content 回答正文，traceId 供渲染层 👍/👎 精确回填。
export interface AgentResult {
  content: string
  success: boolean
  traceId?: string
  sources?: KnowledgeSource[]
  webSources?: WebSource[]   // 联网检索来源（与知识来源区分展示：可点开原网页）
  files?: SkillFile[]   // 技能产出文件（文件卡展示）
  permSwitch?: boolean  // 先决权限闸：用户选择「切到允许操作重跑」→ 渲染层在本次结束后以 full 权限自动重发原任务
  ontology?: string     // 本体语义执行的技术细节（对象/消解/动作/状态迁移/审计）——回复正文只留业务话，细节进「本体执行」折叠区
}
