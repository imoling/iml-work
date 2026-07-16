import { configGet } from './db'
import { getAdminBaseUrl } from './http'
import { recordLlmUsage } from './automation-runtime'
import { swallow } from './util'

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

  if (mode === 'proxy') {
    // Enterprise unified gateway (admin backend /api/v1/model/chat). Accept the
    // base URL with or without a trailing /chat so either form works.
    let gwBase = cleanBaseUrl.endsWith('/chat') ? cleanBaseUrl.slice(0, -'/chat'.length) : cleanBaseUrl
    // 用户常把「后端地址」直接当网关地址填（http://host:8081，少了 /api/v1/model）——
    // 裸源站自动补全网关路径，别让一个路径差把人挡在门外
    try { if (new URL(gwBase).pathname === '/') gwBase = gwBase.replace(/\/$/, '') + '/api/v1/model' } catch (e) { swallow(e, 'gw-normalize') }
    targetUrl = `${gwBase}/chat`
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

  if (apiMode === 'anthropic' && mode !== 'proxy') {
    const content = resData.content?.[0]?.text
    return content || JSON.stringify(resData)
  } else {
    const content = resData.choices?.[0]?.message?.content
    return content || JSON.stringify(resData)
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
