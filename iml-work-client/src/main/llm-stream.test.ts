// SSE 聚合契约钉子：流式化后 callLlm/callLlmTools 拿到的一切都出自这套聚合——
// 聚合错了症状是「模型抽风」（残缺回答/工具参数解析失败），极难向上归因，必须钉死。
import { describe, it, expect } from 'vitest'
import { createSseAggregator, aggregateSseText, toChatCompletionJson } from './llm-stream'

describe('SSE 增量聚合', () => {
  it('正文增量按序拼接，[DONE] 终结流', () => {
    const agg = createSseAggregator()
    expect(agg.feed('data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"}}]}')).toBe(false)
    expect(agg.feed('data: {"choices":[{"index":0,"delta":{"content":"，世界"}}]}')).toBe(false)
    expect(agg.feed('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}')).toBe(false)
    expect(agg.feed('data: [DONE]')).toBe(true)
    const s = agg.snapshot()
    expect(s.content).toBe('你好，世界')
    expect(s.finishReason).toBe('stop')
  })

  it('思维链与正文分开聚合（reasoning_content 须原样保留供多轮回传）', () => {
    const agg = createSseAggregator()
    agg.feed('data: {"choices":[{"delta":{"reasoning_content":"想一"}}]}')
    agg.feed('data: {"choices":[{"delta":{"reasoning_content":"想二"}}]}')
    agg.feed('data: {"choices":[{"delta":{"content":"答案"}}]}')
    const s = agg.snapshot()
    expect(s.content).toBe('答案')
    expect(s.reasoningContent).toBe('想一想二')
  })

  it('工具调用参数分片按 index 归并，name 不重复拼接', () => {
    const agg = createSseAggregator()
    agg.feed('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"getWeather","arguments":"{\\"ci"}}]}}]}')
    // 个别厂商每块重发完整 name——不能拼成 getWeathergetWeather
    agg.feed('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"getWeather","arguments":"ty\\":\\"北京\\"}"}}]}}]}')
    agg.feed('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}')
    const s = agg.snapshot()
    expect(s.toolCalls).toHaveLength(1)
    expect(s.toolCalls[0].name).toBe('getWeather')
    expect(s.toolCalls[0].args).toBe('{"city":"北京"}')
    expect(s.toolCalls[0].id).toBe('call_1')
  })

  it('usage 取末块；错误块被捕获', () => {
    const agg = createSseAggregator()
    agg.feed('data: {"choices":[{"delta":{"content":"x"}}]}')
    agg.feed('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22}}')
    agg.feed('data: {"error":{"message":"midway broke"}}')
    const s = agg.snapshot()
    expect(s.usage).toEqual({ prompt_tokens: 11, completion_tokens: 22 })
    expect(s.error).toBe('midway broke')
  })

  it('注释/空行/坏 JSON 块安全跳过', () => {
    const agg = createSseAggregator()
    expect(agg.feed(': keepalive')).toBe(false)
    expect(agg.feed('')).toBe(false)
    expect(agg.feed('event: ping')).toBe(false)
    expect(agg.feed('data: {截断坏块')).toBe(false)
    agg.feed('data: {"choices":[{"delta":{"content":"ok"}}]}')
    expect(agg.snapshot().content).toBe('ok')
  })

  it('aggregateSseText 兼容整段 SSE 文本（旧网关过渡形态）', () => {
    const text = [
      'data: {"choices":[{"delta":{"content":"a"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"b"}},{"index":1}]}',
      'data: [DONE]',
      'data: {"choices":[{"delta":{"content":"不应出现"}}]}',
    ].join('\n')
    expect(aggregateSseText(text).content).toBe('ab')
  })
})

describe('toChatCompletionJson 形状契约（下游 content/parseToolCalls/usage 不区分来路）', () => {
  it('文本回答 → choices[0].message.content', () => {
    const agg = createSseAggregator()
    agg.feed('data: {"choices":[{"delta":{"content":"你好"}}]}')
    const j = toChatCompletionJson(agg.snapshot())
    expect(j.choices[0].message.content).toBe('你好')
    expect(j.choices[0].finish_reason).toBe('stop')   // 无 finish 的 EOF 流兜底为 stop
    expect(j.usage).toBeUndefined()
  })

  it('工具调用轮 → tool_calls 形状与非流式一致（content 可为空不算失败）', () => {
    const agg = createSseAggregator()
    agg.feed('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c9","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}')
    agg.feed('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}')
    const j = toChatCompletionJson(agg.snapshot())
    const tc = j.choices[0].message.tool_calls[0]
    expect(tc.id).toBe('c9')
    expect(tc.function.name).toBe('f')
    expect(tc.function.arguments).toBe('{}')
    expect(j.choices[0].finish_reason).toBe('tool_calls')
    expect(j.usage.completion_tokens).toBe(2)
  })

  it('思维链保留在 message.reasoning_content（漏了下一轮 400）', () => {
    const agg = createSseAggregator()
    agg.feed('data: {"choices":[{"delta":{"reasoning_content":"思","content":"答"}}]}')
    const j = toChatCompletionJson(agg.snapshot())
    expect(j.choices[0].message.reasoning_content).toBe('思')
  })
})
