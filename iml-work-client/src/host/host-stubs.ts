// Web 形态降级通道——桌面原生能力缺席时如实响应，不假装成功（不虚构"已开启"状态）。
// 必须在真实模块 register 之前调用：WsBus 采用「先注册者优先」，stub 占位后真实同名注册被忽略。
import { ipcMain } from '../main/ipc-bus'
import { appVersion } from '../main/app-paths'

export function registerHostStubs(): void {
  const NOT_SUPPORTED = { success: false, error: '该操作需要桌面客户端（网页版不支持）' }

  // 窗口边框：网页没有窗口概念（web-bridge 已把 window:open-url 截在浏览器端开新标签）
  ipcMain.handle('window:minimize', () => undefined)
  ipcMain.handle('window:maximize', () => false)
  ipcMain.handle('window:is-maximized', () => false)
  ipcMain.handle('window:close', () => undefined)
  ipcMain.handle('window:show-main', () => true)
  ipcMain.handle('window:open-path', () => NOT_SUPPORTED)
  ipcMain.handle('window:open-url', () => NOT_SUPPORTED)

  // 应用偏好：开机自启/悬浮球/阻止休眠是桌面能力
  ipcMain.handle('app:autostart-get', () => false)
  ipcMain.handle('app:autostart-set', () => false)
  ipcMain.handle('app:floatball-get', () => false)
  ipcMain.handle('app:floatball-set', () => false)
  ipcMain.handle('app:keepawake-get', () => false)
  ipcMain.handle('app:keepawake-set', () => false)

  // 版本/自动更新：网页版由宿主自身负责更新，客户端更新通道不适用
  const UPDATE_OFF = { state: 'disabled', reason: '网页版不支持客户端自动更新' }
  ipcMain.handle('app:version', () => appVersion())
  ipcMain.handle('app:update-get', () => UPDATE_OFF)
  ipcMain.handle('app:update-check', () => UPDATE_OFF)
  ipcMain.handle('app:update-download', () => UPDATE_OFF)
  ipcMain.handle('app:update-install', () => false)

  // 技能录制（决策 D3：网页版不开放）
  const REC_OFF = { success: false, error: '技能录制请在桌面客户端进行（网页版不开放）' }
  ipcMain.handle('recorder:start', () => REC_OFF)
  ipcMain.handle('recorder:stop', () => REC_OFF)
  ipcMain.handle('recorder:cancel', () => REC_OFF)
}
