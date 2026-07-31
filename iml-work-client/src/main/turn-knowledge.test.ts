// 寒暄快路径判定单测。判错的代价是不对称的：
// 判漏 → 一句「你好」走完整条管线（旧链路实测等半分钟）；判过 → 真任务被当寒暄敷衍过去。
// 所以宁可漏判也不能误判，用例按这个方向取。
import { describe, it, expect, vi } from 'vitest'

// corporate-rag → http → db → electron，本测试只要纯函数，整层桩掉。
vi.mock('./corporate-rag', () => ({ queryCorporateKnowledge: async () => [] }))

const { isTrivialMessage } = await import('./turn-knowledge')

describe('寒暄快路径', () => {
  it('单个寒暄词命中', () => {
    for (const q of ['你好', '您好', 'hi', '在吗', '你是谁', '谢谢', '晚安', 'ok', '再见']) {
      expect(isTrivialMessage(q)).toBe(true)
    }
  })

  it('组合寒暄句也命中（整句枚举会漏，所以按分段词元判）', () => {
    expect(isTrivialMessage('你好，你是谁')).toBe(true)
    expect(isTrivialMessage('你好！在吗？')).toBe(true)
  })

  it('真任务绝不能被当寒暄敷衍', () => {
    for (const q of [
      '你好，帮我查一下今天的待办',
      '查一下 A 股行情',
      '你是谁开发的产品有哪些功能',
      '介绍下自己公司的报销制度',
    ]) expect(isTrivialMessage(q)).toBe(false)
  })

  it('长消息一律不算寒暄（16 字上限）', () => {
    expect(isTrivialMessage('你好你好你好你好你好你好你好你好你好')).toBe(false)
    expect(isTrivialMessage('')).toBe(false)
  })
})
