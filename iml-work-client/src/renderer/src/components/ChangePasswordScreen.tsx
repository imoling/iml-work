import { useState } from 'react'
import { KeyRound, Lock, LogOut, ArrowRight } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'

export default function ChangePasswordScreen() {
  const { changePassword, logout, user } = useAuthStore()
  const [oldPwd, setOld] = useState('')
  const [n1, setN1] = useState('')
  const [n2, setN2] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (n1.length < 6) { setErr('新密码至少 6 位'); return }
    if (n1 !== n2) { setErr('两次新密码不一致'); return }
    setBusy(true); setErr('')
    const r = await changePassword(oldPwd, n1)
    setBusy(false)
    if (!r.ok) setErr(r.error || '修改失败')
  }

  return (
    <div className="login-screen">
      <form onSubmit={submit} className="pwd-card">
        <div className="pwd-head">
          <div className="pwd-head-ic"><KeyRound size={22} /></div>
          <div>
            <h1>首次登录 · 请修改密码</h1>
            <p>账号「{user?.displayName || user?.username}」需设置新密码后继续</p>
          </div>
        </div>

        <label className="auth-field">
          <span className="auth-label">当前密码</span>
          <div className="auth-input-wrap"><Lock size={15} className="auth-input-ic" /><input type="password" value={oldPwd} autoFocus onChange={e => setOld(e.target.value)} placeholder="请输入当前密码" /></div>
        </label>
        <label className="auth-field">
          <span className="auth-label">新密码（≥6 位）</span>
          <div className="auth-input-wrap"><Lock size={15} className="auth-input-ic" /><input type="password" value={n1} onChange={e => setN1(e.target.value)} placeholder="请输入新密码" /></div>
        </label>
        <label className="auth-field">
          <span className="auth-label">确认新密码</span>
          <div className="auth-input-wrap"><Lock size={15} className="auth-input-ic" /><input type="password" value={n2} onChange={e => setN2(e.target.value)} placeholder="再次输入新密码" /></div>
        </label>

        {err && <div className="auth-error">{err}</div>}

        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? '提交中…' : <>设置新密码并继续 <ArrowRight size={16} /></>}
        </button>
        <button type="button" className="pwd-logout" onClick={logout}><LogOut size={13} />退出登录</button>
      </form>
    </div>
  )
}
