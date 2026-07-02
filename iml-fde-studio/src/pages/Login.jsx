import React, { useState } from 'react'
import { useAuth } from '../services/auth.jsx'

const S = {
  root: { position: 'fixed', inset: 0, display: 'flex', overflow: 'hidden', fontFamily: 'inherit' },
  brand: { flex: 1.05, position: 'relative', overflow: 'hidden', color: '#fff', display: 'flex', alignItems: 'center', padding: '56px 60px', background: 'linear-gradient(150deg,#16A371 0%,#0C8154 60%,#0A6E48 100%)' },
  blob1: { position: 'absolute', width: 340, height: 340, borderRadius: '50%', background: '#7DF0BE', filter: 'blur(55px)', opacity: .32, top: -80, right: -60 },
  blob2: { position: 'absolute', width: 300, height: 300, borderRadius: '50%', background: '#0E9E6A', filter: 'blur(55px)', opacity: .5, bottom: -90, left: -70 },
  bInner: { position: 'relative', zIndex: 1, maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 24 },
  logoBadge: { width: 46, height: 46, borderRadius: 12, background: '#fff', color: '#0C8154', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 18, boxShadow: '0 6px 20px rgba(0,0,0,.18)' },
  headline: { fontSize: 29, lineHeight: 1.35, fontWeight: 800, margin: 0, letterSpacing: .5 },
  feat: { display: 'flex', alignItems: 'flex-start', gap: 12 },
  featIc: { flexShrink: 0, width: 32, height: 32, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,.16)', border: '1px solid rgba(255,255,255,.22)' },
  formSide: { flex: .9, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, background: '#F7F9FB' },
  form: { width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 16 },
  label: { fontSize: 12.5, fontWeight: 600, color: '#5b6b7a' },
  input: { height: 46, boxSizing: 'border-box', width: '100%', padding: '0 14px', fontSize: 14, background: '#fff', border: '1.5px solid #dde3e8', borderRadius: 11, outline: 'none' },
  btn: { marginTop: 4, height: 48, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: 700, color: '#fff', borderRadius: 12, background: 'linear-gradient(135deg,#16A371,#0E8A5E)', boxShadow: '0 8px 22px rgba(14,138,94,.28)' },
  err: { fontSize: 12.5, color: '#dc2626', background: 'rgba(220,38,38,.08)', border: '1px solid rgba(220,38,38,.2)', padding: '8px 12px', borderRadius: 9 },
  hint: { textAlign: 'center', fontSize: 12, color: '#8a97a3' }
}

const FEATURES = [
  ['🛡️', '本地安全环境', '登录态与业务凭证只在本机，绝不上传'],
  ['🎬', '录制即生成技能', '实操录制自动产出可复用语义化技能'],
  ['🚀', '一体化调试上架', '直达执行 → 一段话测链路 → 上架技能中心'],
]

export default function Login() {
  const { login, forgot } = useAuth()
  const [username, setUsername] = useState(() => { try { return window.localStorage.getItem('fde.lastUsername') || '' } catch (_) { return '' } })
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState('login')
  const [phone, setPhone] = useState('')
  const [notice, setNotice] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (!username.trim() || !password) { setErr('请输入用户名和密码'); return }
    setBusy(true); setErr('')
    const r = await login(username.trim(), password)
    setBusy(false)
    if (!r.ok) setErr(r.error || '登录失败')
  }

  const submitForgot = async (e) => {
    e.preventDefault()
    if (!username.trim()) { setErr('请输入用户名'); return }
    setBusy(true); setErr('')
    const r = await forgot(username.trim(), phone.trim())
    setBusy(false)
    if (r.ok) { setNotice(r.message || '已提交找回申请'); setMode('login') }
    else setErr(r.error || '提交失败')
  }

  return (
    <div style={S.root}>
      <div style={S.brand}>
        <div style={S.blob1} /><div style={S.blob2} />
        <div style={S.bInner}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={S.logoBadge}>iML</span>
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: .5 }}>FDE 工作台</div>
              <div style={{ fontSize: 12, opacity: .82, marginTop: 2 }}>企业岗位分身训练场</div>
            </div>
          </div>
          <h2 style={S.headline}>录制即生成技能<br />把业务操作训练成工作分身能力</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 4 }}>
            {FEATURES.map((f, i) => (
              <div key={i} style={S.feat}>
                <span style={S.featIc}>{f[0]}</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{f[1]}</div>
                  <div style={{ fontSize: 12.5, opacity: .82, marginTop: 2, lineHeight: 1.5 }}>{f[2]}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, opacity: .72, marginTop: 4 }}>本地安全 · 高效执行 · 数据不出企业</div>
        </div>
      </div>

      <div style={S.formSide}>
        {mode === 'login' ? (
        <form style={S.form} onSubmit={submit}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0, color: '#1a2530' }}>欢迎回来</h1>
            <p style={{ fontSize: 13, color: '#6b7885', margin: '6px 0 0' }}>登录以进入 FDE 工作台</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <span style={S.label}>用户名</span>
            <input style={S.input} value={username} autoFocus onChange={e => setUsername(e.target.value)} placeholder="请输入用户名" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <span style={S.label}>密码</span>
            <input style={S.input} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="请输入密码" />
          </div>
          {err && <div style={S.err}>{err}</div>}
          {notice && <div style={{ fontSize: 12.5, color: '#0C8154', background: 'rgba(22,163,113,.1)', padding: '8px 12px', borderRadius: 9 }}>{notice}</div>}
          <button type="submit" style={{ ...S.btn, opacity: busy ? .65 : 1 }} disabled={busy}>{busy ? '登录中…' : '登录'}</button>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ ...S.hint, textAlign: 'left' }}>演示：<code>fde / fde123</code></span>
            <a style={{ fontSize: 12.5, color: '#0C8154', cursor: 'pointer' }} onClick={() => { setMode('forgot'); setErr(''); setNotice('') }}>忘记密码？</a>
          </div>
        </form>
        ) : (
        <form style={S.form} onSubmit={submitForgot}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: '#1a2530' }}>找回密码</h1>
            <p style={{ fontSize: 13, color: '#6b7885', margin: '6px 0 0' }}>提交后由管理员核验身份并重置</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <span style={S.label}>用户名</span>
            <input style={S.input} value={username} autoFocus onChange={e => setUsername(e.target.value)} placeholder="请输入用户名" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <span style={S.label}>预留手机号（供核验，可选）</span>
            <input style={S.input} value={phone} onChange={e => setPhone(e.target.value)} placeholder="手机号" />
          </div>
          {err && <div style={S.err}>{err}</div>}
          <button type="submit" style={{ ...S.btn, opacity: busy ? .65 : 1 }} disabled={busy}>{busy ? '提交中…' : '提交找回申请'}</button>
          <a style={{ fontSize: 12.5, color: '#0C8154', cursor: 'pointer', textAlign: 'center' }} onClick={() => { setMode('login'); setErr('') }}>← 返回登录</a>
        </form>
        )}
      </div>
    </div>
  )
}
