// 执行内核单测：用 mock 模型 + mock 工具，离线验证循环调度 / 权限闸 / 并发策略 / 收尾（不碰真网关）。
// 权限闸走真实 authorizeToolCall，只把它底下的确认卡（依赖 electron）mock 掉——
// **闸的判定逻辑必须被真测到**，那是本次重构最重要的安全收益。
import { describe, it, expect, vi, beforeEach } from 'vitest'

// confirm-token → automation-runtime → electron，必须在 import 权限闸之前桩掉。
const mockConfirm = vi.fn()
vi.mock('./confirm-token', () => ({
  requestSignedConfirmation: (...a: unknown[]) => mockConfirm(...a),
  tokenStateNote: (s: string) => `token:${s}`,
}))

const { runTurn, normalizeTodos, outboundMessages, makeTodoToolSpec, extractLeakedTodos, TODO_TOOL_NAME } = await import('./turn-engine')
const { ToolRegistry, isParallelSafe, schemaFromArgsHint, fromAgentTool } = await import('./tool-registry')
type TurnEngineOptions = import('./turn-engine').TurnEngineOptions
type ToolSpec = import('./tool-registry').ToolSpec
type TurnEvent = import('../shared/turn-protocol').TurnEvent
type TurnToolCall = import('../shared/turn-protocol').TurnToolCall

const cfg = { mode: 'proxy', apiMode: 'chat', baseUrl: 'x', apiKey: 'x', modelName: 'x' } as any

/** 造一个工具；默认 low 档（自动放行）。 */
function tool(name: string, run: (a: any) => Promise<string>, risk: 'low' | 'write' = 'low'): ToolSpec {
  return {
    name, description: name,
    parameters: { type: 'object', properties: {} },
    metadata: { label: `执行${name}`, risk },
    run,
  }
}

/** 按脚本依次返回的 mock 模型：每项要么是纯文本（收尾），要么是若干工具调用。 */
function scriptedModel(script: ({ text?: string; calls?: { name: string; args?: any }[] })[]) {
  let i = 0
  // 形参显式声明（虽然本体用不到）：测试要断言"收尾那次调用没带工具"，得能读到 mock.calls[n][1]。
  return vi.fn(async (_messages: unknown, _tools: unknown[], _cfg?: unknown, _opts?: unknown) => {
    const step = script[Math.min(i++, script.length - 1)]
    const toolCalls: TurnToolCall[] = (step.calls || []).map((c, n) => ({
      id: `c${i}_${n}`, name: c.name, args: c.args || {}, argsRaw: JSON.stringify(c.args || {}),
    }))
    return { text: step.text || '', toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' }
  })
}

function baseOpts(over: Partial<TurnEngineOptions> & Pick<TurnEngineOptions, 'callModel' | 'registry'>): TurnEngineOptions {
  return {
    runId: 'r1', messages: [{ role: 'user', content: '任务' }], cfg,
    sendLog: () => {}, emit: () => {}, permMode: 'full',
    ...over,
  }
}

function regWith(...specs: ToolSpec[]) {
  const r = new ToolRegistry()
  r.registerAll(specs)
  return r
}

beforeEach(() => { mockConfirm.mockReset() })

describe('normalizeTodos', () => {
  it('规整状态别名', () => {
    const r = normalizeTodos([{ content: 'a', status: 'completed' }, { content: 'b', status: 'doing' }])
    expect(r).toEqual([{ content: 'a', status: 'done' }, { content: 'b', status: 'in_progress' }])
  })
  it('容忍纯字符串项与未知状态', () => {
    expect(normalizeTodos(['x', { content: 'y', status: '???' }]))
      .toEqual([{ content: 'x', status: 'pending' }, { content: 'y', status: 'pending' }])
  })
  it('丢掉空内容与非数组', () => {
    expect(normalizeTodos([{ content: '   ' }])).toEqual([])
    expect(normalizeTodos('nope')).toEqual([])
  })
})

describe('outboundMessages', () => {
  const msgs = [{ role: 'user' as const, content: 'q1' }, { role: 'assistant' as const, content: 'a1' }, { role: 'user' as const, content: 'q2' }]
  it('上下文追加到最后一条 user 消息', () => {
    const out = outboundMessages(msgs, 'CTX')
    expect(out[2].content).toContain('q2')
    expect(out[2].content).toContain('<system-context>\nCTX')
    expect(out[0].content).toBe('q1')
  })
  it('不改动原数组（ephemeral，不得被历史重放污染）', () => {
    outboundMessages(msgs, 'CTX')
    expect(msgs[2].content).toBe('q2')
  })
  it('空上下文原样返回', () => {
    expect(outboundMessages(msgs, '  ')).toBe(msgs)
  })
})

describe('工具注册表', () => {
  it('只有 low 且不需审批的工具可并发', () => {
    expect(isParallelSafe(tool('a', async () => ''))).toBe(true)
    expect(isParallelSafe(tool('b', async () => '', 'write'))).toBe(false)
    const needsApproval = { ...tool('c', async () => ''), metadata: { label: 'c', risk: 'low' as const, requiresApproval: true } }
    expect(isParallelSafe(needsApproval)).toBe(false)
  })
  it('argsHint 样例串推出参数 schema', () => {
    const s = schemaFromArgsHint('{"query":"检索词","n":3}')
    expect(s.properties.query).toEqual({ type: 'string', description: '检索词' })
    expect(s.properties.n.type).toBe('number')
    expect(s.required).toEqual(['query', 'n'])
  })
  it('坏 JSON 的 argsHint 不炸，退化成自由形状', () => {
    expect(schemaFromArgsHint('不是JSON').properties).toEqual({})
  })
  it('存量 AgentTool 可原样包装（执行体复用）', async () => {
    const spec = fromAgentTool(
      { name: 'legacy', description: 'd', argsHint: '{"q":"x"}', run: async (a) => `got:${a.q}` },
      { label: '旧工具', risk: 'low' },
    )
    expect(await spec.run({ q: '1' }, { sendLog: () => {} })).toBe('got:1')
  })
})

describe('runTurn 主循环', () => {
  it('第一轮就不调工具 → 那句话即最终答案（普通问答走同一条路）', async () => {
    const callModel = scriptedModel([{ text: '你好' }])
    const res = await runTurn(baseOpts({ callModel, registry: regWith() }))
    expect(res.status).toBe('completed')
    expect(res.answer).toBe('你好')
    expect(res.toolCallCount).toBe(0)
    expect(callModel).toHaveBeenCalledTimes(1)
  })

  it('调工具 → 结果回灌 → 再答（工具结果进 messages，多轮追问才看得见）', async () => {
    const callModel = scriptedModel([
      { text: '先查一下', calls: [{ name: 'search', args: { q: 'x' } }] },
      { text: '答案是 42' },
    ])
    const res = await runTurn(baseOpts({ callModel, registry: regWith(tool('search', async () => '结果:42')) }))
    expect(res.answer).toBe('答案是 42')
    expect(res.toolCallCount).toBe(1)
    const toolMsg = res.messages.find(m => m.role === 'tool')
    expect(toolMsg?.content).toBe('结果:42')
    expect(toolMsg?.status).toBe('ok')
    // 助手那轮必须带上 toolCalls，否则下一轮上游会因为 tool 结果没有对应调用而报错
    expect(res.messages.find(m => m.role === 'assistant')?.toolCalls?.[0].name).toBe('search')
  })

  it('有工具调用时的助手文本 = 叙述（对话框里的实时进度行）', async () => {
    const events: TurnEvent[] = []
    const callModel = scriptedModel([{ text: '正在检索最新数据', calls: [{ name: 'search' }] }, { text: '好了' }])
    await runTurn(baseOpts({ callModel, registry: regWith(tool('search', async () => 'ok')), emit: e => events.push(e) }))
    expect(events.find(e => e.type === 'narration')).toMatchObject({ text: '正在检索最新数据' })
  })

  it('工具报错如实回灌，不静默当成功', async () => {
    const callModel = scriptedModel([{ calls: [{ name: 'boom' }] }, { text: '我没能拿到数据' }])
    const res = await runTurn(baseOpts({
      callModel, registry: regWith(tool('boom', async () => { throw new Error('炸了') })),
    }))
    const toolMsg = res.messages.find(m => m.role === 'tool')
    expect(toolMsg?.status).toBe('error')
    expect(toolMsg?.content).toContain('炸了')
  })

  it('todo_write 由内核拦截 → 事件流带出清单', async () => {
    const events: TurnEvent[] = []
    const callModel = scriptedModel([
      { calls: [{ name: TODO_TOOL_NAME, args: { todos: [{ content: '第一步', status: 'in_progress' }] } }] },
      { text: '完成' },
    ])
    const res = await runTurn(baseOpts({ callModel, registry: regWith(makeTodoToolSpec()), emit: e => events.push(e) }))
    // completed 收尾会把 in_progress 自动标 done（见「清单收尾」组测试），这里验拦截与事件本身
    expect(res.todos).toEqual([{ content: '第一步', status: 'done' }])
    expect(events.find(e => e.type === 'todo_updated')).toBeTruthy()
  })

  it('步数上限 → 收尾时不再给工具，逼模型基于已有观察作答', async () => {
    const callModel = scriptedModel([{ calls: [{ name: 'loop', args: { n: Math.random() } }] }])
    const res = await runTurn(baseOpts({
      callModel, registry: regWith(tool('loop', async () => '还没查到')), maxIterations: 2,
    }))
    expect(res.status).toBe('max_iterations')
    // 最后一次调用的 tools 必须为空数组
    expect(callModel.mock.calls[callModel.mock.calls.length - 1][1]).toEqual([])
  })

  it('连续重复同一批调用 → 判定卡死并收尾', async () => {
    const callModel = scriptedModel([{ calls: [{ name: 'same', args: { q: 'fixed' } }] }])
    const res = await runTurn(baseOpts({
      callModel, registry: regWith(tool('same', async () => '一样的结果')), maxIterations: 20,
    }))
    expect(res.status).toBe('max_iterations')
    expect(res.iterations).toBeLessThan(6)   // 不该跑满 20 轮
  })

  it('未知工具 → 拒绝并把原因回灌（让模型自纠，而不是拿不到结果空转）', async () => {
    const callModel = scriptedModel([{ calls: [{ name: 'ghost' }] }, { text: '改用别的方式' }])
    const res = await runTurn(baseOpts({ callModel, registry: regWith() }))
    const toolMsg = res.messages.find(m => m.role === 'tool')
    expect(toolMsg?.status).toBe('denied')
    expect(toolMsg?.content).toContain('未知工具')
  })

  it('中断：未执行的调用仍补结果，绝不留孤儿 tool_calls', async () => {
    const callModel = scriptedModel([{ calls: [{ name: 'a' }, { name: 'b' }] }])
    // 循环开头会先查一次中断——那次必须放行，否则根本走不到工具调度这一步。
    let checks = 0
    const res = await runTurn(baseOpts({
      callModel, registry: regWith(tool('a', async () => 'ok'), tool('b', async () => 'ok')),
      isCancelled: () => checks++ > 0,
    }))
    expect(res.status).toBe('interrupted')
    const assistant = res.messages.find(m => m.role === 'assistant')
    const toolMsgs = res.messages.filter(m => m.role === 'tool')
    expect(toolMsgs.length).toBe(assistant?.toolCalls?.length)   // 每个调用都有回答
    expect(toolMsgs.every(m => m.status === 'interrupted')).toBe(true)
  })

  it('一轮结束清理有状态工具（绝不泄漏离屏窗口）', async () => {
    const cleanup = vi.fn(async () => {})
    const spec: ToolSpec = { ...tool('browse', async () => 'ok'), cleanup }
    await runTurn(baseOpts({ callModel: scriptedModel([{ text: 'done' }]), registry: regWith(spec) }))
    expect(cleanup).toHaveBeenCalledOnce()
  })
})

describe('权限闸（本次重构的核心安全收益）', () => {
  const writeCall = [{ name: 'submit', args: { 单号: 'A1' } }]

  it('只读档：写工具直接拒，连确认卡都不弹', async () => {
    const callModel = scriptedModel([{ calls: writeCall }, { text: '已如实告知无法提交' }])
    const res = await runTurn(baseOpts({
      callModel, registry: regWith(tool('submit', async () => '提交成功', 'write')), permMode: 'readonly',
    }))
    expect(mockConfirm).not.toHaveBeenCalled()
    const toolMsg = res.messages.find(m => m.role === 'tool')
    expect(toolMsg?.status).toBe('denied')
    expect(toolMsg?.content).toContain('只读模式')
  })

  it('无人值守：写工具不执行——绝不替用户签字', async () => {
    const callModel = scriptedModel([{ calls: writeCall }, { text: '需要人工确认' }])
    const res = await runTurn(baseOpts({
      callModel, registry: regWith(tool('submit', async () => '提交成功', 'write')), unattended: true,
    }))
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(res.messages.find(m => m.role === 'tool')?.content).toContain('无人值守')
  })

  it('写工具必须过签字闸——与用户怎么措辞无关（旧词表的漏洞在此被堵住）', async () => {
    mockConfirm.mockResolvedValue({ values: { ok: '1' }, tokenState: 'consumed' })
    const run = vi.fn(async () => '提交成功')
    const callModel = scriptedModel([{ calls: writeCall }, { text: '已提交' }])
    await runTurn(baseOpts({ callModel, registry: regWith(tool('submit', run, 'write')) }))
    expect(mockConfirm).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
    // 确认卡必须摆出决定后果的参数，用户才有得核对
    const fields = mockConfirm.mock.calls[0][0] as { name: string; value: string }[]
    expect(fields.find(f => f.name === '单号')?.value).toBe('A1')
  })

  it('令牌被拒（过期/重放/表单变更）→ 中止执行', async () => {
    mockConfirm.mockResolvedValue({ values: null, tokenState: 'rejected', rejectReason: '已过期' })
    const run = vi.fn(async () => '提交成功')
    const callModel = scriptedModel([{ calls: writeCall }, { text: '未能提交' }])
    const res = await runTurn(baseOpts({ callModel, registry: regWith(tool('submit', run, 'write')) }))
    expect(run).not.toHaveBeenCalled()
    expect(res.messages.find(m => m.role === 'tool')?.content).toContain('已过期')
  })

  it('用户取消 → 不执行，并提示模型别重复发起', async () => {
    mockConfirm.mockResolvedValue({ values: null, tokenState: 'cancelled' })
    const run = vi.fn(async () => '提交成功')
    const callModel = scriptedModel([{ calls: writeCall }, { text: '好的' }])
    const res = await runTurn(baseOpts({ callModel, registry: regWith(tool('submit', run, 'write')) }))
    expect(run).not.toHaveBeenCalled()
    expect(res.messages.find(m => m.role === 'tool')?.content).toContain('取消')
  })

  it('写工具串行、只读工具并发（防写操作的状态竞争）', async () => {
    mockConfirm.mockResolvedValue({ values: { ok: '1' }, tokenState: 'consumed' })
    const order: string[] = []
    const slow = (name: string) => tool(name, async () => {
      order.push(`${name}:start`)
      await new Promise(r => setTimeout(r, 10))
      order.push(`${name}:end`)
      return 'ok'
    })
    const w = tool('w', async () => { order.push('w:start'); order.push('w:end'); return 'ok' }, 'write')
    const callModel = scriptedModel([
      { calls: [{ name: 'r1' }, { name: 'r2' }, { name: 'w' }] },
      { text: '完成' },
    ])
    await runTurn(baseOpts({ callModel, registry: regWith(slow('r1'), slow('r2'), w) }))
    // 两个只读工具并发：r2 在 r1 结束前就开始了
    expect(order.indexOf('r2:start')).toBeLessThan(order.indexOf('r1:end'))
    // 写工具严格在自己的区间内完成
    expect(order.indexOf('w:end') - order.indexOf('w:start')).toBe(1)
  })
})

describe('执行计划的运行时纠偏', () => {
  /** 取某次模型调用时，出站消息里最后一条 user 的内容（ephemeral 上下文就拼在它尾部）。 */
  const lastUserAt = (callModel: any, n: number) => {
    const msgs = callModel.mock.calls[n][0] as { role: string; content: string }[]
    return [...msgs].reverse().find(m => m.role === 'user')?.content || ''
  }

  it('第二轮仍没列清单 → 上下文里当场提醒（静态提示词遵守率不够）', async () => {
    const callModel = scriptedModel([
      { text: '先查一下', calls: [{ name: 'search', args: { q: 'a' } }] },
      { text: '再查一下', calls: [{ name: 'search', args: { q: 'b' } }] },
      { text: '好了' },
    ])
    await runTurn(baseOpts({ callModel, registry: regWith(tool('search', async () => 'ok')) }))
    expect(lastUserAt(callModel, 0)).not.toContain('还没有列执行计划')   // 第一轮不打扰
    expect(lastUserAt(callModel, 1)).toContain('还没有列执行计划')       // 第二轮开始提醒
  })

  it('已经列了清单就不再唠叨', async () => {
    const callModel = scriptedModel([
      { calls: [{ name: TODO_TOOL_NAME, args: { todos: [{ content: '第一步', status: 'in_progress' }] } }] },
      { text: '先查一下', calls: [{ name: 'search', args: { q: 'a' } }] },
      { text: '好了' },
    ])
    await runTurn(baseOpts({
      callModel, registry: regWith(makeTodoToolSpec(), tool('search', async () => 'ok')),
    }))
    expect(lastUserAt(callModel, 1)).not.toContain('还没有列执行计划')
    expect(lastUserAt(callModel, 2)).not.toContain('还没有列执行计划')
  })
})

describe('todo_write 参数泄漏兜底（实测：整段 JSON 成了"最终答案"）', () => {
  it('剥出打头的 todos JSON 并照本意更新清单', () => {
    const r = extractLeakedTodos('[{"content":"联网调研：主流番茄钟产品","status":"done"},{"content":"产出报告","status":"done"}] 以下是报告…')
    expect(r?.todos).toHaveLength(2)
    expect(r?.todos[0].status).toBe('done')
    expect(r?.rest).toBe('以下是报告…')
  })

  it('content 里带 ] 也不截错（引号感知的括号匹配）', () => {
    const r = extractLeakedTodos('[{"content":"整理[附录]与图表","status":"pending"}]')
    expect(r?.todos[0].content).toBe('整理[附录]与图表')
    expect(r?.rest).toBe('')
  })

  it('普通 JSON 数组/正常文本不误伤', () => {
    expect(extractLeakedTodos('[1,2,3]')).toBeNull()
    expect(extractLeakedTodos('[{"name":"x"}]')).toBeNull()
    expect(extractLeakedTodos('调研完成，共三步。')).toBeNull()
  })

  it('剥空且无工具调用 → 不当最终答案，提醒后继续（清单同步更新）', async () => {
    const events: TurnEvent[] = []
    const callModel = scriptedModel([
      { text: '[{"content":"第一步","status":"done"},{"content":"第二步","status":"done"}]' },
      { text: '全部完成，这是给用户的总结。' },
    ])
    const res = await runTurn(baseOpts({ callModel, registry: regWith(), emit: e => events.push(e) }))
    expect(res.answer).toBe('全部完成，这是给用户的总结。')
    expect(res.todos.every(t => t.status === 'done')).toBe(true)
    expect(events.some(e => e.type === 'todo_updated')).toBe(true)
    // 提醒消息里明确要求自然语言答复
    const nudge = res.messages.find(m => m.role === 'user' && m.content.includes('不要输出 JSON'))
    expect(nudge).toBeTruthy()
  })

  it('JSON 后跟着正文 → 剥掉 JSON、正文即答案', async () => {
    const callModel = scriptedModel([
      { text: '[{"content":"调研","status":"done"}] 报告已完成，要点如下…' },
    ])
    const res = await runTurn(baseOpts({ callModel, registry: regWith() }))
    expect(res.answer).toBe('报告已完成，要点如下…')
    expect(res.todos[0].status).toBe('done')
  })
})

describe('清单收尾（实测：任务已回复，最后一项还在转圈）', () => {
  it('completed 时把 in_progress 标 done（模型忘了最后一次 todo_write）', async () => {
    const events: TurnEvent[] = []
    const callModel = scriptedModel([
      { calls: [{ name: TODO_TOOL_NAME, args: { todos: [
        { content: '检索', status: 'done' }, { content: '整理应答', status: 'in_progress' },
      ] } }] },
      { text: '这是最终答复。' },
    ])
    const res = await runTurn(baseOpts({ callModel, registry: regWith(makeTodoToolSpec()), emit: e => events.push(e) }))
    expect(res.todos.every(t => t.status === 'done')).toBe(true)
    // 收尾更新要有事件（渲染层靠它把转圈换成划掉）
    const updates = events.filter(e => e.type === 'todo_updated')
    expect(updates.length).toBeGreaterThanOrEqual(2)
  })

  it('步数耗尽不硬收（真没做完，如实保留 in_progress）', async () => {
    const callModel = scriptedModel([
      { calls: [{ name: TODO_TOOL_NAME, args: { todos: [{ content: 'x', status: 'in_progress' }] } }] },
      { calls: [{ name: 'loop', args: { n: 1 } }] },
      { calls: [{ name: 'loop', args: { n: 2 } }] },
    ])
    const res = await runTurn(baseOpts({
      callModel, registry: regWith(makeTodoToolSpec(), tool('loop', async () => '…')), maxIterations: 3,
    }))
    expect(res.status).toBe('max_iterations')
    expect(res.todos[0].status).toBe('in_progress')
  })
})

describe('收尾加固（实测：432 秒素材满仓，最后只落一句"未能完成"）', () => {
  it('全量收尾失败 → 精简重试（system+任务+最近5条工具结果）', async () => {
    let calls = 0
    const callModel = vi.fn(async (msgs: any[], tools: unknown[]) => {
      if ((tools as unknown[]).length) return { text: '', toolCalls: [{ id: `c${++calls}`, name: 'search', args: { n: calls }, argsRaw: '{}' }], finishReason: 'tool_calls' }
      calls++
      // 第一次收尾（全量）模拟超上下文失败；精简重试成功
      if (msgs.length > 8) throw new Error('context length exceeded')
      return { text: '基于已有素材的整理结果。', toolCalls: [], finishReason: 'stop' }
    })
    const res = await runTurn(baseOpts({
      callModel: callModel as any, registry: regWith(tool('search', async () => '素材'.repeat(50))), maxIterations: 3,
    }))
    expect(res.status).toBe('max_iterations')
    expect(res.answer).toBe('基于已有素材的整理结果。')
  })

  it('两次都失败 → 兜底文案诚实有用（带轮数/调用数与下一步建议）', async () => {
    const callModel = vi.fn(async (_m: unknown, tools: unknown[]) => {
      if ((tools as unknown[]).length) return { text: '', toolCalls: [{ id: `c${Math.random()}`, name: 'search', args: { n: Math.random() }, argsRaw: '{}' }], finishReason: 'tool_calls' }
      throw new Error('上游持续失败')
    })
    const res = await runTurn(baseOpts({
      callModel: callModel as any, registry: regWith(tool('search', async () => 'x')), maxIterations: 2,
    }))
    expect(res.answer).toContain('2 轮')
    expect(res.answer).toContain('深度调研')
    expect(res.answer).not.toBe('未能在限定步数内完成该任务。')
  })
})

describe('泄漏检测放宽（实测二次泄漏：键序 status 在前 / 围栏包裹）', () => {
  it('status 在 content 前也命中', () => {
    const r = extractLeakedTodos('[{"status":"completed","content":"执行深度调研"},{"status":"completed","content":"整理产出"}]')
    expect(r?.todos).toHaveLength(2)
    expect(r?.todos.every(t => t.status === 'done')).toBe(true)
  })
  it('```json 围栏包裹也命中并剥净', () => {
    const r = extractLeakedTodos('```json\n[{"content":"a","status":"done"}]\n``` 后续正文')
    expect(r?.todos).toHaveLength(1)
    expect(r?.rest).toBe('后续正文')
  })
  it('非 todos 的对象数组仍不误伤', () => {
    expect(extractLeakedTodos('[{"name":"x","value":1}]')).toBeNull()
  })
})

describe('收尾路径的泄漏剥离 + 技能微计划（实测：275秒预算耗尽，收尾吐 JSON、清单空转）', () => {
  it('wrapUp 收尾吐 todos JSON → 剥离并按模型声明更新清单', async () => {
    const events: TurnEvent[] = []
    const callModel = vi.fn(async (_m: unknown, tools: unknown[]) => {
      if ((tools as unknown[]).length) return { text: '', toolCalls: [{ id: `c${Math.random()}`, name: 'run_skill', args: { skillId: 'skill-x', n: Math.random() }, argsRaw: '{}' }], finishReason: 'tool_calls' }
      return { text: '[{"content":"执行调研","status":"completed"},{"content":"整理报告","status":"in_progress"}] 报告已生成，见文件。', toolCalls: [], finishReason: 'stop' }
    })
    const res = await runTurn(baseOpts({
      callModel: callModel as any, registry: regWith(tool('run_skill', async () => '技能完成')), maxIterations: 2,
      emit: e => events.push(e),
    }))
    expect(res.answer).toBe('报告已生成，见文件。')          // JSON 剥净
    expect(res.answer).not.toContain('"content"')
    // 给出了像样答案 → in_progress 收掉，不再转圈
    expect(res.todos.every(t => t.status === 'done')).toBe(true)
  })

  it('调 run_skill 且模型没列清单 → 内核补微计划，技能完成后自动推进', async () => {
    const events: TurnEvent[] = []
    const callModel = scriptedModel([
      { calls: [{ name: 'run_skill', args: { skillId: 'skill-imp-fcde6655' } }] },
      { text: '行情整理如下…' },
    ])
    const res = await runTurn(baseOpts({
      callModel, registry: regWith(tool('run_skill', async () => '技能结果')), emit: e => events.push(e),
    }))
    // 执行前：微计划出现（第一项 in_progress）
    const first = events.find(e => e.type === 'todo_updated') as any
    expect(first.todos[0].content).toContain('skill-imp-fcde6655')
    expect(first.todos[0].status).toBe('in_progress')
    // 完成后推进 + completed 收尾 → 全 done
    expect(res.todos.every(t => t.status === 'done')).toBe(true)
  })
})

describe('第四次泄漏（叙述句之后）与预算口径', () => {
  it('JSON 在叙述句后面也剥净（全文扫描，位置无关）', () => {
    const r = extractLeakedTodos('深度调研已完成，现在我来整理最终交付。\n\n[{"content":"产出报告","status":"completed"},{"content":"整理交付","status":"in_progress"}]')
    expect(r?.rest).toBe('深度调研已完成，现在我来整理最终交付。')
    expect(r?.todos).toHaveLength(2)
  })
  it('正文里的普通数组（非 todos）不误伤', () => {
    const r = extractLeakedTodos('对比数据：[1,2,3]，另见 [{"name":"x"}]。[{"content":"a","status":"done"}]')
    expect(r?.rest).toContain('[1,2,3]')
    expect(r?.rest).toContain('{"name":"x"}')
    expect(r?.todos?.[0].content).toBe('a')
  })
  it('工具执行时间不吃墙钟预算（技能跑 10 分钟也不该被迫走收尾）', async () => {
    let now = 0
    const realNow = Date.now
    Date.now = () => now
    try {
      const callModel = scriptedModel([
        { calls: [{ name: 'run_skill', args: { skillId: 's' } }] },
        { text: '正常答案。' },
      ])
      const res = await runTurn(baseOpts({
        callModel,
        registry: regWith(tool('run_skill', async () => { now += 600_000; return '技能结果' })),   // 模拟跑 10 分钟
        budgetMs: 330_000,
      }))
      expect(res.status).toBe('completed')     // 不再 budget_exceeded
      expect(res.answer).toBe('正常答案。')
    } finally { Date.now = realNow }
  })
})
