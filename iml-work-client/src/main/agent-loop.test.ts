// P1 循环机制单测：用 mock 模型 + mock 工具，离线验证 ReAct 循环的调度/记忆/收尾/防卡死（不碰真网关）。
import { describe, it, expect, vi } from 'vitest'
import { runAgentLoop, parseAgentDecision, type AgentTool } from './agent-loop'
import type { LlmConfig } from './llm'

const cfg = { mode: 'proxy', apiMode: 'chat', baseUrl: 'x', apiKey: 'x', modelName: 'x' } as LlmConfig
const noLog = () => {}

// 按脚本依次返回的 mock 模型
function scriptedModel(outputs: string[]) {
  let i = 0
  return vi.fn(async () => outputs[Math.min(i++, outputs.length - 1)])
}
const echoTool = (name: string, reply: (a: any) => string): AgentTool => ({
  name, description: name, argsHint: '{}', run: async (a) => reply(a),
})

describe('parseAgentDecision', () => {
  it('解析工具调用', () => {
    const d = parseAgentDecision('前言 {"thought":"t","tool":"web_search","args":{"query":"q"}} 后语')
    expect(d?.tool).toBe('web_search'); expect(d?.args?.query).toBe('q')
  })
  it('解析 finish', () => {
    const d = parseAgentDecision('```json\n{"thought":"done","finish":true,"answer":"42"}\n```')
    expect(d?.finish).toBe(true); expect(d?.answer).toBe('42')
  })
  it('answer 字段即视为 finish', () => {
    expect(parseAgentDecision('{"answer":"x"}')?.finish).toBe(true)
  })
  it('无 JSON → null', () => { expect(parseAgentDecision('随便说点啥')).toBeNull() })
})

describe('runAgentLoop', () => {
  it('调用工具→观察→finish 的完整回合', async () => {
    const model = scriptedModel([
      '{"thought":"先查","tool":"web_search","args":{"query":"生日"}}',
      '{"thought":"再算","tool":"python","args":{"code":"print(62)"}}',
      '{"thought":"得出","finish":true,"answer":"61 岁"}',
    ])
    const tools = [echoTool('web_search', () => '生于1927年'), echoTool('python', () => 'stdout:\n62')]
    const r = await runAgentLoop({ task: 'x', tools, cfg, sendLog: noLog, callModel: model })
    expect(r.finished).toBe(true); expect(r.answer).toBe('61 岁')
    expect(r.steps).toHaveLength(3)
    expect(model).toHaveBeenCalledTimes(3)
  })

  it('观察结果被喂回下一步提示（scratchpad 生效）', async () => {
    const prompts: string[] = []
    const model = vi.fn(async (p: string) => {
      prompts.push(p)
      return prompts.length === 1
        ? '{"tool":"web_search","args":{"query":"q"}}'
        : '{"finish":true,"answer":"ok"}'
    })
    const tools = [echoTool('web_search', () => 'SECRET_OBSERVATION_123')]
    await runAgentLoop({ task: 'x', tools, cfg, sendLog: noLog, callModel: model })
    // 第二次提示里应含第一步的观察
    expect(prompts[1]).toContain('SECRET_OBSERVATION_123')
  })

  it('未知工具 → 观察提示可用工具，循环继续', async () => {
    const model = scriptedModel([
      '{"tool":"nonexist","args":{}}',
      '{"finish":true,"answer":"done"}',
    ])
    const r = await runAgentLoop({ task: 'x', tools: [echoTool('web_search', () => 'x')], cfg, sendLog: noLog, callModel: model })
    expect(r.steps[0].observation).toContain('未知工具')
    expect(r.answer).toBe('done')
  })

  it('步数耗尽 → 强制收尾（finished=false）', async () => {
    // 模型永远只调工具、从不 finish
    const model = vi.fn(async () => '{"tool":"web_search","args":{"query":"q"}}')
    const tools = [echoTool('web_search', () => 'obs')]
    const r = await runAgentLoop({ task: 'x', tools, cfg, sendLog: noLog, callModel: model, maxSteps: 3 })
    expect(r.finished).toBe(false)
    // maxSteps 次决策 + 1 次收尾
    expect(model.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('连续重复同一调用 → 防卡死终止', async () => {
    let calls = 0
    const model = vi.fn(async () => { calls++; return '{"tool":"web_search","args":{"query":"same"}}' })
    const tools = [echoTool('web_search', () => 'same-obs')]
    const r = await runAgentLoop({ task: 'x', tools, cfg, sendLog: noLog, callModel: model, maxSteps: 20 })
    // 应在重复第3次时终止，而不是跑满 20 步
    expect(r.finished).toBe(false)
    expect(calls).toBeLessThan(20)
  })

  it('观察过长被截断', async () => {
    const prompts: string[] = []
    const model = vi.fn(async (p: string) => {
      prompts.push(p)
      return prompts.length === 1 ? '{"tool":"big","args":{}}' : '{"finish":true,"answer":"ok"}'
    })
    const tools = [echoTool('big', () => 'X'.repeat(5000))]
    await runAgentLoop({ task: 'x', tools, cfg, sendLog: noLog, callModel: model, obsCap: 500 })
    expect(prompts[1]).toContain('已截断')
  })
})

describe('runAgentLoop 有状态工具清理', () => {
  it('循环结束后调用工具 cleanup（正常 finish 路径）', async () => {
    let cleaned = false
    const stateful: AgentTool = { name: 'browse', description: 'b', argsHint: '{}', run: async () => 'obs', cleanup: async () => { cleaned = true } }
    const model = scriptedModel(['{"tool":"browse","args":{}}', '{"finish":true,"answer":"ok"}'])
    await runAgentLoop({ task: 'x', tools: [stateful], cfg, sendLog: noLog, callModel: model })
    expect(cleaned).toBe(true)
  })
  it('模型抛错也清理（finally 保证）', async () => {
    let cleaned = false
    const stateful: AgentTool = { name: 'browse', description: 'b', argsHint: '{}', run: async () => 'obs', cleanup: async () => { cleaned = true } }
    const model = async () => { throw new Error('boom') }
    await runAgentLoop({ task: 'x', tools: [stateful], cfg, sendLog: noLog, callModel: model })
    expect(cleaned).toBe(true)
  })
})
