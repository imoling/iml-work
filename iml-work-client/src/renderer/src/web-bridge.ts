// Web 形态桥（B/S）：给浏览器提供与 Electron preload 同形状的 window.api——
// invoke 走 WS RPC、on 走事件订阅（协议帧见 src/host/ws-bus.ts）。
// 断线自动重连；未连上时 invoke 排队；断开时悬着的调用如实失败，绝不让界面永远转圈。
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

export function installWebBridge(): void {
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const pending = new Map<number, Pending>()
  let seq = 0
  let ws: WebSocket | null = null
  let queue: string[] = []
  let platform = ''

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws`)
    ws.onopen = () => { const q = queue; queue = []; for (const m of q) ws!.send(m) }
    ws.onmessage = (ev) => {
      let m: any
      try { m = JSON.parse(String(ev.data)) } catch { return }
      if (m?.t === 'hello') { platform = String(m.platform || ''); return }
      if (m?.t === 'result') {
        const p = pending.get(m.id)
        if (!p) return
        pending.delete(m.id)
        if (m.ok) p.resolve(m.data)
        else p.reject(new Error(String(m.error || '调用失败')))
        return
      }
      if (m?.t === 'event') {
        const subs = listeners.get(m.channel)
        if (subs) for (const cb of subs) { try { cb(m.payload) } catch (e) { console.error('[web-bridge] 事件回调异常', m.channel, e) } }
      }
    }
    ws.onclose = () => {
      for (const [, p] of pending) p.reject(new Error('与本机宿主的连接已断开，正在重连…'))
      pending.clear()
      setTimeout(connect, 1500)
    }
  }
  connect()

  ;(window as any).api = {
    invoke: (channel: string, ...args: any[]) => {
      // 外链浏览器自己就能开新标签，不必绕宿主（宿主 stub 只是兜底）
      if (channel === 'window:open-url' && typeof args[0] === 'string') {
        window.open(args[0], '_blank', 'noopener')
        return Promise.resolve({ success: true })
      }
      return new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        const frame = JSON.stringify({ t: 'invoke', id, channel, args })
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame)
        else queue.push(frame)
      })
    },
    on: (channel: string, callback: (...args: any[]) => void) => {
      let subs = listeners.get(channel)
      if (!subs) { subs = new Set(); listeners.set(channel, subs) }
      subs.add(callback)
      return () => { subs!.delete(callback) }
    },
    get platform() { return platform },
    mode: 'web',
  }
}
