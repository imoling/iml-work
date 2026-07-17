// FDE 工作台登录：与管理端/客户端同一套暗色登录视觉（英雄插画 + 暗色玻璃表单）。
// 含「服务器连接设置」：后端地址可配（localStorage fde.adminBaseUrl），测试走 fde:api 主进程代理规避 CORS。
import React, { useState } from 'react'
import { useAuth } from '../services/auth'
import { getBaseUrl, setBaseUrl } from '../services/api'
import heroArt from '../assets/brand/login-hero-illustration.png'
import logoMarkDark from '../assets/brand/logo-mark-dark.png'

const INK = '#e6eef0', MUTED = 'rgba(148,163,184,0.9)', FAINT = 'rgba(148,163,184,0.6)', ACCENT = '#37C98B'

const S: any = {
  root: { position: 'fixed', inset: 0, display: 'flex', overflow: 'hidden', color: INK, background: 'linear-gradient(180deg,#0a1214 0%,#0c171b 55%,#0a1416 100%)' },
  aura1: { position: 'absolute', width: 560, height: 560, borderRadius: '50%', background: 'rgba(55,201,139,0.14)', filter: 'blur(90px)', top: -140, left: -100, pointerEvents: 'none' },
  aura2: { position: 'absolute', width: 520, height: 520, borderRadius: '50%', background: 'rgba(45,212,191,0.10)', filter: 'blur(90px)', bottom: -160, right: -120, pointerEvents: 'none' },
  brand: { flex: 1.1, position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '48px 60px', minWidth: 0, overflow: 'hidden' },
  bInner: { position: 'relative', zIndex: 1, maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 20 },
  logoRow: { display: 'flex', alignItems: 'center', gap: 13 },
  headline: { fontSize: 28, lineHeight: 1.35, fontWeight: 800, margin: 0, letterSpacing: 0.5 },
  hero: { width: '78%', maxWidth: 400, alignSelf: 'center', marginTop: 2, borderRadius: 16, opacity: 0.94 },
  feat: { display: 'flex', alignItems: 'flex-start', gap: 12 },
  featIc: { flexShrink: 0, width: 32, height: 32, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(55,201,139,0.12)', border: '1px solid rgba(55,201,139,0.25)' },
  formSide: { flex: 0.9, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, position: 'relative', zIndex: 1 },
  card: { width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 16, background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 18, padding: '30px 28px', backdropFilter: 'blur(14px)', boxShadow: '0 24px 60px rgba(0,0,0,0.35)' },
  label: { fontSize: 12.5, fontWeight: 600, color: MUTED },
  input: { height: 46, boxSizing: 'border-box', width: '100%', padding: '0 14px', fontSize: 14, color: INK, background: 'rgba(255,255,255,0.06)', border: '1.5px solid rgba(255,255,255,0.12)', borderRadius: 11, outline: 'none' },
  btn: { marginTop: 4, height: 48, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: 700, color: '#06251a', borderRadius: 12, background: 'linear-gradient(135deg,#37C98B,#2BB67C)', boxShadow: '0 10px 26px rgba(55,201,139,0.25)' },
  err: { fontSize: 12.5, color: '#fda4af', background: 'rgba(220,38,38,0.12)', border: '1px solid rgba(220,38,38,0.3)', padding: '8px 12px', borderRadius: 9 },
  ok: { fontSize: 12.5, color: '#86efac', background: 'rgba(55,201,139,0.1)', border: '1px solid rgba(55,201,139,0.25)', padding: '8px 12px', borderRadius: 9 },
  link: { fontSize: 12.5, color: ACCENT, cursor: 'pointer' },
  srvToggle: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: FAINT, cursor: 'pointer', userSelect: 'none' },
  srvBox: { display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid rgba(255,255,255,0.09)', borderRadius: 11, padding: 12, background: 'rgba(255,255,255,0.03)' },
  srvBtn: { height: 34, padding: '0 14px', fontSize: 12.5, fontWeight: 600, color: INK, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 9, cursor: 'pointer' }
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
  // 服务器连接设置（与客户端登录页同能力：改后端地址不用进设置页）
  const [srvOpen, setSrvOpen] = useState(false)
  const [srvUrl, setSrvUrl] = useState(getBaseUrl())
  const [srvMsg, setSrvMsg] = useState('')
  const [srvBusy, setSrvBusy] = useState(false)

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

  const testServer = async () => {
    const url = (srvUrl || '').trim().replace(/\/$/, '')
    if (!/^https?:\/\//.test(url)) { setSrvMsg('✗ 地址需以 http(s):// 开头'); return }
    setSrvBusy(true); setSrvMsg('')
    try {
      // 走主进程代理规避 CORS；浏览器预览（无 window.api）时退回 fetch
      let ok = false
      if ((window as any).api?.invoke) {
        const r = await (window as any).api.invoke('fde:api', { baseUrl: url, method: 'GET', path: '/actuator/health' })
        ok = !!(r && r.ok)
      } else {
        const r = await fetch(url + '/actuator/health'); ok = r.ok
      }
      setSrvMsg(ok ? '✓ 服务可达' : '✗ 服务不可达（检查地址与端口，常见为 http://服务器:8081）')
    } catch (e: any) { setSrvMsg(`✗ 连接失败：${e?.message || e}`) }
    setSrvBusy(false)
  }

  const saveServer = () => {
    const url = (srvUrl || '').trim().replace(/\/$/, '')
    if (url && !/^https?:\/\//.test(url)) { setSrvMsg('✗ 地址需以 http(s):// 开头'); return }
    setBaseUrl(url)
    setSrvMsg(url ? '✓ 已保存，本次登录即用新地址' : '已清空，恢复默认地址')
  }

  return (
    <div style={S.root}>
      <div style={S.aura1} /><div style={S.aura2} />
      <div style={S.brand}>
        <div style={S.bInner}>
          <div style={S.logoRow}>
            <img src={logoMarkDark} alt="iML" style={{ width: 44, height: 44 }} />
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: 0.5 }}>FDE 工作台</div>
              <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>企业岗位分身训练场</div>
            </div>
          </div>
          <h2 style={S.headline}>录制即生成技能<br />把业务操作训练成工作分身能力</h2>
          <img src={heroArt} alt="" aria-hidden style={S.hero} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {FEATURES.map((f, i) => (
              <div key={i} style={S.feat}>
                <span style={S.featIc}>{f[0]}</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{f[1]}</div>
                  <div style={{ fontSize: 12.5, color: MUTED, marginTop: 2, lineHeight: 1.5 }}>{f[2]}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: FAINT }}>本地安全 · 高效执行 · 数据不出企业</div>
        </div>
      </div>

      <div style={S.formSide}>
        {mode === 'login' ? (
        <form style={S.card} onSubmit={submit}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>欢迎回来</h1>
            <p style={{ fontSize: 13, color: MUTED, margin: '6px 0 0' }}>登录以进入 FDE 工作台</p>
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
          {notice && <div style={S.ok}>{notice}</div>}
          <button type="submit" style={{ ...S.btn, opacity: busy ? 0.65 : 1 }} disabled={busy}>{busy ? '登录中…' : '登录'}</button>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={S.srvToggle} onClick={() => setSrvOpen(v => !v)}>⚙ 服务器连接设置 {srvOpen ? '▴' : '▾'}</span>
            <a style={S.link} onClick={() => { setMode('forgot'); setErr(''); setNotice('') }}>忘记密码？</a>
          </div>
          {srvOpen && (
            <div style={S.srvBox}>
              <span style={{ ...S.label, fontSize: 12 }}>管理平台后端地址（留空用默认）</span>
              <input style={{ ...S.input, height: 38, fontSize: 13 }} value={srvUrl} onChange={e => setSrvUrl(e.target.value)} placeholder="http://服务器地址:8081" />
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" style={S.srvBtn} onClick={testServer} disabled={srvBusy}>{srvBusy ? '测试中…' : '测试'}</button>
                <button type="button" style={S.srvBtn} onClick={saveServer}>保存</button>
              </div>
              {srvMsg && <span style={{ fontSize: 12, color: srvMsg.startsWith('✓') ? '#86efac' : '#fda4af' }}>{srvMsg}</span>}
            </div>
          )}
        </form>
        ) : (
        <form style={S.card} onSubmit={submitForgot}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>找回密码</h1>
            <p style={{ fontSize: 13, color: MUTED, margin: '6px 0 0' }}>提交后由管理员核验身份并重置</p>
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
          <button type="submit" style={{ ...S.btn, opacity: busy ? 0.65 : 1 }} disabled={busy}>{busy ? '提交中…' : '提交找回申请'}</button>
          <a style={{ ...S.link, textAlign: 'center' }} onClick={() => { setMode('login'); setErr('') }}>← 返回登录</a>
        </form>
        )}
      </div>
    </div>
  )
}
