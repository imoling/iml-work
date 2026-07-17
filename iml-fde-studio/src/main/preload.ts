import { contextBridge, ipcRenderer } from 'electron'

// ─── IPC 通道白名单 ──────────────────────────────────────────────────────────
// 渲染进程只能调用这里显式登记的通道，杜绝任意通道透传（XSS → 拿到全部主进程能力）。
// 与客户端 iml-work-client 的 preload 一致。新增 ipcMain.handle / webContents.send 时，务必同步下面对应集合。

// invoke：渲染 → 主 请求-响应（对应 ipcMain.handle）
const INVOKE_CHANNELS = new Set<string>([
  'admin:save-skill', 'admin:systems',
  'connection:ping', 'connection:verify-check', 'connection:verify-close', 'connection:verify-start',
  'desktop:check', 'desktop:dry-run', 'desktop:record-cancel', 'desktop:record-start', 'desktop:record-stop',
  'fde:api',
  'recorder:cancel', 'recorder:start', 'recorder:stop',
  'skill:dry-run', 'skill:dry-run-close', 'skill:gen-sop', 'skill:suggest-params', 'skill:test',
])

// on：主 → 渲染 事件推送（对应 webContents.send）
const ON_CHANNELS = new Set<string>([
  'dryrun:line', 'recorder:step',
])

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
    const sub = (_e: any, ...args: any[]) => callback(...args)
    ipcRenderer.on(channel, sub)
    return () => ipcRenderer.removeListener(channel, sub)
  }
})
