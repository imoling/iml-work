// Agent Trace 采集：把一次 agent:send-message 任务的全链路轨迹（技能/本体/联网/模型 span、
// 来源、token、风险等级、状态）封装为一个共享对象，任务结束时上报管理端审计追溯。
// 从 main.ts 的 agent:send-message 闭包内联状态抽出——把 traceSpans/traceSkill/... 收敛成一个
// 可传递的实例，便于把编排子步骤（本体钩子/技能执行）拆成独立函数而不丢失 trace 上下文。
import os from 'os'
import { configGet } from './db'
import { afetch, getAdminBaseUrl } from './http'
import { swallow } from './util'
import type { LlmConfig } from './llm'

// submitTrace 用到的任务元信息（与 agent:send-message 的 data 结构兼容）。
export interface AgentTaskMeta {
  content: string
  expertName: string
  llmConfig: LlmConfig
}

export class AgentTrace {
  start = Date.now()
  spans: any[] = []
  events: any[] = []
  webSearch = false
  skill = ''
  sources: any[] = []
  tokens = { p: 0, c: 0 }
  id = ''   // 后端保存后回填的 Trace id，随回答返回给渲染层（供 👍/👎 精确回填）

  constructor(private data: AgentTaskMeta, private expertId: string, private userNickname: string) {}

  async submit(finalContent: string, status: string, summary: string): Promise<void> {
    try {
      const cfg: any = this.data.llmConfig || {}
      const url = (cfg.baseUrl || '').toLowerCase()
      const provider = cfg.mode === 'proxy' ? 'GATEWAY'
        : url.includes('deepseek') ? 'DEEPSEEK' : url.includes('agnes') || url.includes('apihub') ? 'AGNES'
        : url.includes('openai') ? 'OPENAI' : url.includes('moonshot') ? 'MOONSHOT'
        : url.includes('dashscope') ? 'QWEN' : url.includes('localhost') || url.includes('11434') ? 'OLLAMA' : 'DIRECT'
      const spans = [...this.spans, { type: 'model', name: `模型作答·${cfg.modelName || ''}`, status: status === 'SUCCESS' ? 'ok' : 'warn' }]
      const risk = status === 'BLOCKED' ? 'MEDIUM' : (this.webSearch || this.skill) ? 'MEDIUM' : 'LOW'
      const payload = {
        clientId: (configGet('clientId') || os.hostname()), deviceHost: os.hostname(),
        appVersion: 'v1.0.3', workspace: 'iML Work Workspace',
        userId: 'user-' + this.userNickname, userNickname: this.userNickname, expertId: this.expertId, expertName: this.data.expertName,
        department: '', role: '', sessionId: 'sess-' + String(Date.now()).slice(-6),
        userQuestion: this.data.content,
        modelName: cfg.modelName || '', modelProvider: provider, connectionMode: cfg.mode || 'direct',
        promptTokens: this.tokens.p || Math.ceil((this.data.content || '').length / 2),
        completionTokens: this.tokens.c || Math.ceil((finalContent || '').length / 2),
        durationMs: Date.now() - this.start,
        webSearchUsed: this.webSearch, skillUsed: this.skill, knowledgeUsed: '',
        riskLevel: risk, status,
        reasoningSummary: summary,
        finalAnswer: finalContent,
        spans: JSON.stringify(spans), sources: JSON.stringify(this.sources), events: JSON.stringify(this.events)
      }
      const tr = await afetch(`${getAdminBaseUrl()}/api/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (tr.ok) { try { const d: any = await tr.json(); if (d && d.id) this.id = d.id } catch (e) { swallow(e) } }
    } catch (e) { swallow(e) }
  }
}
