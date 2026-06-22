import React, { useState, useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { NAV } from '../lib/constants.js'
import { getBaseUrl, setBaseUrl, Browser } from '../services/api.js'
import { subscribe as hbSubscribe, setEnabled as hbSetEnabled, startLoop as hbStartLoop, getState as hbGetState } from '../lib/heartbeat.js'
import Icon from './Icon.jsx'

export default function Layout() {
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState(getBaseUrl())
  const browserOk = Browser.available()
  const [hb, setHb] = useState(hbGetState())
  useEffect(() => { const un = hbSubscribe(setHb); hbStartLoop(); return un }, [])
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <div className="brand-mark" aria-label="iML Work">
            <svg width="37" height="40" viewBox="208 179 660 720" fill="none">
              <defs>
                <linearGradient id="m_mint" x1="208" y1="184" x2="816" y2="840" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#62E0B1" /><stop offset="0.58" stopColor="#37C98B" /><stop offset="1" stopColor="#20A978" />
                </linearGradient>
                <linearGradient id="m_mintSoft" x1="360" y1="612" x2="650" y2="818" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#E9F8F1" /><stop offset="1" stopColor="#B8F0D9" />
                </linearGradient>
                <linearGradient id="m_graphite" x1="294" y1="378" x2="602" y2="658" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#202A34" /><stop offset="1" stopColor="#0F1720" />
                </linearGradient>
              </defs>
              <path d="M226 357C216 336 225 311 246 300L449 191C488 170 535 170 574 191L782 303C803 314 812 339 803 360L785 405L546 279C525 268 500 268 479 279L241 405L226 357Z" fill="url(#m_mint)" />
              <path d="M785 405L826 384V438L785 460V405Z" fill="#3B82F6" />
              <path d="M220 650L479 786C500 797 525 797 546 786L804 650V718C804 746 789 772 764 785L574 887C535 908 488 908 449 887L260 786C235 773 220 747 220 719V650Z" fill="url(#m_mint)" />
              <path d="M432 611C465 583 505 569 550 569C596 569 639 585 678 614L719 646C665 624 612 625 562 645C514 664 480 694 464 736L416 711C420 672 425 638 432 611Z" fill="url(#m_mintSoft)" />
              <path d="M414 624C469 592 523 583 578 596C627 607 674 633 717 675" stroke="#DFF5EC" strokeWidth="26" strokeLinecap="round" />
              <path d="M426 682C473 646 520 631 568 637C615 642 658 667 696 711" stroke="#FFFFFF" strokeWidth="20" strokeLinecap="round" />
              <circle cx="306" cy="459" r="42" fill="#37C98B" />
              <path d="M278 523H332V702H278V523Z" fill="url(#m_graphite)" />
              <path d="M395 461H461L512 512L563 461H632V702H576V562L512 626L448 562V702H395V461Z" fill="url(#m_graphite)" />
              <path d="M675 461H733V642H856V702H675V461Z" fill="#37C98B" />
            </svg>
          </div>
          <div>
            <b>FDE <span className="brand-accent">工作台</span></b>
            <div className="sub">企业岗位分身训练场</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map(n => (
            <NavLink key={n.path} to={n.path} end={n.end} className={({ isActive }) => isActive ? 'active' : ''}>
              <span className="ic"><Icon name={n.ic} /></span>{n.label}
            </NavLink>
          ))}
        </nav>
        <div className="foot">
          {editing ? (
            <div>
              <input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://localhost:8080" />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button className="primary" style={{ flex: 1 }} onClick={() => { setBaseUrl(url); setEditing(false) }}>保存</button>
                <button onClick={() => { setUrl(getBaseUrl()); setEditing(false) }}>取消</button>
              </div>
            </div>
          ) : (
            <div>
              <div>管理端：<a style={{ color: 'var(--brand-d)', cursor: 'pointer' }} onClick={() => setEditing(true)}>{getBaseUrl().replace(/^https?:\/\//, '')}</a></div>
              <div style={{ marginTop: 4 }}>浏览器执行器：{browserOk ? <span className="ok">就绪</span> : <span className="muted">仅桌面端可用</span>}</div>
              {browserOk && (
                <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }} title={hb.enabled ? '登录保活已开启：定时静默访问已验证系统、刷新会话有效期。点此关闭' : '登录保活已关闭。点此开启'}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: !hb.enabled ? '#9ca3af' : hb.busy ? '#d97706' : '#16a34a', animation: hb.busy ? 'hb-pulse 1s ease-in-out infinite' : 'none' }} />
                  登录保活：<a style={{ color: 'var(--brand-d)', cursor: 'pointer' }} onClick={() => hbSetEnabled(!hb.enabled)}>{hb.enabled ? '开' : '关'}</a>
                  {hb.enabled && <span className="muted">{hb.busy ? '· 保活中' : hb.lastAt ? `· 在线 ${hb.online}/${hb.total} · ${hb.lastAt}` : '· 待心跳'}</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
