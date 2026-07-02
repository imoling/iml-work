import React, { createContext, useContext, useEffect, useState } from 'react'
import { Auth, getToken, setToken, getUser, setUser } from './api.js'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }) {
  const [user, setUserState] = useState(getUser())
  const [ready, setReady] = useState(false)

  useEffect(() => {
    (async () => {
      if (getToken()) {
        try { const me = await Auth.me(); setUser(me); setUserState(me) }
        catch { setToken(''); setUser(null); setUserState(null) }
      }
      setReady(true)
    })()
    const onExpired = () => setUserState(null)
    window.addEventListener('fde-auth-expired', onExpired)
    return () => window.removeEventListener('fde-auth-expired', onExpired)
  }, [])

  const login = async (username, password) => {
    try {
      const data = await Auth.login(username, password)
      if (data && data.success) {
        setToken(data.token); setUser(data.user); setUserState(data.user)
        try { window.localStorage.setItem('fde.lastUsername', username) } catch (_) {}
        return { ok: true }
      }
      return { ok: false, error: (data && data.error) || '登录失败' }
    } catch (e) {
      return { ok: false, error: e.message || '网络错误' }
    }
  }

  const forgot = async (username, phone) => {
    try {
      const d = await Auth.forgot(username, phone)
      if (d && d.success) return { ok: true, message: d.message }
      return { ok: false, error: (d && d.error) || '提交失败' }
    } catch (e) { return { ok: false, error: e.message || '网络错误' } }
  }

  const logout = () => { setToken(''); setUser(null); setUserState(null) }
  const has = (perm) => !!user && (user.permissions?.includes('*') || user.permissions?.includes(perm))

  const changePassword = async (oldPassword, newPassword) => {
    try {
      const d = await Auth.changePassword(oldPassword, newPassword)
      if (d && d.success) {
        try { const me = await Auth.me(); setUser(me); setUserState(me) } catch { /* ignore */ }
        return { ok: true }
      }
      return { ok: false, error: (d && d.error) || '修改失败' }
    } catch (e) { return { ok: false, error: e.message || '网络错误' } }
  }

  return (
    <AuthContext.Provider value={{ user, ready, login, logout, has, changePassword, forgot }}>
      {children}
    </AuthContext.Provider>
  )
}
