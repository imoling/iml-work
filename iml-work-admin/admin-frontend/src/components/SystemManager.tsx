import { useState, useEffect } from 'react'
import { Plug, Plus, RefreshCw, Trash2, Link2, Unlink, CheckCircle2, XCircle, Circle } from 'lucide-react'

interface Integration {
  id: string
  type: string
  name: string
  baseUrl: string
  username: string
  secret: string
  status: string
  message: string
  lastChecked: string
}

const TYPES = ['OA', 'CRM', 'EMAIL', 'GITHUB', 'ERP', 'OTHER']

export default function SystemManager() {
  const [items, setItems] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ type: 'OA', name: '', baseUrl: '', username: '', secret: '' })

  const fetchItems = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/v1/integrations')
      if (res.ok) setItems(await res.json())
    } catch (err) { console.error(err) }
    setLoading(false)
  }

  useEffect(() => { fetchItems() }, [])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.baseUrl.trim()) { alert('请填写名称与连接 URL'); return }
    const res = await fetch('/api/v1/integrations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form)
    })
    if (res.ok) { setShowForm(false); setForm({ type: 'OA', name: '', baseUrl: '', username: '', secret: '' }); fetchItems() }
  }

  const verify = async (id: string) => {
    const res = await fetch(`/api/v1/integrations/${id}/verify`, { method: 'POST' })
    if (res.ok) fetchItems()
  }
  const disconnect = async (id: string) => {
    const res = await fetch(`/api/v1/integrations/${id}/disconnect`, { method: 'POST' })
    if (res.ok) fetchItems()
  }
  const remove = async (id: string) => {
    if (!confirm('确认删除该系统连接?')) return
    const res = await fetch(`/api/v1/integrations/${id}`, { method: 'DELETE' })
    if (res.ok) fetchItems()
  }

  const statusBadge = (status: string) => {
    if (status === 'CONNECTED') return <span className="badge badge-green" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={11} />已连接</span>
    if (status === 'ERROR') return <span className="badge badge-red" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><XCircle size={11} />凭证异常</span>
    return <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)' }}><Circle size={11} />未连接</span>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
          管理智能体免接口穿透驱动的外部业务系统（OA / CRM / 邮件 / GitHub），校验凭证并维护连接状态机。
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" onClick={fetchItems}><RefreshCw size={14} /><span>刷新</span></button>
          <button className="btn-primary" onClick={() => setShowForm(!showForm)}><Plus size={14} /><span>新增系统连接</span></button>
        </div>
      </div>

      {showForm && (
        <form onSubmit={create} className="glass-panel" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr) auto', gap: '12px', alignItems: 'flex-end', animation: 'slideIn 0.2s ease' }}>
          <div className="form-group">
            <label className="form-label">系统类型</label>
            <select className="form-select" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
              {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">名称</label>
            <input className="form-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="泛微 OA" />
          </div>
          <div className="form-group">
            <label className="form-label">连接 URL</label>
            <input className="form-input" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://oa.corp.local" />
          </div>
          <div className="form-group">
            <label className="form-label">账号</label>
            <input className="form-input" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">密码 / Token</label>
            <input className="form-input" type="password" value={form.secret} onChange={e => setForm({ ...form, secret: e.target.value })} />
          </div>
          <button type="submit" className="btn-primary" style={{ height: 38 }}>保存</button>
        </form>
      )}

      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-secondary)' }}>正在拉取系统集成配置...</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th style={{ width: 80 }}>类型</th>
                <th>系统名称</th>
                <th>连接端点</th>
                <th>账号</th>
                <th style={{ width: 110 }}>连接状态</th>
                <th>说明</th>
                <th style={{ width: 220 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id}>
                  <td><span className="badge badge-blue" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Plug size={11} />{it.type}</span></td>
                  <td><div style={{ fontWeight: 600 }}>{it.name}</div><div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{it.id}</div></td>
                  <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{it.baseUrl}</td>
                  <td style={{ fontSize: 12 }}>{it.username || '-'}</td>
                  <td>{statusBadge(it.status)}</td>
                  <td style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 200 }}>{it.message || '-'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => verify(it.id)}><Link2 size={12} />校验连接</button>
                      <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => disconnect(it.id)}><Unlink size={12} /></button>
                      <button className="btn-danger" style={{ padding: '4px 8px' }} onClick={() => remove(it.id)}><Trash2 size={12} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>暂无系统连接</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
