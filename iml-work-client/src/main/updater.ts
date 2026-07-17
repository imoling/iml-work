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
import { afetch, getAdminBaseUrl } from './http'
import { emitToRenderer } from './window-ref'
import { swallow } from './util'

type UpdateStatus =
  | { state: 'disabled'; reason: string }
  | { state: 'checking' }
  | { state: 'available'; version: string; page?: string }   // page：下载落地页（manifest 通道，用户自取安装包）
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

/** 版本比较：按数字段逐位比对（1.1.2 vs 1.2.0）；只有严格更大才算新版本。 */
function newerThan(remote: string, local: string): boolean {
  const seg = (s: string) => (s || '').split(/[^0-9]+/).filter(Boolean).map(Number)
  const a = seg(remote), b = seg(local)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0
    if (x !== y) return x > y
  }
  return false
}

/** 下载落地页缺省：后端没配 page-url 时，按「nginx 与后端同机」的部署约定去端口推导。 */
function defaultDownloadPage(): string {
  try { const u = new URL(getAdminBaseUrl()); return `${u.protocol}//${u.hostname}/#downloads` } catch { return '' }
}

/** feed 通道未激活时的真实检测：比对管理端发布的安装包清单（nginx /downloads/manifest.json，
 *  经后端 /api/v1/clients/update-manifest 代理）。发现新版不静默下载——打开下载落地页由用户自取，
 *  与「不发布 electron-updater feed」的部署约定一致。 */
async function manifestCheck(): Promise<UpdateStatus> {
  setStatus({ state: 'checking' })
  let s: UpdateStatus
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/clients/update-manifest`)
    if (!r.ok) throw new Error(`backend ${r.status}`)
    const d: any = await r.json()
    if (!d || !d.available || !d.version) {
      s = { state: 'disabled', reason: '服务器暂未发布安装包清单（管理端「客户端下载」页发布后即可检测）' }
    } else if (newerThan(String(d.version), app.getVersion())) {
      s = { state: 'available', version: String(d.version), page: (d.pageUrl || '').trim() || defaultDownloadPage() }
    } else {
      s = { state: 'none', version: app.getVersion() }
    }
  } catch (e: any) {
    s = { state: 'error', message: '无法获取版本清单：' + (e?.message || e) }
  }
  setStatus(s)
  return s
}

/** 手动检查（设置页「检查更新」按钮）。feed 通道未激活时回退到安装包清单比对（本项目的真实发布通道）。 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  if (!updater) {
    if (!app.isPackaged || !feedUrl()) return manifestCheck()
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
