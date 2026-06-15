import { useState, useEffect } from 'react'
import {
  Boxes, Plus, RefreshCw, Trash2, Activity, Power, PowerOff,
  CheckCircle2, XCircle, CircleHelp, Gauge, Scale, Pencil
} from 'lucide-react'

interface Provider {
  id: string
  name: string
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  routeKey: string
  weight: number
  enabled: boolean
  status: string
  message: string
  lastChecked: string
  totalRequests: number
  failedRequests: number
  avgLatencyMs: number
}

interface Summary {
  total: number
  enabled: number
  healthy: number
  down: number
  totalRequests: number
  failedRequests: number
  successRate: number
}

const VENDORS = ['DEEPSEEK', 'OPENAI', 'ANTHROPIC', 'AGNES', 'OLLAMA', 'CUSTOM']
const BLANK = { id: '', provider: 'DEEPSEEK', name: '', baseUrl: '', apiKey: '', model: '', routeKey: 'corp-default', weight: 1, enabled: true }

export default function ModelGatewayManager() {
  const [items, setItems] = useState<Provider[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<typeof BLANK>(BLANK)

  const fetchItems = async () => {
    setLoading(true)
    try {
      const [r1, r2] = await Promise.all([
        fetch('/api/v1/model/providers'),
        fetch('/api/v1/model/providers/summary')
      ])
      if (r1.ok) setItems(await r1.json())
      if (r2.ok) setSummary(await r2.json())
    } catch (err) { console.error(err) }
    setLoading(false)
  }

  useEffect(() => { fetchItems() }, [])

  const openCreate = () => { setEditingId(null); setForm(BLANK); setShowForm(true) }
  const openEdit = (p: Provider) => {
    setEditingId(p.id)
    setForm({ id: p.id, provider: p.provider, name: p.name, baseUrl: p.baseUrl, apiKey: '', model: p.model, routeKey: p.routeKey || '', weight: p.weight, enabled: p.enabled })
    setShowForm(true)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim()) { alert('请填写名称、上游地址与模型名'); return }
    const url = editingId ? `/api/v1/model/providers/${editingId}` : '/api/v1/model/providers'
    const res = await fetch(url, {
      method: editingId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    })
    if (res.ok) { setShowForm(false); setForm(BLANK); setEditingId(null); fetchItems() }
  }

  const health = async (id: string) => {
    const res = await fetch(`/api/v1/model/providers/${id}/health`, { method: 'POST' })
    if (res.ok) fetchItems()
  }
  const toggle = async (id: string) => {
    const res = await fetch(`/api/v1/model/providers/${id}/toggle`, { method: 'POST' })
    if (res.ok) fetchItems()
  }
  const remove = async (id: string) => {
    if (!confirm('确认从中转站移除该模型通道?')) return
    const res = await fetch(`/api/v1/model/providers/${id}`, { method: 'DELETE' })
    if (res.ok) fetchItems()
  }

  const statusBadge = (s: string) => {
    if (s === 'HEALTHY') return <span className="badge badge-green" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={11} />健康</span>
    if (s === 'DOWN') return <span className="badge badge-red" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><XCircle size={11} />故障</span>
    return <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)' }}><CircleHelp size={11} />未探测</span>
  }

  // Total weight within each route-key pool, to render the live LB share.
  const poolWeight = (routeKey: string) => items
    .filter(p => p.enabled && (p.routeKey || '') === (routeKey || '') && p.status !== 'DOWN')
    .reduce((sum, p) => sum + Math.max(1, p.weight), 0)

  const stat = (label: string, value: React.ReactNode, icon: React.ReactNode) => (
    <div className="glass-panel" style={{ flex: 1, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ color: 'var(--accent-primary, #37C98B)' }}>{icon}</div>
      <div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: 640 }}>
          企业模型中转站：集中登记多个上游大模型，统一网关按权重做负载均衡与故障转移调度。客户端只需指向网关并请求逻辑路由名（routeKey），由中转站决定实际通道。
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" onClick={fetchItems}><RefreshCw size={14} /><span>刷新</span></button>
          <button className="btn-primary" onClick={openCreate}><Plus size={14} /><span>登记模型通道</span></button>
        </div>
      </div>

      {summary && (
        <div style={{ display: 'flex', gap: 12 }}>
          {stat('已登记通道', summary.total, <Boxes size={20} />)}
          {stat('启用中', summary.enabled, <Power size={20} />)}
          {stat('健康', summary.healthy, <CheckCircle2 size={20} />)}
          {stat('累计请求', summary.totalRequests, <Activity size={20} />)}
          {stat('成功率', `${(summary.successRate * 100).toFixed(1)}%`, <Gauge size={20} />)}
        </div>
      )}

      {showForm && (
        <form onSubmit={submit} className="glass-panel" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px', animation: 'slideIn 0.2s ease' }}>
          <div className="form-group">
            <label className="form-label">通道名称</label>
            <input className="form-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="DeepSeek 主用通道" />
          </div>
          <div className="form-group">
            <label className="form-label">厂商</label>
            <select className="form-select" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}>
              {VENDORS.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">路由名 (routeKey)</label>
            <input className="form-input" value={form.routeKey} onChange={e => setForm({ ...form, routeKey: e.target.value })} placeholder="corp-default" />
          </div>
          <div className="form-group" style={{ gridColumn: 'span 2' }}>
            <label className="form-label">上游地址 (Base URL)</label>
            <input className="form-input" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1/chat/completions" />
          </div>
          <div className="form-group">
            <label className="form-label">上游模型名</label>
            <input className="form-input" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} placeholder="deepseek-chat" />
          </div>
          <div className="form-group">
            <label className="form-label">API Key {editingId && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>（留空不变）</span>}</label>
            <input className="form-input" type="password" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." />
          </div>
          <div className="form-group">
            <label className="form-label">负载权重</label>
            <input className="form-input" type="number" min={1} value={form.weight} onChange={e => setForm({ ...form, weight: parseInt(e.target.value) || 1 })} />
          </div>
          <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
            <button type="submit" className="btn-primary" style={{ height: 38 }}>{editingId ? '保存修改' : '登记通道'}</button>
            <button type="button" className="btn-secondary" style={{ height: 38 }} onClick={() => { setShowForm(false); setEditingId(null) }}>取消</button>
          </div>
        </form>
      )}

      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-secondary)' }}>正在拉取中转站通道配置...</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>通道</th>
                <th style={{ width: 90 }}>厂商</th>
                <th>路由 / 模型</th>
                <th style={{ width: 150 }}>负载份额</th>
                <th style={{ width: 110 }}>健康</th>
                <th style={{ width: 130 }}>请求 / 失败 / 延迟</th>
                <th style={{ width: 230 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map(p => {
                const total = poolWeight(p.routeKey)
                const share = p.enabled && p.status !== 'DOWN' && total > 0 ? Math.round(Math.max(1, p.weight) / total * 100) : 0
                return (
                  <tr key={p.id} style={{ opacity: p.enabled ? 1 : 0.5 }}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{p.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.id}</div>
                    </td>
                    <td><span className="badge badge-blue">{p.provider}</span></td>
                    <td style={{ fontSize: 12 }}>
                      <div><span style={{ color: 'var(--text-muted)' }}>route:</span> {p.routeKey || '*'}</div>
                      <div style={{ color: 'var(--text-secondary)' }}>{p.model}</div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <Scale size={12} style={{ color: 'var(--text-muted)' }} />
                        <span>权重 {p.weight}</span>
                      </div>
                      <div style={{ height: 5, background: 'var(--bg-subtle, #eee)', borderRadius: 3, marginTop: 4, overflow: 'hidden' }}>
                        <div style={{ width: `${share}%`, height: '100%', background: 'var(--accent-primary, #37C98B)' }} />
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{share}% 流量</div>
                    </td>
                    <td>
                      {statusBadge(p.status)}
                      {p.message && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, maxWidth: 140 }}>{p.message}</div>}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      <div>{p.totalRequests} / <span style={{ color: p.failedRequests > 0 ? 'var(--accent-red, #ef4444)' : 'inherit' }}>{p.failedRequests}</span></div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.avgLatencyMs}ms</div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => health(p.id)}><Activity size={12} />探活</button>
                        <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => toggle(p.id)}>
                          {p.enabled ? <PowerOff size={12} /> : <Power size={12} />}
                        </button>
                        <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => openEdit(p)}><Pencil size={12} /></button>
                        <button className="btn-danger" style={{ padding: '4px 8px' }} onClick={() => remove(p.id)}><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {items.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>暂无模型通道，点击「登记模型通道」开始配置</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
