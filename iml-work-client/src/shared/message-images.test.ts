import { describe, it, expect } from 'vitest'
import { currentTurnImageIdx } from './message-images'
import type { CoreMessage } from './core-protocol'

const u = (content: string, imagePaths?: string[]): CoreMessage =>
  ({ role: 'user', content, ts: 0, ...(imagePaths ? { imagePaths } : {}) }) as CoreMessage
const a = (content: string): CoreMessage => ({ role: 'assistant', content, ts: 0 }) as CoreMessage
const t = (content: string): CoreMessage => ({ role: 'tool', content, ts: 0, toolCallId: 'x' }) as CoreMessage

// 实测事故（2026-08-03）：贴过一张截图后，同会话后续每一轮都在重发那张图（出站 236KB）
// 并被路由到视觉档，而视觉模型工具调用弱 → 技能跑完合成返回空 → 界面报"助手返回了空响应"。
describe('本轮该不该发图片', () => {
  it('当前轮带图 → 发', () => {
    expect(currentTurnImageIdx([u('看这张'), a('好'), u('介绍下', ['/a.png'])])).toBe(2)
  })

  it('当前轮没带图 → 不发，哪怕历史里有图（一次贴图不该永久生效）', () => {
    expect(currentTurnImageIdx([u('介绍下', ['/a.png']), a('这是…'), u('画个大漠孤烟直')])).toBe(-1)
  })

  it('工具循环中间态：user 之后的 assistant/tool 不影响判定', () => {
    expect(currentTurnImageIdx([u('介绍下', ['/a.png']), a(''), t('结果')])).toBe(0)
  })

  it('同一轮的工具循环里，图片仍然发（锚点还是那条 user）', () => {
    const msgs = [u('旧图', ['/old.png']), a(''), u('新图', ['/new.png']), a(''), t('r')]
    expect(currentTurnImageIdx(msgs)).toBe(2)
  })

  it('没有 user 消息 → -1', () => {
    expect(currentTurnImageIdx([a('hi')])).toBe(-1)
  })
})
