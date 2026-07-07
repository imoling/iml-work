import { describe, it, expect, beforeEach, vi } from 'vitest'

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
;(globalThis as any).window = { api: { invoke, on: () => () => {} } }

import { useChatStore } from './chatStore'

const reset = () => useChatStore.setState({
  messages: [], viewConvId: null, generatingConvs: {}, unreadConvs: {}, runQueue: [],
  convCache: {}, convLogs: {}, abortedConvs: {}, activeCliForm: null, cliFormData: {}, cliCurrentFieldIndex: 0,
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
