import React, { useEffect, useState, useCallback } from 'react'

export function PageHeader({ title, desc, actions, crumb }) {
  return (
    <div className="topbar">
      <div>
        {crumb}
        <h2>{title}</h2>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>{actions}</div>
    </div>
  )
}

export function Modal({ title, onClose, children, width }) {
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal" style={width ? { width } : null} onMouseDown={e => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

export function Field({ label, children }) {
  return <div className="field"><label className="fl">{label}</label>{children}</div>
}

export function Tag({ kind, children }) {
  return <span className={'tag ' + (kind || '')}>{children}</span>
}

export function Empty({ children }) { return <div className="empty">{children}</div> }

// 异步加载封装：返回 { data, loading, error, reload }
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null })
  const reload = useCallback(() => {
    setState(s => ({ ...s, loading: true, error: null }))
    Promise.resolve().then(fn).then(
      data => setState({ data, loading: false, error: null }),
      err => setState({ data: null, loading: false, error: err.message || String(err) })
    )
  }, deps) // eslint-disable-line
  useEffect(() => { reload() }, [reload])
  return { ...state, reload, setData: (data) => setState(s => ({ ...s, data })) }
}

export function Loading() { return <div className="empty">加载中…</div> }
export function ErrorBox({ error, onRetry }) {
  return (
    <div className="card" style={{ borderColor: '#fecaca', background: '#fef2f2' }}>
      <div className="err">⚠ {error}</div>
      <div className="sec" style={{ marginTop: 6, fontSize: 12 }}>请确认管理端服务已启动（左下角可改地址）。</div>
      {onRetry && <button style={{ marginTop: 10 }} onClick={onRetry}>重试</button>}
    </div>
  )
}
