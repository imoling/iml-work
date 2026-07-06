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
 */
export async function callLlm(prompt: string, cfg: LlmConfig, opts?: { temperature?: number }): Promise<string> {
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
    const gwBase = cleanBaseUrl.endsWith('/chat') ? cleanBaseUrl.slice(0, -'/chat'.length) : cleanBaseUrl
    targetUrl = `${gwBase}/chat`
    headers['Authorization'] = `Bearer ${apiKey}`
    body = {
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      ...(temp !== undefined ? { temperature: temp } : {})
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

  const resData: any = await response.json()
  console.log('[callLlm] <<< Response JSON keys:', Object.keys(resData))

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
