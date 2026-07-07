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

// 审计轨迹三类结构化子项（各编排步骤 push 进来，submit 时 JSON 序列化上报）。
export interface TraceSpan { type: string; name: string; status?: string }
export interface TraceSource { title?: string; url?: string }
export interface TraceEvent { type: string; name?: string; status?: string; detail?: string }

export class AgentTrace {
  start = Date.now()
  spans: TraceSpan[] = []
  events: TraceEvent[] = []
  webSearch = false
  sandboxUsed = false   // 本次任务是否经公司级 Docker 沙箱执行过代码（直接代码技能或 agentic 技能）
  skill = ''
  // 结构化失败原因：调用方可显式设置；为空时 submit 按「我们自己生成的受控文案」推断兜底。
  // 词表：SYSTEM_NOT_LOGGED_IN|SANDBOX_UNAVAILABLE|SKILL_EXEC_FAILED|MODEL_ERROR|
  //       USER_CANCELLED|PERMISSION_BLOCKED|CONFIRM_REJECTED|TASK_FAILED
  failureReason = ''
  sources: TraceSource[] = []
  tokens = { p: 0, c: 0 }
  id = ''   // 后端保存后回填的 Trace id，随回答返回给渲染层（供 👍/👎 精确回填）

  // 任务编排：多子任务同属一次用户请求时，暂缓各子任务各自上报，改由编排器最后合并成一条审计。
  // deferSubmit=true 期间 submit() 只把 {status,summary} 记入 deferred 缓冲，不真正 POST。
  deferSubmit = false
  deferred: { status: string; summary: string }[] = []

  constructor(private data: AgentTaskMeta, private expertId: string, private userNickname: string) {}

  async submit(finalContent: string, status: string, summary: string): Promise<void> {
    if (this.deferSubmit) { this.deferred.push({ status, summary }); return }
    try {
      const cfg = this.data.llmConfig || {} as LlmConfig
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
        webSearchUsed: this.webSearch, sandboxUsed: this.sandboxUsed, skillUsed: this.skill, knowledgeUsed: '',
        riskLevel: risk, status,
        failureReason: this.resolveFailureReason(status, summary, finalContent),
        reasoningSummary: summary,
        finalAnswer: finalContent,
        spans: JSON.stringify(spans), sources: JSON.stringify(this.sources), events: JSON.stringify(this.events)
      }
      const tr = await afetch(`${getAdminBaseUrl()}/api/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (tr.ok) { try { const d = await tr.json() as { id?: string }; if (d && d.id) this.id = d.id } catch (e) { swallow(e) } }
    } catch (e) { swallow(e) }
  }

  /** 失败原因归类：显式设置优先；否则按 summary/正文里我们自己写的固定文案推断（受控词表，非用户输入）。 */
  private resolveFailureReason(status: string, summary: string, content: string): string {
    if (status === 'SUCCESS') return ''
    if (this.failureReason) return this.failureReason
    const t = `${summary || ''} ${content || ''}`
    if (/取消人工确认|确认未通过|拒绝确认|取消批量确认/.test(t)) return 'CONFIRM_REJECTED'
    if (/只读|权限拦截|越权|readonly/i.test(t)) return 'PERMISSION_BLOCKED'
    if (/用户取消|已终止|中止|用户点击停止/.test(t)) return 'USER_CANCELLED'
    if (/未登录|需登录|登录失效|重新登录|会话过期/.test(t)) return 'SYSTEM_NOT_LOGGED_IN'
    if (/沙箱不可达|沙箱当前不可用|沙箱暂不可用/.test(t)) return 'SANDBOX_UNAVAILABLE'
    if (/执行失败|未产出文件|回放失败|无候选/.test(t)) return 'SKILL_EXEC_FAILED'
    if (/模型|LLM|连接失败|网络|HTTP \d/.test(t)) return 'MODEL_ERROR'
    return 'TASK_FAILED'
  }
}
