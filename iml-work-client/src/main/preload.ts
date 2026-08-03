import { contextBridge, ipcRenderer } from 'electron'

// ─── IPC 通道白名单 ──────────────────────────────────────────────────────────
// 渲染进程只能调用这里显式登记的通道，杜绝任意通道透传（XSS → 拿到全部主进程能力）。
// 新增 ipcMain.handle / webContents.send 时，务必同步下面对应的集合。

// invoke：渲染 → 主 请求-响应（对应 ipcMain.handle）
const INVOKE_CHANNELS = new Set<string>([
  'agent:abort', 'agent:delete-confirm', 'agent:form-cancel', 'agent:form-submit', 'agent:perm-choice', 'agent:send-message',
  'app:autostart-get', 'app:autostart-set', 'app:floatball-get', 'app:floatball-set',
  'app:keepawake-get', 'app:keepawake-set',
  'app:version', 'app:update-get', 'app:update-check', 'app:update-download', 'app:update-install',
  'attach:pick',
  'auth:change-password', 'auth:forgot', 'auth:last-username', 'auth:login', 'auth:logout', 'auth:session',
  'backend:get-url', 'backend:set-url', 'backend:ping',
  'db:config-get', 'db:config-get-all', 'db:config-set',
  'db:conv-create', 'db:conv-delete', 'db:conv-list', 'db:conv-pin', 'db:conv-update-title',
  'db:memory-get', 'db:memory-set', 'db:msg-add', 'db:msg-list', 'db:msg-update-meta', 'db:msg-search',
  'expert:claim', 'expert:list',
  'focus:archive', 'focus:events', 'focus:list', 'focus:pin',
  'files:list', 'files:sync', 'files:preview', 'files:read-text', 'files:reveal', 'files:thumb', 'sandbox:status', 'sandbox:run',
  'kb:ingest', 'kb:overview', 'kb:promote', 'kb:remove', 'kb:set-autoingest', 'memory:enterprise',
  'llm:list-models', 'llm:test',
  'recorder:cancel', 'recorder:start', 'recorder:stop',
  'remote-bot:start', 'remote-bot:status', 'remote-bot:stop', 'remote-bot:test',
  'schedule:delete', 'schedule:list', 'schedule:run-now', 'schedule:save', 'schedule:toggle',
  'task-run:add', 'task-run:finish', 'task-run:list', 'task-run:recent-convs', 'task-run:delete', 'llm:usage-stats', 'stt:model-base', 'app:device-info', 'sandbox-local:status', 'sandbox-local:set-mode', 'sandbox-local:install', 'sandbox-local:install-docker',
  'secure-store:get', 'secure-store:save',
  'skill:save-recorded', 'skill:transpile-recording', 'skill:delete-recorded',
  'skillauth:draft', 'skillauth:mine', 'skillauth:perms', 'skillauth:save', 'skillauth:upload', 'skillauth:validate',
  'systems:check', 'systems:heartbeat-get', 'systems:heartbeat-now', 'systems:heartbeat-set',
  'systems:list', 'systems:login', 'systems:login-close', 'systems:logout',
  'trace:feedback',
  'turn:clear-history', 'turn:conv-model-get', 'turn:conv-model-set', 'turn:enabled', 'turn:history', 'turn:send-message', 'turn:set-enabled',
  'turn:set-workspace-access', 'turn:workspace-access',
  'window:close', 'window:is-maximized', 'window:maximize', 'window:minimize',
  'window:open-path', 'window:open-url', 'window:show-main',
  'workbench:overview', 'context:compact',
  'workspace:files', 'workspace:open', 'workspace:pick-dir', 'workspace:reset-dir',
  'artifacts:groups', 'dict:list',
])

// on：主 → 渲染 事件推送（对应 webContents.send）
const ON_CHANNELS = new Set<string>([
  'agent:form-request', 'agent:log-stream', 'agent:perm-gate', 'agent:plan-proposal', 'sandbox-local:install-progress',
  'app:update-status',
  'files:sync-progress', 'files:watch-event', 'filesync:event',
  'auth:expired', 'kb:changed', 'recorder:step', 'recorder:stopped', 'remote-bot:status', 'schedule:fire', 'schedule:changed',
  'skills:changed', 'systems:heartbeat', 'systems:logged-in', 'turn:event', 'window:maximized-changed',
])

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, ...args: any[]) => {
    if (!INVOKE_CHANNELS.has(channel)) {
      console.error(`[preload] 拒绝未登记的 invoke 通道: ${channel}`)
      return Promise.reject(new Error(`IPC 通道未授权: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel: string, callback: (...args: any[]) => void) => {
    if (!ON_CHANNELS.has(channel)) {
      console.error(`[preload] 拒绝未登记的 on 通道: ${channel}`)
      return () => {}
    }
    const subscription = (_event: any, ...args: any[]) => callback(...args)
    ipcRenderer.on(channel, subscription)
    return () => {
      ipcRenderer.removeListener(channel, subscription)
    }
  },
  // Host OS, so the renderer can place window controls per-platform
  // (macOS: top-left; Windows/Linux: top-right).
  platform: process.platform
})
