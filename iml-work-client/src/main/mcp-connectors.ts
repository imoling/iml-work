// ================= MCP 连接器：服务器登记 + 探活验证 + 工具组装 =================
//
// 「服务连接器」的 MCP 形态：SaaS 目录是固定的 7 个描述符，MCP 服务器则由用户自行添加
//（任意数量、任意实现），故独立存储于 config 键 `mcpServers`（db.ts SECURE_KEYS 加密——
// env/headers 里常放 token，且按账号分库）。分层与 SaaS 连接器同构：
//   mcp-client（协议叶子）→ 本文件（存储/验证/ToolSpec 组装）→ agent-core 注册。
//
// 工具注册表组装是同步的，而 MCP 取工具清单要真连服务器——因此工具清单在「测试连接」
// 时拉取并缓存进配置，注册表用缓存；服务器工具集变了，重点一次测试即刷新。
// 风险档：服务器自述只读（readOnlyHint）→ low 自动放行；其余一律 write 走确认闸
//（MCP 注解是服务器单方声明，缺省不可信——宁可多签一次字，不放过一次外发）。

import crypto from 'crypto'
import { configGet, configSet } from './db'
import { McpClient, pooledMcpCall, type McpToolInfo, type McpTransportConfig } from './mcp-client'
import type { ToolSpec, ToolParamSchema } from './tool-registry'
import { swallow, friendlyNetError } from './util'

const CONFIG_KEY = 'mcpServers'

export interface McpServerConfig extends McpTransportConfig {
  id: string
  name: string
  enabled: boolean
  /** 探活身份（如「everything · 12 个工具」）。 */
  identity?: string
  verifiedAt?: number
  /** 上次验证时缓存的工具清单（注册表组装用它，不用现场连服务器）。 */
  tools?: McpToolInfo[]
}

export function loadMcpServers(): McpServerConfig[] {
  try {
    const raw = configGet(CONFIG_KEY)
    if (raw) {
      const v = JSON.parse(raw)
      if (Array.isArray(v)) return v as McpServerConfig[]
    }
  } catch (e) { swallow(e, 'mcp-load') }
  return []
}

function persist(list: McpServerConfig[]): void {
  configSet(CONFIG_KEY, JSON.stringify(list))
}

export function mcpServerOf(id: string): McpServerConfig | undefined {
  return loadMcpServers().find(s => s.id === id)
}

export interface McpServerPatch {
  id?: string
  name?: string
  transport?: 'stdio' | 'http'
  command?: string
  url?: string
  env?: string
  headers?: string
  enabled?: boolean
}

/** 保存（新增或更新）。env/headers 属凭证字段：留空 = 保留旧值（渲染层只拿到「已保存」标记）。 */
export function saveMcpServer(patch: McpServerPatch): McpServerConfig {
  const list = loadMcpServers()
  const id = (patch.id || '').trim() || `mcp_${crypto.randomBytes(4).toString('hex')}`
  const prev = list.find(s => s.id === id)
  const next: McpServerConfig = {
    id,
    name: (patch.name ?? prev?.name ?? '').trim() || 'MCP 服务器',
    transport: patch.transport || prev?.transport || 'stdio',
    command: (patch.command ?? prev?.command ?? '').trim(),
    url: (patch.url ?? prev?.url ?? '').trim(),
    env: (patch.env || '').trim() || prev?.env || '',
    headers: (patch.headers || '').trim() || prev?.headers || '',
    enabled: patch.enabled ?? prev?.enabled ?? false,
  }
  // 连接参数没变才继承旧的验证结论与工具缓存（变了就作废，逼一次重新验证）
  const sameTarget = !!prev && prev.transport === next.transport && prev.command === next.command
    && prev.url === next.url && prev.env === next.env && prev.headers === next.headers
  if (sameTarget && prev) { next.identity = prev.identity; next.verifiedAt = prev.verifiedAt; next.tools = prev.tools }
  const idx = list.findIndex(s => s.id === id)
  if (idx >= 0) list[idx] = next
  else list.push(next)
  persist(list)
  return next
}

export function removeMcpServer(id: string): void {
  persist(loadMcpServers().filter(s => s.id !== id))
}

export interface McpValidationResult { ok: boolean; identity?: string; tools?: McpToolInfo[]; error?: string }

/** 探活：真连一次（stdio 会真实启动子进程）→ 握手 → 拉工具清单缓存进配置。 */
export async function validateMcpServer(id: string): Promise<McpValidationResult> {
  const cfg = mcpServerOf(id)
  if (!cfg) return { ok: false, error: `未找到 MCP 服务器配置：${id}` }
  if (cfg.transport === 'stdio' && !(cfg.command || '').trim()) return { ok: false, error: '请先填写启动命令' }
  if (cfg.transport === 'http' && !(cfg.url || '').trim()) return { ok: false, error: '请先填写服务地址' }
  const client = new McpClient(cfg)
  try {
    await client.connect()
    const tools = await client.listTools()
    const identity = `${client.serverName || cfg.name} · ${tools.length} 个工具`
    const list = loadMcpServers()
    const idx = list.findIndex(s => s.id === id)
    if (idx >= 0) { list[idx] = { ...list[idx], identity, verifiedAt: Date.now(), tools }; persist(list) }
    return { ok: true, identity, tools }
  } catch (e: any) {
    // stdio 的错误（进程退出/未响应）本身已是人话；HTTP 的网络级失败交给统一翻译
    return { ok: false, error: cfg.transport === 'http' ? friendlyNetError(e, cfg.url) : (e?.message || String(e)) }
  } finally {
    client.close()
  }
}

// ── ToolSpec 组装 ─────────────────────────────────────────────────────────────

/** MCP 工具名并入全局注册表：前缀服务器 id 防撞名，字符收敛到 function-calling 允许集。 */
function specName(serverId: string, toolName: string): string {
  return `${serverId}_${toolName}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

/** MCP inputSchema 原样透传（function-calling 接受完整 JSON Schema）；缺失/非法时兜底空对象。 */
function toParamSchema(inputSchema: unknown): ToolParamSchema {
  const s = inputSchema as any
  if (s && typeof s === 'object' && s.type === 'object') {
    return { ...s, type: 'object', properties: s.properties || {} } as ToolParamSchema
  }
  return { type: 'object', properties: {} }
}

/**
 * 已启用 MCP 服务器贡献的工具（与 connectorToolSpecs 并列的门控入口：未启用或
 * 从未验证过的服务器，一个工具都不出现）。执行体走 mcp-client 连接池：同一服务器
 * 多次调用复用连接，闲置 5 分钟自动断开。
 */
export function mcpToolSpecs(): ToolSpec[] {
  const specs: ToolSpec[] = []
  for (const server of loadMcpServers()) {
    if (!server.enabled || !server.tools?.length) continue
    for (const tool of server.tools) {
      specs.push({
        name: specName(server.id, tool.name),
        description: `【${server.name}（MCP）】${(tool.description || tool.name).slice(0, 800)}`,
        parameters: toParamSchema(tool.inputSchema),
        metadata: {
          label: `${server.name}·${tool.name}`,
          risk: tool.readOnly ? 'low' : 'write',
          category: 'connector',
        },
        run: async (args) => pooledMcpCall(server.id, server, tool.name, args),
      })
    }
  }
  return specs
}
