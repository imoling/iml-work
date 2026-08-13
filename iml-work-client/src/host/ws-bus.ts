// Web 宿主的 IPC 总线：实现 IpcMainLike，把 ipc/*.ts 注册的同一批 handler 挂到 WebSocket RPC 上。
// 协议帧（JSON）：
//   渲染→宿主  { t:'invoke', id, channel, args[] }
//   宿主→渲染  { t:'result', id, ok, data|error } / { t:'event', channel, payload } / { t:'hello', ... }
import type { WebSocket } from 'ws'
import type { IpcHandler, IpcMainLike } from '../main/ipc-bus'

const WS_OPEN = 1

export class WsBus implements IpcMainLike {
  private handlers = new Map<string, IpcHandler>()
  private clients = new Set<WebSocket>()

  /** 回执送达失败（发起页已断开）时的兜底钩子——宿主用它把 turn 结果落库，浏览器刷新不丢回复。 */
  onOrphanResult: ((channel: string, args: unknown[], result: unknown) => void) | null = null

  handle(channel: string, listener: IpcHandler): void {
    if (this.handlers.has(channel)) {
      // 降级 stub 先注册占位，真实模块的同名通道让位（仅宿主策略；Electron 的 ipcMain 重复注册照旧抛错）
      console.warn(`[ws-bus] 通道已被降级 stub 占用，忽略后到注册: ${channel}`)
      return
    }
    this.handlers.set(channel, listener)
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws)
    ws.on('close', () => this.clients.delete(ws))
  }

  clientCount(): number { return this.clients.size }

  /** emitToRenderer 的 WS 形态：广播给所有已连页面（多标签≈多窗口）。 */
  broadcast(channel: string, payload?: unknown): void {
    let frame: string
    try { frame = JSON.stringify({ t: 'event', channel, payload }) } catch (e) {
      console.error(`[ws-bus] 事件序列化失败 ${channel}:`, e)
      return
    }
    // schedule:fire 是「接单」语义（收到的页面会发起执行）：多标签全播 = 同一定时任务跑 N 遍。
    // 只投给一个活连接；其余事件（日志/状态）照常全播。
    if (channel === 'schedule:fire') {
      for (const c of this.clients) {
        if (c.readyState === WS_OPEN) { try { c.send(frame) } catch (_) { /* 连接正在关闭 */ } return }
      }
      return
    }
    for (const c of this.clients) {
      if (c.readyState === WS_OPEN) { try { c.send(frame) } catch (_) { /* 连接正在关闭 */ } }
    }
  }

  async dispatch(ws: WebSocket, msg: { id: number; channel: string; args?: unknown[] }, allowed: ReadonlySet<string>): Promise<void> {
    const reply = (ok: boolean, body: unknown) => {
      let frame: string
      try { frame = JSON.stringify(ok ? { t: 'result', id: msg.id, ok, data: body } : { t: 'result', id: msg.id, ok, error: body }) } catch (e) {
        // 返回值 JSON 化失败（循环引用等）——如实报错，绝不静默吞掉让页面转圈
        frame = JSON.stringify({ t: 'result', id: msg.id, ok: false, error: `返回值无法序列化: ${(e as Error)?.message}` })
      }
      if (ws.readyState === WS_OPEN) { try { ws.send(frame) } catch (_) { /* 连接已断 */ } }
    }
    if (!allowed.has(msg.channel)) { reply(false, `IPC 通道未授权: ${msg.channel}`); return }
    const h = this.handlers.get(msg.channel)
    if (!h) { reply(false, `通道未注册（Web 形态不支持）: ${msg.channel}`); return }
    try {
      const result = await h(null, ...(msg.args || []))
      const delivered = ws.readyState === WS_OPEN
      reply(true, result)
      // 长任务期间页面被刷新/关闭：回执无处可送——交兜底钩子处理（如把助手回复落库）
      if (!delivered && this.onOrphanResult) {
        try { this.onOrphanResult(msg.channel, msg.args || [], result) } catch (e) { console.error('[ws-bus] 兜底钩子异常', e) }
      }
    } catch (e: any) {
      reply(false, e?.message || String(e))
    }
  }
}
