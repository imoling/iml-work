import crypto from 'crypto'
import { configGet, configSet } from './db'
import { swallow } from './util'

// 后端管理端地址：运行时配置(adminBaseUrl) → 构建/启动期 env → 本地默认，三级回退。
export function getAdminBaseUrl(): string {
  const v = configGet('adminBaseUrl')
  if (v && v.trim()) return v.trim().replace(/\/$/, '')
  return (process.env.VITE_ADMIN_BASE_URL || 'http://localhost:8080').replace(/\/$/, '')
}

// ── 登录会话（统一账户）───────────────────────────────────────────────────
// token + 用户信息存本地 config；后端调用带上 token；ownerId 用登录 userId。
export interface AuthUser {
  id: string; username: string; displayName?: string; department?: string; phone?: string
  permissions: string[]; roles: string[]; assignedExpertIds: string[]; allowAllExperts: boolean
}

export function authToken(): string { return configGet('auth-token') || '' }

export function authUser(): AuthUser | null {
  try { const raw = configGet('auth-user'); if (raw) return JSON.parse(raw) } catch (e) { swallow(e) }
  return null
}

export function authHeaders(): Record<string, string> {
  const t = authToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

// 带登录 token 的后端请求包装（仅用于访问管理端 getAdminBaseUrl()）。合并 Authorization，
// 不覆盖已有头（含 multipart 的 Content-Type 由 fetch 自动处理）。统一注入超时（默认 30s，
// 避免后端/网络慢响应无限挂起）；调用方可用 init.timeoutMs 覆盖，传 0 表示不设超时（流式/长任务）。
// 已传 signal 时以其为准。
export type AFetchInit = RequestInit & { timeoutMs?: number }

export async function afetch(url: string, init?: AFetchInit): Promise<Response> {
  const { timeoutMs, headers, signal, ...rest } = init || {}
  const merged = { ...((headers as Record<string, string>) || {}), ...authHeaders() }
  const t = timeoutMs === undefined ? 30000 : timeoutMs
  const sig = signal || (t > 0 ? AbortSignal.timeout(t) : undefined)
  const res = await fetch(url, { ...rest, headers: merged, signal: sig })
  // 登录过期统一识别：**带着 token 却仍被拒**（401/403）→ token 失效（JWT 72h ttl / 后端换了密钥）。
  // 不这么做的话，各调用点会把 403 各自翻译成"服务不可达/沙箱不可用"，把「登录过期」误报成「服务故障」
  // ——用户看到满屏红叉却不知道只要重登一下。此处清本地登录态并广播，渲染层踢回登录页。
  if ((res.status === 401 || res.status === 403) && authToken()) notifyAuthExpired()
  return res
}

// 登录过期：清 token/用户，通知渲染层回登录页。60s 内只广播一次（并发请求会同时撞 403，避免刷屏）。
let lastAuthExpiredAt = 0
function notifyAuthExpired(): void {
  const now = Date.now()
  if (now - lastAuthExpiredAt < 60000) return
  lastAuthExpiredAt = now
  try {
    configSet('auth-token', '')
    configSet('auth-user', '')
    // 叶子模块不 import window-ref 以外的东西；emitToRenderer 是纯转发，无环。
    void import('./window-ref').then(m => m.emitToRenderer('auth:expired', { reason: '登录已过期，请重新登录' }))
  } catch (e) { swallow(e, 'auth-expired') }
}

// 该用户的稳定 owner id（个人知识库归属）。已登录 → 用登录 userId（换机也是同一个人）；
// 未登录 → 退回本地生成（兼容未接入登录的场景）。
export function getOwnerId(): string {
  const u = authUser()
  if (u && u.id) return u.id
  let id = configGet('kb-owner-id')
  if (!id) {
    const nick = configGet('user-nickname') || 'user'
    id = 'own-' + crypto.createHash('md5').update(nick + ':' + crypto.randomUUID()).digest('hex').slice(0, 12)
    configSet('kb-owner-id', id)
  }
  return id
}
