// 自动更新通道：基于 electron-updater。
//
// 【前提】autoUpdater 只在「已打包应用」+「已发布更新源」下真正工作；开发/未打包运行时
// 完全惰性（app.isPackaged=false），本模块此时只如实上报状态、不做任何网络请求。
// 更新源地址来自本地配置 update-feed-url（generic provider，指向自建/对象存储发布目录），
// 未配置则视为「未启用更新通道」——诚实留白，不虚假声称能检查。
//
// 打包启用时另需在 electron-builder 配置里加 publish 段（见 docs/部署方案），
// 或在此 setFeedURL；本项目当前约定不打包，故仅备通道。
import { app } from 'electron'
import { configGet } from './db'
import { emitToRenderer } from './window-ref'
import { swallow } from './util'

type UpdateStatus =
  | { state: 'disabled'; reason: string }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'none'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

let updater: any = null
let lastStatus: UpdateStatus = { state: 'disabled', reason: '未初始化' }

function setStatus(s: UpdateStatus) { lastStatus = s; emitToRenderer('app:update-status', s) }

export function getUpdateStatus(): UpdateStatus { return lastStatus }

/** 更新源：本地配置 update-feed-url（generic），未配则通道关闭。 */
function feedUrl(): string { return (configGet('update-feed-url') || '').trim() }

/** 启动时初始化：仅在「已打包 + 已配置更新源」时挂载 electron-updater 事件并静默检查一次。 */
export async function initAutoUpdate(): Promise<void> {
  if (!app.isPackaged) { lastStatus = { state: 'disabled', reason: '开发/未打包运行，更新通道不激活' }; return }
  const url = feedUrl()
  if (!url) { lastStatus = { state: 'disabled', reason: '未配置更新源（update-feed-url）' }; return }
  try {
    const { autoUpdater } = await import('electron-updater')
    updater = autoUpdater
    updater.autoDownload = false          // 先通知用户，确认后再下（不静默替换）
    updater.setFeedURL({ provider: 'generic', url })
    updater.on('checking-for-update', () => setStatus({ state: 'checking' }))
    updater.on('update-available', (i: any) => setStatus({ state: 'available', version: i?.version || '' }))
    updater.on('update-not-available', (i: any) => setStatus({ state: 'none', version: i?.version || app.getVersion() }))
    updater.on('download-progress', (p: any) => setStatus({ state: 'downloading', percent: Math.round(p?.percent || 0) }))
    updater.on('update-downloaded', (i: any) => setStatus({ state: 'downloaded', version: i?.version || '' }))
    updater.on('error', (e: any) => setStatus({ state: 'error', message: String(e?.message || e) }))
    void updater.checkForUpdates()
  } catch (e) { swallow(e, 'updater-init'); lastStatus = { state: 'error', message: '更新模块加载失败' } }
}

/** 手动检查（设置页「检查更新」按钮）。未激活时返回当前 disabled 状态，如实告知原因。 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  if (!updater) {
    if (!app.isPackaged) return { state: 'disabled', reason: '开发/未打包运行，无法检查更新（打包后生效）' }
    if (!feedUrl()) return { state: 'disabled', reason: '未配置更新源，请在部署时设置 update-feed-url' }
    await initAutoUpdate()
  }
  if (!updater) return lastStatus
  try { setStatus({ state: 'checking' }); await updater.checkForUpdates() } catch (e: any) { setStatus({ state: 'error', message: String(e?.message || e) }) }
  return lastStatus
}

/** 下载已发现的更新（update-available 后调用）。 */
export async function downloadUpdate(): Promise<void> {
  if (updater) { try { await updater.downloadUpdate() } catch (e) { swallow(e, 'updater-download') } }
}

/** 退出并安装已下载的更新（update-downloaded 后调用）。 */
export function quitAndInstall(): void {
  if (updater) { try { updater.quitAndInstall() } catch (e) { swallow(e, 'updater-install') } }
}
