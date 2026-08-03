// 「本轮该不该把图片发给模型」的判定。**纯函数**，主进程与测试共用
// （llm.ts 依赖 electron 的 app.getPath，没法在纯 Node 下 import）。
import type { CoreMessage } from './core-protocol'

/**
 * 本轮真正该发送图片的那条消息下标（没有则 -1）。**只认当前这一轮**。
 *
 * 成本理由：一张 1024×1024 约 1000+ token，每轮重传历史图片，十轮下来光图片就上万 token——
 * 而模型早在第一轮就把图看过、观察也写进了对话里。
 *
 * 为什么必须锚在"最后一条 user 消息"而不是"最后一条**带图的** user 消息"：
 * 后者会让一次贴图**永久生效**——三轮前发过一张图，之后每一轮都在重发它，
 * 并且每轮都被判定为"本轮含图片"而路由到视觉档，哪怕当前请求跟图毫无关系。
 * 实测事故（2026-08-03）：贴过一张截图后，同会话里「画个大漠孤烟直」出站 236KB、
 * 被打到视觉档，而视觉模型工具调用弱，技能跑完的合成直接返回空 → 界面报"助手返回了空响应"。
 */
export function currentTurnImageIdx(messages: CoreMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    return messages[i].imagePaths?.length ? i : -1   // 最后一条 user 没带图 = 本轮不发图
  }
  return -1
}
