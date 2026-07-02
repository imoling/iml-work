import { useState } from 'react'
import { KeyRound, LogOut } from 'lucide-react'
import { useAuth } from '../auth'

export default function ChangePasswordGate() {
  const { refresh, logout, user } = useAuth()
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
    try {
      const res = await fetch('/api/v1/auth/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: oldPwd, newPassword: n1 })
      })
      const d = await res.json()
      setBusy(false)
      if (res.ok && d.success) { await refresh() } else setErr(d.error || '修改失败')
    } catch (e: any) { setBusy(false); setErr(e.message || '网络错误') }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base,#0b0f14)' }}>
      <form onSubmit={submit} className="glass-panel" style={{ width: 380, display: 'flex', flexDirection: 'column', gap: 14, padding: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <KeyRound size={20} color="var(--brand-primary)" />
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>首次登录 · 请修改密码</h1>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0' }}>账号「{user?.displayName || user?.username}」需设置新密码后继续</p>
          </div>
        </div>
        <div className="form-group"><label className="form-label">当前密码</label><input className="form-input" type="password" value={oldPwd} onChange={e => setOld(e.target.value)} autoFocus /></div>
        <div className="form-group"><label className="form-label">新密码（≥6 位）</label><input className="form-input" type="password" value={n1} onChange={e => setN1(e.target.value)} /></div>
        <div className="form-group"><label className="form-label">确认新密码</label><input className="form-input" type="password" value={n2} onChange={e => setN2(e.target.value)} /></div>
        {err && <div style={{ fontSize: 12, color: 'var(--accent-red,#dc2626)' }}>{err}</div>}
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? '提交中…' : '设置新密码并继续'}</button>
        <button type="button" className="btn-secondary" onClick={logout} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><LogOut size={13} />退出登录</button>
      </form>
    </div>
  )
}
