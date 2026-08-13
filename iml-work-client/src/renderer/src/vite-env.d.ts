/// <reference types="vite/client" />

interface Window {
  api: {
    invoke: (channel: string, ...args: any[]) => Promise<any>
    on: (channel: string, callback: (...args: any[]) => void) => () => void
    platform: string
    /** 'web' = 浏览器经 WS 连本机宿主（web-bridge 注入）；Electron preload 不设置该字段 */
    mode?: string
  }
}
