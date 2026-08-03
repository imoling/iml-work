import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// chatStore 多会话状态机测试——bug 高发区（气泡消失、并发路由都出在这里）。
// mock window.api + peer stores，只驱动纯前端状态迁移，不启 electron。

// peer stores 桩：loadMessages/sendMessage 会读它们，给最小实现
vi.mock('./userStore', () => ({
  useUserStore: { getState: () => ({ claimedExpertId: 'exp-1', getCurrentExpertName: () => '小璇', userBackground: '', userNickname: '康Sir', llmConnectionMode: 'proxy', llmApiMode: 'chat', llmBaseUrl: '', llmApiKey: '', llmModelName: '' }) },
}))
vi.mock('./historyStore', () => ({
  useHistoryStore: { getState: () => ({ activeConversationId: null, createConversation: async () => 'conv-new' }) },
}))

// window.api 桩：可编排 db:msg-list 的返回时机（模拟 DB 读迟到）
let msgListImpl: (convId: string) => Promise<any[]> = async () => []
const invoke = vi.fn(async (channel: string, ...args: any[]) => {
  if (channel === 'db:msg-list') return msgListImpl(args[0])
  return undefined
})
;
// on 记下处理器：测主进程事件（表单卡等）时要能手动触发
const handlers = new Map<string, (d: any) => void>()
;(globalThis as any).window = {
  api: { invoke, on: (ch: string, fn: (d: any) => void) => { handlers.set(ch, fn); return () => handlers.delete(ch) } },
}

import { useChatStore } from './chatStore'

const reset = () => useChatStore.setState({
  messages: [], viewConvId: null, generatingConvs: {}, unreadConvs: {}, runQueue: [],
  convCache: {}, convLogs: {}, convEpoch: {}, activeCliForm: null, cliFormData: {}, cliCurrentFieldIndex: 0,
})

describe('loadMessages 竞态守卫（气泡消失回归）', () => {
  beforeEach(() => { reset(); msgListImpl = async () => [] })

  it('DB 读迟到期间会话开跑并被查看 → 空结果不覆盖乐观消息（await 后复核守卫）', async () => {
    // 入口：查看 conv-A、未生成 → 早期守卫不拦，进入 await；期间会话开跑 + 乐观消息上屏。
    useChatStore.setState({ viewConvId: 'conv-A', generatingConvs: {}, messages: [] })
    let release!: (v: any[]) => void
    msgListImpl = () => new Promise(res => { release = res })
    const p = useChatStore.getState().loadMessages('conv-A')
    // await 期间：发消息把会话置为生成中并乐观上屏
    useChatStore.setState({
      generatingConvs: { 'conv-A': true },
      messages: [{ id: 'opt-user', sender: 'user', content: '你好', timestamp: '' }],
    })
    release([])                    // DB 迟到返回空表
    await p
    // await 后复核：生成中且正被查看 → 跳过写屏，乐观消息仍在
    expect(useChatStore.getState().messages.map(m => m.id)).toContain('opt-user')
  })

  it('后发起的加载令先发起的过期结果作废（乱序覆盖防护）', async () => {
    useChatStore.setState({ viewConvId: 'conv-A', messages: [] })
    // 第一次加载 A（慢），返回旧内容
    let releaseA!: (v: any[]) => void
    msgListImpl = () => new Promise(res => { releaseA = res })
    const pA = useChatStore.getState().loadMessages('conv-A')
    // 期间切到 B（快），返回 B 内容
    msgListImpl = async () => [{ id: 'mB', conversation_id: 'conv-B', role: 'user', content: 'B内容', created_at: 2 }]
    await useChatStore.getState().loadMessages('conv-B')
    expect(useChatStore.getState().viewConvId).toBe('conv-B')
    // A 的迟到结果现在回来 → 应被 loadSeq 判过期丢弃，不把屏幕盖回 A
    releaseA([{ id: 'mA', conversation_id: 'conv-A', role: 'user', content: 'A内容', created_at: 1 }])
    await pA
    expect(useChatStore.getState().viewConvId).toBe('conv-B')
    expect(useChatStore.getState().messages.map(m => m.id)).toEqual(['mB'])
  })

  it('切到空会话即清屏', async () => {
    useChatStore.setState({ viewConvId: 'conv-A', messages: [{ id: 'x', sender: 'user', content: 'x', timestamp: '' }] })
    await useChatStore.getState().loadMessages(null)
    expect(useChatStore.getState().messages).toEqual([])
    expect(useChatStore.getState().viewConvId).toBeNull()
  })

  it('生成中会话切走时把在屏消息缓存，切回可恢复', async () => {
    useChatStore.setState({
      viewConvId: 'conv-A', generatingConvs: { 'conv-A': true },
      messages: [{ id: 'live', sender: 'assistant', content: '生成中…', timestamp: '' }],
    })
    await useChatStore.getState().loadMessages('conv-B')   // 切走
    expect(useChatStore.getState().convCache['conv-A']?.map(m => m.id)).toEqual(['live'])
  })

  it('切走时屏上有待确认表单 → 该会话标黄点（需人工介入）', async () => {
    useChatStore.setState({
      viewConvId: 'conv-A', generatingConvs: { 'conv-A': true },
      messages: [{ id: 'f', sender: 'assistant', content: '', timestamp: '', formRequest: { fields: [] } as any, formSubmitted: false }],
    })
    await useChatStore.getState().loadMessages('conv-B')
    expect(useChatStore.getState().unreadConvs['conv-A']).toBe('attention')
  })
})

describe('停止任务后迟到结果的丢弃（答复晚到回归）', () => {
  // 真实事故序列（2026-08-02）：停掉"画手抄报" → 追问"画个小女孩" → 小女孩答复先到，
  // 手抄报的答复随后冒出来插在它后面。根因是"已停止"按会话存布尔值、被新一轮 sendMessage 重置。
  // 必须**真的连发两次**才能复现——第二次发送里的重置正是病灶，用 setState 假造就测不出来。
  let resolvers: ((v: any) => void)[] = []
  beforeEach(() => {
    reset(); msgListImpl = async () => []; resolvers = []
    invoke.mockImplementation(async (channel: string, ...args: any[]) => {
      if (channel === 'db:msg-list') return msgListImpl(args[0])
      if (channel === 'turn:send-message') return new Promise(res => { resolvers.push(res) })
      return undefined
    })
    useChatStore.setState({ viewConvId: 'conv-A' })
  })
  const replies = () => useChatStore.getState().messages.filter(m => m.sender === 'assistant').map(m => m.content)

  it('停止 → 同会话再发一条 → 被停任务的迟到结果不得上屏', async () => {
    const runA = useChatStore.getState().sendMessage('画个庆国庆的手抄报', { convId: 'conv-A' })
    await Promise.resolve(); await Promise.resolve()
    useChatStore.getState().cancelTask()                                   // ← 用户点停止

    const runB = useChatStore.getState().sendMessage('画个小女孩', { convId: 'conv-A' })
    await Promise.resolve(); await Promise.resolve()
    expect(resolvers.length).toBe(2)                                       // 两轮都真跑起来了

    resolvers[1]({ content: '已经画好啦·小女孩' })                            // 新任务先返回
    await runB
    resolvers[0]({ content: '已经画好啦·被停任务的答复' })                     // 被停的那轮此刻才返回
    await runA

    expect(replies().some(t => t.includes('小女孩'))).toBe(true)
    expect(replies().some(t => t.includes('被停任务的答复'))).toBe(false)
  })

  it('迟到的作废结果不得清掉新一轮的生成态', async () => {
    // 旧实现在丢弃分支里调 settleConv()，会把此刻已归新一轮所有的 generatingConvs 清空，
    // 表现为新任务还在跑、界面却显示已结束。
    const runA = useChatStore.getState().sendMessage('第一个任务', { convId: 'conv-A' })
    await Promise.resolve(); await Promise.resolve()
    useChatStore.getState().cancelTask()
    useChatStore.getState().sendMessage('第二个任务', { convId: 'conv-A' })
    await Promise.resolve(); await Promise.resolve()

    resolvers[0]({ content: '旧任务的迟到答复' })                             // 只让被停的那轮返回
    await runA

    expect(useChatStore.getState().generatingConvs['conv-A']).toBe(true)   // 新一轮仍在跑
  })
})

describe('停止任务的可见反馈', () => {
  let stop: (() => void) | undefined
  afterEach(() => { stop?.() })
  beforeEach(() => {
    reset(); handlers.clear(); stop = useChatStore.getState().initIpcListeners()
    invoke.mockImplementation(async (channel: string, ...args: any[]) => {
      if (channel === 'db:msg-list') return msgListImpl(args[0])
      if (channel === 'turn:send-message') return new Promise(() => {})   // 永不返回，模拟在途
      return undefined
    })
    useChatStore.setState({ viewConvId: 'conv-A' })
  })

  it('停止后对话里留下明确标识', async () => {
    // 实测反馈：点了停止，屏幕上只是转圈没了，没有任何一句话说明发生过什么，
    // 事后回看不知道是被停掉的还是自己跑完的。
    useChatStore.getState().sendMessage('长任务', { convId: 'conv-A' })
    await Promise.resolve(); await Promise.resolve()
    await useChatStore.getState().cancelTask()
    const sys = useChatStore.getState().messages.filter(m => m.sender === 'system')
    expect(sys.some(m => m.content.includes('已停止本次任务'))).toBe(true)
  })

  it('被停止关掉的表单卡不得显示成"已完成确认"', async () => {
    useChatStore.getState().sendMessage('长任务', { convId: 'conv-A' })
    await Promise.resolve(); await Promise.resolve()
    handlers.get('agent:form-request')!({ runId: 'conv-A', fields: [], kind: 'ask' })
    await useChatStore.getState().cancelTask()
    const card = useChatStore.getState().messages.filter(m => m.formRequest).pop()!
    // 沿用绿勾"已完成确认"等于谎报：用户明明取消了
    expect(card.formCancelled).toBe(true)
  })
})

describe('提问卡片带上模型自己的说明（两个气泡合一）', () => {
  let stop: (() => void) | undefined
  beforeEach(() => {
    reset()
    handlers.clear()
    stop = useChatStore.getState().initIpcListeners()
    useChatStore.setState({
      viewConvId: 'conv-A', generatingConvs: { 'conv-A': true }, runQueue: ['conv-A'],
      turnRuns: { 'conv-A': { todos: [], tools: [], narration: '找到了两个候选仓库，来源不同，需要你确认装哪个：' } },
    })
  })
  afterEach(() => { stop?.() })

  const fire = (data: any) => handlers.get('agent:form-request')!({ runId: 'conv-A', fields: [], ...data })
  const lastCard = () => useChatStore.getState().messages.filter(m => m.formRequest).pop()!

  it('提问卡用模型的叙述，而不是通用样板话', () => {
    // 病灶：真正有信息量的那句只出现在「执行中」临时气泡里，卡片显示样板话，
    // 屏幕上两个气泡各说一半，且临时气泡在任务结束后消失。
    fire({ kind: 'ask' })
    expect(lastCard().content).toContain('找到了两个候选仓库')
    expect(lastCard().content).not.toContain('执行中有一个问题需要你回答')
  })

  it('澄清卡同样生效', () => {
    fire({ kind: 'clarify' })
    expect(lastCard().content).toContain('找到了两个候选仓库')
  })

  it('写操作签字卡**不得**被塞进旁白', () => {
    // 回归钉子：签字卡的 kind 是 undefined 而非 "confirm"，用排除法写会漏。
    // 那张卡讲的是"将要改动什么"，掺进模型旁白会稀释用户真正该核对的东西。
    fire({ kind: undefined })
    expect(lastCard().content).not.toContain('找到了两个候选仓库')
    expect(lastCard().content).toContain('确认表单信息')
  })

  it('模型没叙述时退回样板话', () => {
    useChatStore.setState({ turnRuns: { 'conv-A': { todos: [], tools: [], narration: '' } } })
    fire({ kind: 'ask' })
    expect(lastCard().content).toContain('执行中有一个问题需要你回答')
  })
})
