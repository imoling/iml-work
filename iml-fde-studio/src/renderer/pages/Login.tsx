// FDE 工作台登录：与客户端 LoginScreen 同一套 .auth-* 暗色视觉（DOM 结构同构，样式见 login.css，
// 均移植自客户端，改动请两边同步）。「服务器连接设置」= 客户端 BackendConfig 的 FDE 版
//（地址存 localStorage fde.adminBaseUrl；测试经 fde:api 主进程代理探活，规避 CORS）。
import React, { useState } from 'react'
import { ArrowRight, User, Lock, ShieldCheck, Clapperboard, Rocket, Eye, EyeOff, Check, Server, ChevronDown, CheckCircle2, XCircle } from 'lucide-react'
import { useAuth } from '../services/auth'
import { getBaseUrl, setBaseUrl } from '../services/api'
import heroArt from '../assets/brand/login-hero-illustration.png'
import logoMarkDark from '../assets/brand/logo-mark-dark.png'
import './login.css'

const FEATURES = [
  { icon: <ShieldCheck size={16} />, title: '本地安全环境', desc: '登录态与业务凭证只在本机，绝不上传' },
  { icon: <Clapperboard size={16} />, title: '录制即生成技能', desc: '实操录制自动产出可复用语义化技能' },
  { icon: <Rocket size={16} />, title: '一体化调试上架', desc: '直达执行 → 一段话测链路 → 上架技能中心' },
]

/** 服务器连接设置（客户端 BackendConfig 同构；FDE 侧地址在 localStorage）。 */
function ServerConfig() {
  const [url, setUrl] = useState(() => { try { return window.localStorage.getItem('fde.adminBaseUrl') || '' } catch (_) { return '' } })
  const [busy, setBusy] = useState<'test' | ''>('')
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const effective = getBaseUrl()

  const test = async () => {
    const target = (url || effective).trim().replace(/\/$/, '')
    if (!/^https?:\/\//.test(target)) { setResult({ ok: false, msg: '地址需以 http(s):// 开头' }); return }
    setBusy('test'); setResult(null)
    try {
      let ok = false
      if (window.api?.invoke) {
        const r = await window.api.invoke('fde:api', { baseUrl: target, method: 'GET', path: '/actuator/health' })
        ok = !!(r && r.ok)
      } else {
        const r = await fetch(target + '/actuator/health'); ok = r.ok
      }
      setResult(ok ? { ok: true, msg: `可连接 · ${target}` } : { ok: false, msg: `无法连接：${target}（常见为 http://服务器:8081）` })
    } catch (e: any) { setResult({ ok: false, msg: `无法连接：${e?.message || e}` }) }
    setBusy('')
  }
  const save = () => {
    const v = (url || '').trim().replace(/\/$/, '')
    if (v && !/^https?:\/\//.test(v)) { setResult({ ok: false, msg: '地址需以 http(s):// 开头' }); return }
    setBaseUrl(v)
    setResult({ ok: true, msg: `已保存 · 当前生效：${v || getBaseUrl()}` })
  }

  return (
    <div className="backend-cfg">
      <div className="backend-cfg-row">
        <input value={url} onChange={e => setUrl(e.target.value)} spellCheck={false} placeholder={effective} />
        <button type="button" className="backend-cfg-btn" onClick={test} disabled={!!busy}>{busy === 'test' ? '测试中…' : '测试'}</button>
        <button type="button" className="backend-cfg-btn primary" onClick={save} disabled={!!busy}>保存</button>
      </div>
      {result
        ? <div className={`backend-cfg-msg ${result.ok ? 'ok' : 'err'}`}>{result.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}<span>{result.msg}</span></div>
        : <div className="backend-cfg-hint">留空则用默认 {effective}；保存后本次登录即生效。</div>}
    </div>
  )
}

export default function Login() {
  const { login, forgot } = useAuth()
  const [username, setUsername] = useState(() => { try { return window.localStorage.getItem('fde.lastUsername') || '' } catch (_) { return '' } })
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [phone, setPhone] = useState('')
  const [notice, setNotice] = useState('')
  const [showBackend, setShowBackend] = useState(false)

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
    const r = await forgot(username.trim(), phone.trim())
    setBusy(false)
    if (r.ok) { setNotice(r.message || '已提交找回申请'); setMode('login') }
    else setErr(r.error || '提交失败')
  }

  return (
    <div className="auth-root">
      {/* 左侧品牌区：深色渐变 + 极光 + 英雄插画（与客户端登录同构） */}
      <div className="auth-brand">
        <span className="auth-aurora a" /><span className="auth-aurora b" />
        <img className="auth-brand-illu" src={heroArt} alt="" aria-hidden />
        <div className="auth-brand-inner">
          <div className="auth-brand-top">
            <div className="auth-brand-logo">
              <img src={logoMarkDark} alt="iML" />
              <div>
                <div className="auth-brand-name">FDE 工作台</div>
                <div className="auth-brand-sub">企业岗位分身训练场</div>
              </div>
            </div>
            <h2 className="auth-brand-headline">录制即生成技能<br />把业务操作<em>训练成分身能力</em></h2>
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
            <p>登录以进入 FDE 工作台</p>
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
            <span />
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

          <div className="auth-backend">
            <button type="button" className="auth-backend-toggle" onClick={() => setShowBackend(v => !v)}>
              <Server size={13} /> 服务器连接设置 <ChevronDown size={13} className={showBackend ? 'rot' : ''} />
            </button>
            {showBackend && <ServerConfig />}
          </div>
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
