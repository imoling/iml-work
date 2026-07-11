import React, { useEffect, useState, useCallback } from 'react'

export function PageHeader({ title, desc, actions, crumb }: any) {
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

export function Modal({ title, onClose, children, width }: any) {
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="modal" style={width ? { width } : undefined} onMouseDown={e => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

export function Field({ label, children }: any) {
  return <div className="field"><label className="fl">{label}</label>{children}</div>
}

export function Tag({ kind, children }: any) {
  return <span className={'tag ' + (kind || '')}>{children}</span>
}

export function Empty({ children }: any) { return <div className="empty">{children}</div> }

// 分页条：共 N 条 · 每页选择 · 上一页/页码/下一页（纯客户端分页）
export function Pager({ total, page, pageSize, onPage, onPageSize, unit = "条", sizes = [10, 20, 50], style }: any) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const cur = Math.min(page, pages)
  const nums = []
  for (let i = 1; i <= pages; i++) { if (i === 1 || i === pages || Math.abs(i - cur) <= 1) nums.push(i); else if (nums[nums.length - 1] !== '…') nums.push('…') }
  return (
    <div className="conn-foot" style={style}>
      <span>共 {total} {unit}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {onPageSize && (
          <select className="pager-size" value={pageSize} onChange={e => onPageSize(Number(e.target.value))} style={{ height: 30, flexShrink: 0 }}>
            {sizes.map(s => <option key={s} value={s}>{s} 条/页</option>)}
          </select>
        )}
        <button style={{ height: 30 }} disabled={cur <= 1} onClick={() => onPage(cur - 1)}>‹</button>
        {nums.map((n, i) => n === '…'
          ? <span key={'e' + i} className="sec" style={{ padding: '0 2px' }}>…</span>
          : <button key={n} className={n === cur ? 'primary' : ''} style={{ height: 30, minWidth: 32 }} onClick={() => onPage(n)}>{n}</button>)}
        <button style={{ height: 30 }} disabled={cur >= pages} onClick={() => onPage(cur + 1)}>›</button>
      </div>
    </div>
  )
}

// 异步加载封装：返回 { data, loading, error, reload }
export function useAsync(fn: any, deps: any[] = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null })
  const reload = useCallback(() => {
    setState(s => ({ ...s, loading: true, error: null }))
    Promise.resolve().then(fn).then(
      data => setState({ data, loading: false, error: null }),
      err => setState({ data: null, loading: false, error: err.message || String(err) })
    )
  }, deps) // eslint-disable-line
  useEffect(() => { reload() }, [reload])
  return { ...state, reload, setData: (data: any) => setState(s => ({ ...s, data })) }
}

export function Loading() { return <div className="empty">加载中…</div> }
export function ErrorBox({ error, onRetry }: any) {
  return (
    <div className="card" style={{ borderColor: '#fecaca', background: '#fef2f2' }}>
      <div className="err">⚠ {error}</div>
      <div className="sec" style={{ marginTop: 6, fontSize: 12 }}>请确认管理端服务已启动（左下角可改地址）。</div>
      {onRetry && <button style={{ marginTop: 10 }} onClick={onRetry}>重试</button>}
    </div>
  )
}
