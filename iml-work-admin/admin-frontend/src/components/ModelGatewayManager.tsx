import { useState, useEffect } from 'react'
import {
  Boxes, Plus, RefreshCw, Trash2, Activity, Power, PowerOff,
  CheckCircle2, XCircle, CircleHelp, Gauge, Scale, Pencil, Sparkles, Moon, Settings2, Check, X
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

// 厂商预设：与客户端模型配置一致。选择后自动带出上游地址(完整 chat/completions 端点)与默认模型。
interface VendorPreset { key: string; name: string; provider: string; baseUrl: string; model: string }
const VENDOR_PRESETS: VendorPreset[] = [
  { key: 'agnes', name: 'Agnes', provider: 'AGNES', baseUrl: 'https://apihub.agnes-ai.com/v1/chat/completions', model: 'agnes-2.0-flash' },
  { key: 'deepseek', name: 'DeepSeek', provider: 'DEEPSEEK', baseUrl: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
  { key: 'openai', name: 'OpenAI', provider: 'OPENAI', baseUrl: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o' },
  { key: 'anthropic', name: 'Anthropic', provider: 'ANTHROPIC', baseUrl: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-sonnet-latest' },
  { key: 'qwen', name: '通义千问', provider: 'QWEN', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
  { key: 'moonshot', name: 'Moonshot', provider: 'MOONSHOT', baseUrl: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
  { key: 'ollama', name: 'Ollama', provider: 'OLLAMA', baseUrl: 'http://localhost:11434/v1/chat/completions', model: 'qwen2.5' },
  { key: 'lmstudio', name: 'LM Studio', provider: 'LMSTUDIO', baseUrl: 'http://localhost:1234/v1/chat/completions', model: '' },
  { key: 'vllm', name: 'vLLM', provider: 'VLLM', baseUrl: 'http://localhost:8000/v1/chat/completions', model: '' },
  { key: 'custom', name: '自定义', provider: 'CUSTOM', baseUrl: '', model: '' },
]

// 厂商标识：品牌色圆角底 + 风格化字形（非官方 LOGO 精确复刻，仅作辨识）。
const VENDOR_BRAND: Record<string, { bg: string; node: React.ReactNode }> = {
  AGNES: { bg: 'linear-gradient(135deg,#62E0B1,#37C98B)', node: <Sparkles size={15} color="#fff" /> },
  DEEPSEEK: { bg: '#4D6BFE', node: <span style={{ fontSize: 14 }}>🐳</span> },
  OPENAI: {
    bg: '#0B0B0B', node: (
      <svg width="15" height="15" viewBox="0 0 24 24">
        {[0, 60, 120, 180, 240, 300].map(a => <ellipse key={a} cx="12" cy="6.5" rx="2.1" ry="4.2" fill="#fff" transform={`rotate(${a} 12 12)`} />)}
      </svg>
    )
  },
  ANTHROPIC: {
    bg: '#D97757', node: (
      <svg width="15" height="15" viewBox="0 0 24 24" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" />
        <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" /><line x1="18.4" y1="5.6" x2="5.6" y2="18.4" />
      </svg>
    )
  },
  QWEN: { bg: '#615CED', node: <span style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>通</span> },
  MOONSHOT: { bg: '#101426', node: <Moon size={14} color="#fff" /> },
  OLLAMA: { bg: '#111111', node: <span style={{ fontSize: 14 }}>🦙</span> },
  LMSTUDIO: { bg: '#4F46E5', node: <span style={{ fontSize: 10, fontWeight: 800, color: '#fff' }}>LM</span> },
  VLLM: { bg: '#FF6B35', node: <span style={{ fontSize: 10, fontWeight: 800, color: '#fff' }}>vL</span> },
  CUSTOM: { bg: 'var(--bg-subtle)', node: <Settings2 size={14} color="var(--text-secondary)" /> },
}
function vendorLogo(provider: string): React.ReactNode {
  const b = VENDOR_BRAND[provider] || VENDOR_BRAND.CUSTOM
  return <span className="vendor-logo" style={{ background: b.bg }}>{b.node}</span>
}

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
  // 选择厂商预设：带出上游地址、默认模型与厂商类型；通道名为空时补默认名。
  const applyPreset = (v: VendorPreset) => setForm(f => ({
    ...f, provider: v.provider, baseUrl: v.baseUrl, model: v.model || f.model,
    name: f.name.trim() ? f.name : `${v.name} 通道`
  }))
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
      <div style={{ color: 'var(--brand-primary)' }}>{icon}</div>
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
          企业模型中转站：集中登记多个上游大模型，统一网关按权重做负载均衡与故障转移调度。客户端只需指向网关并请求一个逻辑路由名，由中转站决定实际通道。
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
        <div className="skill-drawer-overlay" onClick={() => { setShowForm(false); setEditingId(null) }}>
        <div className="skill-drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <h3 style={{ fontSize: 16, fontWeight: 700 }}>{editingId ? '编辑模型通道' : '登记模型通道'}</h3>
          <button type="button" className="icon-btn" onClick={() => { setShowForm(false); setEditingId(null) }}><X size={16} /></button>
        </div>
        <form onSubmit={submit} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' }}>
          <div className="form-group" style={{ gridColumn: 'span 3' }}>
            <label className="form-label">厂商预设（选择后自动带出上游地址与默认模型）</label>
            <div className="vendor-grid">
              {VENDOR_PRESETS.map(v => (
                <button type="button" key={v.key} className={`vendor-card ${form.provider === v.provider ? 'selected' : ''}`} onClick={() => applyPreset(v)}>
                  {vendorLogo(v.provider)}
                  <span className="vendor-name">{v.name}</span>
                  {form.provider === v.provider && <Check size={13} className="vendor-check" />}
                </button>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">通道名称</label>
            <input className="form-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="DeepSeek 主用通道" />
          </div>
          <div className="form-group">
            <label className="form-label">逻辑路由名</label>
            <input className="form-input" value={form.routeKey} onChange={e => setForm({ ...form, routeKey: e.target.value })} placeholder="corp-default" />
          </div>
          <div className="form-group">
            <label className="form-label">负载权重</label>
            <input className="form-input" type="number" min={1} value={form.weight} onChange={e => setForm({ ...form, weight: parseInt(e.target.value) || 1 })} />
          </div>
          <div className="form-group" style={{ gridColumn: 'span 2' }}>
            <label className="form-label">上游地址</label>
            <input className="form-input" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1/chat/completions" />
          </div>
          <div className="form-group">
            <label className="form-label">上游模型名</label>
            <input className="form-input" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} placeholder="deepseek-chat" />
          </div>
          <div className="form-group" style={{ gridColumn: 'span 3' }}>
            <label className="form-label">
              API 密钥 {editingId && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>（留空不变）</span>}
            </label>
            <input className="form-input" type="password" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })}
              placeholder={['OLLAMA', 'LMSTUDIO', 'VLLM'].includes(form.provider) ? '本地部署无需 API Key，可留空' : 'sk-...'} />
            {['OLLAMA', 'LMSTUDIO', 'VLLM'].includes(form.provider) && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>本地模型（Ollama / LM Studio / vLLM）通常无需 API Key，留空即可。</span>
            )}
          </div>
          <div className="form-group" style={{ gridColumn: 'span 3', flexDirection: 'row', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" className="btn-secondary" style={{ height: 38 }} onClick={() => { setShowForm(false); setEditingId(null) }}>取消</button>
            <button type="submit" className="btn-primary" style={{ height: 38 }}>{editingId ? '保存修改' : '登记通道'}</button>
          </div>
        </form>
        </div>
        </div>
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
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {vendorLogo(p.provider)}
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{p.provider}</span>
                      </span>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      <div><span style={{ color: 'var(--text-muted)' }}>路由</span> {p.routeKey || '*'}</div>
                      <div style={{ color: 'var(--text-secondary)' }}>{p.model}</div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <Scale size={12} style={{ color: 'var(--text-muted)' }} />
                        <span>权重 {p.weight}</span>
                      </div>
                      <div style={{ height: 5, background: 'var(--bg-subtle)', borderRadius: 3, marginTop: 4, overflow: 'hidden' }}>
                        <div style={{ width: `${share}%`, height: '100%', background: 'var(--brand-primary)' }} />
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
