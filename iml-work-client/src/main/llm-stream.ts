// ============================================================================
// SSE 流式聊天响应的消费与聚合（OpenAI 兼容 chat.completions 流）
//
// 超时哲学与网关 ModelStreamRelay 一致：思考模型只要还在吐增量（思维链也算），
// 链路就是活的，「卡死」的判据是**增量间静默**，不是总时长——等完整响应 + 总时长
// 一刀切的旧模式把长推理全部误杀（2026-08-13 网关 180s 实锤）。
//
// 叶子模块：只依赖 util 的 swallow，绝不 import main.ts / llm.ts（llm.ts 反向消费本模块）。
// ============================================================================
import { swallow } from './util'

export interface SseToolCall {
  id: string
  name: string
  /** 模型原样吐出的参数分片拼接结果（保持 raw，由调用方解析——与非流式 argsRaw 同语义） */
  args: string
}

export interface SseAggregated {
  content: string
  reasoningContent: string
  toolCalls: SseToolCall[]
  finishReason: string
  usage: Record<string, unknown> | null
  /** 上游/网关在流中夹带的 error 块（网关中断通知也走这条路）；空串即无 */
  error: string
}

/** 正文/思维链增量的实时回调（进度可视化用）；只在增量真到达时触发，字段可能只有其一。 */
export type SseDeltaHandler = (d: { content?: string; reasoning?: string }) => void

/**
 * 增量聚合器：一行行喂 SSE 原文，折叠出完整回答。
 * feed 返回 true 表示流已终结（[DONE]）；坏块/注释/心跳行安全跳过。
 * onDelta：增量到达时同步回调（勿在其中做重活，会拖慢流消费）。
 */
export function createSseAggregator(onDelta?: SseDeltaHandler) {
  const tool = new Map<number, SseToolCall>()
  let content = ''
  let reasoning = ''
  let finish = ''
  let usage: Record<string, unknown> | null = null
  let error = ''

  function feed(rawLine: string): boolean {
    const line = rawLine.trim()
    if (!line || line.startsWith(':') || !line.startsWith('data:')) return false
    const data = line.slice(5).trim()
    if (data === '[DONE]') return true
    let chunk: any
    try {
      chunk = JSON.parse(data)
    } catch (e) {
      swallow(e, 'sse-bad-chunk')   // 被截断的块/厂商私有心跳，跳过等下一块
      return false
    }
    if (chunk?.error) {
      error = typeof chunk.error === 'object'
        ? String(chunk.error.message ?? JSON.stringify(chunk.error))
        : String(chunk.error)
      return false
    }
    if (chunk?.usage && typeof chunk.usage === 'object') usage = chunk.usage
    const choice = chunk?.choices?.[0]
    if (!choice) return false
    if (choice.finish_reason) finish = String(choice.finish_reason)
    const delta = choice.delta || {}
    if (typeof delta.content === 'string') content += delta.content
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
    if (onDelta && (delta.content || delta.reasoning_content)) {
      try {
        onDelta({
          ...(delta.content ? { content: delta.content } : {}),
          ...(delta.reasoning_content ? { reasoning: delta.reasoning_content } : {}),
        })
      } catch (e) { swallow(e, 'sse-ondelta') }   // 展示层回调出错绝不能打断流消费
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number(tc?.index ?? 0)
        const d = tool.get(idx) || { id: '', name: '', args: '' }
        if (typeof tc?.id === 'string' && tc.id) d.id = tc.id
        // name 首块完整下发；个别厂商每块重发完整 name，不能拼成 "getXgetX"
        if (typeof tc?.function?.name === 'string' && tc.function.name && !d.name) d.name = tc.function.name
        if (typeof tc?.function?.arguments === 'string') d.args += tc.function.arguments
        tool.set(idx, d)
      }
    }
    return false
  }

  function snapshot(): SseAggregated {
    return {
      content,
      reasoningContent: reasoning,
      toolCalls: [...tool.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
      finishReason: finish,
      usage,
      error,
    }
  }

  return { feed, snapshot }
}

/** 整段 SSE 文本一次性聚合：兼容「旧版网关把上游 SSE 原文当 JSON 体整体返回」的过渡形态。 */
export function aggregateSseText(text: string): SseAggregated {
  const agg = createSseAggregator()
  for (const line of text.split('\n')) {
    if (agg.feed(line)) break
  }
  return agg.snapshot()
}

/**
 * 聚合结果 → 标准非流式 chat.completion 形状。
 * callLlm/callLlmTools 下游（取 content / parseToolCalls / usage 计量）不必区分来路。
 */
export function toChatCompletionJson(agg: SseAggregated): any {
  return {
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: agg.content,
        ...(agg.reasoningContent ? { reasoning_content: agg.reasoningContent } : {}),
        ...(agg.toolCalls.length ? {
          tool_calls: agg.toolCalls.map((t, i) => ({
            id: t.id, type: 'function', index: i,
            function: { name: t.name, arguments: t.args },
          })),
        } : {}),
      },
      finish_reason: agg.finishReason || 'stop',
    }],
    ...(agg.usage ? { usage: agg.usage } : {}),
  }
}

/**
 * 消费一个 SSE 响应流并聚合。
 *
 * 静默看门狗：相邻两个增量之间超过 idleMs 没动静 → 经 controller.abort() 掐断连接并抛
 * 可判读的错误。总时长兜底由调用方在外层定时（fetch 与本函数共用同一个 controller）。
 */
export async function consumeSseChat(
  response: { body: ReadableStream<Uint8Array> | null },
  controller: AbortController,
  opts: { idleMs: number; onDelta?: SseDeltaHandler },
): Promise<SseAggregated> {
  const body = response.body
  if (!body) throw new Error('流式响应缺少 body')
  const agg = createSseAggregator(opts.onDelta)
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let idleFired = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { idleFired = true; controller.abort() }, opts.idleMs)
  }
  resetIdle()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      resetIdle()
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (agg.feed(line)) return agg.snapshot()
      }
    }
    // 无 [DONE] 直接关流的厂商：把残余缓冲喂完，EOF 即完
    buf += decoder.decode()
    for (const line of buf.split('\n')) {
      if (agg.feed(line)) break
    }
    return agg.snapshot()
  } catch (e: any) {
    if (idleFired) {
      throw new Error(`模型流静默超过 ${Math.round(opts.idleMs / 1000)}s（增量停止，判定链路卡死），请重试`)
    }
    throw e
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    try { reader.releaseLock() } catch (e) { swallow(e, 'sse-reader-release') }
  }
}
