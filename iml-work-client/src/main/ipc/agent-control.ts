// Agent 交互控制 IPC:表单确认提交/取消、中止、删除确认——都作用于共享 runningState。
import { ipcMain } from 'electron'
import { runningState } from '../automation-runtime'

export function registerAgentControlHandlers() {
ipcMain.handle('agent:form-submit', (_event, formData: any) => {
  if (runningState.isFormPending && runningState.formResolve) {
    runningState.isFormPending = false
    runningState.formResolve(formData)
  }
})

// 终止/取消：把挂起的确认表单以「空」解决（各执行路径将其判为取消 → 不执行、不改动状态）
ipcMain.handle('agent:form-cancel', () => {
  if (runningState.isFormPending && runningState.formResolve) {
    runningState.isFormPending = false
    runningState.formResolve({})
  }
  if (runningState.isDeletePending && runningState.deleteResolve) {
    runningState.isDeletePending = false
    runningState.deleteResolve(false)
  }
  return { success: true }
})

// 用户点「停止」：置中止标志（执行路径在写入前会检查并放弃）+ 解挂起的确认
ipcMain.handle('agent:abort', () => {
  runningState.aborted = true
  if (runningState.isFormPending && runningState.formResolve) { runningState.isFormPending = false; runningState.formResolve({}) }
  if (runningState.isDeletePending && runningState.deleteResolve) { runningState.isDeletePending = false; runningState.deleteResolve(false) }
  return { success: true }
})

ipcMain.handle('agent:delete-confirm', (_event, authorized: boolean) => {
  if (runningState.isDeletePending && runningState.deleteResolve) {
    runningState.isDeletePending = false
    runningState.deleteResolve(authorized)
  }
})
}
