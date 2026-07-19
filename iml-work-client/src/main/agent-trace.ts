// Agent Trace 采集：把一次 agent:send-message 任务的全链路轨迹（技能/本体/联网/模型 span、
// 来源、token、风险等级、状态）封装为一个共享对象，任务结束时上报管理端审计追溯。
// 从 main.ts 的 agent:send-message 闭包内联状态抽出——把 traceSpans/traceSkill/... 收敛成一个
// 可传递的实例，便于把编排子步骤（本体钩子/技能执行）拆成独立函数而不丢失 trace 上下文。
import os from 'os'
import { configGet } from './db'
import { afetch, getAdminBaseUrl } from './http'
import { swallow } from './util'
import { currentUsage } from './automation-runtime'
import type { LlmConfig } from './llm'

// submitTrace 用到的任务元信息（与 agent:send-message 的 data 结构兼容）。
export interface AgentTaskMeta {
  content: string
  expertName: string
  llmConfig: LlmConfig
}

// 审计轨迹三类结构化子项（各编排步骤 push 进来，submit 时 JSON 序列化上报）。
/** 执行时间线节点：atMs=相对任务起点的偏移，durationMs=耗时，detail=输入/输出摘要（人话），
 *  pid=父节点 id（多跳补查等子步挂到父检索下，管理端按树渲染）。旧扁平推送兼容不变。 */
/** 执行时间线节点（生产级 Trace 要素）：
 *  stage=生命周期阶段（接收→理解→检索→执行→确认→作答→输出，围绕状态迁移建模而非函数调用）；
 *  model/tokens=LLM 节点的模型与本次调用 token 增量；tool=工具节点的名称与参数摘要；
 *  status 含 hitl 语义（确认节点用 ok/warn 表达确认/取消，等待时长即 durationMs）；error 走 detail。 */
export interface TraceSpan {
  type: string; name: string; status?: string; detail?: string
  atMs?: number; durationMs?: number; id?: string; pid?: string; io?: boolean
  stage?: string
  model?: string
  tokens?: { in: number; out: number }
  tool?: { name: string; args?: string }
}
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

  // 节点完整输入/输出（执行轨迹点开查看 + 管线调优定位）。与 spans 分开上报、后端独立表存储——
  // 完整 prompt/素材可达几十 KB，进 agent_trace.spans 会把审计热表撑爆（性能规则）。
  payloads: { spanId: string; name: string; input: string; output: string }[] = []

  /** 给某个 span 挂完整输入/输出。单侧截 64KB（超限打标注明原始长度），单任务最多 40 个节点。 */
  attachIo(spanId: string, name: string, input: string, output: string): void {
    if (!spanId || this.payloads.length >= 40) return
    const cap = (s: string) => { const t = s || ''; return t.length > 65536 ? t.slice(0, 65536) + `\n……（已截断，原文 ${t.length} 字）` : t }
    this.payloads.push({ spanId, name, input: cap(input), output: cap(output) })
    const sp = this.spans.find(s => s.id === spanId)
    if (sp) sp.io = true   // 时间线据此显示「查看输入/输出」入口
  }

  /** 计时 span：begin 记起点偏移，end 补耗时与输入/输出摘要——执行时间线"脉络翔实"的数据源。
   *  返回的 id 可作子步的 pid（如多跳补查挂在父检索下）。推入的对象按引用原地补全，submit 时序列化。 */
  beginSpan(type: string, name: string, opts?: { pid?: string; stage?: string; model?: string; tool?: { name: string; args?: string } }): { id: string; end: (status?: string, detail?: string, extra?: { tokens?: { in: number; out: number } }) => void } {
    const id = 's' + (this.spans.length + 1) + '-' + Date.now().toString(36)
    const span: TraceSpan = { type, name, status: 'run', atMs: Date.now() - this.start, id, ...(opts || {}) }
    this.spans.push(span)
    const t0 = Date.now()
    return {
      id,
      end: (status = 'ok', detail?: string, extra?: { tokens?: { in: number; out: number } }) => {
        span.status = status
        span.durationMs = Date.now() - t0
        if (detail) span.detail = detail.slice(0, 300)
        if (extra?.tokens && (extra.tokens.in > 0 || extra.tokens.out > 0)) span.tokens = extra.tokens
      }
    }
  }

  /** 生命周期锚点②「理解任务」：路由决策落定时调用——时间线要能回答"系统把这个任务理解成了什么"。 */
  markRoute(understanding: string, detail?: string): void {
    this.spans.push({ type: 'route', name: `理解任务·${understanding}`, stage: '理解', status: 'ok', atMs: Date.now() - this.start, ...(detail ? { detail: detail.slice(0, 300) } : {}) })
  }
  id = ''   // 后端保存后回填的 Trace id，随回答返回给渲染层（供 👍/👎 精确回填）

  // 任务编排：多子任务同属一次用户请求时，暂缓各子任务各自上报，改由编排器最后合并成一条审计。
  // deferSubmit=true 期间 submit() 只把 {status,summary} 记入 deferred 缓冲，不真正 POST。
  deferSubmit = false
  deferred: { status: string; summary: string }[] = []

  constructor(private data: AgentTaskMeta, private expertId: string, private userNickname: string) {
    // 生命周期锚点①「接收任务」：时间线树根，用户原话完整进 payload（点开可看）
    this.spans.push({ type: 'task', name: '接收任务', stage: '接收', status: 'ok', atMs: 0, durationMs: 0, id: 'recv' })
    this.attachIo('recv', '接收任务', (data as { content?: string })?.content || '', '')
  }

  async submit(finalContent: string, status: string, summary: string): Promise<void> {
    if (this.deferSubmit) { this.deferred.push({ status, summary }); return }
    try {
      const cfg = this.data.llmConfig || {} as LlmConfig
      const url = (cfg.baseUrl || '').toLowerCase()
      // 上游归属：走中转站时以**网关回传的真实上游**为准（X-Relay-Vendor/Model）。
      // 只记 'GATEWAY' + 请求别名（corp-default）的话，与按厂商/模型配置的单价永远匹配不上
      // ——这就是"计费覆盖 0%、费用恒为 ¥0.00"的直接原因。网关没回传时才退回按 baseUrl 猜。
      const usage = currentUsage()
      const provider = (usage?.vendor)
        || (cfg.mode === 'proxy' ? 'GATEWAY'
        : url.includes('deepseek') ? 'DEEPSEEK' : url.includes('agnes') || url.includes('apihub') ? 'AGNES'
        : url.includes('openai') ? 'OPENAI' : url.includes('moonshot') ? 'MOONSHOT'
        : url.includes('dashscope') ? 'QWEN' : url.includes('localhost') || url.includes('11434') ? 'OLLAMA' : 'DIRECT')
      const modelName = usage?.model || cfg.modelName || ''
      // 悬空 span 清理：仍是 run 的（异常路径没走到 end）按任务终态落定，时间线不留"进行中"僵尸
      for (const s of this.spans) if (s.status === 'run') s.status = status === 'SUCCESS' ? 'ok' : 'warn'
      // 生命周期锚点④「结果输出」：所有路径（问答/技能/本体/拦截）统一在提交时落点
      this.spans.push({ type: 'task', name: '结果输出', stage: '输出', status: status === 'SUCCESS' ? 'ok' : 'warn', atMs: Date.now() - this.start, detail: `${status} · 回复 ${String(finalContent || '').length} 字` })
      // 作答链路已用 beginSpan 埋过带耗时的「模型作答」节点时不再追加，避免时间线出现重复条目
      const hasModelSpan = this.spans.some(s => s.type === 'model' && s.name.startsWith('模型作答'))
      const spans = hasModelSpan ? [...this.spans]
        : [...this.spans, { type: 'model', name: `模型作答·${modelName}`, status: status === 'SUCCESS' ? 'ok' : 'warn' }]
      const risk = status === 'BLOCKED' ? 'MEDIUM' : (this.webSearch || this.skill) ? 'MEDIUM' : 'LOW'
      const payload = {
        clientId: (configGet('clientId') || os.hostname()), deviceHost: os.hostname(),
        appVersion: 'v1.0.3', workspace: 'iML Work Workspace',
        userId: 'user-' + this.userNickname, userNickname: this.userNickname, expertId: this.expertId, expertName: this.data.expertName,
        department: '', role: '', sessionId: 'sess-' + String(Date.now()).slice(-6),
        userQuestion: this.data.content,
        modelName, modelProvider: provider, connectionMode: cfg.mode || 'direct',
        // 真实 usage（网关回传，按本次任务的所有模型调用累加）。拿不到才退回字符数估算——
        // 早先这里**永远**在估算（this.tokens 声明了却没人赋值），审计里的 token 全是假的。
        promptTokens: usage?.prompt || Math.ceil((this.data.content || '').length / 2),
        completionTokens: usage?.completion || Math.ceil((finalContent || '').length / 2),
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
      // 节点完整输入/输出随后补报（独立表，不进热表）；失败只损失点开查看，不影响主审计
      if (tr.ok && this.id && this.payloads.length) {
        try {
          await afetch(`${getAdminBaseUrl()}/api/v1/traces/${this.id}/payloads`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.payloads)
          })
        } catch (e) { swallow(e, 'trace-payloads') }
      }
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
