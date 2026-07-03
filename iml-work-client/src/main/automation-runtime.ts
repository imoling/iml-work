// 自动化运行时：Agent 单步执行的共享状态 + 串行化 + 表单确认。
// runningState 作为共享单例对象，被 main 的 IPC handler（form-submit/cancel/abort/delete-confirm）
// 与浏览器回放引擎共同读写。
import { emitToRenderer } from './window-ref'

export interface RunningState {
  isFormPending: boolean
  formResolve: ((value: any) => void) | null
  isDeletePending: boolean
  deleteResolve: ((value: boolean) => void) | null
  aborted: boolean
}

export const runningState: RunningState = {
  isFormPending: false,
  formResolve: null,
  isDeletePending: false,
  deleteResolve: null,
  aborted: false,
}

// 串行化 agent 任务：保证同一时刻只有一个 agent:send-message 在执行。否则 UI 对话与定时任务
// 并发进入会践踏共享的 runningState（表单/删除确认回调、中止标志串台）。新任务排队依次执行，
// 每个任务开始时重置标志，其间的 form-submit / abort 都精确作用于当前唯一在跑的任务。
let _agentTail: Promise<unknown> = Promise.resolve()
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = _agentTail.then(fn, fn)
  _agentTail = result.then(() => {}, () => {})
  return result
}

// 表单确认卡片的字段形状（与 main 的 VisitField 结构兼容）。
export interface FormField { name: string; label: string; value: string; type: string; options?: string[] }

// 向渲染层弹出表单确认卡片，并阻塞等待用户在对话框中确认后回传的参数。
export function requestFormConfirmation(fields: FormField[]): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    runningState.isFormPending = true
    runningState.formResolve = (val: any) => resolve(val && typeof val === 'object' ? val : {})
    emitToRenderer('agent:form-request', { fields })
  })
}
