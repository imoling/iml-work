import './global-env'
import { app, BrowserWindow, ipcMain } from 'electron'
import path, { join } from 'path'
import {
  schedList,
  schedUpsert,
  schedSetEnabled,
  schedDelete,
  configGet, type ScheduledTask, taskRunAdd, taskRunFinish, taskRunList, taskRunRecentConvs, taskRunDelete } from './db'
import { getConvUsage } from './automation-runtime'
import { localStatus, installLocalImage, installDockerRuntime, getSandboxMode, setSandboxMode } from './sandbox-local'
import { getAdminBaseUrl } from './http'
import { setMainWindow, emitToRenderer } from './window-ref'
import { type RemoteBotKey, stopRemoteBot, bootRemoteBots } from './remote-bots'
import { swallow } from './util'
import { registerDbHandlers } from './ipc/db'
import { registerWindowHandlers } from './ipc/window'
import { registerAgentControlHandlers } from './ipc/agent-control'
import { registerAuthExpertHandlers } from './ipc/auth-expert'
import { registerFilesKbHandlers } from './ipc/files-kb'
import { registerMiscHandlers } from './ipc/misc'
import { registerBizSystemsHandlers } from './ipc/biz-systems'
import { registerFocusHandlers } from './ipc/focus'
import { registerRecorderIpc } from './ipc/recorder'
import { registerSkillAuthoringHandlers } from './ipc/skill-authoring'
import { registerTurnHandlers } from './ipc/agent-core'
import { initSkillStore } from './skill-store'
import { startHeartbeat, stopHeartbeat } from './client-heartbeat'
import { fireScheduledTask, startScheduler } from './scheduler'
import { startFileSyncWatcher, stopFileSyncWatcher } from './file-sync'
import { ingestToPersonalKB } from './personal-kb'
import { startBizKeepAlive } from './biz-keepalive'
import { initFloatBall } from './float-ball'
import { initAutoUpdate } from './updater'

let mainWindow: BrowserWindow | null = null

// 应用显示名：Hide/Quit/About 菜单项与「关于」面板用它（dev 下菜单栏加粗名来自 Electron.app 的
// Info.plist——已由 scripts 侧改写为 iML Work；打包时由 productName 接管）。
app.setName('iML Work')
app.setAboutPanelOptions({
  applicationName: 'iML Work',
  applicationVersion: 'v1.0.3',
  credits: '工作分身 · 本地安全 · 高效执行',
  copyright: 'iML Studio · 由个人开发者 imoling 打造 · © 2026',
  iconPath: path.join(app.getAppPath(), 'build/icon.png')
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "iML Work - iML Studio",
    frame: false, // Frosted native chrome is simulated in the React layer
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  setMainWindow(mainWindow)

  // Load local Vite dev server in development, compiled HTML in production
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  // Forward maximize/restore state so the renderer can reflect the control icon.
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-changed', false))
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('window:maximized-changed', true))
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('window:maximized-changed', false))

  mainWindow.on('closed', () => {
    mainWindow = null
    setMainWindow(null)
  })
}

app.whenReady().then(() => {
  // macOS 扩展坞图标（dev 运行时 Electron 默认是通用图标；打包由 build/icon.png 提供）
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(app.getAppPath(), 'build/icon.png')) } catch (e) { swallow(e, 'dock-icon') }
  }
  createWindow()
  startFileSyncWatcher(p => { ingestToPersonalKB(p).catch(e => swallow(e, 'personal-kb-ingest')) })   // 摄入失败要留痕，否则「同步成功却查不到」无从排查（体检 P3-6）
  startHeartbeat()
  startBizKeepAlive()
  startScheduler()
  bootRemoteBots()
  initFloatBall()   // 按持久化配置恢复桌面悬浮球
  void initAutoUpdate()   // 自动更新通道（未打包/未配源时惰性）

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  stopHeartbeat()
  stopFileSyncWatcher()
  for (const k of ['feishu', 'dingtalk', 'qq'] as RemoteBotKey[]) { void stopRemoteBot(k) }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* =========================================================================
   FileSyncService — real directory watching (chokidar) + delta sync upload
   ========================================================================= */

// 文件同步 watcher / 客户端心跳 / 定时任务调度已拆至 file-sync.ts / client-heartbeat.ts / scheduler.ts。

ipcMain.handle('schedule:list', () => schedList())
// 任务运行记录（详情页 Runs 列表）：add 由渲染层在为运行开出专属会话后调用，finish 在任务收尾时回填
ipcMain.handle('task-run:add', (_e, p: { taskId: string; convId: string; trigger?: string }) =>
  taskRunAdd(String(p?.taskId || ''), String(p?.convId || ''), String(p?.trigger || 'schedule')))
ipcMain.handle('task-run:finish', (_e, p: { runId: number; status?: string; summary?: string; fileCount?: number }) => {
  taskRunFinish(Number(p?.runId || 0), String(p?.status || 'ok'), String(p?.summary || ''), Number(p?.fileCount || 0))
  return true
})
ipcMain.handle('task-run:list', (_e, taskId: string) => taskRunList(String(taskId || '')))
ipcMain.handle('task-run:recent-convs', () => taskRunRecentConvs())
ipcMain.handle('task-run:delete', (_e, runId: number) => { taskRunDelete(Number(runId || 0)); return true })
// 安全沙箱管理：本地/云端切换 + 本机 Docker 状态 + 镜像一键安装（进度经事件推渲染层）
ipcMain.handle('sandbox-local:status', async () => ({ ...(await localStatus()), mode: getSandboxMode() }))
ipcMain.handle('sandbox-local:set-mode', (_e, mode: string) => { setSandboxMode(mode === 'local' ? 'local' : 'cloud'); return true })
ipcMain.handle('sandbox-local:install', async () => {
  return installLocalImage((msg) => emitToRenderer('sandbox-local:install-progress', { msg }))
})
ipcMain.handle('sandbox-local:install-docker', async () => {
  return installDockerRuntime((msg) => emitToRenderer('sandbox-local:install-progress', { msg }))
})
// 语音输入（本地 whisper）：模型基址（企业平台优先，渲染层探测可达性）+ 设备信息（设置页兼容性卡）
ipcMain.handle('stt:model-base', () => getAdminBaseUrl())
ipcMain.handle('app:device-info', () => {
  const os = require('os') as typeof import('os')
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    memGb: Math.round(os.totalmem() / (1024 ** 3)),
    cores: os.cpus().length,
  }
})

// composer Token 用量：**当前会话**的累计 + 最近一次请求的上下文占用；新会话为零
ipcMain.handle('llm:usage-stats', (_e, convId?: string) => {
  const u = convId ? getConvUsage(String(convId)) : undefined
  const win = Number(configGet('llm-context-window')) || 128_000
  return {
    prompt: u?.prompt || 0,
    completion: u?.completion || 0,
    byModel: u?.byModel || {},
    last: u?.last || { prompt: 0, completion: 0, model: '' },
    contextWindow: win,
  }
})
ipcMain.handle('schedule:save', (_e, t: ScheduledTask) => { schedUpsert(t); return schedList() })
ipcMain.handle('schedule:toggle', (_e, { id, enabled }: { id: string; enabled: boolean }) => { schedSetEnabled(id, enabled); return schedList() })
ipcMain.handle('schedule:delete', (_e, { id }: { id: string }) => { schedDelete(id); return schedList() })
ipcMain.handle('schedule:run-now', (_e, { id }: { id: string }) => { const t = schedList().find(x => x.id === id); if (t) fireScheduledTask(t, 'manual'); return { ok: true } })

// 启动初始化本地技能缓存（加载 + 异步清理已删技能）
initSkillStore()
// secure-store：敏感值经系统钥匙串(safeStorage)加密后落盘；绝不打印明文值。
registerDbHandlers()
registerFocusHandlers()

// 各域 IPC 已拆至 ipc/*.ts（auth-expert / files-kb / misc / biz-systems）。
registerAuthExpertHandlers()
registerSkillAuthoringHandlers()
registerFilesKbHandlers()
registerMiscHandlers()
registerBizSystemsHandlers()
registerRecorderIpc()   // 录制域（原写在 browser-automation 顶层，体检 P2-17 归位）
registerTurnHandlers()  // AgentCore 执行内核（唯一链路）

// 任务编排与技能主管线已拆至 skill-orchestrator.ts。


// 旧执行管线（agent:send-message）已于 v2.0.0 下线：AgentCore 是唯一链路（ipc/agent-core.ts）。
// 完整旧实现见 tag legacy-pipeline-final。

// IPC Form / Delete Confirmation responses from React UI
registerAgentControlHandlers()

// Window chrome handlers
registerWindowHandlers()

// 工作空间目录/扫描与文档解析已拆至 workspace-files.ts，此处只留 IPC 编排。
