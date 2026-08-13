// ================= MCP 轻量客户端（stdio + Streamable HTTP）=================
//
// 连接器接 MCP（Model Context Protocol）服务器，但客户端只需要协议的一小块：
// initialize 握手、tools/list、tools/call——为这三个方法引入官方 SDK 不值
//（打包 externalize、版本跟跑都是长期成本），沿用服务连接器「零新依赖」纪律自研。
// MCP 本体是 JSON-RPC 2.0：
// · stdio 传输：spawn 本地子进程，stdin/stdout 按行分隔 JSON（规范如此）；
// · Streamable HTTP 传输（2025-03-26 起的标准远程传输）：每个请求一次 POST，
//   响应可能是 application/json，也可能是 text/event-stream（SSE 流里夹响应消息），都要解析；
//   旧式 HTTP+SSE 双端点（GET /sse + POST /messages）已被规范废弃，不支持——
//   探测到疑似旧式服务时报指向性错误，而不是干等超时。
// 叶子纪律：只 import Node 内置 + util，绝不 import main.ts / db / llm。

import { spawn, type ChildProcess } from 'child_process'
import { swallow } from './util'

export interface McpTransportConfig {
  transport: 'stdio' | 'http'
  /** stdio：完整启动命令行（支持引号包参数），如 `npx -y @modelcontextprotocol/server-filesystem /tmp` */
  command?: string
  /** stdio：附加环境变量，每行一条 KEY=VALUE（API 密钥等凭证走这里）。 */
  env?: string
  /** http：服务端点 URL（常见路径为 /mcp）。 */
  url?: string
  /** http：附加请求头，每行一条 `Name: Value`（Authorization 等凭证走这里）。 */
  headers?: string
}

export interface McpToolInfo {
  name: string
  description: string
  /** 入参 JSON Schema，原样透传给 function-calling。 */
  inputSchema?: unknown
  /** 服务器自述「只读」（annotations.readOnlyHint === true）。缺省按可写对待。 */
  readOnly: boolean
}

const INIT_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000
const POOL_IDLE_MS = 5 * 60_000
const PROTOCOL_VERSION = '2025-03-26'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

/** 把命令行拆成 argv（支持双/单引号包住带空格的参数）。 */
function parseCommandLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = '' } }
    else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** 每行一条 KEY=VALUE → 对象（空行与无 = 的行忽略）。 */
function parseEnvLines(text?: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (text || '').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** 每行一条 `Name: Value` → 请求头对象。 */
function parseHeaderLines(text?: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (text || '').split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/**
 * GUI 启动的 Electron 拿到的 PATH 不含 Homebrew/用户目录（macOS 通病），
 * 直接 spawn `npx`/`uvx` 会 ENOENT——把常见安装位补进 PATH。
 */
function spawnEnv(extraEnv?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...parseEnvLines(extraEnv) }
  if (process.platform !== 'win32') {
    const extras = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME || ''}/.local/bin`]
    const parts = (env.PATH || '').split(':')
    env.PATH = [...parts, ...extras.filter(p => p && !parts.includes(p))].join(':')
  }
  return env
}

export class McpClient {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private proc: ChildProcess | null = null
  private stdoutBuf = ''
  private stderrTail: string[] = []
  private procDead = ''          // 子进程死亡原因；非空后所有请求直接拒绝
  private sessionId = ''         // Streamable HTTP 的 Mcp-Session-Id
  private negotiatedVersion = PROTOCOL_VERSION
  /** initialize 握手带回的服务器自述名（探活身份展示用）。 */
  serverName = ''

  constructor(private cfg: McpTransportConfig) {}

  async connect(): Promise<void> {
    if (this.cfg.transport === 'stdio') this.startProcess()
    const r: any = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'iml-work-client', version: '1.0.0' },
    }, INIT_TIMEOUT_MS)
    this.negotiatedVersion = String(r?.protocolVersion || PROTOCOL_VERSION)
    this.serverName = String(r?.serverInfo?.name || '')
    await this.notify('notifications/initialized')
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {   // 分页游标循环，20 页封顶防服务器游标成环
      const r: any = await this.request('tools/list', cursor ? { cursor } : {}, LIST_TIMEOUT_MS)
      for (const t of (Array.isArray(r?.tools) ? r.tools : [])) {
        if (!t?.name) continue
        tools.push({
          name: String(t.name),
          description: String(t.description || ''),
          inputSchema: t.inputSchema,
          readOnly: t?.annotations?.readOnlyHint === true,
        })
      }
      cursor = r?.nextCursor
      if (!cursor) break
    }
    return tools
  }

  /** 调工具并把 content 摊平成观察文本；isError 时抛出（内核按失败观察处理）。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const r: any = await this.request('tools/call', { name, arguments: args || {} }, CALL_TIMEOUT_MS)
    const parts = (Array.isArray(r?.content) ? r.content : []).map((c: any) =>
      c?.type === 'text' ? String(c.text || '')
        : c?.type === 'resource' ? JSON.stringify(c.resource ?? {}).slice(0, 2000)
          : c?.type ? `[${c.type} 内容，已省略]` : '')
    let text = parts.filter(Boolean).join('\n').trim()
    if (!text && r?.structuredContent !== undefined) text = JSON.stringify(r.structuredContent).slice(0, 4000)
    if (r?.isError) throw new Error((text || 'MCP 工具执行失败（服务器未说明原因）').slice(0, 1500))
    return text || '(工具无输出)'
  }

  close(): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('连接已关闭')) }
    this.pending.clear()
    if (this.proc) {
      const proc = this.proc
      this.proc = null
      try { proc.kill() } catch (e) { swallow(e, 'mcp-kill') }
      const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch (e) { swallow(e, 'mcp-kill9') } }, 3000)
      t.unref?.()
    }
  }

  // ── JSON-RPC 分发（按传输方式路由）────────────────────────────────────────

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++
    const msg = { jsonrpc: '2.0', id, method, params }
    if (this.cfg.transport === 'stdio') return this.stdioRequest(id, msg, timeoutMs, method)
    return this.httpRequest(msg, timeoutMs, method)
  }

  private async notify(method: string): Promise<void> {
    const msg = { jsonrpc: '2.0', method }
    if (this.cfg.transport === 'stdio') { this.stdioSend(msg); return }
    // HTTP 下通知预期回 202；个别服务器不认这条通知，失败不影响主流程
    try { await this.httpSend(msg, 10_000) } catch (e) { swallow(e, 'mcp-notify') }
  }

  // ── stdio 传输 ────────────────────────────────────────────────────────────

  private startProcess(): void {
    const line = (this.cfg.command || '').trim()
    if (!line) throw new Error('未配置启动命令')
    const env = spawnEnv(this.cfg.env)
    // Windows 上 npx/uvx 是 .cmd，必须走 shell；类 Unix 自行拆 argv 避免 shell 注入面
    const proc = process.platform === 'win32'
      ? spawn(line, { shell: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
      : (() => { const argv = parseCommandLine(line); return spawn(argv[0], argv.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] }) })()
    this.proc = proc
    proc.stdout!.setEncoding('utf8')
    proc.stdout!.on('data', (chunk: string) => this.onStdout(chunk))
    proc.stderr!.setEncoding('utf8')
    proc.stderr!.on('data', (chunk: string) => {
      this.stderrTail = [...this.stderrTail, ...chunk.split('\n').filter(Boolean)].slice(-8)
    })
    proc.on('error', (e) => this.failAll(`无法启动 MCP 服务器进程：${e.message}（检查命令是否存在、路径是否正确）`))
    proc.on('exit', (code) => {
      if (this.proc) this.failAll(`MCP 服务器进程退出（code=${code ?? '?'}）${this.stderrTail.length ? '：' + this.stderrTail.join(' | ').slice(-500) : ''}`)
    })
  }

  private failAll(reason: string): void {
    this.procDead = reason
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)) }
    this.pending.clear()
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let i: number
    while ((i = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, i).trim()
      this.stdoutBuf = this.stdoutBuf.slice(i + 1)
      if (!line) continue
      let msg: any
      // 个别服务器把日志混进 stdout（违规但常见），忽略非 JSON 行
      try { msg = JSON.parse(line) } catch (e) { swallow(e, 'mcp-stdout-line'); continue }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: any): void {
    // 服务器→客户端请求：ping 必须应答（不答会被判断连），其余礼貌拒绝
    if (msg && msg.id !== undefined && typeof msg.method === 'string') {
      this.stdioSend(msg.method === 'ping'
        ? { jsonrpc: '2.0', id: msg.id, result: {} }
        : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not supported' } })
      return
    }
    if (msg && msg.id !== undefined) {
      const p = this.pending.get(Number(msg.id))
      if (!p) return
      this.pending.delete(Number(msg.id))
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`MCP 错误：${msg.error.message || JSON.stringify(msg.error).slice(0, 300)}`))
      else p.resolve(msg.result)
    }
    // 无 id 的通知（进度/日志）：忽略
  }

  private stdioSend(msg: unknown): void {
    try { this.proc?.stdin?.write(JSON.stringify(msg) + '\n') } catch (e) { swallow(e, 'mcp-stdin') }
  }

  private stdioRequest(id: number, msg: unknown, timeoutMs: number, method: string): Promise<unknown> {
    if (this.procDead) return Promise.reject(new Error(this.procDead))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 服务器 ${timeoutMs / 1000}s 未响应 ${method}${this.stderrTail.length ? '（stderr：' + this.stderrTail.join(' | ').slice(-300) + '）' : ''}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.stdioSend(msg)
    })
  }

  // ── Streamable HTTP 传输 ──────────────────────────────────────────────────

  private async httpSend(msg: any, timeoutMs: number): Promise<any | null> {
    const url = (this.cfg.url || '').trim()
    if (!url) throw new Error('未配置服务地址')
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        'MCP-Protocol-Version': this.negotiatedVersion,
        ...parseHeaderLines(this.cfg.headers),
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    if (res.status === 202) return null   // 通知已接受，无响应体
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300)
      if (res.status === 404 || res.status === 405) {
        throw new Error(`HTTP ${res.status}：该地址不接受 Streamable HTTP 请求。检查 URL 路径（常见为 /mcp）；若服务器只支持旧式 SSE 传输（/sse 端点）则暂不支持，需服务器升级到 2025-03-26 及以上协议`)
      }
      throw new Error(`MCP 服务器返回 HTTP ${res.status}${text ? '：' + text : ''}`)
    }
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('text/event-stream')) return this.readSseResponse(res, msg.id)
    return res.json().catch(() => null)
  }

  /** 从 SSE 流里读出与本次请求 id 匹配的响应消息（流里可能夹进度通知，跳过）。 */
  private async readSseResponse(res: Response, id: number | undefined): Promise<any | null> {
    if (!res.body) return null
    let buf = ''
    const decoder = new TextDecoder()
    for await (const chunk of res.body as any) {
      // CRLF 归一：uvicorn 系服务器（DeepWiki 实测 2026-08-13）SSE 行尾是 \r\n，事件分隔
      // \r\n\r\n——只认 \n\n 会整条流读完也匹配不到，表现为「initialize 未返回响应」。
      // 裸 \r 在合法 JSON 字符串里不可能出现（CR 必须转义成 \\r），直接剥掉安全。
      buf += decoder.decode(chunk as Uint8Array, { stream: true }).replace(/\r/g, '')
      let sep: number
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const rawEvent = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        const data = rawEvent.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
        if (!data) continue
        let m: any
        try { m = JSON.parse(data) } catch (e) { swallow(e, 'mcp-sse-parse'); continue }
        // id 宽松比对：个别服务器把数字 id 回成字符串
        if (id !== undefined && m?.id !== undefined && String(m.id) === String(id)) return m
      }
    }
    return null
  }

  private async httpRequest(msg: any, timeoutMs: number, method: string): Promise<unknown> {
    const m = await this.httpSend(msg, timeoutMs)
    if (!m) throw new Error(`MCP 服务器对 ${method} 未返回响应`)
    if (m.error) throw new Error(`MCP 错误：${m.error.message || JSON.stringify(m.error).slice(0, 300)}`)
    return m.result
  }
}

// ── 连接池：同一服务器多次调用复用连接（stdio 免得每次冷启动子进程）──────────

const pool = new Map<string, { client: McpClient; timer: ReturnType<typeof setTimeout> }>()

async function pooledClient(key: string, cfg: McpTransportConfig): Promise<McpClient> {
  const hit = pool.get(key)
  if (hit) {
    clearTimeout(hit.timer)
    hit.timer = setTimeout(() => closeMcpClient(key), POOL_IDLE_MS)
    hit.timer.unref?.()
    return hit.client
  }
  const client = new McpClient(cfg)
  try { await client.connect() } catch (e) { client.close(); throw e }
  const timer = setTimeout(() => closeMcpClient(key), POOL_IDLE_MS)
  timer.unref?.()
  pool.set(key, { client, timer })
  return client
}

/**
 * 经连接池调一次工具。连接级失败（进程死亡/连接关闭/HTTP 会话过期）时踢出失活连接、
 * 透明重连重试一次；工具业务错误原样抛给内核。
 */
export async function pooledMcpCall(key: string, cfg: McpTransportConfig, tool: string, args: Record<string, unknown>): Promise<string> {
  const client = await pooledClient(key, cfg)
  try {
    return await client.callTool(tool, args)
  } catch (e: any) {
    const m = String(e?.message || '')
    const staleConn = /进程退出|连接已关闭/.test(m) || (cfg.transport === 'http' && /HTTP 404/.test(m))
    if (!staleConn) throw e
    closeMcpClient(key)
    const fresh = await pooledClient(key, cfg)
    return fresh.callTool(tool, args)
  }
}

export function closeMcpClient(key: string): void {
  const e = pool.get(key)
  if (!e) return
  pool.delete(key)
  clearTimeout(e.timer)
  e.client.close()
}

/** 应用退出前收尾全部连接（stdio 子进程不留孤儿）。 */
export function closeAllMcpClients(): void {
  for (const key of [...pool.keys()]) closeMcpClient(key)
}
