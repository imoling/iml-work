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
    expect(s.tools[0]).toMatchObject({ callId: 'c1', name: 'web_search', status: 'running' })
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
    expect(s.tools[0].status).toBe('running')
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
    expect(turnStats(s)).toEqual({ iterations: 7, toolCalls: 1 })
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

  it('progress 随快照落库（回放要和实时长一样）', () => {
    const s = reduce([
      { type: 'tool_proposed', runId: R, call: call('c1') },
      { type: 'tool_progress', runId: R, callId: 'c1', log: { type: 'acting', text: 'p', timestamp: 't' } },
    ])
    expect(toSnapshot(s)?.tools[0].progress).toHaveLength(1)
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
