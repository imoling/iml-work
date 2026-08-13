// ws 的最小类型声明——只覆盖 Web 宿主用到的表面（本机代理环境装 @types/ws 不可靠，零依赖自持）。
// 若日后引入 @types/ws，删除本文件即可。
declare module 'ws' {
  import type { Server as HttpServer, IncomingMessage } from 'http'
  import { EventEmitter } from 'events'

  export class WebSocket extends EventEmitter {
    readyState: number
    send(data: string): void
    on(event: 'close', cb: () => void): this
    on(event: 'message', cb: (raw: unknown) => void): this
    on(event: string, cb: (...args: any[]) => void): this
  }

  export class WebSocketServer extends EventEmitter {
    constructor(opts: { server?: HttpServer; path?: string })
    on(event: 'connection', cb: (ws: WebSocket, req: IncomingMessage) => void): this
    on(event: string, cb: (...args: any[]) => void): this
  }
}
