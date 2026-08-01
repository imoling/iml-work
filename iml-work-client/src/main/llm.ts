import { configGet, configSet } from './db'
import { getAdminBaseUrl } from './http'
import { recordLlmUsage } from './automation-runtime'
import { swallow } from './util'
import { DEV_CORP_GATEWAY_KEY } from '../shared/corp-key'
import type { CoreMessage, CoreToolCall } from '../shared/core-protocol'
import type { LlmToolSchema } from './tool-registry'
import { stripToolCallArtifacts } from './llm-parse'

export interface LlmConfig {
  mode: string;
  apiMode: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

/**
 * 直连 / 中转 / Anthropic 三种模式统一的一次性 LLM 调用；200s 超时（≥ 网关长请求上限），返回文本内容。
 *
 * opts.temperature：确定性场景（技能路由、驱动脚本生成）传 0，避免同一输入答案漂移。
 * opts.longRunning：**生成类任务**（写 PPT/Word 的 Python 脚本、长文）——告诉网关"这次要等久一点"。
 *   为什么必须由调用方声明、不能靠网关猜：生成类任务的特征是**输入短、输出长**
 *   （实测 728 字符的提示词让模型写出 4300+ tokens 的脚本，耗时 33s）。
 *   按输入长度估超时必然误判 —— 短输入被判成"该快速失败"，然后在模型答完前掐断。
 */
export async function callLlm(prompt: string, cfg: LlmConfig, opts?: { temperature?: number; longRunning?: boolean }): Promise<string> {
  const mode = cfg.mode || 'direct'
  const apiMode = cfg.apiMode || 'chat'
  const baseUrl = cfg.baseUrl || ''
  const apiKey = cfg.apiKey || ''
  const modelName = cfg.modelName || ''

  console.log('[callLlm] ===== LLM REQUEST =====')
  console.log('[callLlm] mode:', mode, '| apiMode:', apiMode)
  console.log('[callLlm] baseUrl:', baseUrl)
  console.log('[callLlm] modelName:', modelName)
  console.log('[callLlm] apiKey prefix:', apiKey?.substring(0, 10) + '...')

  const cleanBaseUrl = cleanModelBase(baseUrl)

  let targetUrl = ''
  let headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  let body: any = {}
  const temp = opts?.temperature

  if (mode === 'proxy') {
    // Enterprise unified gateway (admin backend /api/v1/model/chat). Accept the
    // base URL with or without a trailing /chat so either form works.
    // 用户常把「后端地址」直接当网关地址填（http://host:8081，少了 /api/v1/model）——
    // gatewayChatUrl 里对裸源站自动补全网关路径，别让一个路径差把人挡在门外
    targetUrl = gatewayChatUrl(cleanBaseUrl)
    headers['Authorization'] = `Bearer ${apiKey}`
    body = {
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      ...(temp !== undefined ? { temperature: temp } : {}),
      // 网关据此放宽上游超时（生成类任务 30~60s 是常态）。非网关模式不传（厂商 API 不认这个字段）。
      ...(opts?.longRunning ? { iml_long_running: true } : {})
    }
  } else {
    if (apiMode === 'anthropic') {
      targetUrl = `${cleanBaseUrl}/v1/messages`
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      body = {
        model: modelName,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
        ...(temp !== undefined ? { temperature: temp } : {})
      }
    } else {
      targetUrl = `${cleanBaseUrl}/chat/completions`
      headers['Authorization'] = `Bearer ${apiKey}`
      body = {
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        ...(temp !== undefined ? { temperature: temp } : {})
      }
    }
  }

  console.log('[callLlm] >>> Final targetUrl:', targetUrl)

  let response: Response
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // 生成类任务（写 PPT/Word 的 Python 脚本）实测 30~60s 是常态，模型偶尔更久。
      // 必须 ≥ 网关的长请求上限（180s），否则网关还在耐心等、客户端已经先断了 —— 白等一场。
      signal: AbortSignal.timeout(200000)
    })
  } catch (networkErr: any) {
    console.error('[callLlm] Network/fetch error:', networkErr.message)
    throw new Error(`网络连接失败: ${networkErr.message}（请确认服务地址可访问）`)
  }

  console.log('[callLlm] <<< HTTP status:', response.status, response.statusText)

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    console.error('[callLlm] Error response body:', errBody)
    throw new Error(`HTTP ${response.status}: ${errBody || response.statusText}`)
  }

  const resData: any = await response.json()
  console.log('[callLlm] <<< Response JSON keys:', Object.keys(resData))

  // 登记**真实**用量与**真正服务本次请求的上游**。
  // 以前这两样全被丢掉：审计里的 token 是「字符数 ÷ 2」的估算，provider/model 记成 GATEWAY/corp-default
  // ——而单价按厂商/模型配置，永远匹配不上 → 计费覆盖 0%、费用恒为 ¥0.00。
  try {
    const u = resData.usage || {}
    recordLlmUsage({
      // OpenAI 兼容用 prompt_tokens/completion_tokens；Anthropic 原生用 input_tokens/output_tokens
      prompt: Number(u.prompt_tokens ?? u.input_tokens ?? 0),
      completion: Number(u.completion_tokens ?? u.output_tokens ?? 0),
      vendor: response.headers.get('X-Relay-Vendor') || '',
      model: response.headers.get('X-Relay-Model') || '',
    })
  } catch (e) { swallow(e, 'llm-usage') }

  // 空内容一律按失败抛错，绝不把原始响应 JSON 当答案返回——
  // 曾用 `content || JSON.stringify(resData)` 兜底，模型偶发返回空 content（如推理耗尽输出预算）时，
  // 整段上游 API JSON（id/usage/system_fingerprint…）直接吐到用户答案里（留出测量实锤 ga03）。
  // 抛错走调用方既有的失败路径（技能合成回退直通、问答兜底如实报"连接失败"），至少诚实且不吓人。
  const content = (apiMode === 'anthropic' && mode !== 'proxy')
    ? resData.content?.[0]?.text
    : resData.choices?.[0]?.message?.content
  if (!content || !String(content).trim()) {
    console.error('[callLlm] 空响应内容，finish_reason:', resData.choices?.[0]?.finish_reason ?? resData.stop_reason ?? '?')
    throw new Error('模型返回了空内容（可能是输出预算耗尽或上游异常），请重试')
  }
  return content
}

// ============================================================================
// function-calling 调用（新执行内核 AgentCore 的模型层）
//
// 为什么不改 callLlm 而是新增：callLlm 的契约是「返回文本，空内容即失败」，而 function-calling
// 的正常响应恰恰是 content=null + tool_calls 有值——把它塞进 callLlm 必然要在热路径上加分支，
// 存量几十个调用点都得跟着重新验证。新增一个函数，两条路各自清晰。
//
// 网关侧零改动：ModelProxyService 用 Map<String,Object> **全字段透传**（只摘内部标记 iml_long_running、
// 覆盖 model、按需补 max_tokens），所以 tools/tool_choice 原样到达厂商、tool_calls 原样带回。
// ============================================================================

/** 上游不支持 function-calling —— 调用方据此降级到 agent-loop.ts 的文本 ReAct。 */
export class ToolsUnsupportedError extends Error {
  constructor(message: string) { super(message); this.name = 'ToolsUnsupportedError' }
}

export interface LlmTurnResult {
  /** 助手这一轮说的话；只调工具不说话时为空串。 */
  text: string
  toolCalls: CoreToolCall[]
  finishReason: string
}

/** 模型基址规范化：去尾斜杠与已带的具体端点路径（callLlm 与 callLlmTools 共用，勿各写一份）。 */
function cleanModelBase(baseUrl: string): string {
  let s = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  if (s.endsWith('/chat/completions')) s = s.slice(0, -'/chat/completions'.length)
  else if (s.endsWith('/v1/messages')) s = s.slice(0, -'/v1/messages'.length)
  return s
}

/** 企业网关的 /chat 端点。裸源站（用户把后端地址当网关填）自动补全网关路径。 */
function gatewayChatUrl(cleanBase: string): string {
  let gw = cleanBase.endsWith('/chat') ? cleanBase.slice(0, -'/chat'.length) : cleanBase
  try { if (new URL(gw).pathname === '/') gw = gw.replace(/\/$/, '') + '/api/v1/model' } catch (e) { swallow(e, 'gw-normalize') }
  return `${gw}/chat`
}

/** 能力探测缓存键：按模型名记住上游认不认 tools，避免每轮都去试错。 */
function toolsCapKey(modelName: string): string { return `llm-tools-capable:${modelName}` }

/** 该模型是否已被探测为不支持 function-calling（调用方可据此直接走降级路径）。 */
export function toolsKnownUnsupported(cfg: LlmConfig): boolean {
  return configGet(toolsCapKey(cfg.modelName || '')) === '0'
}

/** 清除能力探测结论（换了网关/上游通道后重新探测）。 */
export function resetToolsCapability(cfg: LlmConfig): void {
  configSet(toolsCapKey(cfg.modelName || ''), '')
}

/** 内部消息 → OpenAI 兼容 messages。notice 是展示专用标记，**绝不回灌给模型**。 */
function toOpenAiMessages(messages: CoreMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === 'notice') continue
    if (m.role === 'tool') {
      // tool_call_id 必须原样回填：上游据此把结果对回它自己发起的那次调用。
      out.push({ role: 'tool', tool_call_id: m.toolCallId || '', content: m.content })
      continue
    }
    if (m.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: m.content || null }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          // argsRaw 优先：把模型原样发出的参数串回灌，避免我们解析→再序列化导致的细微差异
          // （某些托管 chat 模板会对不上而 400）。
          function: { name: tc.name, arguments: tc.argsRaw ?? JSON.stringify(tc.args) },
        }))
      }
      out.push(msg)
      continue
    }
    out.push({ role: m.role, content: m.content })
  }
  return out
}

/** 解析上游返回的 tool_calls。参数解析失败不丢弃调用——保留 argsRaw，让内核回报给模型自纠。 */
function parseToolCalls(raw: unknown): CoreToolCall[] {
  if (!Array.isArray(raw)) return []
  const out: CoreToolCall[] = []
  for (let i = 0; i < raw.length; i++) {
    const tc = raw[i] as any
    const name = tc?.function?.name
    if (!name || typeof name !== 'string') continue
    const argsRaw = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : ''
    let args: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(argsRaw || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
    } catch (e) { swallow(e, 'llm-toolcall-args') }
    // id 缺失时合成一个：tool_call_id 是关联调用与结果的唯一键，缺了整轮就串不起来。
    out.push({ id: String(tc?.id || `call_${Date.now()}_${i}`), name, args, argsRaw })
  }
  return out
}

/**
 * 一次带工具的模型调用。返回助手文本 + 它要发起的工具调用。
 *
 * 仅支持 OpenAI 兼容协议（企业网关 proxy 模式与 direct/chat 模式）。Anthropic **原生** messages 协议
 * 的工具格式不同（tool_use 内容块），这里不做转换而是抛 ToolsUnsupportedError 走降级——
 * 我们默认走 proxy 网关，Anthropic 直连是少数配置，不值得为它引入第二套消息形状。
 */
export async function callLlmTools(
  messages: CoreMessage[],
  tools: LlmToolSchema[],
  cfg: LlmConfig,
  opts?: { temperature?: number; longRunning?: boolean },
): Promise<LlmTurnResult> {
  const mode = cfg.mode || 'direct'
  const apiMode = cfg.apiMode || 'chat'
  const modelName = cfg.modelName || ''

  if (mode !== 'proxy' && apiMode === 'anthropic') {
    throw new ToolsUnsupportedError('Anthropic 原生协议未接入 function-calling，本轮降级')
  }
  if (toolsKnownUnsupported(cfg)) {
    throw new ToolsUnsupportedError(`模型 ${modelName} 已探测为不支持 function-calling`)
  }

  const cleanBase = cleanModelBase(cfg.baseUrl || '')
  const targetUrl = mode === 'proxy' ? gatewayChatUrl(cleanBase) : `${cleanBase}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.apiKey || ''}`,
  }
  const body: Record<string, unknown> = {
    model: modelName,
    messages: toOpenAiMessages(messages),
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts?.longRunning ? { iml_long_running: true } : {}),
  }

  console.log(`[callLlmTools] ${mode}/${apiMode} → ${targetUrl} | model=${modelName} | tools=${tools.length} | msgs=${messages.length}`)

  let response: Response
  try {
    response = await fetch(targetUrl, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(200000),
    })
  } catch (networkErr: any) {
    throw new Error(`网络连接失败: ${networkErr.message}（请确认服务地址可访问）`)
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    // 能力探测：4xx 且错误体点名 tool/function → 判定该模型不认工具，记下来并降级。
    // 只认 4xx：5xx 与超时是上游临时故障，据此永久标记"不支持"会误杀（下次就再也不试了）。
    if (response.status >= 400 && response.status < 500 && /tool|function/i.test(errBody)) {
      configSet(toolsCapKey(modelName), '0')
      console.warn(`[callLlmTools] 模型 ${modelName} 拒绝 tools 参数，标记为不支持并降级：${errBody.slice(0, 200)}`)
      throw new ToolsUnsupportedError(`上游拒绝 tools 参数：HTTP ${response.status}`)
    }
    throw new Error(`HTTP ${response.status}: ${errBody || response.statusText}`)
  }

  const resData: any = await response.json()
  configSet(toolsCapKey(modelName), '1')

  try {
    const u = resData.usage || {}
    recordLlmUsage({
      prompt: Number(u.prompt_tokens ?? u.input_tokens ?? 0),
      completion: Number(u.completion_tokens ?? u.output_tokens ?? 0),
      vendor: response.headers.get('X-Relay-Vendor') || '',
      model: response.headers.get('X-Relay-Model') || '',
    })
  } catch (e) { swallow(e, 'llm-tools-usage') }

  const choice = resData.choices?.[0]
  const msg = choice?.message || {}
  const toolCalls = parseToolCalls(msg.tool_calls)
  const rawText = typeof msg.content === 'string' ? msg.content : ''
  // 剥掉泄漏的工具调用标记：整段都是标记时会剥成空串，下面按"空回复"处理并重试，
  // 绝不把 `<||DSML|| invoke name="python">…` 这种内部格式当答案甩给用户（实测泄漏过）。
  const text = stripToolCallArtifacts(rawText)
  if (rawText && !text.trim() && !toolCalls.length) {
    console.warn('[callLlmTools] 模型把工具调用当文本输出且无有效正文，按空回复处理：', rawText.slice(0, 200))
  }

  // 与 callLlm 的关键差异：content 为空但有 tool_calls 是**正常**的一轮，不能当失败抛。
  // 两者都空才是真异常（输出预算耗尽/上游抽风）。
  if (!text.trim() && !toolCalls.length) {
    throw new Error('模型返回了空内容且未调用任何工具（可能是输出预算耗尽或上游异常），请重试')
  }
  return { text, toolCalls, finishReason: String(choice?.finish_reason || '') }
}

/** 当前生效的 LLM 配置（本地 config 覆盖 → 默认走本地后端模型中转站）。 */
export function currentLlmConfig(): LlmConfig {
  return {
    mode: configGet('llm-connection-mode') || 'proxy',
    apiMode: configGet('llm-api-mode') || 'chat',
    baseUrl: configGet('llm-base-url') || (getAdminBaseUrl() + '/api/v1/model'),
    apiKey: configGet('llm-api-key') || DEV_CORP_GATEWAY_KEY,
    modelName: configGet('llm-model-name') || 'deepseek-chat',
  }
}
