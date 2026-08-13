// 录制域 IPC（register 函数模式）：从 browser-automation 顶层的 ipcMain.handle 归位至此
// ——体检 P2-17：业务模块 import 即注册 IPC 是副作用，也让"main.ts 一眼看全部 IPC 编排"的收敛结构失效。
import { ipcMain } from '../ipc-bus'
import { BrowserWindow } from 'electron'
import { ensureAuthFresh } from '../http'
import { usePwEngine } from '../pw-runtime'
import { finishRecording, instrumentRecorderWindow, resetRecorderSteps, startPwRecorder, pwFinishRecording } from '../browser-recorder'

export function registerRecorderIpc(): void {
  ipcMain.handle('recorder:start', async (_e, payload: { systemId: string; baseUrl: string; systemName: string }) => {
    try {
      // 开录前先确认 iML Work 后端登录态**够撑完一次录制**（<20 分钟就先踢去重登拿全新 72h 令牌）——
      // 别让你录一场后在「保存技能」时才发现登录过期、白干（用户反馈：该在操作前退回登录，而非保存时）。
      if (!ensureAuthFresh(20 * 60 * 1000)) return { ok: false, error: '登录态即将过期，已为你退回登录——请重新登录后再开始录制（避免录到一半失效、白录一场）。' }
      if (usePwEngine()) { finishRecording(true); return await startPwRecorder(payload.systemId, payload.baseUrl) }   // 灰度：Playwright 录制（复用 pw profile 登录态）
      finishRecording(true)   // 关掉任何遗留录制窗，重置
      resetRecorderSteps()
      const win = new BrowserWindow({
        show: true, width: 1280, height: 860, title: `实操录制 · ${payload.systemName}`,
        webPreferences: { partition: `persist:bizsys-${payload.systemId}` }
      })
      instrumentRecorderWindow(win)   // console 监听 + 全帧注入 + 新窗口递归装配
      // 不能 await loadURL：业务系统未登录/会话过期时会 302 跳 SSO 登录页，**重定向会让 loadURL reject**
      //（Electron 经典坑，讯飞这类固定 TTL 的 SSO 一过期必现 ERR_FAILED(-2)/ERR_ABORTED(-3)）——那样会把
      // 整场录制误判成"无法启动"。重定向是正常的：让录制窗停在 SSO 登录页，用户在窗口里登一下再操作即可。
      // 与回放(replayActionScript)、登录窗(systems:login)一致，都用 .catch 忽略导航级 reject。
      win.loadURL(payload.baseUrl).catch(() => {})
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('recorder:stop', async () => ({ ok: true, steps: usePwEngine() ? await pwFinishRecording(false) : finishRecording(false) }))

  ipcMain.handle('recorder:cancel', async () => { if (usePwEngine()) { await pwFinishRecording(true) } else { finishRecording(true) } return { ok: true } })
}
