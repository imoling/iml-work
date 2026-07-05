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

// 技能产出的文件（沙箱执行落工作空间）：随回答返回渲染层，以文件卡展示（查看/打开所在位置）。
export interface SkillFile {
  name: string
  sizeBytes: number
}

// 编排每个分支的统一返回：content 回答正文，traceId 供渲染层 👍/👎 精确回填。
export interface AgentResult {
  content: string
  success: boolean
  traceId?: string
  sources?: KnowledgeSource[]
  files?: SkillFile[]   // 技能产出文件（文件卡展示）
  permSwitch?: boolean  // 先决权限闸：用户选择「切到允许操作重跑」→ 渲染层在本次结束后以 full 权限自动重发原任务
  ontology?: string     // 本体语义执行的技术细节（对象/消解/动作/状态迁移/审计）——回复正文只留业务话，细节进「本体执行」折叠区
}
