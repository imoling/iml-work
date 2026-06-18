import React, { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { NAV } from '../lib/constants.js'
import { getBaseUrl, setBaseUrl, Browser } from '../services/api.js'

export default function Layout() {
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState(getBaseUrl())
  const browserOk = Browser.available()
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <div>
            <b>iML · FDE 工作台</b>
            <div className="sub">场景 → SKILL 生产线</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map(n => (
            <NavLink key={n.path} to={n.path} end={n.end} className={({ isActive }) => isActive ? 'active' : ''}>
              <span className="ic">{n.ic}</span>{n.label}
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
