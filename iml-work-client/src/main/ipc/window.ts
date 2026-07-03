// 窗口边框 IPC:最小化/最大化/关闭/打开路径与外链。
import { ipcMain, shell } from 'electron'
import { getMainWindow } from '../window-ref'

export function registerWindowHandlers() {
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
