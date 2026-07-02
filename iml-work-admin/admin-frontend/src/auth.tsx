import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

export interface AuthUser {
  id: string
  username: string
  displayName: string
  department?: string
  roles: string[]
  permissions: string[]
  mustChangePassword?: boolean
}

const TOKEN_KEY = 'iml-admin-token'
let authToken: string | null = localStorage.getItem(TOKEN_KEY)

export function getToken() { return authToken }
function setToken(t: string | null) {
  authToken = t
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
}

// 全局 fetch 拦截：给同源 /api 请求自动带上 Authorization；401 时清 token 触发回登录。
const rawFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url)
  const isApi = url.startsWith('/api/') || url.includes('://') === false && url.startsWith('/api')
  if (isApi && authToken) {
    init = init || {}
    const headers = new Headers(init.headers || (typeof input !== 'string' && !(input instanceof URL) ? input.headers : undefined))
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${authToken}`)
    init.headers = headers
  }
  const res = await rawFetch(input as any, init)
  if (res.status === 401 && isApi && !url.includes('/auth/login')) {
    setToken(null)
    window.dispatchEvent(new Event('iml-auth-expired'))
  }
  return res
}

interface AuthContextValue {
  user: AuthUser | null
  ready: boolean
  has: (perm: string) => boolean
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string; user?: AuthUser }>
  logout: () => void
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>(null as any)
export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [ready, setReady] = useState(false)

  const loadMe = async () => {
    if (!authToken) { setUser(null); setReady(true); return }
    try {
      const res = await rawFetch('/api/v1/auth/me', { headers: { Authorization: `Bearer ${authToken}` } })
      if (res.ok) setUser(await res.json())
      else { setToken(null); setUser(null) }
    } catch { setUser(null) }
    setReady(true)
  }

  useEffect(() => {
    loadMe()
    const onExpired = () => setUser(null)
    window.addEventListener('iml-auth-expired', onExpired)
    return () => window.removeEventListener('iml-auth-expired', onExpired)
  }, [])

  const login = async (username: string, password: string) => {
    try {
      const res = await rawFetch('/api/v1/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': 'admin' },
        body: JSON.stringify({ username, password })
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setToken(data.token)
        setUser(data.user)
        return { ok: true, user: data.user as AuthUser }
      }
      return { ok: false, error: data.error || '登录失败' }
    } catch (e: any) {
      return { ok: false, error: e.message || '网络错误' }
    }
  }

  const logout = () => { setToken(null); setUser(null) }
  const has = (perm: string) => !!user && (user.permissions.includes('*') || user.permissions.includes(perm))

  return (
    <AuthContext.Provider value={{ user, ready, has, login, logout, refresh: loadMe }}>
      {children}
    </AuthContext.Provider>
  )
}
