// Agent 交互控制 IPC：表单确认提交/取消、中止、删除确认、权限选择。
// 每个回调带 runId（≡ convId），精确作用于对应任务的 RunContext（per-run 隔离，真并发不串台）；
// 未带 runId 时退回兼容行为（旧渲染层）。
import { ipcMain } from 'electron'
import { resolveForm, cancelForm, abortRun, resolveDelete, resolvePermChoice } from '../automation-runtime'

export function registerAgentControlHandlers() {
  ipcMain.handle('agent:form-submit', (_e, formData: any, runId?: string) => { resolveForm(runId, formData) })

  // 终止/取消：把挂起的确认表单以「空」解决（各执行路径将其判为取消 → 不执行、不改动状态）
  ipcMain.handle('agent:form-cancel', (_e, runId?: string) => { cancelForm(runId); return { success: true } })

  // 用户点「停止」：置该任务中止标志（执行路径写入前会检查并放弃）+ 解其挂起的确认
  ipcMain.handle('agent:abort', (_e, runId?: string) => { abortRun(runId); return { success: true } })

  ipcMain.handle('agent:delete-confirm', (_e, authorized: boolean, runId?: string) => { resolveDelete(runId, authorized) })

  // 先决权限闸选择：'continue'（继续，跳过写操作）| 'switch'（切到允许操作重跑，当前任务中止）
  ipcMain.handle('agent:perm-choice', (_e, choice: string, runId?: string) => { resolvePermChoice(runId, choice) })
}
