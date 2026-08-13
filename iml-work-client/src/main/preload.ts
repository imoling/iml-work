import { contextBridge, ipcRenderer } from 'electron'
import { INVOKE_CHANNELS as INVOKE_LIST, ON_CHANNELS as ON_LIST } from '../shared/ipc-channels'

// ─── IPC 通道白名单 ──────────────────────────────────────────────────────────
// 渲染进程只能调用这里显式登记的通道，杜绝任意通道透传（XSS → 拿到全部主进程能力）。
// 清单已抽 src/shared/ipc-channels.ts（与 Web 宿主单一来源），新增通道改那里、两端自动同步。

const INVOKE_CHANNELS = new Set<string>(INVOKE_LIST)
const ON_CHANNELS = new Set<string>(ON_LIST)

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, ...args: any[]) => {
    if (!INVOKE_CHANNELS.has(channel)) {
      console.error(`[preload] 拒绝未登记的 invoke 通道: ${channel}`)
      return Promise.reject(new Error(`IPC 通道未授权: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel: string, callback: (...args: any[]) => void) => {
    if (!ON_CHANNELS.has(channel)) {
      console.error(`[preload] 拒绝未登记的 on 通道: ${channel}`)
      return () => {}
    }
    const subscription = (_event: any, ...args: any[]) => callback(...args)
    ipcRenderer.on(channel, subscription)
    return () => {
      ipcRenderer.removeListener(channel, subscription)
    }
  },
  // Host OS, so the renderer can place window controls per-platform
  // (macOS: top-left; Windows/Linux: top-right).
  platform: process.platform
})
