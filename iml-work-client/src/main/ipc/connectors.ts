// 服务连接器 IPC 域（register 函数模式）。回调只做调度：取参 → 调 connector-runtime → 回结果。
//
// 密钥不出主进程：`connectors:list` 只回非密钥字段的明文值，密钥字段只回「已保存」标记；
// 渲染层保存时密钥留空 = 保留旧值（合并逻辑在 connector-runtime.saveConnectorConfig）。
import { app } from 'electron'
import { ipcMain } from '../ipc-bus'
import { CONNECTOR_DEFS, connectorDefOf, connectorFieldsComplete } from '../connector-defs'
import {
  loadConnectorConfigs, saveConnectorConfig, removeConnectorConfig,
  markVerified, validateConnector,
} from '../connector-runtime'
import {
  loadMcpServers, mcpServerOf, saveMcpServer, removeMcpServer, validateMcpServer,
  type McpServerConfig, type McpServerPatch,
} from '../mcp-connectors'
import { closeMcpClient, closeAllMcpClients } from '../mcp-client'

/** 渲染层可见的连接器状态（不含任何密钥明文）。 */
function statusOf(key: string) {
  const def = connectorDefOf(key)
  if (!def) return null
  const saved = loadConnectorConfigs()[key]
  const values: Record<string, string> = {}
  const savedSecrets: string[] = []
  for (const f of def.fields) {
    const v = (saved?.values?.[f.key] || '').trim()
    if (!v) continue
    if (f.secret) savedSecrets.push(f.key)
    else values[f.key] = v
  }
  return {
    enabled: !!saved?.enabled,
    configured: !!saved && connectorFieldsComplete(def, saved.values),
    identity: saved?.identity || '',
    verifiedAt: saved?.verifiedAt || 0,
    values,
    savedSecrets,
  }
}

export function registerConnectorHandlers(): void {
  // 目录 + 各连接器状态（UI 一次拉全；描述符是可序列化纯数据，图标由渲染层按 key 映射）。
  // 消费方有两个页面：ConnectorsTab（开发协作类）与 ImTab（IM 平台连接器与远程机器人同卡配置）。
  ipcMain.handle('connectors:list', () => ({
    defs: CONNECTOR_DEFS,
    status: Object.fromEntries(CONNECTOR_DEFS.map(d => [d.key, statusOf(d.key)])),
  }))

  // 保存启用态与配置（不做网络验证；密钥留空=保留旧值）
  ipcMain.handle('connectors:save', (_e, key: string, patch: { enabled?: boolean; values?: Record<string, string> }) => {
    try {
      saveConnectorConfig(String(key || ''), {
        ...(patch?.enabled !== undefined ? { enabled: !!patch.enabled } : {}),
        values: patch?.values || {},
      })
      return { success: true, status: statusOf(String(key)) }
    } catch (e: any) { return { success: false, error: e?.message || String(e) } }
  })

  // 测试连接：草稿值合并已存值 → 真调目标 API 探活；成功则把验证过的凭证与身份一并落盘
  ipcMain.handle('connectors:test', async (_e, key: string, draft: Record<string, string>) => {
    const k = String(key || '')
    try {
      const saved = saveConnectorConfig(k, { values: draft || {} })
      const r = await validateConnector(k, saved.values)
      if (r.ok) markVerified(k, r.identity || '已验证')
      return { success: r.ok, identity: r.identity, error: r.error, status: statusOf(k) }
    } catch (e: any) { return { success: false, error: e?.message || String(e) } }
  })

  // 清空该连接器的全部本地配置（含密钥）
  ipcMain.handle('connectors:remove', (_e, key: string) => {
    removeConnectorConfig(String(key || ''))
    return { success: true }
  })

  // ── MCP 服务器（用户自定义条目，与固定目录的 SaaS 连接器并列）────────────

  ipcMain.handle('mcp:list', () => ({ servers: loadMcpServers().map(maskMcp) }))

  ipcMain.handle('mcp:save', (_e, patch: McpServerPatch) => {
    try {
      const s = saveMcpServer(patch || {})
      closeMcpClient(s.id)   // 连接参数可能变了，踢掉池里的旧连接
      return { success: true, id: s.id, server: maskMcp(s) }
    } catch (e: any) { return { success: false, error: e?.message || String(e) } }
  })

  // 测试连接：先落盘（新增条目由此产生 id）→ 真连一次 → 工具清单缓存进配置
  ipcMain.handle('mcp:test', async (_e, patch: McpServerPatch) => {
    try {
      const s = saveMcpServer(patch || {})
      closeMcpClient(s.id)
      const r = await validateMcpServer(s.id)
      return { success: r.ok, id: s.id, identity: r.identity, error: r.error, server: maskMcp(mcpServerOf(s.id) || s) }
    } catch (e: any) { return { success: false, error: e?.message || String(e) } }
  })

  ipcMain.handle('mcp:remove', (_e, id: string) => {
    closeMcpClient(String(id || ''))
    removeMcpServer(String(id || ''))
    return { success: true }
  })

  // 应用退出时收尾 MCP 连接（stdio 子进程不留孤儿）；无头宿主没有 electron app，退化挂 process
  if (app && typeof app.on === 'function') app.on('will-quit', closeAllMcpClients)
  else process.on('exit', closeAllMcpClients)
}

/** 渲染层可见的 MCP 服务器状态：env/headers 明文不出主进程，只回「已保存」标记。 */
function maskMcp(s: McpServerConfig) {
  return {
    id: s.id, name: s.name, transport: s.transport,
    command: s.command || '', url: s.url || '',
    hasEnv: !!(s.env || '').trim(), hasHeaders: !!(s.headers || '').trim(),
    enabled: s.enabled, identity: s.identity || '', verifiedAt: s.verifiedAt || 0,
    tools: (s.tools || []).map(t => ({ name: t.name, readOnly: t.readOnly, description: (t.description || '').slice(0, 200) })),
  }
}
