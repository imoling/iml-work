import { useState } from 'react'
import { KeyRound, LogOut } from 'lucide-react'
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
      <form onSubmit={submit} className="claim-panel" style={{ maxWidth: 400 }}>
        <div className="claim-header">
          <KeyRound size={30} color="var(--brand-primary)" />
          <div>
            <h1>首次登录 · 请修改密码</h1>
            <p>账号「{user?.displayName || user?.username}」需设置新密码后继续</p>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
          <div className="form-field"><label className="form-label">当前密码</label><input className="form-input" type="password" value={oldPwd} autoFocus onChange={e => setOld(e.target.value)} /></div>
          <div className="form-field"><label className="form-label">新密码（≥6 位）</label><input className="form-input" type="password" value={n1} onChange={e => setN1(e.target.value)} /></div>
          <div className="form-field"><label className="form-label">确认新密码</label><input className="form-input" type="password" value={n2} onChange={e => setN2(e.target.value)} /></div>
          {err && <div style={{ fontSize: 12, color: 'var(--accent-red, #dc2626)' }}>{err}</div>}
          <button type="submit" className="settings-btn" disabled={busy} style={{ width: '100%', padding: 12 }}>{busy ? '提交中…' : '设置新密码并继续'}</button>
          <button type="button" className="btn-secondary" onClick={logout} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><LogOut size={13} />退出登录</button>
        </div>
      </form>
    </div>
  )
}
