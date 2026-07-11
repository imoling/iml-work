// FDE 工作台主进程壳：应用/窗口生命周期 + 注册各域 IPC。业务分域在 ipc/*.ts（依赖单向：域模块→runtime/automation，绝不反向 import 本文件）。
import { app, BrowserWindow } from 'electron'
import path from 'path'
import fs from 'fs'
import { rt } from './ipc/runtime'
import { register as registerAdmin } from './ipc/admin'
import { register as registerRecorder } from './ipc/recorder'
import { register as registerSkillRun } from './ipc/skill-run'
import { register as registerConnection } from './ipc/connection'
import { register as registerDesktop } from './ipc/desktop'

// vite-plugin-electron 把本文件打包到 dist-electron/main.cjs，故项目根 = __dirname 的上一级。
// 项目根资源(build/ 图标、dist/ 渲染产物)用 ROOT 定位；preload 与 main 同在 dist-electron/，仍用 __dirname。
const ROOT = path.join(__dirname, '..')

// 应用显示名（Hide/Quit/About 菜单与「关于」面板；dev 菜单栏加粗名由 Electron.app Info.plist 提供）
app.setName('FDE 工作台')
app.setAboutPanelOptions({
  applicationName: 'iML Work · FDE 工作台',
  applicationVersion: 'v1.0.0',
  credits: '技能构建 · 录制回放 · 本地安全',
  copyright: 'iML Studio · 由个人开发者 imoling 打造 · © 2026',
  iconPath: path.join(ROOT, 'build', 'icon.png')
})

function createWindow(): void {
  rt.toolWin = new BrowserWindow({
    width: 1320, height: 900, minWidth: 1080, minHeight: 680, title: 'iML Work · FDE 工作台',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  // dev: Vite 开发服务器（热更新，vite-plugin-electron 注入 VITE_DEV_SERVER_URL）；prod: 构建产物 dist/index.html
  const devUrl = process.env.VITE_DEV_SERVER_URL || process.env.FDE_DEV_URL
  if (devUrl) { rt.toolWin.loadURL(devUrl) }
  else if (fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) { rt.toolWin.loadFile(path.join(ROOT, 'dist', 'index.html')) }
  else { rt.toolWin.loadURL('data:text/html,<body style="font-family:sans-serif;padding:40px;color:%23374151"><h2>FDE 工作台未构建</h2><p>请先运行 <code>npm run build</code>（或开发模式 <code>npm run dev</code>）。</p></body>') }
}

// 注册各域 IPC（同步登记，渲染层调用前就绪）
registerAdmin()
registerRecorder()
registerSkillRun()
registerConnection()
registerDesktop()

app.whenReady().then(() => {
  // macOS 扩展坞图标（dev 运行时 Electron 默认是通用图标）
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(ROOT, 'build', 'icon.png')) } catch (e: any) { console.error('dock icon:', e.message) }
  }
  createWindow()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
