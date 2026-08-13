// 渲染层可用 IPC 通道白名单——**单一来源**。
//
// 消费方有两个：preload.ts（Electron 桥，白名单校验）与 src/host/（Web 宿主，WS RPC 校验）。
// 新增 ipcMain.handle / webContents.send 时改这里，两端自动同步；绝不在任何一端另开清单。

// invoke：渲染 → 主 请求-响应（对应 ipcMain.handle）
export const INVOKE_CHANNELS: readonly string[] = [
  'agent:abort', 'agent:delete-confirm', 'agent:form-cancel', 'agent:form-submit', 'agent:perm-choice', 'agent:send-message',
  'app:autostart-get', 'app:autostart-set', 'app:floatball-get', 'app:floatball-set',
  'floatball:drag-start', 'floatball:move', 'floatball:ignore-mouse',
  'app:keepawake-get', 'app:keepawake-set',
  'app:version', 'app:update-get', 'app:update-check', 'app:update-download', 'app:update-install',
  'attach:pick', 'attach:upload',
  'auth:change-password', 'auth:forgot', 'auth:last-username', 'auth:login', 'auth:logout', 'auth:session',
  'backend:get-url', 'backend:set-url', 'backend:ping',
  'connectors:list', 'connectors:save', 'connectors:test', 'connectors:remove',
  'mcp:list', 'mcp:save', 'mcp:test', 'mcp:remove',
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
  'secure-store:get', 'secure-store:save', 'ui-config:hero-cards',
  'skill:save-recorded', 'skill:transpile-recording', 'skill:delete-recorded',
  'skillauth:draft', 'skillauth:mine', 'skillauth:perms', 'skillauth:save', 'skillauth:upload', 'skillauth:validate',
  'systems:check', 'systems:heartbeat-get', 'systems:heartbeat-now', 'systems:heartbeat-set',
  'systems:list', 'systems:login', 'systems:login-close', 'systems:logout',
  'trace:feedback',
  'turn:clear-history', 'turn:conv-model-get', 'turn:conv-model-set', 'turn:enabled', 'turn:history', 'turn:running', 'turn:send-message', 'turn:set-enabled',
  'turn:set-workspace-access', 'turn:workspace-access',
  'window:close', 'window:is-maximized', 'window:maximize', 'window:minimize',
  'window:open-path', 'window:open-url', 'window:show-main',
  'workbench:overview', 'context:compact',
  'workspace:files', 'workspace:open', 'workspace:pick-dir', 'workspace:reset-dir',
  'artifacts:groups', 'dict:list',
]

// on：主 → 渲染 事件推送（对应 webContents.send / emitToRenderer）
export const ON_CHANNELS: readonly string[] = [
  'agent:form-request', 'agent:log-stream', 'agent:perm-gate', 'agent:plan-proposal', 'sandbox-local:install-progress',
  'app:update-status',
  'files:sync-progress', 'files:watch-event', 'filesync:event',
  'auth:expired', 'kb:changed', 'recorder:step', 'recorder:stopped', 'remote-bot:status', 'schedule:fire', 'schedule:changed',
  'skills:changed', 'systems:heartbeat', 'systems:logged-in', 'turn:event', 'window:maximized-changed',
  'floatball:state',
]
