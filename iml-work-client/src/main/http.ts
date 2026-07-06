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

export function afetch(url: string, init?: AFetchInit): Promise<Response> {
  const { timeoutMs, headers, signal, ...rest } = init || {}
  const merged = { ...((headers as Record<string, string>) || {}), ...authHeaders() }
  const t = timeoutMs === undefined ? 30000 : timeoutMs
  const sig = signal || (t > 0 ? AbortSignal.timeout(t) : undefined)
  return fetch(url, { ...rest, headers: merged, signal: sig })
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
