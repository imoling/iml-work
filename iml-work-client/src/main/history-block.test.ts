import { describe, it, expect, vi, beforeEach } from 'vitest'

// buildHistoryBlock（滚动折叠版）的触发逻辑：
// - 逐字窗口预算内（VERBATIM_BUDGET=3000 tokens，单轮 cap 400）不调用 LLM；
// - 超预算且**有 convId + 模型配置**才把早期轮次增量折叠进持久摘要（ctx-sum:<convId>，本地 config 表）；
// - 无 convId（定时任务等）→ 纯窗口截断，绝不调用；
// - 折叠边界按 SUMMARY_STEP=4 对齐：同桶不重调，跨桶才增量合并一次。
// ⚠️ 旧版测试假设"无 convId 也摘要 + 模块级内容缓存"——那是重设计前的行为，曾以 3 个失败用例
// 的形式滞留仓库（体检期间定位为存量失败）。本文件按现行设计全面重写。
const callLlm = vi.fn(async (..._a: any[]) => '· 用户抬头用子公司全称\n· 已产出 方案.docx')
vi.mock('./llm', () => ({ callLlm: (...a: any[]) => callLlm(...a) }))
// swallow/emit 等无关依赖给空实现；db 的 config 表用内存 Map（ctx-sum 持久化走它）
const kv = new Map<string, string>()
vi.mock('./util', () => ({ swallow: () => {}, sleep: async () => {} }))
vi.mock('./db', () => ({
  memoryGet: () => '', memorySet: () => {}, schedUpsert: () => {},
  configGet: (k: string) => kv.get(k) || '', configSet: (k: string, v: string) => { kv.set(k, v) },
}))
vi.mock('./window-ref', () => ({ emitToRenderer: () => {} }))
vi.mock('./corporate-rag', () => ({}))
vi.mock('./agent-trace', () => ({ AgentTrace: class {} }))

import { buildHistoryBlock } from './agent-steps'

const cfg = { mode: 'proxy', apiMode: 'chat', baseUrl: 'http://x', apiKey: 'k', modelName: 'm' }
const noCfg = { mode: '', apiMode: '', baseUrl: '', apiKey: '', modelName: '' }
// 短轮：预算内全逐字。长轮：单轮 ≈400 CJK tokens（clip 后），7 轮出头就撑爆 3000 预算 → 触发折叠。
const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `第${i}轮内容` }))
const longTurns = (n: number, tag = '长') => Array.from({ length: n }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `第${i}轮${tag}` + '事'.repeat(420) }))

describe('buildHistoryBlock 滚动折叠上下文', () => {
  beforeEach(() => callLlm.mockClear())

  it('空历史返回空串', async () => {
    expect(await buildHistoryBlock([], cfg)).toBe('')
    expect(await buildHistoryBlock(undefined, cfg)).toBe('')
  })

  it('短对话（预算内）不触发折叠调用', async () => {
    const out = await buildHistoryBlock(turns(6), cfg, 'conv-short')
    expect(callLlm).not.toHaveBeenCalled()
    expect(out).toContain('对话上文')
    expect(out).not.toContain('更早对话要点')
  })

  it('中等长度全量逐字，不丢早期轮次', async () => {
    // 回归：曾因渲染层砍到 8 条 + 阈值错位，导致中段轮次既不逐字也不摘要地被丢
    const out = await buildHistoryBlock(turns(10), cfg, 'conv-mid')
    expect(callLlm).not.toHaveBeenCalled()
    expect(out).toContain('第0轮内容')               // 最早那轮仍在逐字上文里，没被丢
    expect(out).toContain('第9轮内容')
    expect(out).not.toContain('更早对话要点')
  })

  it('超预算 + 有 convId：触发一次增量折叠并注入摘要块', async () => {
    const out = await buildHistoryBlock(longTurns(16, '甲'), cfg, 'conv-fold')
    expect(callLlm).toHaveBeenCalledTimes(1)
    expect(out).toContain('更早对话要点')
    expect(out).toContain('用户抬头用子公司全称')   // 摘要内容注入
    expect(out).toContain('第15轮甲')               // 最近轮仍逐字
  })

  it('无 convId（定时任务等无会话场景）：纯窗口截断，绝不调用', async () => {
    const out = await buildHistoryBlock(longTurns(16, '乙'), cfg)
    expect(callLlm).not.toHaveBeenCalled()
    expect(out).not.toContain('更早对话要点')
    expect(out).not.toContain('第0轮乙')   // 超预算部分如实丢弃（无处折叠）
    expect(out).toContain('第15轮乙')
  })

  it('无 LLM 配置：即使有 convId 也退回纯截断，不调用', async () => {
    const out = await buildHistoryBlock(longTurns(16, '丙'), noCfg, 'conv-nocfg')
    expect(callLlm).not.toHaveBeenCalled()
    expect(out).not.toContain('更早对话要点')
  })

  it('折叠边界按 STEP 桶推进：同桶命中持久摘要不重调，跨桶才增量合并（防长对话每条消息重调）', async () => {
    const base = longTurns(24, '丁')
    await buildHistoryBlock(base.slice(0, 16), cfg, 'conv-step')   // 折叠 [0,8)，首算
    expect(callLlm).toHaveBeenCalledTimes(1)
    await buildHistoryBlock(base.slice(0, 18), cfg, 'conv-step')   // 边界仍在 8（同桶）→ 命中持久摘要，不再调
    expect(callLlm).toHaveBeenCalledTimes(1)
    await buildHistoryBlock(base.slice(0, 24), cfg, 'conv-step')   // 边界推进到 16（跨桶）→ 增量合并一次
    expect(callLlm).toHaveBeenCalledTimes(2)
  })

  it('同一会话重复调用：第二次命中持久摘要，不重复调用', async () => {
    const h = longTurns(16, '戊')
    await buildHistoryBlock(h, cfg, 'conv-cache')
    await buildHistoryBlock(h, cfg, 'conv-cache')   // 同一批早期轮次已折叠（upto 持久化）
    expect(callLlm).toHaveBeenCalledTimes(1)
  })

  it('histTotal 窗口偏移：窗口外已折叠的绝对轮数不重复折叠', async () => {
    // 会话全程 40 轮、渲染层只送最近 16 轮：首折后 upto 为绝对轮数；同窗口再调不重算
    const win = longTurns(16, '己')
    await buildHistoryBlock(win, cfg, 'conv-offset', 40)
    const calls = callLlm.mock.calls.length
    await buildHistoryBlock(win, cfg, 'conv-offset', 40)
    expect(callLlm.mock.calls.length).toBe(calls)   // 第二次不新增调用
  })
})
