// 本地 HTML 报告预览窗：技能产出的 .html 交付物在独立 BrowserWindow 内渲染
// （Quick Look 不执行 JS，图表类报告只能看到空壳，所以 .html 走专用预览窗）。
// 安全边界：模型/沙箱生成的 HTML 一律视为不可信内容——无 Node、无 preload、独立会话分区、
// 会话级网络封锁（仅放行 file:// 与 devtools），页内外链与新窗一律拒绝。
// 离线部署下外网本来就不可达，封锁同时把「报告引用 CDN 资源」这类做法在开发期就暴露出来。
import { BrowserWindow, session } from 'electron'
import path from 'path'

const PREVIEW_PARTITION = 'html-preview'
let sessionLocked = false

function lockPreviewSession(): void {
  if (sessionLocked) return
  sessionLocked = true
  const ses = session.fromPartition(PREVIEW_PARTITION)
  ses.webRequest.onBeforeRequest((details, cb) => {
    const ok = details.url.startsWith('file://') || details.url.startsWith('devtools://')
    cb({ cancel: !ok })
  })
}

export function openHtmlPreview(absPath: string, title?: string): void {
  lockPreviewSession()
  const win = new BrowserWindow({
    width: 1080, height: 800,
    title: title || path.basename(absPath),
    autoHideMenuBar: true,
    webPreferences: {
      partition: PREVIEW_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault() })
  void win.loadFile(absPath)
}
