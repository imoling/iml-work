import { useState, useEffect } from 'react'
import { ArrowRight, User, Lock, ShieldCheck, Boxes, Database, Eye, EyeOff, Check } from 'lucide-react'
import logoMark from '../assets/brand/logo-mark.svg'
import loginShield from '../assets/brand/login-shield.png'   // 左侧盾牌插画（透明羽化，独立摆放）
import { useAuthStore } from '../stores/authStore'

const FEATURES = [
  { icon: <ShieldCheck size={16} />, title: '本地安全环境', desc: '登录态与业务凭证只在本机，绝不上传' },
  { icon: <Boxes size={16} />, title: '岗位工作分身', desc: '领用即用，岗位专业技能与自动化能力' },
  { icon: <Database size={16} />, title: '个人 + 企业知识库', desc: '文档随手沉淀，分享越用越懂你' },
]


export default function LoginScreen() {
  const { login, forgot, getLastUsername } = useAuthStore()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [remember, setRemember] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [phone, setPhone] = useState('')
  const [notice, setNotice] = useState('')

  // 记住上次登录用户名（预填）
  useEffect(() => { getLastUsername().then(u => { if (u) setUsername(u) }) }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) { setErr('请输入用户名和密码'); return }
    setBusy(true); setErr('')
    const r = await login(username.trim(), password, remember)
    setBusy(false)
    if (!r.ok) setErr(r.error || '登录失败')
  }

  const submitForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim()) { setErr('请输入用户名'); return }
    setBusy(true); setErr('')
    const r = await forgot(username.trim(), phone.trim())
    setBusy(false)
    if (r.ok) { setNotice(r.message || '已提交找回申请'); setMode('login') }
    else setErr(r.error || '提交失败')
  }

  return (
    <div className="auth-root">
      {/* 左侧品牌区：深绿渐变背景 + 文案 + 独立盾牌插画 + 微曲线分隔 */}
      <div className="auth-brand">
        <img className="auth-brand-illu" src={loginShield} alt="" aria-hidden />
        <svg className="auth-brand-curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          <path d="M100,0 L100,100 L60,100 C42,66 42,34 62,0 Z" fill="var(--bg-base, #fff)" />
        </svg>
        <div className="auth-brand-inner">
          <div className="auth-brand-top">
            <div className="auth-brand-logo">
              <img src={logoMark} alt="iML" />
              <div>
                <div className="auth-brand-name">iML Work</div>
                <div className="auth-brand-sub">企业岗位工作分身</div>
              </div>
            </div>
            <h2 className="auth-brand-headline">让每位员工<br />都有<em>一个懂业务</em>的工作分身</h2>
            <div className="auth-feature-list">
              {FEATURES.map((f, i) => (
                <div key={i} className="auth-feature">
                  <span className="auth-feature-ic">{f.icon}</span>
                  <div>
                    <div className="auth-feature-title">{f.title}</div>
                    <div className="auth-feature-desc">{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="auth-brand-foot"><ShieldCheck size={14} />本地安全 · 高效执行 · 数据不出企业</div>
        </div>
      </div>

      {/* 右侧登录表单 */}
      <div className="auth-form-side">
        {mode === 'login' ? (
        <form onSubmit={submit} className="auth-form">
          <div className="auth-form-head">
            <h1>欢迎回来</h1>
            <p>登录进入你的工作分身</p>
          </div>

          <label className="auth-field">
            <span className="auth-label">用户名</span>
            <div className="auth-input-wrap">
              <User size={15} className="auth-input-ic" />
              <input value={username} autoFocus onChange={e => setUsername(e.target.value)} placeholder="请输入用户名" />
              {username.trim() && <Check size={16} className="auth-input-ok" />}
            </div>
          </label>

          <label className="auth-field">
            <span className="auth-label">密码</span>
            <div className="auth-input-wrap">
              <Lock size={15} className="auth-input-ic" />
              <input type={showPwd ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="请输入密码" />
              <button type="button" className="auth-input-toggle" onClick={() => setShowPwd(v => !v)} title={showPwd ? '隐藏密码' : '显示密码'} tabIndex={-1}>
                {showPwd ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
            </div>
          </label>

          <div className="auth-row">
            <label className="auth-remember">
              <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
              <span className="auth-check" />
              <span>7 天内自动登录</span>
            </label>
            <a className="auth-link" onClick={() => { setMode('forgot'); setErr(''); setNotice('') }}>忘记密码？</a>
          </div>

          {err && <div className="auth-error">{err}</div>}
          {notice && <div className="auth-notice">{notice}</div>}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? '登录中…' : <>登录 <ArrowRight size={16} /></>}
          </button>

          <div className="auth-foot-note">
            <ShieldCheck size={14} className="auth-foot-ic" />
            <div>
              <div className="auth-foot-strong">企业内部系统安全登录</div>
              <div className="auth-foot-sub">不依赖任何外部平台账号体系</div>
            </div>
          </div>
          <div className="auth-hint">演示账号：<code>kang / kang123</code></div>
        </form>
        ) : (
        <form onSubmit={submitForgot} className="auth-form">
          <div className="auth-form-head">
            <h1>找回密码</h1>
            <p>提交后由管理员核验身份并重置，请留意联系</p>
          </div>
          <label className="auth-field">
            <span className="auth-label">用户名</span>
            <div className="auth-input-wrap">
              <User size={15} className="auth-input-ic" />
              <input value={username} autoFocus onChange={e => setUsername(e.target.value)} placeholder="请输入用户名" />
            </div>
          </label>
          <label className="auth-field">
            <span className="auth-label">预留手机号（供核验，可选）</span>
            <div className="auth-input-wrap">
              <Lock size={15} className="auth-input-ic" />
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="手机号" />
            </div>
          </label>
          {err && <div className="auth-error">{err}</div>}
          <button type="submit" className="auth-submit" disabled={busy}>{busy ? '提交中…' : '提交找回申请'}</button>
          <a className="auth-link" style={{ textAlign: 'center' }} onClick={() => { setMode('login'); setErr('') }}>← 返回登录</a>
        </form>
        )}
      </div>
    </div>
  )
}
