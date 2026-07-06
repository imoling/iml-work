import { configGet } from './db'
import { getAdminBaseUrl } from './http'

export interface LlmConfig {
  mode: string;
  apiMode: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

/**
 * 直连 / 中转 / Anthropic 三种模式统一的一次性 LLM 调用；120s 超时，返回文本内容。
 * opts.temperature：确定性场景（技能路由、驱动脚本生成）传 0，避免同一输入答案漂移。
 * opts.onDelta：传入即请求流式（body.stream=true）——SSE 增量逐段回调，最终仍返回完整文本；
 *   上游/网关不支持流式（返回普通 JSON）时自动降级为整段解析，调用方无感。
 */
export async function callLlm(prompt: string, cfg: LlmConfig, opts?: { temperature?: number; onDelta?: (delta: string) => void }): Promise<string> {
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

  let cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  if (cleanBaseUrl.endsWith('/chat/completions')) {
    cleanBaseUrl = cleanBaseUrl.slice(0, -'/chat/completions'.length)
  } else if (cleanBaseUrl.endsWith('/v1/messages')) {
    cleanBaseUrl = cleanBaseUrl.slice(0, -'/v1/messages'.length)
  }

  let targetUrl = ''
  let headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  let body: any = {}
  const temp = opts?.temperature

  const wantStream = typeof opts?.onDelta === 'function'
  if (mode === 'proxy') {
    // Enterprise unified gateway (admin backend /api/v1/model/chat). Accept the
    // base URL with or without a trailing /chat so either form works.
    const gwBase = cleanBaseUrl.endsWith('/chat') ? cleanBaseUrl.slice(0, -'/chat'.length) : cleanBaseUrl
    targetUrl = `${gwBase}/chat`
    headers['Authorization'] = `Bearer ${apiKey}`
    body = {
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      ...(temp !== undefined ? { temperature: temp } : {}),
      ...(wantStream ? { stream: true } : {})
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
        ...(temp !== undefined ? { temperature: temp } : {}),
        ...(wantStream ? { stream: true } : {})
      }
    } else {
      targetUrl = `${cleanBaseUrl}/chat/completions`
      headers['Authorization'] = `Bearer ${apiKey}`
      body = {
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        ...(temp !== undefined ? { temperature: temp } : {}),
        ...(wantStream ? { stream: true } : {})
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
      // 模型推理可能较慢，给 120s 超时，既容忍长回答又避免无限挂起。
      signal: AbortSignal.timeout(120000)
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

  // 流式路径：不赌 content-type（网关/代理常把 SSE 标成 application/json）——
  // 直接按载荷特征嗅探：首个非空行以 "data:" 开头即 SSE 增量解析，否则整段按 JSON 解析。
  const anthropicShape = apiMode === 'anthropic' && mode !== 'proxy'
  if (wantStream && response.body) {
    return await readStreamAuto(response.body, anthropicShape, opts!.onDelta!)
  }

  const resData: any = await response.json()
  console.log('[callLlm] <<< Response JSON keys:', Object.keys(resData))
  return extractContent(resData, anthropicShape)
}

function extractContent(resData: any, anthropic: boolean): string {
  const content = anthropic ? resData?.content?.[0]?.text : resData?.choices?.[0]?.message?.content
  return content || JSON.stringify(resData)
}

/**
 * 自动嗅探的流读取：SSE（OpenAI chat 取 choices[0].delta.content，Anthropic 取
 * content_block_delta 的 delta.text）逐段回调 onDelta 并返回累计全文；
 * 非 SSE 载荷则整段收完按 JSON 解析（上游忽略 stream 参数时的降级路径）。
 */
async function readStreamAuto(bodyStream: ReadableStream<Uint8Array>, anthropic: boolean, onDelta: (d: string) => void): Promise<string> {
  const reader = bodyStream.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let full = ''
  let mode: 'unknown' | 'sse' | 'json' = 'unknown'

  const handleSseLine = (line: string) => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    try {
      const j: any = JSON.parse(payload)
      const delta = anthropic
        ? (j.type === 'content_block_delta' ? (j.delta?.text || '') : '')
        : (j.choices?.[0]?.delta?.content || '')
      if (delta) { full += delta; onDelta(delta) }
    } catch { /* 心跳/注释行，忽略 */ }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    if (mode === 'unknown') {
      // 用首个非空行定型：SSE 以 data:/event: 开头；否则按 JSON 整段收
      const probe = buf.replace(/^\s+/, '')
      if (!probe) continue
      mode = (probe.startsWith('data:') || probe.startsWith('event:')) ? 'sse' : 'json'
    }
    if (mode === 'sse') {
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        handleSseLine(line)
      }
    }
    // json 模式：持续累积到流结束
  }
  if (mode === 'sse') {
    if (buf.trim()) handleSseLine(buf.trim())
    return full
  }
  try {
    return extractContent(JSON.parse(buf), anthropic)
  } catch {
    return buf   // 既非 SSE 也非 JSON：原样返回，调用方兜底
  }
}

/** 当前生效的 LLM 配置（本地 config 覆盖 → 默认走本地后端模型中转站）。 */
export function currentLlmConfig(): LlmConfig {
  return {
    mode: configGet('llm-connection-mode') || 'proxy',
    apiMode: configGet('llm-api-mode') || 'chat',
    baseUrl: configGet('llm-base-url') || (getAdminBaseUrl() + '/api/v1/model'),
    apiKey: configGet('llm-api-key') || 'sk-corp-default-key',
    modelName: configGet('llm-model-name') || 'deepseek-chat',
  }
}
