import type { BrowserWindow } from 'electron'

// 主窗口的共享引用：main.ts 创建/销毁时登记，其余模块通过 getMainWindow() 访问，
// 避免各模块直接依赖 main.ts 的模块级变量。
let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 向渲染进程推送事件（窗口不存在/已销毁时安全忽略）。 */
export function emitToRenderer(channel: string, payload?: unknown): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  } catch (_) { /* 窗口已关闭 */ }
}
