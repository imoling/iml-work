import { useState } from 'react'
import { LogIn, User, Lock } from 'lucide-react'
import { useAuth } from '../auth'
import heroArt from '../assets/brand/login-hero-illustration.png'
// 暗色专用 logo：原版 iM 字母是深色，在暗色玻璃卡上看不清
import logoMarkDark from '../assets/brand/logo-mark-dark.png'

export default function LoginPage() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [phone, setPhone] = useState('')
  const [notice, setNotice] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) { setErr('请输入用户名和密码'); return }
    setBusy(true); setErr('')
    const r = await login(username.trim(), password)
    setBusy(false)
    if (!r.ok) setErr(r.error || '登录失败')
  }

  const submitForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim()) { setErr('请输入用户名'); return }
    setBusy(true); setErr('')
    try {
      const res = await fetch('/api/v1/auth/forgot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), phone: phone.trim() })
      })
      const d = await res.json()
      setBusy(false)
      if (res.ok && d.success) { setNotice(d.message || '已提交找回申请'); setMode('login') }
      else setErr(d.error || '提交失败')
    } catch (e: any) { setBusy(false); setErr(e.message || '网络错误') }
  }

  if (mode === 'forgot') {
    return (
      <div className="login-hero">
        <span className="login-aurora a" /><span className="login-aurora b" /><span className="login-aurora c" />
          <form onSubmit={submitForgot} className="glass-panel" style={{ width: 380, display: 'flex', flexDirection: 'column', gap: 16, padding: 32 }}>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>找回密码</h1>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '6px 0 0' }}>提交后由管理员核验身份并重置，请留意联系。</p>
          </div>
          <div className="form-group"><label className="form-label">用户名</label><input className="form-input" value={username} autoFocus onChange={e => setUsername(e.target.value)} placeholder="用户名" /></div>
          <div className="form-group"><label className="form-label">预留手机号（供核验，可选）</label><input className="form-input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="手机号" /></div>
          {err && <div style={{ fontSize: 12, color: 'var(--accent-red, #dc2626)' }}>{err}</div>}
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? '提交中…' : '提交找回申请'}</button>
          <a style={{ fontSize: 12, color: 'var(--brand-primary)', cursor: 'pointer', textAlign: 'center' }} onClick={() => { setMode('login'); setErr('') }}>← 返回登录</a>
        </form>
      </div>
    )
  }

  return (
    <div className="login-hero">
      <span className="login-aurora a" /><span className="login-aurora b" /><span className="login-aurora c" />
      <div className="login-duo">
      <div className="login-pitch">
        <div className="login-pitch-title">让每个岗位都有一个数字分身</div>
        <div className="login-pitch-sub">贴身执行 · 本体驱动 · 全程可审计</div>
        <img className="login-art" src={heroArt} alt="数字工作分身" />
      </div>
      <form onSubmit={submit} className="glass-panel" style={{ width: 380, display: 'flex', flexDirection: 'column', gap: 18, padding: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src={logoMarkDark} alt="iML" style={{ width: 40, height: 40 }} />
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>iML 管理台</h1>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>企业岗位分身管理控制台</p>
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">用户名</label>
          <div style={{ position: 'relative' }}>
            <User size={14} style={{ position: 'absolute', left: 10, top: 12, color: 'var(--text-muted)' }} />
            <input className="form-input" style={{ paddingLeft: 32 }} value={username} autoFocus
              onChange={e => setUsername(e.target.value)} placeholder="用户名" />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">密码</label>
          <div style={{ position: 'relative' }}>
            <Lock size={14} style={{ position: 'absolute', left: 10, top: 12, color: 'var(--text-muted)' }} />
            <input className="form-input" style={{ paddingLeft: 32 }} type="password" value={password}
              onChange={e => setPassword(e.target.value)} placeholder="密码" />
          </div>
        </div>

        {err && <div style={{ fontSize: 12, color: 'var(--accent-red, #dc2626)' }}>{err}</div>}
        {notice && <div style={{ fontSize: 12, color: 'var(--brand-primary)', background: 'var(--mint-50, rgba(55,201,139,.1))', padding: '8px 12px', borderRadius: 8 }}>{notice}</div>}

        <button type="submit" className="btn-primary" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <LogIn size={15} />{busy ? '登录中…' : '登录'}
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span />
          <a style={{ fontSize: 12, color: 'var(--brand-primary)', cursor: 'pointer' }} onClick={() => { setMode('forgot'); setErr(''); setNotice('') }}>忘记密码？</a>
        </div>
      </form>
      </div>
      {/* 公开下载入口：要装客户端的是员工，员工没有管理台账号——入口不能锁在登录后面 */}
      <a className="login-download-link" href="#downloads">⬇ 下载桌面客户端（macOS / Windows）</a>
      <div className="login-footnote">凭证与业务实例数据只留员工本机 · 平台只存 Schema 与审计事件</div>
    </div>
  )
}
