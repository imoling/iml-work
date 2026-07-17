// 渲染层通过 preload 暴露的 IPC 桥（contextBridge → window.api）。
// 宽松工程：桥面按 any 处理，具体形状以 preload.ts 白名单为单一来源。
// 静态资源（*.png 等）模块类型由 vite-env.d.ts 的 vite/client 提供。
export {}

declare global {
  interface Window {
    api: any
  }
}
