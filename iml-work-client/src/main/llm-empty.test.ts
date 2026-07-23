// A1 回归：模型空内容响应必须抛错，绝不把原始 API JSON 当答案返回（留出实锤 ga03）。
// callLlm 内联了 fetch，这里直接测「空内容 → 抛错、非空 → 返回」的解析契约（用同构提取逻辑）。
import { describe, it, expect } from 'vitest'

// 与 llm.ts 末尾的提取契约同构：choices[0].message.content 空即抛错。
function extractOrThrow(resData: any, apiMode = 'chat', mode = 'proxy'): string {
  const content = (apiMode === 'anthropic' && mode !== 'proxy')
    ? resData.content?.[0]?.text
    : resData.choices?.[0]?.message?.content
  if (!content || !String(content).trim()) throw new Error('模型返回了空内容')
  return content
}

describe('callLlm 空响应契约', () => {
  it('空 content → 抛错，绝不返回原始 JSON', () => {
    const raw = { id: 'x', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: '' } }], usage: {}, system_fingerprint: 'fp' }
    expect(() => extractOrThrow(raw)).toThrow()
  })
  it('缺 choices → 抛错', () => {
    expect(() => extractOrThrow({ id: 'x', object: 'chat.completion' })).toThrow()
  })
  it('纯空白 content → 抛错', () => {
    expect(() => extractOrThrow({ choices: [{ message: { content: '  \n ' } }] })).toThrow()
  })
  it('正常 content → 返回', () => {
    expect(extractOrThrow({ choices: [{ message: { content: '你好' } }] })).toBe('你好')
  })
  it('anthropic 直连空 → 抛错', () => {
    expect(() => extractOrThrow({ content: [{ text: '' }] }, 'anthropic', 'direct')).toThrow()
  })
})
