import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, callback: (...args: any[]) => void) => {
    const subscription = (_event: any, ...args: any[]) => callback(...args)
    ipcRenderer.on(channel, subscription)
    return () => {
      ipcRenderer.removeListener(channel, subscription)
    }
  },
  send: (channel: string, ...args: any[]) => ipcRenderer.send(channel, ...args),
  // Host OS, so the renderer can place window controls per-platform
  // (macOS: top-left; Windows/Linux: top-right).
  platform: process.platform
})
