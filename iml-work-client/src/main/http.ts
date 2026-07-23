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

// 解析本地 JWT 的 exp（秒），返回**距过期的毫秒数**（已过期为负）；无 token / 解不出返回 **NaN**（表示"无法判定"，别与"已过期的负数"混淆）。
export function authExpiresInMs(): number {
  const t = authToken()
  if (!t) return NaN
  try {
    const payload = t.split('.')[1]; if (!payload) return NaN
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    if (!json || typeof json.exp !== 'number') return NaN
    return json.exp * 1000 - Date.now()
  } catch { return NaN }
}

// 令牌是否至少还有 minMs 才过期。**已过期（负）或即将过期（0 ≤ 剩余 < minMs）**→ 触发登录过期（清令牌+踢回登录页）返回 false；
// 解不出 exp（NaN，含无令牌）→ 不误踢、放行，交给真实请求时的 401 兜底。
// 用于「开始录制」等**耗时操作前**的前置检查：宁可现在重登一次拿全新 72h 令牌，也别录一场后在保存时才失效、白干。
export function ensureAuthFresh(minMs: number): boolean {
  const left = authExpiresInMs()
  if (Number.isNaN(left)) return true
  if (left < minMs) { notifyAuthExpired(); return false }   // 负数(已过期)也落这里 → 踢
  return true
}

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
  // 带着 token 却被拒（401/403）：要分清「登录过期」和「权限不足」——后端对二者都可能回 403
  //（SecurityConfig 无自定义入口点，过期令牌被 JwtAuthFilter 清成匿名后走默认 Http403ForbiddenEntryPoint，
  //  与「已认证但缺权限」同样是 403），单看状态码分不开。**用本地 JWT 的 exp 作判据**：
  //   · 401                          → 服务端明确「未认证」（令牌无效/密钥轮换），重登有用 → 踢回登录；
  //   · 403 且本地令牌已过期/解不出   → 确是登录态失效（过期令牌被当匿名），→ 踢回登录；
  //   · 403 且本地令牌仍新鲜          → 是**权限不足**（如员工无 SKILL_MANAGE 存中央技能），重登无用，
  //                                     别误报「登录过期」害用户白白重登，交调用方按 403 自行提示。
  // 不做甄别的话会把「无权限」一律翻成「登录已过期」，用户重登后再撞同样的 403，永远救不回来。
  if (res.status === 401 && authToken()) notifyAuthExpired()
  else if (res.status === 403 && authToken()) {
    const left = authExpiresInMs()
    if (Number.isNaN(left) || left <= 0) notifyAuthExpired()   // 本地令牌真过期/解不出才踢
  }
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
