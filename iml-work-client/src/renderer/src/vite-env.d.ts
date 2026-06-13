/// <reference types="vite/client" />

interface Window {
  api: {
    invoke: (channel: string, ...args: any[]) => Promise<any>
    on: (channel: string, callback: (...args: any[]) => void) => () => void
    send: (channel: string, ...args: any[]) => void
  }
}
