// 窗口边框 IPC:最小化/最大化/关闭/打开路径与外链 + 应用偏好（开机自启/悬浮球）。
import { app, ipcMain, shell } from 'electron'
import { getMainWindow } from '../window-ref'
import { isFloatBallOn, setFloatBall, showMainFromBall } from '../float-ball'

export function registerWindowHandlers() {
// ── 应用偏好：开机自启（系统登录项）与桌面悬浮球 ──
ipcMain.handle('app:autostart-get', () => app.getLoginItemSettings().openAtLogin)
ipcMain.handle('app:autostart-set', (_e, on: boolean) => {
  // dev 下登记的是 Electron 开发二进制，打包后自动指向正式应用——行为一致，仅路径不同
  app.setLoginItemSettings({ openAtLogin: !!on })
  return app.getLoginItemSettings().openAtLogin
})
ipcMain.handle('app:floatball-get', () => isFloatBallOn())
ipcMain.handle('app:floatball-set', (_e, on: boolean) => setFloatBall(!!on))
// 悬浮球点击：唤起主窗口
ipcMain.handle('window:show-main', () => { showMainFromBall(); return true })

ipcMain.handle('window:minimize', () => {
  getMainWindow()?.minimize()
})
ipcMain.handle('window:maximize', () => {
  if (!getMainWindow()) return false
  if (getMainWindow()!.isMaximized()) {
    getMainWindow()!.unmaximize()
    return false
  }
  getMainWindow()!.maximize()
  return true
})
ipcMain.handle('window:is-maximized', () => {
  return getMainWindow()?.isMaximized() ?? false
})
ipcMain.handle('window:close', () => {
  getMainWindow()?.close()
})
ipcMain.handle('window:open-path', async (_event, filePath: string) => {
  try {
    shell.openPath(filePath)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('window:open-url', async (_event, url: string) => {
  try {
    shell.openExternal(url)
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
})
}
