import { create } from 'zustand'

export interface AuthUser {
  id: string
  username: string
  displayName?: string
  department?: string
  phone?: string
  roles: string[]
  permissions: string[]
  assignedExpertIds: string[]
  allowAllExperts: boolean
  mustChangePassword?: boolean
}

interface AuthState {
  user: AuthUser | null
  ready: boolean
  offline: boolean            // 上次会话检查时后端不可达（→ 登录页提示配置后端地址）
  loadSession: () => Promise<void>
  login: (username: string, password: string, remember?: boolean) => Promise<{ ok: boolean; error?: string }>
  logout: () => Promise<void>
  changePassword: (oldPassword: string, newPassword: string) => Promise<{ ok: boolean; error?: string }>
  forgot: (username: string, phone: string) => Promise<{ ok: boolean; error?: string; message?: string }>
  getLastUsername: () => Promise<string>
  has: (perm: string) => boolean
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  ready: false,
  offline: false,

  loadSession: async () => {
    try {
      const r = await window.api.invoke('auth:session')
      set({ user: r?.user || null, offline: !!r?.offline, ready: true })
    } catch {
      set({ user: null, offline: true, ready: true })
    }
  },

  login: async (username: string, password: string, remember = true) => {
    try {
      const r = await window.api.invoke('auth:login', { username, password, remember })
      if (r?.ok) {
        set({ user: r.user })
        // 换账号登录：整窗重载，丢弃上一个账号残留在各 store 的内存态（会话/画像/记忆），
        // 重载后从该账号专属库重新加载，杜绝跨账号串号。
        window.location.reload()
        return { ok: true }
      }
      return { ok: false, error: r?.error || '登录失败' }
    } catch (e: any) {
      return { ok: false, error: e?.message || '网络错误' }
    }
  },

  logout: async () => {
    try { await window.api.invoke('auth:logout') } catch { /* ignore */ }
    set({ user: null })
    window.location.reload()   // 清空内存态，回到干净登录页
  },

  changePassword: async (oldPassword: string, newPassword: string) => {
    try {
      const r = await window.api.invoke('auth:change-password', { oldPassword, newPassword })
      if (r?.ok) { if (r.user) set({ user: r.user }); return { ok: true } }
      return { ok: false, error: r?.error || '修改失败' }
    } catch (e: any) {
      return { ok: false, error: e?.message || '网络错误' }
    }
  },

  forgot: async (username: string, phone: string) => {
    try {
      const r = await window.api.invoke('auth:forgot', { username, phone })
      return r?.ok ? { ok: true, message: r.message } : { ok: false, error: r?.error || '提交失败' }
    } catch (e: any) { return { ok: false, error: e?.message || '网络错误' } }
  },

  getLastUsername: async () => {
    try { return (await window.api.invoke('auth:last-username')) || '' } catch { return '' }
  },

  has: (perm: string) => {
    const u = get().user
    return !!u && (u.permissions.includes('*') || u.permissions.includes(perm))
  }
}))
