import { useState, useEffect } from 'react'
import { Plug, Plus, RefreshCw, Trash2, Link2, CheckCircle2, XCircle, Circle, Pencil, X } from 'lucide-react'

interface Integration {
  id: string
  type: string
  name: string
  baseUrl: string
  status: string
  message: string
  lastChecked: string
}

const TYPES = ['OA', 'CRM', 'EMAIL', 'GITHUB', 'ERP', 'OTHER']

export default function SystemManager() {
  const [items, setItems] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ type: 'OA', name: '', baseUrl: '' })

  const BLANK = { type: 'OA', name: '', baseUrl: '' }
  const openCreate = () => { setEditingId(null); setForm(BLANK); setShowForm(true) }
  const openEdit = (it: Integration) => {
    setEditingId(it.id)
    setForm({ type: it.type, name: it.name, baseUrl: it.baseUrl })
    setShowForm(true)
  }
  const closeForm = () => { setShowForm(false); setEditingId(null) }

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
    const res = await fetch(editingId ? `/api/v1/integrations/${editingId}` : '/api/v1/integrations', {
      method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form)
    })
    if (res.ok) { closeForm(); setForm(BLANK); fetchItems() }
  }

  const verify = async (id: string) => {
    const res = await fetch(`/api/v1/integrations/${id}/verify`, { method: 'POST' })
    if (res.ok) fetchItems()
  }
  const remove = async (id: string) => {
    if (!confirm('确认删除该系统连接?')) return
    const res = await fetch(`/api/v1/integrations/${id}`, { method: 'DELETE' })
    if (res.ok) fetchItems()
  }

  const statusBadge = (status: string) => {
    if (status === 'REACHABLE' || status === 'CONNECTED') return <span className="badge badge-green" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={11} />地址可达</span>
    if (status === 'UNREACHABLE') return <span className="badge badge-yellow" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><XCircle size={11} />地址不可达</span>
    if (status === 'ERROR') return <span className="badge badge-red" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><XCircle size={11} />地址缺失</span>
    return <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)' }}><Circle size={11} />已登记</span>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
          只登记免接口穿透业务系统的<strong>地址</strong>（OA / CRM / 邮件 / GitHub）。登录凭证不入平台——由员工在 FDE 工作台 / 客户端本地受管浏览器完成登录验证。
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" onClick={fetchItems}><RefreshCw size={14} /><span>刷新</span></button>
          <button className="btn-primary" onClick={openCreate}><Plus size={14} /><span>新增系统连接</span></button>
        </div>
      </div>

      {showForm && (
        <div className="skill-drawer-overlay" onClick={closeForm}>
          <div className="skill-drawer" onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>{editingId ? '编辑业务系统连接' : '新增业务系统连接'}</h3>
              <button type="button" className="icon-btn" onClick={closeForm}><X size={16} /></button>
            </div>
            <form onSubmit={create} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
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
              </div>
              <div className="form-group">
                <label className="form-label">连接 URL（业务系统首页/登录页地址）</label>
                <input className="form-input" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://oa.corp.local" />
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--mint-50, #E9F8F1)', border: '1px solid #D9F2E6', borderRadius: 8, padding: '10px 12px' }}>
                平台只登记地址，不收集账号密码。员工在 FDE 工作台 / 客户端「系统连接」中用本地受管浏览器登录并验证，凭证只留本地。
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button type="submit" className="btn-primary">{editingId ? '保存修改' : '保存'}</button>
                <button type="button" className="btn-secondary" onClick={closeForm}>取消</button>
              </div>
            </form>
          </div>
        </div>
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
                <th style={{ width: 110 }}>地址状态</th>
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
                  <td>{statusBadge(it.status)}</td>
                  <td style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 200 }}>{it.message || '-'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => verify(it.id)}><Link2 size={12} />探测可达</button>
                      <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => openEdit(it)}><Pencil size={12} /></button>
                      <button className="btn-danger" style={{ padding: '4px 8px' }} onClick={() => remove(it.id)}><Trash2 size={12} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>暂无业务系统</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
