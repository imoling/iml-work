// DB / 安全存储 IPC:配置读写、会话/消息、记忆、加密安全存储——全部转发到 db.ts。
import { ipcMain } from 'electron'
import { configGet, configSet, configGetAll, convList, convCreate, convDelete, convUpdateTitle, msgAdd, msgList, msgSearch, memoryGet, memorySet, encryptValue, decryptValue } from '../db'

export function registerDbHandlers() {
ipcMain.handle('secure-store:save', (_event, key: string, value: string) => {
  try {
    if (typeof value !== 'string') {
      console.error(`[secure-store:save] key="${key}" 值非字符串，已拒绝`)
      return { success: false, error: 'value must be a string' }
    }
    configSet(key, encryptValue(value))   // 加密后落盘（configSet 不会对非白名单 key 二次加密）
    return { success: true }
  } catch (err: any) {
    console.error(`[secure-store:save] key="${key}" 异常:`, err.message)
    return { success: false, error: err.message }
  }
})

ipcMain.handle('secure-store:get', (_event, key: string) => {
  try {
    const raw = configGet(key)
    if (raw === '[object Object]') return null   // 兼容历史脏值
    return decryptValue(raw)
  } catch (err: any) {
    console.error(`[secure-store:get] key="${key}" 异常:`, err.message)
    return null
  }
})

// SQLite native database handlers
ipcMain.handle('db:config-get', (_event, key: string) => {
  return configGet(key)
})

ipcMain.handle('db:config-set', (_event, key: string, value: string) => {
  configSet(key, value)
  return true
})

ipcMain.handle('db:config-get-all', (_event) => {
  return configGetAll()
})

ipcMain.handle('db:conv-list', (_event, expertId: string) => {
  return convList(expertId)
})

ipcMain.handle('db:conv-create', (_event, expertId: string, title?: string) => {
  return convCreate(expertId, title)
})

ipcMain.handle('db:conv-delete', (_event, id: string) => {
  convDelete(id)
  return true
})

ipcMain.handle('db:conv-update-title', (_event, id: string, title: string) => {
  convUpdateTitle(id, title)
  return true
})

ipcMain.handle('db:msg-add', (_event, conversationId: string, role: 'user' | 'assistant', content: string, meta?: string | null) => {
  return msgAdd(conversationId, role, content, meta)
})

ipcMain.handle('db:msg-list', (_event, conversationId: string) => {
  return msgList(conversationId)
})

ipcMain.handle('db:msg-search', (_event, expertId: string, query: string) => {
  return msgSearch(expertId, query)
})

ipcMain.handle('db:memory-get', (_event, expertId: string, type: 'agent' | 'personal') => {
  return memoryGet(expertId, type)
})

ipcMain.handle('db:memory-set', (_event, expertId: string, type: 'agent' | 'personal', content: string) => {
  memorySet(expertId, type, content)
  return true
})
}
