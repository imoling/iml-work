// 事件流 → 展示态归约的单测。重点钉住顺序与丢包的边界：
// 这套规则同时服务「实时视图」与「刷新回放」，错一处两边就长得不一样。
import { describe, it, expect } from 'vitest'
import { applyTurnEvent, toSnapshot, turnStats, EMPTY_TURN_RUN, type CoreRunState } from './core-state'
import type { CoreEvent } from '../../../shared/core-protocol'

const R = 'conv-1'
const call = (id: string, name = 'web_search', args: any = { query: 'x' }) => ({ id, name, args })

/** 依次把一串事件并进初始态。 */
function reduce(events: CoreEvent[], init: CoreRunState = EMPTY_TURN_RUN): CoreRunState {
  return events.reduce(applyTurnEvent, init)
}

describe('applyTurnEvent', () => {
  it('turn_start 重置为空态（重跑同一会话不残留上一轮）', () => {
    const dirty: CoreRunState = { todos: [{ content: 'old', status: 'done' }], tools: [], narration: '旧的' }
    expect(applyTurnEvent(dirty, { type: 'turn_start', runId: R })).toEqual(EMPTY_TURN_RUN)
  })

  it('工具在 proposed 时就上屏——写工具等签字的那段时间界面不能像卡死', () => {
    const s = reduce([{ type: 'tool_proposed', runId: R, call: call('c1') }])
    expect(s.tools).toHaveLength(1)
    // 上屏但是 queued：此刻它一步都没开始（等授权 / 排在别的调用后面）
    expect(s.tools[0]).toMatchObject({ callId: 'c1', name: 'web_search', status: 'queued' })
  })

  it('tool_started 才转 running——排队中的调用不能画成正在跑', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('c1') },
      { type: 'tool_proposed', runId: R, call: call('c2', 'python', { code: '1+1' }) },
      { type: 'tool_started', runId: R, callId: 'c1', name: 'web_search' },
    ])
    expect(s.tools[0].status).toBe('running')
    expect(s.tools[1].status).toBe('queued')      // 串行排队的那个仍是 queued
  })

  it('tool_started 不会把已完成的行拉回 running（事件乱序时的防御）', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('c1') },
      { type: 'tool_finished', runId: R, callId: 'c1', name: 'web_search', status: 'ok', preview: 'x' },
      { type: 'tool_started', runId: R, callId: 'c1', name: 'web_search' },
    ])
    expect(s.tools[0].status).toBe('ok')
  })

  it('同一 callId 重复 proposed 不重复上屏', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('c1') },
      { type: 'tool_proposed', runId: R, call: call('c1') },
    ])
    expect(s.tools).toHaveLength(1)
  })

  it('finished 更新对应那行，不影响其他行', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('c1') },
      { type: 'tool_proposed', runId: R, call: call('c2', 'python', { code: '1+1' }) },
      { type: 'tool_finished', runId: R, callId: 'c2', name: 'python', status: 'ok', preview: 'stdout:2' },
    ])
    expect(s.tools[0].status).toBe('queued')
    expect(s.tools[1]).toMatchObject({ status: 'ok', preview: 'stdout:2' })
  })

  it('没见过 proposed 就来 finished（事件丢失/乱序）→ 补一行，不吞掉这次调用', () => {
    const s = reduce([{ type: 'tool_finished', runId: R, callId: 'ghost', name: 'python', status: 'error', preview: '炸了' }])
    expect(s.tools).toHaveLength(1)
    expect(s.tools[0]).toMatchObject({ callId: 'ghost', status: 'error', preview: '炸了' })
  })

  it('被拒的写工具保留在轨迹里（状态 denied）——用户要看得见"它想做但被拦了"', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('c1', 'submit', { 单号: 'A1' }) },
      { type: 'tool_finished', runId: R, callId: 'c1', name: 'submit', status: 'denied', preview: '只读模式：已拦截', reason: '只读模式' },
    ])
    expect(s.tools[0].status).toBe('denied')
  })

  it('todo_updated 整表替换（模型每次都传全量清单）', () => {
    const s = reduce([
      { type: 'todo_updated', runId: R, todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }] },
      { type: 'todo_updated', runId: R, todos: [{ content: 'a', status: 'done' }] },
    ])
    expect(s.todos).toEqual([{ content: 'a', status: 'done' }])
  })

  it('narration 在任务结束时撤掉（"正在做什么"不该留在已完成的任务上）', () => {
    const running = reduce([{ type: 'narration', runId: R, text: '正在检索' }])
    expect(running.narration).toBe('正在检索')
    for (const ev of [
      { type: 'turn_end', runId: R, status: 'completed', iterations: 2 },
      { type: 'interrupted', runId: R, iterations: 1 },
      { type: 'error', runId: R, message: 'x' },
    ] as CoreEvent[]) {
      expect(applyTurnEvent(running, ev).narration).toBe('')
    }
  })

  it('无关事件返回原对象（引用相等 → 调用方可跳过重渲染）', () => {
    const s: CoreRunState = { todos: [], tools: [], narration: '' }
    expect(applyTurnEvent(s, { type: 'iteration_end', runId: R, iteration: 1 })).toBe(s)
    expect(applyTurnEvent(s, { type: 'assistant_message', runId: R, text: 'x', toolCalls: [] })).toBe(s)
  })

  it('turn_end 记下真实轮数（状态栏统计的口径，不能用日志条数冒充）', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('c1') },
      { type: 'tool_proposed', runId: R, call: call('c2', 'todo_write', { todos: [] }) },
      { type: 'turn_end', runId: R, status: 'completed', iterations: 7 },
    ])
    expect(s.iterations).toBe(7)
    // todo_write 是清单维护，不该算进"调用了几次工具"
    expect(turnStats(s)).toEqual({ iterations: 7, toolCalls: 1, subSteps: 0 })
  })
})

describe('toSnapshot', () => {
  it('丢掉只在执行期有意义的叙述', () => {
    const snap = toSnapshot({ todos: [{ content: 'a', status: 'done' }], tools: [], narration: '正在…' })
    expect(snap).toEqual({ todos: [{ content: 'a', status: 'done' }], tools: [] })
  })
  it('空过程 → undefined（普通问答不该挂个空壳卡片）', () => {
    expect(toSnapshot(EMPTY_TURN_RUN)).toBeUndefined()
    expect(toSnapshot(undefined)).toBeUndefined()
  })
})

describe('tool_progress（工具内部流水，单一数据源）', () => {
  it('流水挂到对应工具行的 progress 上', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('c1', 'run_skill', { skillId: 'x' }) },
      { type: 'tool_progress', runId: R, callId: 'c1', log: { type: 'thinking', text: '拉取技能定义', timestamp: 't1' } },
      { type: 'tool_progress', runId: R, callId: 'c1', log: { type: 'acting', text: '沙箱执行', timestamp: 't2' } },
    ])
    expect(s.tools[0].progress).toHaveLength(2)
    expect(s.tools[0].progress![1].text).toBe('沙箱执行')
  })

  it('行不存在（事件乱序）→ 丢弃流水，不凭空造行', () => {
    const s = reduce([{ type: 'tool_progress', runId: R, callId: 'ghost', log: { type: 'thinking', text: 'x', timestamp: 't' } }])
    expect(s.tools).toHaveLength(0)
  })

  it('落库前给子分身瘦身：丢内部流水，保留步骤与结论', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('p1', 'run_subagent', { task: 't' }) },
      { type: 'agent_started', runId: R, agentId: 'a1', label: '查A', parentCallId: 'p1' },
      { type: 'tool_proposed', runId: R, agentId: 'a1', call: call('s1') },
      { type: 'tool_progress', runId: R, agentId: 'a1', callId: 's1', log: { type: 'acting', text: '正在细读…', timestamp: 't' } },
      { type: 'tool_finished', runId: R, agentId: 'a1', callId: 's1', name: 'web_search', status: 'ok', preview: '6 条结果' },
      { type: 'agent_finished', runId: R, agentId: 'a1', status: 'ok', summary: '结论内容' },
    ])
    // 实时态里流水是在的（执行当时要看）
    expect(s.tools[0].subTools![0].progress).toHaveLength(1)
    const snap = toSnapshot(s)!
    // 落库后流水丢掉（事后没有追溯价值），但步骤、结果节选、结论都要留
    expect(snap.tools[0].subTools![0].progress).toBeUndefined()
    expect(snap.tools[0].subTools![0].name).toBe('web_search')
    expect(snap.tools[0].subTools![0].preview).toBe('6 条结果')
    expect(snap.tools[0].subSummary).toBe('结论内容')
  })

  it('主分身自己那层的 progress 不瘦身——「执行详情」点开就要看它', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('c1') },
      { type: 'tool_progress', runId: R, callId: 'c1', log: { type: 'acting', text: 'x', timestamp: 't' } },
    ])
    expect(toSnapshot(s)!.tools[0].progress).toHaveLength(1)
  })

  it('progress 随快照落库（回放要和实时长一样）', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('c1') },
      { type: 'tool_progress', runId: R, callId: 'c1', log: { type: 'acting', text: 'p', timestamp: 't' } },
    ])
    expect(toSnapshot(s)?.tools[0].progress).toHaveLength(1)
  })
})

describe('子智能体事件（带 agentId 的事件归位到发起它的那一行）', () => {
  /** 一个跑起来的子智能体：父行上屏 → agent_started 建立归属 → 子工具若干。 */
  const started = (): CoreEvent[] => [
    { type: 'tool_proposed', runId: R, call: call('p1', 'run_subagent', { task: '查竞品B', label: '竞品B动向' }) },
    { type: 'agent_started', runId: R, agentId: 'p1-a1', label: '竞品B动向', parentCallId: 'p1' },
  ]

  it('子工具行嵌进父行的 subTools，不平铺进主轨迹', () => {
    const s = reduce([
      ...started(),
      { type: 'tool_proposed', runId: R, agentId: 'p1-a1', call: call('s1') },
      { type: 'tool_finished', runId: R, agentId: 'p1-a1', callId: 's1', name: 'web_search', status: 'ok', preview: '6 条' },
    ])
    expect(s.tools).toHaveLength(1)                       // 主轨迹仍只有「派子智能体」这一行
    expect(s.tools[0].subTools).toHaveLength(1)
    expect(s.tools[0].subTools![0]).toMatchObject({ callId: 's1', status: 'ok', preview: '6 条' })
  })

  it('子智能体的叙述不抢主分身的进度行', () => {
    const s = reduce([
      ...started(),
      { type: 'narration', runId: R, text: '我在汇总三家的结论' },
      { type: 'narration', runId: R, agentId: 'p1-a1', text: '正在细读：某篇报道' },
    ])
    expect(s.narration).toBe('我在汇总三家的结论')        // 主分身的那句还在
    expect(s.tools[0].subNarration).toBe('正在细读：某篇报道')
  })

  it('agent_finished 落结论并撤掉叙述', () => {
    const s = reduce([
      ...started(),
      { type: 'narration', runId: R, agentId: 'p1-a1', text: '正在读' },
      { type: 'agent_finished', runId: R, agentId: 'p1-a1', status: 'ok', summary: '竞品B 在 Q2 发布了…' },
    ])
    expect(s.tools[0].subSummary).toContain('Q2')
    expect(s.tools[0].subNarration).toBe('')
  })

  it('归属未知（agent_started 丢失）→ 丢弃子事件，不在主轨迹里造孤儿行', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('p1', 'run_subagent', { task: 't' }) },
      { type: 'tool_proposed', runId: R, agentId: 'ghost', call: call('s1') },
    ])
    expect(s.tools).toHaveLength(1)
    expect(s.tools[0].subTools).toBeUndefined()
  })

  it('两个子智能体各归各的父行，不串号', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('p1', 'run_subagent', { task: 'A' }) },
      { type: 'agent_started', runId: R, agentId: 'p1-a1', label: 'A', parentCallId: 'p1' },
      { type: 'tool_proposed', runId: R, call: call('p2', 'run_subagent', { task: 'B' }) },
      { type: 'agent_started', runId: R, agentId: 'p2-a1', label: 'B', parentCallId: 'p2' },
      { type: 'tool_proposed', runId: R, agentId: 'p1-a1', call: call('s1') },
      { type: 'tool_proposed', runId: R, agentId: 'p2-a1', call: call('s2') },
      { type: 'tool_proposed', runId: R, agentId: 'p2-a1', call: call('s3') },
    ])
    expect(s.tools[0].subTools).toHaveLength(1)
    expect(s.tools[1].subTools).toHaveLength(2)
  })

  it('归属表随快照落库——否则刷新回放时子工具行全部无处归位', () => {
    const s = reduce([
      ...started(),
      { type: 'tool_proposed', runId: R, agentId: 'p1-a1', call: call('s1') },
    ])
    const snap = toSnapshot(s)
    expect(snap?.agents).toEqual({ 'p1-a1': 'p1' })
    // 回放：把快照当初始态重放同一批事件，结果要与实时一致
    const replayed = reduce([{ type: 'tool_progress', runId: R, agentId: 'p1-a1', callId: 's1', log: { type: 'acting', text: 'x', timestamp: 't' } }],
      { ...snap!, narration: '' } as CoreRunState)
    expect(replayed.tools[0].subTools![0].progress).toHaveLength(1)
  })

  it('子智能体的工具调用不计入主分身的工具调用数（口径与后端审计一致）', () => {
    const s = reduce([
      ...started(),
      { type: 'tool_proposed', runId: R, agentId: 'p1-a1', call: call('s1') },
      { type: 'tool_proposed', runId: R, agentId: 'p1-a1', call: call('s2') },
      { type: 'turn_end', runId: R, status: 'completed', iterations: 3 },
    ])
    // toolCalls 是**主分身口径**（要与后端审计对得上）；小分身的步数单独一项，
    // 否则用户看到「1 次工具调用」却等了两分钟，账对不上。
    expect(turnStats(toSnapshot(s))).toEqual({ iterations: 3, toolCalls: 1, subSteps: 2 })
  })
})

describe('humanizeStep：内部流水 → 第一人称拟人短句', async () => {
  const { humanizeStep } = await import('../components/dialogue/humanize')
  it('实测那条"跳过旧文"转成人话且不丢事实', () => {
    const out = humanizeStep('跳过旧文：《合肥今日天气|大风|雷暴|气象台|省气象局|强对流_网易新闻》页面发布于 2024-08-08，与询问的时间范围不符')
    expect(out).toContain('旧文')
    expect(out).toContain('合肥今日天气')
    expect(out).toContain('跳过')
    expect(out.length).toBeLessThan(40)
  })
  it('检索战果与轮次笔记', () => {
    expect(humanizeStep('搜到 6 条结果，细读成功 4 篇。')).toBe('搜到 6 条结果，我挑了 4 篇细看')
    expect(humanizeStep('第2轮：提炼 6 条事实笔记（累计 30 条）')).toContain('第 2 轮读完')
  })
  it('未覆盖模式：去技术前缀原样截断，不硬编', () => {
    expect(humanizeStep('[技能执行] 识别到自定义技能 "xxx"')).not.toContain('[技能执行]')
  })
})

describe('parseCsvLite（CSV 应用内预览）', async () => {
  const { parseCsvLite } = await import('../components/dialogue/csv-lite')
  it('引号字段：内含逗号/换行/转义引号都不切错', () => {
    const p = parseCsvLite('代码,名称,备注\n600519,"贵州,茅台","他说""稳""\n继续持有"\n000001,平安银行,')
    expect(p.headers).toEqual(['代码', '名称', '备注'])
    expect(p.rows[0]).toEqual(['600519', '贵州,茅台', '他说"稳"\n继续持有'])
    expect(p.totalRows).toBe(2)
  })
  it('超行截断且如实标注', () => {
    const big = 'a,b\n' + Array.from({ length: 250 }, (_, i) => `${i},x`).join('\n')
    const p = parseCsvLite(big)
    expect(p.rows).toHaveLength(200)
    expect(p.totalRows).toBe(250)
    expect(p.truncated).toBe(true)
  })
})

describe('跨岗位协作（agent teams）的展示态', () => {
  it('agent_started 带 kind=expert → 行上标出是"请教的岗位"而不是自己的小分身', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('p1', 'consult_expert', { expertId: 'expert-legal', question: '有风险吗' }) },
      { type: 'agent_started', runId: R, agentId: 'c1', label: '法务专员 · 合同风险', parentCallId: 'p1', kind: 'expert' },
    ])
    expect(s.tools[0].agentKind).toBe('expert')
    expect(s.tools[0].agentLabel).toContain('法务专员')
  })

  it('不带 kind 的老事件按小分身处理（向后兼容，不崩不错标）', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('p1', 'run_subagent', { task: 'x' }) },
      { type: 'agent_started', runId: R, agentId: 'a1', label: '查A', parentCallId: 'p1' },
    ])
    expect(s.tools[0].agentKind).toBe('sub')
  })

  it('协作岗位的意见与轨迹同样归位到发起它的那一行', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('p1', 'consult_expert', { expertId: 'expert-legal', question: 'q' }) },
      { type: 'agent_started', runId: R, agentId: 'c1', label: '法务专员', parentCallId: 'p1', kind: 'expert' },
      { type: 'tool_proposed', runId: R, agentId: 'c1', call: call('s1', 'search_knowledge', { query: '合同审查' }) },
      { type: 'agent_finished', runId: R, agentId: 'c1', status: 'ok', summary: '结论：付款条款有风险' },
    ])
    expect(s.tools).toHaveLength(1)
    expect(s.tools[0].subTools).toHaveLength(1)
    expect(s.tools[0].subSummary).toContain('付款条款')
  })

  it('小分身与协作岗位混在一轮里，各自归各自的行', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('p1', 'run_subagent', { task: 'a' }) },
      { type: 'agent_started', runId: R, agentId: 'a1', label: '查市场', parentCallId: 'p1' },
      { type: 'tool_proposed', runId: R, call: call('p2', 'consult_expert', { expertId: 'expert-legal', question: 'q' }) },
      { type: 'agent_started', runId: R, agentId: 'c1', label: '法务专员', parentCallId: 'p2', kind: 'expert' },
      { type: 'tool_proposed', runId: R, agentId: 'a1', call: call('s1') },
      { type: 'tool_proposed', runId: R, agentId: 'c1', call: call('s2') },
    ])
    expect(s.tools[0].agentKind).toBe('sub')
    expect(s.tools[1].agentKind).toBe('expert')
    expect(s.tools[0].subTools).toHaveLength(1)
    expect(s.tools[1].subTools).toHaveLength(1)
  })
})
