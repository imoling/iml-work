// 进程内 IPC 总线抽象——B/S 化的核心接缝（叶子模块，绝不 import electron/main.ts）。
//
// ipc/*.ts 的注册代码统一从这里拿 `ipcMain`（导出名刻意与 electron 同名，换入口只动 import 行）：
// · Electron 壳（main.ts）启动首行 setIpcBus(真 ipcMain) —— 行为与直连完全一致；
// · Web 宿主（src/host）setIpcBus(WS 总线) —— 同一批 handler 挂到 WebSocket RPC 上。
//
// handler 的第一个参数 event 在 Electron 下是 IpcMainInvokeEvent、在宿主下是 null——
// 全量 grep 坐实现有 handler 无一使用 event（皆为 `_e`/`_event`），新 handler 也不许依赖它。

export type IpcHandler = (event: unknown, ...args: any[]) => any

export interface IpcMainLike {
  handle(channel: string, listener: IpcHandler): void
}

let impl: IpcMainLike | null = null

/** 入口（main.ts / host.ts）在任何 register 之前调用，注入真实总线实现。 */
export function setIpcBus(bus: IpcMainLike): void {
  impl = bus
}

export const ipcMain: IpcMainLike = {
  handle(channel: string, listener: IpcHandler): void {
    if (!impl) throw new Error(`[ipc-bus] 总线未初始化就注册通道 ${channel}（入口必须先 setIpcBus）`)
    impl.handle(channel, listener)
  },
}
