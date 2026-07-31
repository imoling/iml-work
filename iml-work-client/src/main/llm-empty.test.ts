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

describe('工具调用标记泄漏防护', () => {
  it('剥掉模型当文本吐出来的工具调用标记（实测 deepseek 泄漏过 DSML 格式）', async () => {
    const { stripToolCallArtifacts } = await import('./llm-parse')
    const leaked = `<||DSML|| tool_calls>
<||DSML|| invoke name="python">
<||DSML|| parameter name="code" string="true">import os
print("hi")
</||DSML|| parameter>
</||DSML|| invoke>
</||DSML|| tool_calls>`
    const out = stripToolCallArtifacts(leaked)
    expect(out).not.toContain('DSML')
    expect(out).not.toContain('invoke')
    expect(out).toContain('print("hi")')   // 代码本体留着，便于排障时看清模型想干什么
  })

  it('正常文本原样返回（不误伤含"函数"字样的正常回答）', async () => {
    const { stripToolCallArtifacts } = await import('./llm-parse')
    const normal = '这个函数的作用是计算总额，建议用 python 工具真算一遍。'
    expect(stripToolCallArtifacts(normal)).toBe(normal)
  })

  it('整段都是标记 → 剥成空串（调用方据此按空回复重试，绝不甩给用户）', async () => {
    const { stripToolCallArtifacts } = await import('./llm-parse')
    expect(stripToolCallArtifacts('<||DSML|| tool_calls></||DSML|| tool_calls>')).toBe('')
  })
})
