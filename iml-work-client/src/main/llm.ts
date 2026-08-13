import nodeFs from 'fs'
import nodePath from 'path'
import { configGet, configSet } from './db'
import { getAdminBaseUrl } from './http'
import { recordLlmUsage, noteLlmCallStart, noteLlmStreamDelta } from './automation-runtime'
import { swallow, friendlyNetError } from './util'
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
import { consumeSseChat, aggregateSseText, toChatCompletionJson, type SseDeltaHandler } from './llm-stream'

export interface LlmConfig {
  mode: string;
  apiMode: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

/**
 * 直连 / 中转 / Anthropic 三种模式统一的一次性 LLM 调用，返回文本内容。
 * 中转（proxy）模式走网关 SSE 流式：增量静默 90s 判死 + 总时长兜底（200s / 长任务 600s），
 * 思考模型只要还在吐增量就不算超时；直连/Anthropic 维持非流式老路。
 *
 * opts.temperature：确定性场景（技能路由、驱动脚本生成）传 0，避免同一输入答案漂移。
 * opts.longRunning：**生成类任务**（写 PPT/Word 的 Python 脚本、长文）——告诉网关"这次要等久一点"。
 *   为什么必须由调用方声明、不能靠网关猜：生成类任务的特征是**输入短、输出长**
 *   （实测 728 字符的提示词让模型写出 4300+ tokens 的脚本，耗时 33s）。
 *   按输入长度估超时必然误判 —— 短输入被判成"该快速失败"，然后在模型答完前掐断。
 * opts.reasoning：短调用默认关思考换速度（见下方 iml_fast），确需思维链的判定传 true 保留思考。
 * opts.maxTokens：**输出预算**（思考+正文都从这里出）。大型生成任务（整站 HTML/长脚本）必须
 *   显式给大预算：网关默认 32k 在这类任务上思考吃掉大半后正文被截断（impeccable 实锤
 *   2026-08-13）。厂商不认过大值时网关会回退通道默认预算重发，不会更糟。
 * opts.onDelta：流式增量回调（进度可视化）。仅 proxy（网关 SSE）路径有增量；直连非流式
 *   拿不到增量，回调整体不触发——调用方 UI 须容忍「一次都不回调」。
 */
export async function callLlm(prompt: string, cfg: LlmConfig, opts?: { temperature?: number; longRunning?: boolean; reasoning?: boolean; maxTokens?: number; onDelta?: SseDeltaHandler }): Promise<string> {
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
      ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      // 网关据此放宽上游超时（生成类任务 30~60s 是常态）。非网关模式不传（厂商 API 不认这个字段）。
      ...(opts?.longRunning ? { iml_long_running: true } : {}),
      // 非生成类短调用（路由/判定/提炼）默认声明 iml_fast → 网关关思考（thinking disabled）。
      // 混合推理模型对分类型小任务也先思考 20~60s（通道 1.4 万次请求平均 19.5s）——「任务理解慢」
      // 的主因，2026-08-13 实测关思考后同题 <1s。个别确需思考的判定传 reasoning: true 保留原行为。
      // 长任务显式传 reasoning:false 也关思考：超长产物的**续写轮**用（写什么首轮已想清楚，
      // 把整个输出预算留给正文）。
      ...((opts?.reasoning === false || (!opts?.longRunning && opts?.reasoning !== true)) ? { iml_fast: true } : {})
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
        ...(temp !== undefined ? { temperature: temp } : {}),
        // 直连没有网关的预算回退兜底：厂商拒了会直接 400，但那也比静默截断可判读
        ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {})
      }
    }
  }

  console.log('[callLlm] >>> Final targetUrl:', targetUrl)

  // proxy 模式请求流式（网关 SSE 透传）：思考/生成再久，只要增量在流动就不算超时——
  // 等完整响应 + 总时长一刀切的旧模式把长推理误判为卡死（网关 180s 实锤，2026-08-13）。
  // 直连 / Anthropic 维持非流式老路（少数配置，不值得为它引入第二套消费逻辑）。
  const streaming = mode === 'proxy'
  if (streaming) body.stream = true

  // 总时长只是防跑飞的兜底，真正的卡死判据是流静默 90s。长任务 1800s 与网关兜底对齐
  // （客户端先掐会让网关白干）：64k 预算的整站生成流式输出 15 分钟+是正常水平；
  // 有了静默判死，总兜底可以放心给足，正常请求毫发无损。
  const controller = new AbortController()
  const totalTimer = setTimeout(() => controller.abort(), opts?.longRunning ? 1800000 : 200000)

  // 进行中占用登记（上下文圆环的实时估算源）：请求侧先记 prompt 字符，流增量再累计输出字符；
  // 完成后 recordLlmUsage 用真实 usage 校准并清掉估算。
  noteLlmCallStart(prompt.length)

  let resData: any
  let relayVendor = ''
  let relayModel = ''
  try {
    let response: Response
    try {
      response = await fetch(targetUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
    } catch (networkErr: any) {
      console.error('[callLlm] Network/fetch error:', networkErr.message)
      // 统一网络错误翻译：带错误码与目标地址（裸 "fetch failed" 连打到哪儿都看不出来）
      throw new Error(`网络连接失败: ${friendlyNetError(networkErr, targetUrl)}`)
    }

    console.log('[callLlm] <<< HTTP status:', response.status, response.statusText)

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      console.error('[callLlm] Error response body:', errBody)
      throw new Error(`HTTP ${response.status}: ${errBody || response.statusText}`)
    }
    relayVendor = response.headers.get('X-Relay-Vendor') || ''
    relayModel = response.headers.get('X-Relay-Model') || ''

    if (streaming && (response.headers.get('content-type') || '').includes('text/event-stream')) {
      const agg = await consumeSseChat(response, controller, {
        idleMs: 90_000,
        onDelta: d => {
          noteLlmStreamDelta((d.content?.length || 0) + (d.reasoning?.length || 0))
          opts?.onDelta?.(d)
        },
      })
      if (agg.error && !agg.content.trim()) throw new Error(`模型流返回错误：${agg.error}`)
      resData = toChatCompletionJson(agg)
    } else {
      // 整体 JSON：直连模式 / 网关 Mock / legacy 兜底（网关对无通道路径摘掉 stream 诚实退化）
      let rawText: string
      try {
        rawText = await response.text()
      } catch (bodyErr: any) {
        throw new Error(`读取模型响应失败: ${bodyErr?.message || bodyErr}（多为响应超长贴着超时线被掐断，可重试或缩小任务范围）`)
      }
      try {
        resData = JSON.parse(rawText)
      } catch (parseErr: any) {
        // 过渡兼容：新客户端先于网关升级时，旧网关会把上游 SSE 原文当 JSON 体整体返回
        if (rawText.trimStart().startsWith('data:')) resData = toChatCompletionJson(aggregateSseText(rawText))
        else throw new Error(`读取模型响应失败: ${parseErr?.message || parseErr}`)
      }
    }
  } finally {
    clearTimeout(totalTimer)
  }
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
      vendor: relayVendor,
      model: relayModel,
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

/**
 * 工具循环里单次模型调用的分段超时与重试（依据见 callLlmTools 内的实测数据注释）。
 * STALL 90s：响应头不到 / 流增量静默的判死阈值——原 90s「总时长闸」的新语义：流式下
 * 思考中的模型一直在吐增量，卡住的只会是真死链路；TOTAL 600s：单次调用总兜底，纯防跑飞。
 */
const TOOLS_STALL_TIMEOUT_MS = 90_000
const TOOLS_TOTAL_MS = 600_000
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
  // 网关地址**单一来源**：管理端地址 + /api/v1/model，绝不读 llm-base-url——那是直连模式的
  // 厂商地址。曾因两者混用（界面显示 adminBaseUrl、请求却用残留的旧环境 llm-base-url），
  // 把本地登录 JWT 发到另一环境的生产网关 → 401 且界面显示的地址完全无辜（2026-08-12 工单）。
  // 网关与管理端是同一个 Spring 服务，派生即真值；换环境只需改一处「服务器地址」。
  let gw = cleanModelBase(getAdminBaseUrl() + '/api/v1/model')
  if (gw.endsWith('/chat')) gw = gw.slice(0, -'/chat'.length)
  return gw
}

/**
 * 网关鉴权凭证，优先级：显式 corp-key（专用键 llm-corp-key）→ 员工登录 JWT（零配置主路径）→ 开发默认。
 *
 * **键分离纪律（2026-08-12，三次 401 工单的治本）**：网关凭证只认专用键 `llm-corp-key`，
 * **绝不**读 `llm-api-key`——那里存的是直连模式的厂商密钥。从前两键混用，切换模式/环境后
 * 残留的厂商密钥/旧环境 corp-key 会占据解析链最高优先级、把登录 JWT 挡住，网关必 401
 * 且界面无处可查（中转站模式不显示密钥框）。分键后厂商密钥在物理上进不了网关链。
 * 登录 JWT 由后端同一 JwtService 签发，网关直接认——员工登录即获得模型权限，无需手填任何密钥。
 */
export function corpGatewayKey(): string {
  return resolveGatewayKey(configGet('llm-corp-key') || '')
}

export type GatewayCredSource = 'corp-key' | 'jwt' | 'dev-default'

/**
 * 解析链的完整版：带凭证来源，供「测试连接」失败时给出**指向性**报错
 * （401 到底是显式 key 配错、登录态失效、还是没登录用了开发默认——三种修法完全不同）。
 * 哨兵值视同未设置：旧版设置页会把开发默认 key 落盘，若当真会永远挡住登录 JWT。
 */
export function resolveGatewayCred(explicit: string): { key: string; source: GatewayCredSource } {
  const custom = explicit && explicit !== DEV_CORP_GATEWAY_KEY ? explicit : ''
  if (custom) return { key: custom, source: 'corp-key' }
  const jwt = configGet('auth-token') || ''
  return jwt ? { key: jwt, source: 'jwt' } : { key: DEV_CORP_GATEWAY_KEY, source: 'dev-default' }
}

/** 同一条解析链的仅取值版（表单值入参；测试连接与真实对话必须同链，否则"测试 401、对话正常"）。 */
export function resolveGatewayKey(explicit: string): string {
  return resolveGatewayCred(explicit).key
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
    // 内核对话轮恒声明长任务 + 流式：多轮消息+工具清单+混合推理思考，总时长闸必误杀。
    // 流式下网关按「增量静默」判死；客户端同样只卡卡死（TOOLS_STALL_TIMEOUT_MS）不卡总时长。
    ...(mode === 'proxy' ? { iml_long_running: true, stream: true } : {}),
  }

  // 出站规模一并打点：思维模式模型要求回传 reasoning_content，多轮下它会显著抬高输入体量，
  // 而"慢"到底慢在上下文还是上游，不打点就只能猜。
  const outChars = JSON.stringify(body.messages).length
  const reasonChars = messages.reduce((n, m) => n + (m.reasoningContent?.length || 0), 0)
  console.log(`[callLlmTools] ${mode}/${apiMode} → ${targetUrl} | model=${modelName} | tools=${tools.length} | msgs=${messages.length} | out=${outChars}字符(含思维链 ${reasonChars})`)
  noteLlmCallStart(outChars)   // 进行中占用登记（与 callLlm 同一套实时估算源）

  // 超时与重试：实测企业任务集 p50 7.2s / p90 10s，但上游偶发**卡死**（不是慢）——90s（p90 的
  // 9 倍）判死并重试。流式化后 90s 卡的是「响应头不到」；正文阶段另有增量静默判死与总兜底，
  // 思考中的模型一直在吐增量，永远不会被误杀。
  //
  // 重试是**安全**的：模型调用本身无副作用——本轮工具尚未执行，卡住的是模型在想。
  // 只重试超时；4xx/5xx 与协议错误立刻抛出（重试它们只是把同一个错误再犯一遍）。
  const t0 = Date.now()
  let response: Response | null = null
  let controller = new AbortController()
  for (let attempt = 0; ; attempt++) {
    // 每次尝试独立 controller：TTFB/静默/总兜底都经它掐连接；用户中止信号合流其上
    //（光有超时的话，用户点了停止仍要干等模型答完——实测点停止后又跑了好几分钟）。
    controller = new AbortController()
    const c = controller
    const sig = opts?.abort ? AbortSignal.any([c.signal, opts.abort]) : c.signal
    const ttfbTimer = setTimeout(() => c.abort(), TOOLS_STALL_TIMEOUT_MS)
    try {
      response = await fetch(targetUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: sig })
      break
    } catch (networkErr: any) {
      const msg = networkErr?.message || String(networkErr)
      // 用户中止**不重试**：那不是网络抖动，是人明确喊停——重试等于当没听见
      if (opts?.abort?.aborted) throw new Error('用户已中止本次任务')
      const timedOut = /abort|timeout/i.test(msg)
      if (!timedOut || attempt >= TOOLS_CALL_RETRIES) {
        throw new Error(`网络连接失败: ${friendlyNetError(networkErr, targetUrl)}`)
      }
      console.warn(`[callLlmTools] 第 ${attempt + 1} 次调用 ${TOOLS_STALL_TIMEOUT_MS / 1000}s 未给出响应头（上游疑似卡死），重试…`)
    } finally {
      clearTimeout(ttfbTimer)
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

  let resData: any
  if (mode === 'proxy' && (response.headers.get('content-type') || '').includes('text/event-stream')) {
    // 流式聚合：思考/工具参数增量在流动就不判死；总兜底纯防跑飞。
    // 中断/静默不重试——虽无副作用，但多轮对话里带着几万字上下文重打一轮的代价已经不小，
    // 交给上层（内核对整轮有自己的失败处理）比在这里盲目再等 10 分钟更诚实。
    const c = controller
    const totalTimer = setTimeout(() => c.abort(), TOOLS_TOTAL_MS)
    try {
      const agg = await consumeSseChat(response, c, {
        idleMs: TOOLS_STALL_TIMEOUT_MS,
        onDelta: d => noteLlmStreamDelta((d.content?.length || 0) + (d.reasoning?.length || 0)),
      })
      if (agg.error && !agg.content.trim() && !agg.toolCalls.length) {
        throw new Error(`模型流返回错误：${agg.error}`)
      }
      resData = toChatCompletionJson(agg)
    } finally {
      clearTimeout(totalTimer)
    }
  } else {
    // 直连模式 / 网关 Mock / legacy 兜底：整体 JSON
    resData = await response.json()
  }
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
    // 中转站模式的网关地址与 corpGatewayBase 同一原则：从管理端地址**派生**，绝不读 llm-base-url
    //（那是直连模式的厂商地址）。此前 proxy 也先读 llm-base-url，设置页「测试连接」用表单里的
    // adminBaseUrl 一切正常，对话却把请求发到残留的旧环境地址秒报 fetch failed——
    // 界面显示的地址完全无辜（2026-08-12 实锤：库里残留已下线的旧服务器地址）。
    baseUrl: mode === 'proxy'
      ? (getAdminBaseUrl() + '/api/v1/model')
      : (configGet('llm-base-url') || (getAdminBaseUrl() + '/api/v1/model')),
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

/** 按**用途**取模型：用途专用层（深度调研/上下文整理）用它拿到对应档位的真实模型。
 *  ⚠️ 返回值可能是 `providerId::model` **跨提供商引用**（档位映射存的就是引用），
 *  不能直接塞进 modelName 发出去——必须经 resolvePurposeModel 解析。 */
export function tierModel(key: TierKey): string {
  return parseTierModels(configGet(TIER_MODELS_KEY))[key] || ''
}

/**
 * 用途专用模型的统一解析入口（researchCfg / summaryCfg / subagentCfg / consultCfg 共用）。
 *
 * 配置值可能是三种形态：裸模型名 / 档位别名（corp-reasoning）/ 跨提供商引用（providerId::model）。
 * 曾有四处各自 `{ ...cfg, modelName: m }` 原样塞名——`deepseek::deepseek-v4-pro` 这种引用被
 * 原样发给上游，400 invalid model，整条深度调研带着兜底检索词退化跑完（2026-08-08 实锤）。
 * 解析统一走 resolveSelection（与会话模型选择同一条链）：引用会换成对应提供商的端点/密钥/裸名，
 * proxy 模式下原样透传（网关侧解析别名）。
 */
export function resolvePurposeModel(cfg: LlmConfig, name: string): LlmConfig {
  const m = (name || '').trim()
  if (!m || m === cfg.modelName) return cfg
  return resolveSelection(cfg, m, {
    providers: llmProviders(),
    tiers: parseTierModels(configGet(TIER_MODELS_KEY)),
    defaultRef: configGet(DEFAULT_MODEL_KEY) || '',
  }) as LlmConfig
}
