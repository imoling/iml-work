// 岗位画像「我的关注」IPC：列表 / 交互流水 / 置顶 / 归档。
// 只做调度（取参 → 调 db 具名函数 → 回结果），沉淀本身发生在本体链路（agent-ontology 的 sinkFocus）。
import { ipcMain } from 'electron'
import { focusRecent, focusEvents, focusSetFlag } from '../db'

export function registerFocusHandlers() {
  ipcMain.handle('focus:list', (_e, expertId: string) => focusRecent(String(expertId || ''), undefined, 50))

  ipcMain.handle('focus:events', (_e, focusId: number) => focusEvents(Number(focusId) || 0, 10))

  ipcMain.handle('focus:pin', (_e, focusId: number, pinned: boolean) => {
    focusSetFlag(Number(focusId) || 0, 'pinned', !!pinned); return { success: true }
  })

  ipcMain.handle('focus:archive', (_e, focusId: number) => {
    focusSetFlag(Number(focusId) || 0, 'archived', true); return { success: true }
  })
}
