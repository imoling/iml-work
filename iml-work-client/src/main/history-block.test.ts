import { describe, it, expect, vi, beforeEach } from 'vitest'

// buildHistoryBlock 的摘要触发逻辑：短对话不调用 LLM，长对话（>阈值）才把早期轮次压成摘要。
// mock callLlm 以断言「是否/何时」调用，而不真发网络。
const callLlm = vi.fn(async (..._a: any[]) => '· 用户抬头用子公司全称\n· 已产出 方案.docx')
vi.mock('./llm', () => ({ callLlm: (...a: any[]) => callLlm(...a) }))
// swallow/emit 等无关依赖给空实现
vi.mock('./util', () => ({ swallow: () => {}, sleep: async () => {} }))
vi.mock('./db', () => ({ memoryGet: () => '', memorySet: () => {}, schedUpsert: () => {} }))
vi.mock('./window-ref', () => ({ emitToRenderer: () => {} }))
vi.mock('./corporate-rag', () => ({}))
vi.mock('./agent-trace', () => ({ AgentTrace: class {} }))

import { buildHistoryBlock } from './agent-steps'

const cfg = { mode: 'proxy', apiMode: 'chat', baseUrl: 'http://x', apiKey: 'k', modelName: 'm' }
const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `第${i}轮内容` }))

describe('buildHistoryBlock 上下文摘要', () => {
  beforeEach(() => callLlm.mockClear())

  it('空历史返回空串', async () => {
    expect(await buildHistoryBlock([], cfg)).toBe('')
    expect(await buildHistoryBlock(undefined, cfg)).toBe('')
  })

  it('短对话（≤阈值）不触发摘要 LLM 调用', async () => {
    const out = await buildHistoryBlock(turns(6), cfg)
    expect(callLlm).not.toHaveBeenCalled()
    expect(out).toContain('对话上文')
    expect(out).not.toContain('更早对话要点')
  })

  it('长对话（>12 轮）触发一次摘要并注入', async () => {
    const out = await buildHistoryBlock(turns(16), cfg)
    expect(callLlm).toHaveBeenCalledTimes(1)
    expect(out).toContain('更早对话要点')
    expect(out).toContain('用户抬头用子公司全称')   // 摘要内容注入
  })

  it('无 LLM 配置时退回纯截断，不调用', async () => {
    const out = await buildHistoryBlock(turns(16), { mode: '', apiMode: '', baseUrl: '', apiKey: '', modelName: '' })
    expect(callLlm).not.toHaveBeenCalled()
    expect(out).not.toContain('更早对话要点')
  })

  it('相同早期轮次命中缓存，不重复调用', async () => {
    // 用唯一内容，避免被前面测试的模块级缓存命中（模块缓存跨测试保留）
    const h = Array.from({ length: 16 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `缓存测试专用第${i}轮_${Date.now()}` }))
    await buildHistoryBlock(h, cfg)
    await buildHistoryBlock(h, cfg)   // 同一批早期轮次
    expect(callLlm).toHaveBeenCalledTimes(1)   // 第二次走缓存
  })
})
