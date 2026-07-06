// 桌面悬浮球：置顶无边框小圆球（可拖拽），点击唤起/聚焦主窗口——随时把分身叫出来。
// 开关持久化在本地 config（float-ball），随应用启动恢复。
import { BrowserWindow, screen } from 'electron'
import path from 'path'
import { configGet, configSet } from './db'
import { getMainWindow } from './window-ref'
import { swallow } from './util'

let ball: BrowserWindow | null = null

const BALL_HTML = `data:text/html;charset=utf-8,` + encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;user-select:none}
  .ball{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg,#62E0B1,#17835B);box-shadow:0 4px 14px rgba(23,131,91,.45);
    -webkit-app-region:drag;cursor:pointer;font-family:-apple-system,'PingFang SC',sans-serif}
  .ball span{color:#fff;font-weight:800;font-size:15px;letter-spacing:-.5px;-webkit-app-region:no-drag;cursor:pointer;
    width:100%;height:100%;display:flex;align-items:center;justify-content:center;border-radius:50%}
  .ball:hover{box-shadow:0 6px 18px rgba(23,131,91,.6)}
</style></head>
<body><div class="ball"><span id="b">iML</span></div>
<script>document.getElementById('b').addEventListener('click',()=>{ if(window.api){ window.api.invoke('window:show-main') } })</script>
</body></html>`)

export function isFloatBallOn(): boolean {
  return configGet('float-ball') === '1'
}

export function showFloatBall(): void {
  if (ball && !ball.isDestroyed()) { ball.show(); return }
  try {
    const { workArea } = screen.getPrimaryDisplay()
    ball = new BrowserWindow({
      width: 64, height: 64,
      x: workArea.x + workArea.width - 88, y: workArea.y + Math.round(workArea.height * 0.6),
      frame: false, transparent: true, resizable: false, alwaysOnTop: true,
      skipTaskbar: true, hasShadow: false, focusable: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
    })
    ball.setAlwaysOnTop(true, 'floating')
    ball.loadURL(BALL_HTML).catch(e => swallow(e, 'floatball-load'))
    ball.on('closed', () => { ball = null })
  } catch (e) { swallow(e, 'floatball') }
}

export function hideFloatBall(): void {
  try { if (ball && !ball.isDestroyed()) { ball.close(); ball = null } } catch (e) { swallow(e) }
}

/** 开关落地：持久化 + 立即生效。 */
export function setFloatBall(on: boolean): boolean {
  configSet('float-ball', on ? '1' : '0')
  if (on) showFloatBall(); else hideFloatBall()
  return on
}

/** 应用启动时按持久化配置恢复悬浮球。 */
export function initFloatBall(): void {
  if (isFloatBallOn()) showFloatBall()
}

/** 悬浮球点击：唤起并聚焦主窗口。 */
export function showMainFromBall(): void {
  const w = getMainWindow()
  if (!w || w.isDestroyed()) return
  if (w.isMinimized()) w.restore()
  w.show(); w.focus()
}
