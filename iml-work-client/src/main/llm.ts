import nodeFs from 'fs'
import nodePath from 'path'
import { configGet, configSet } from './db'
import { getAdminBaseUrl } from './http'
import { recordLlmUsage } from './automation-runtime'
import { swallow } from './util'
import { DEV_CORP_GATEWAY_KEY } from '../shared/corp-key'
import { currentTurnImageIdx } from '../shared/message-images'
import {
  TIER_MODELS_KEY, parseTierModels, type TierKey,
  PROVIDERS_KEY, DEFAULT_MODEL_KEY, parseProviders, migrateLegacyProvider, resolveSelection,
} from '../shared/llm-service'
import { convModelKey } from '../shared/llm-service'
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

/** 工具循环里单次模型调用的超时与重试（依据见 callLlmTools 内的实测数据注释）。 */
const TOOLS_CALL_TIMEOUT_MS = 90_000
const TOOLS_CALL_RETRIES = 2

export interface LlmTurnResult {
  /** 助手这一轮说的话；只调工具不说话时为空串。 */
  text: string
  toolCalls: CoreToolCall[]
  finishReason: string
  /** 思维模式模型的思维链原文；调用方须原样存进 assistant 消息，下一轮回传（见 CoreMessage.reasoningContent）。 */
  reasoningContent?: string
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

/**
 * 企业网关基址（到 /api/v1/model 为止，不含具体端点）。
 *
 * 多媒体生成（图片/视频）**恒走企业网关**，不跟随对话的模型配置：即便员工在设置里
 * 自配了外部模型（mode=self），生成接口也不能用他自己的 key 打——厂商密钥只在网关侧，
 * 是安全红线。所以这里只认「代理模式下配置的网关地址」，其余一律回落到后端地址。
 */
export function corpGatewayBase(): string {
  const proxy = (configGet('llm-connection-mode') || 'proxy') === 'proxy'
  const configured = proxy ? (configGet('llm-base-url') || '') : ''
  let gw = cleanModelBase(configured || (getAdminBaseUrl() + '/api/v1/model'))
  if (gw.endsWith('/chat')) gw = gw.slice(0, -'/chat'.length)
  try { if (new URL(gw).pathname === '/') gw = gw.replace(/\/$/, '') + '/api/v1/model' } catch (e) { swallow(e, 'gw-base') }
  return gw
}

/**
 * 网关鉴权凭证，优先级：显式 corp-key（自配覆盖）→ 员工登录 JWT（零配置主路径）→ 开发默认。
 * 自配模式下 llm-api-key 存的是**用户自己的厂商密钥**，不能拿来打网关。
 * 登录 JWT 由后端同一 JwtService 签发，网关直接认——员工登录即获得模型权限，无需手填任何密钥。
 */
export function corpGatewayKey(): string {
  const proxy = (configGet('llm-connection-mode') || 'proxy') === 'proxy'
  // 哨兵值视同未设置：旧版设置页保存时会把开发默认 key 落盘，若当真会永远挡住登录 JWT。
  const explicit = configGet('llm-api-key')
  const custom = proxy && explicit && explicit !== DEV_CORP_GATEWAY_KEY ? explicit : ''
  return custom || configGet('auth-token') || DEV_CORP_GATEWAY_KEY
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

// ── 图片出站 ────────────────────────────────────────────────────────────────
/** 单张图上限：超过就跳过（转 base64 后体积还要涨三分之一，太大直接把请求撑爆）。 */
const IMAGE_MAX_BYTES = 6 * 1024 * 1024
/** 一条消息最多带几张：视觉模型按张收费，一次十几张既慢又贵。 */
const IMAGE_MAX_PER_MSG = 4

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
}

/** 读图转 data URL；读不到/过大/非图片一律返回空串，由调用方跳过（绝不因为一张图让整轮失败）。 */
function imageDataUrl(absPath: string): string {
  try {
    const ext = nodePath.extname(absPath).toLowerCase()
    const mime = IMAGE_MIME[ext]
    if (!mime) return ''
    const st = nodeFs.statSync(absPath)
    if (!st.isFile() || st.size > IMAGE_MAX_BYTES) return ''
    return `data:${mime};base64,${nodeFs.readFileSync(absPath).toString('base64')}`
  } catch { return '' }
}

/** 内部消息 → OpenAI 兼容 messages。notice 是展示专用标记，**绝不回灌给模型**。 */
function toOpenAiMessages(messages: CoreMessage[]): Record<string, unknown>[] {
  const lastImageIdx = currentTurnImageIdx(messages)
  const out: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === 'notice') continue
    if (m.role === 'tool') {
      // tool_call_id 必须原样回填：上游据此把结果对回它自己发起的那次调用。
      out.push({ role: 'tool', tool_call_id: m.toolCallId || '', content: m.content })
      continue
    }
    if (m.role === 'user' && m.imagePaths?.length) {
      const idx = messages.indexOf(m)
      if (idx !== lastImageIdx) {
        // 历史轮次的图片：只留一句占位，模型此前的观察已经在对话里了
        out.push({ role: 'user', content: `${m.content}\n（本轮附带的 ${m.imagePaths.length} 张图片已在此前轮次分析过，此处省略）` })
        continue
      }
      const parts: Record<string, unknown>[] = []
      if (m.content) parts.push({ type: 'text', text: m.content })
      let used = 0
      for (const p of m.imagePaths) {
        if (used >= IMAGE_MAX_PER_MSG) break
        const url = imageDataUrl(p)
        if (!url) continue
        parts.push({ type: 'image_url', image_url: { url } })
        used++
      }
      // 一张都没读成 → 退回纯文本，并如实告知模型（免得它以为自己看过图）
      if (!used) {
        out.push({ role: 'user', content: `${m.content}\n（附带的图片未能读取，请如实告知用户看不到图片内容，不要臆测）` })
      } else {
        out.push({ role: 'user', content: parts })
      }
      continue
    }
    if (m.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: m.content || null }
      // 思维模式模型要求把上一轮的思维链原样带回，否则下一轮 400（见 CoreMessage.reasoningContent）
      if (m.reasoningContent) msg.reasoning_content = m.reasoningContent
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
  opts?: { temperature?: number; longRunning?: boolean; abort?: AbortSignal },
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
  // 带图片时请求**视觉档别名**：网关按 modelType=vision 路由到能看图的通道。
  // 与 deep-research 发 corp-reasoning 同一模式（用途 → 档位）。别名定义的唯一来源是后端
  // ModelTiers；没配视觉通道时网关 fail-open 回默认池——图会被忽略但不会把请求打挂。
  // 直连模式不换：厂商不认这个别名，用户配的什么模型就发什么。
  // 与出站规则同源：只有**本轮**真的会发图，才切视觉档（否则一次贴图会把整个会话锁死在视觉档）
  const hasImages = currentTurnImageIdx(messages) >= 0
  const effectiveModel = (hasImages && mode === 'proxy') ? 'corp-vision' : modelName
  if (hasImages && mode === 'proxy') console.log(`[callLlmTools] 本轮含图片 → 请求视觉档 ${effectiveModel}`)

  const body: Record<string, unknown> = {
    model: effectiveModel,
    messages: toOpenAiMessages(messages),
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts?.longRunning ? { iml_long_running: true } : {}),
  }

  // 出站规模一并打点：思维模式模型要求回传 reasoning_content，多轮下它会显著抬高输入体量，
  // 而"慢"到底慢在上下文还是上游，不打点就只能猜。
  const outChars = JSON.stringify(body.messages).length
  const reasonChars = messages.reduce((n, m) => n + (m.reasoningContent?.length || 0), 0)
  console.log(`[callLlmTools] ${mode}/${apiMode} → ${targetUrl} | model=${modelName} | tools=${tools.length} | msgs=${messages.length} | out=${outChars}字符(含思维链 ${reasonChars})`)

  // 超时与重试：实测企业任务集 17 次调用 p50 7.2s / p90 10s / max 13s，而原来的 200s 上限
  // **仍然会撞**——那说明是上游偶发卡死，不是"慢"。干等 200s 毫无收益：三次跑每次都有
  // 1~2 个任务栽在这，直接吃掉 pass rate。改成 90s（p90 的 9 倍，正常请求毫发无损）判定卡死并重试。
  //
  // 重试是**安全**的：模型调用本身无副作用——本轮工具尚未执行，卡住的是模型在想。
  // 只重试超时；4xx/5xx 与协议错误立刻抛出（重试它们只是把同一个错误再犯一遍）。
  const t0 = Date.now()
  let response: Response | null = null
  for (let attempt = 0; ; attempt++) {
    try {
      // 超时 + 用户中止两个信号合流：光有超时的话，用户点了停止仍要干等模型答完
      //（一轮 90s、还会重试，实测点停止后又跑了好几分钟）。
      const sig = opts?.abort
        ? AbortSignal.any([AbortSignal.timeout(TOOLS_CALL_TIMEOUT_MS), opts.abort])
        : AbortSignal.timeout(TOOLS_CALL_TIMEOUT_MS)
      response = await fetch(targetUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: sig })
      break
    } catch (networkErr: any) {
      const msg = networkErr?.message || String(networkErr)
      // 用户中止**不重试**：那不是网络抖动，是人明确喊停——重试等于当没听见
      if (opts?.abort?.aborted) throw new Error('用户已中止本次任务')
      const timedOut = /abort|timeout/i.test(msg)
      if (!timedOut || attempt >= TOOLS_CALL_RETRIES) {
        throw new Error(`网络连接失败: ${msg}（请确认服务地址可访问）`)
      }
      console.warn(`[callLlmTools] 第 ${attempt + 1} 次调用 ${TOOLS_CALL_TIMEOUT_MS / 1000}s 未返回（上游疑似卡死），重试…`)
    }
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

  const usage = resData.usage || {}
  console.log(`[callLlmTools] ← ${Date.now() - t0}ms | prompt=${usage.prompt_tokens ?? '?'} completion=${usage.completion_tokens ?? '?'} reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? '?'}`)

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
  // reasoning_content：DeepSeek V4 全系等思维模式模型带回的思维链。上游要求多轮把它原样传回，
  // 漏了下一轮就是 400 —— 多轮 function-calling（企业系统操作十几轮）第一次工具调用后即断。
  const reasoningContent = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : ''
  return { text, toolCalls, finishReason: String(choice?.finish_reason || ''), ...(reasoningContent ? { reasoningContent } : {}) }
}

// ── 会话级模型选择 ────────────────────────────────────────────────────────────
// composer 的模型选择器把「这个会话用哪个模型」写在这里。**只存 modelName，不存密钥**：
// 密钥与端点仍只有 llm-api-key / llm-base-url 一份（SECURE_KEYS 加密落盘），
// 每会话复制一份密钥快照等于把密钥散布到 N 个明文键里，是安全倒退。
//
// 因此本层支持的是「同一服务下换模型」：
// - gateway：写网关的**类型别名**（如 corp-reasoning），由管理端标注的通道类型路由——
//   deep-research 已在用这套别名，无需 profile 列表就能给出"快/强"档位；
// - network / local：写同一 baseUrl 下的另一个 model id（设置页「拉取列表」的结果）。
// 跨服务切换（换 baseUrl + 换密钥）要等模型配置列表化，届时这里改为查 profile 表。
/** 写入会话选择；传空串即"回到全局默认"（picker 取消选择走同一入口，不另设清除函数）。 */
export function setConvModel(convId: string, modelName: string): void {
  if (!convId) return
  configSet(convModelKey(convId), (modelName || '').trim())
}

export function getConvModel(convId: string): string {
  if (!convId) return ''
  return (configGet(convModelKey(convId)) || '').trim()
}

/**
 * 当前生效的 LLM 配置。三级优先级（自上而下覆盖）：
 *
 *   ① 用途专用 —— 调用方在拿到本函数结果后按用途覆盖（如 deep-research 的 researchCfg
 *      换推理档）。用途是**能力要求**，必须赢过用户偏好：否则用户在会话里挑了个小窗口
 *      快档模型，一跑深度调研就直接崩在规划环节。
 *   ② 会话选择 —— 传 convId 时读该会话的模型选择（composer picker 写入）。
 *   ③ 全局默认 —— 设置页保存的配置；缺省走本地后端模型中转站。
 *
 * 不传 convId 即为"无会话"入口（IM 机器人等非对话触发），如实回退到全局默认。
 */
export function currentLlmConfig(opts?: { convId?: string }): LlmConfig {
  const mode = configGet('llm-connection-mode') || 'proxy'
  const base: LlmConfig = {
    mode,
    apiMode: configGet('llm-api-mode') || 'chat',
    baseUrl: configGet('llm-base-url') || (getAdminBaseUrl() + '/api/v1/model'),
    // 中转站模式：显式 key → 登录 JWT（零配置主路径）→ 开发默认；自配模式仍用用户自己的厂商密钥。
    apiKey: mode === 'proxy' ? corpGatewayKey() : (configGet('llm-api-key') || DEV_CORP_GATEWAY_KEY),
    modelName: configGet('llm-model-name') || 'deepseek-chat',
  }
  const picked = opts?.convId ? getConvModel(opts.convId) : ''
  // 解析交给 shared 的纯函数：顺序敏感（先档位后引用，理由见 resolveSelection 注释），
  // 而且这段逻辑错了是静默的——发出去才 400/401，所以用单测钉住而不是散在这里。
  return resolveSelection(base, picked, {
    providers: llmProviders(),
    tiers: parseTierModels(configGet(TIER_MODELS_KEY)),
    defaultRef: configGet(DEFAULT_MODEL_KEY) || '',
  }) as LlmConfig
}

/** 自配侧已登记的提供商；库里没有就从旧的平铺配置迁一条出来——
 *  老用户升级后设置页不能显示"一个提供商都没有"，而对话其实还在用那套旧配置。 */
export function llmProviders() {
  const list = parseProviders(configGet(PROVIDERS_KEY))
  if (list.length) return list
  return migrateLegacyProvider({
    mode: configGet('llm-connection-mode') || 'proxy',
    baseUrl: configGet('llm-base-url') || '',
    apiKey: configGet('llm-api-key') || '',
    modelName: configGet('llm-model-name') || '',
    apiMode: configGet('llm-api-mode') || 'chat',
    vendorKey: configGet('llm-vendor-key') || 'legacy',
  })
}

/** 按**用途**取模型：用途专用层（深度调研/上下文整理）用它拿到对应档位的真实模型。 */
export function tierModel(key: TierKey): string {
  return parseTierModels(configGet(TIER_MODELS_KEY))[key] || ''
}
