import React, { useState } from 'react'
import { useAuth } from '../services/auth'

const S: any = {
  root: { position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F9FB' },
  card: { width: 380, background: '#fff', border: '1px solid #e5eaee', borderRadius: 14, boxShadow: '0 10px 30px rgba(0,0,0,.08)', padding: 30, display: 'flex', flexDirection: 'column', gap: 14 },
  label: { fontSize: 12.5, fontWeight: 600, color: '#5b6b7a', marginBottom: 6, display: 'block' },
  input: { height: 44, boxSizing: 'border-box', width: '100%', padding: '0 12px', fontSize: 14, background: '#fff', border: '1.5px solid #dde3e8', borderRadius: 10, outline: 'none' },
  btn: { height: 46, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: 700, color: '#fff', borderRadius: 11, background: 'linear-gradient(135deg,#16A371,#0E8A5E)' },
  ghost: { height: 40, border: '1px solid #dde3e8', cursor: 'pointer', fontSize: 13, borderRadius: 9, background: '#fff' },
  err: { fontSize: 12.5, color: '#dc2626', background: 'rgba(220,38,38,.08)', border: '1px solid rgba(220,38,38,.2)', padding: '8px 12px', borderRadius: 9 }
}

export default function ChangePassword() {
  const { changePassword, logout, user } = useAuth()
  const [oldPwd, setOld] = useState('')
  const [n1, setN1] = useState('')
  const [n2, setN2] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (n1.length < 6) { setErr('新密码至少 6 位'); return }
    if (n1 !== n2) { setErr('两次新密码不一致'); return }
    setBusy(true); setErr('')
    const r = await changePassword(oldPwd, n1)
    setBusy(false)
    if (!r.ok) setErr(r.error || '修改失败')
  }

  return (
    <div style={S.root}>
      <form style={S.card} onSubmit={submit}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: '#1a2530' }}>首次登录 · 请修改密码</h1>
          <p style={{ fontSize: 12.5, color: '#6b7885', margin: '6px 0 0' }}>账号「{user?.displayName || user?.username}」需设置新密码后继续</p>
        </div>
        <div><span style={S.label}>当前密码</span><input style={S.input} type="password" value={oldPwd} autoFocus onChange={e => setOld(e.target.value)} /></div>
        <div><span style={S.label}>新密码（≥6 位）</span><input style={S.input} type="password" value={n1} onChange={e => setN1(e.target.value)} /></div>
        <div><span style={S.label}>确认新密码</span><input style={S.input} type="password" value={n2} onChange={e => setN2(e.target.value)} /></div>
        {err && <div style={S.err}>{err}</div>}
        <button type="submit" style={{ ...S.btn, opacity: busy ? .65 : 1 }} disabled={busy}>{busy ? '提交中…' : '设置新密码并继续'}</button>
        <button type="button" style={S.ghost} onClick={logout}>退出登录</button>
      </form>
    </div>
  )
}
