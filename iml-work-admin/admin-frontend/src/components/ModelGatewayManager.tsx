import { useState, useEffect } from 'react'
import {
  Plus, RefreshCw, Trash2, Activity, Power, PowerOff,
  CheckCircle2, XCircle, CircleHelp, Pencil, X, ChevronDown, ChevronUp
} from 'lucide-react'
import ModelTierBoard from './ModelTierBoard'
import Switch from './Switch'
import ProviderWizard from './ProviderWizard'
import { vendorLogo, fetchTiers, FALLBACK_TIERS, tierOf, type Tier, type TierDef } from './model-vendors'

interface Provider {
  id: string
  name: string
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  routeKey: string
  modelType?: string
  weight: number
  enabled: boolean
  status: string
  message: string
  lastChecked: string
  totalRequests: number
  failedRequests: number
  avgLatencyMs: number
  inputPricePer1M?: number | null
  outputPricePer1M?: number | null
  maxOutputTokens?: number | null
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

// 单价用字符串存表单（空串=未配置），提交时转 number|null，避免 0 与「未配置」混淆
const BLANK = {
  id: '', provider: 'DEEPSEEK', name: '', baseUrl: '', apiKey: '', model: '',
  routeKey: 'corp-default', modelType: 'chat', weight: 1, enabled: true,
  inputPricePer1M: '', outputPricePer1M: '', maxOutputTokens: '',
}

export default function ModelGatewayManager() {
  const [items, setItems] = useState<Provider[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [showWizard, setShowWizard] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<typeof BLANK>(BLANK)
  const [showAdv, setShowAdv] = useState(false)
  // 档位定义来自后端（唯一来源 ModelTiers）；拉取前先用兜底值把界面画出来
  const [tiers, setTiers] = useState<TierDef[]>(FALLBACK_TIERS)
  // 客户端策略：是否允许员工在客户端自配模型（直连厂商）。随心跳下发，最迟下个周期生效。
  const [allowCustomModel, setAllowCustomModel] = useState(true)

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

  useEffect(() => {
    fetchItems()
    fetchTiers().then(setTiers)
    fetch('/api/v1/clients/policy').then(r => r.ok ? r.json() : null)
      .then(d => { if (d && typeof d.allowCustomModel === 'boolean') setAllowCustomModel(d.allowCustomModel) })
      .catch(() => {})
  }, [])

  const toggleCustomModel = async (next: boolean) => {
    setAllowCustomModel(next)
    try {
      const res = await fetch('/api/v1/clients/policy', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowCustomModel: next })
      })
      if (!res.ok) { setAllowCustomModel(!next); alert('保存失败') }
    } catch { setAllowCustomModel(!next); alert('保存失败：网络或服务异常') }
  }

  // 编辑时也能换模型：传 providerId 让服务端用库里的 key 代取（key 不下发前端）
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const fetchModels = async () => {
    setFetchingModels(true)
    try {
      const res = await fetch('/api/v1/model/providers/models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form.apiKey.trim()
          ? { baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim() }
          : { providerId: editingId })
      })
      const d = await res.json()
      if (Array.isArray(d.models) && d.models.length) setModelOptions(d.models)
      else alert(d.error || '上游未返回模型列表（部分厂商不提供该接口，手填即可）')
    } catch { alert('拉取失败：网络或服务异常') }
    setFetchingModels(false)
  }

  const openEdit = (p: Provider) => {
    setEditingId(p.id)
    setShowAdv(false)
    setModelOptions([])
    setForm({
      id: p.id, provider: p.provider, name: p.name, baseUrl: p.baseUrl, apiKey: '', model: p.model,
      routeKey: p.routeKey || '', modelType: p.modelType || 'chat', weight: p.weight, enabled: p.enabled,
      inputPricePer1M: p.inputPricePer1M == null ? '' : String(p.inputPricePer1M),
      outputPricePer1M: p.outputPricePer1M == null ? '' : String(p.outputPricePer1M),
      maxOutputTokens: p.maxOutputTokens == null ? '' : String(p.maxOutputTokens),
    })
  }

  /** 选档位 = 同时定 routeKey 与 modelType（网关对两者的用法不同，但对管理员是一个概念）。 */
  const pickTier = (t: Tier) => {
    const def = tiers.find(x => x.key === t) || FALLBACK_TIERS[0]
    setForm(f => ({ ...f, routeKey: def.alias, modelType: def.modelType }))
  }

  const submitEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim()) { alert('请填写名称、上游地址与模型名'); return }
    const price = (s: string) => { const v = parseFloat(s); return s.trim() === '' || isNaN(v) || v < 0 ? null : v }
    const payload = {
      ...form,
      inputPricePer1M: price(form.inputPricePer1M),
      outputPricePer1M: price(form.outputPricePer1M),
      maxOutputTokens: form.maxOutputTokens === '' ? null : parseInt(String(form.maxOutputTokens)) || null,
    }
    const res = await fetch(`/api/v1/model/providers/${editingId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    })
    if (res.ok) { setEditingId(null); setForm(BLANK); fetchItems() }
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

  const tierBadge = (p: Provider) => {
    const t = tierOf(p.modelType, tiers)
    const def = tiers.find(x => x.key === t) || FALLBACK_TIERS[0]
    const custom = (p.routeKey || '') !== def.alias
    return (
      <div>
        <span className="badge" style={{ background: t === 'reasoning' ? 'var(--mint-50)' : 'var(--bg-subtle)', color: t === 'reasoning' ? 'var(--brand-primary)' : 'var(--text-secondary)' }}>
          {def.name}
        </span>
        {custom && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
            自定义路由 <code>{p.routeKey || '*'}</code>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="page-header">
        <div className="page-intro">
          企业模型中转站：集中登记多个上游大模型，客户端只按<strong>档位</strong>请求，由网关按权重做负载均衡与故障转移。
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={fetchItems}><RefreshCw size={14} /><span>刷新</span></button>
          <button className="btn-primary" onClick={() => setShowWizard(true)}><Plus size={14} /><span>登记模型通道</span></button>
        </div>
      </div>

      <ModelTierBoard items={items} tiers={tiers} />

      <div className="glass-panel" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>允许员工在客户端自配模型</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
            关闭后员工只能走企业模型中转站。自配厂商端点会让业务数据绕过中转站直连第三方，
            平台侧看不到也审计不到——这是安全边界，不是使用偏好。改动随客户端心跳下发。
          </div>
        </div>
        <div style={{ flexShrink: 0 }}>
          <Switch checked={allowCustomModel} onChange={toggleCustomModel}
            onText="允许自配" offText="仅限中转站" />
        </div>
      </div>

      {summary && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <span>已登记 <strong style={{ color: 'var(--text-primary)' }}>{summary.total}</strong></span>
          <span>启用中 <strong style={{ color: 'var(--text-primary)' }}>{summary.enabled}</strong></span>
          <span>健康 <strong style={{ color: 'var(--text-primary)' }}>{summary.healthy}</strong></span>
          <span>累计请求 <strong style={{ color: 'var(--text-primary)' }}>{summary.totalRequests}</strong></span>
          <span>成功率 <strong style={{ color: 'var(--text-primary)' }}>{(summary.successRate * 100).toFixed(1)}%</strong></span>
        </div>
      )}

      {showWizard && <ProviderWizard onClose={() => setShowWizard(false)} onDone={fetchItems} />}

      {editingId && (
        <div className="skill-drawer-overlay" onClick={() => setEditingId(null)}>
          <div className="skill-drawer" onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>编辑模型通道</h3>
              <button type="button" className="icon-btn" onClick={() => setEditingId(null)}><X size={16} /></button>
            </div>
            <form onSubmit={submitEdit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div className="form-group">
                  <label className="form-label">通道名称</label>
                  <input className="form-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>上游模型名</span>
                    <button type="button" className="btn-ghost" style={{ fontSize: 12, padding: '1px 8px' }}
                      onClick={fetchModels} disabled={fetchingModels}>
                      {fetchingModels ? '拉取中…' : '从上游拉取'}
                    </button>
                  </label>
                  <input className="form-input" list="edit-model-options" value={form.model}
                    onChange={e => setForm({ ...form, model: e.target.value })} />
                  <datalist id="edit-model-options">
                    {modelOptions.map(m => <option key={m} value={m} />)}
                  </datalist>
                </div>
              </div>

              {/* 分两组：对话档位是"这轮对话用哪个模型"，生成能力是"这条通道用来干别的事"。
                  五个并排既挤又混淆两种语义；分组后管理员一眼知道自己在配哪类通道。 */}
              {([
                { label: '对话档位', hint: '客户端按档位请求，网关决定实际落点', list: tiers.filter(t => t.kind !== 'capability') },
                { label: '生成能力', hint: '非对话通道：不参与对话路由，供图片/视频生成技能调用', list: tiers.filter(t => t.kind === 'capability') },
              ] as const).filter(g => g.list.length > 0).map(g => (
                <div className="form-group" key={g.label}>
                  <label className="form-label">
                    {g.label}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8, fontSize: 11.5 }}>{g.hint}</span>
                  </label>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {g.list.map(t => {
                      const on = tierOf(form.modelType, tiers) === t.key
                      return (
                        <button type="button" key={t.key} onClick={() => pickTier(t.key)}
                          className={`vendor-card ${on ? 'selected' : ''}`}
                          style={{ flex: 1, flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '10px 12px' }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{t.name}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.use}</span>
                          <code style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{t.alias}</code>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}

              <div className="form-group">
                <label className="form-label">上游地址</label>
                <input className="form-input" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">API 密钥 <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>（留空不变）</span></label>
                <input className="form-input" type="password" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." />
              </div>

              <div>
                <button type="button" className="btn-ghost" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  onClick={() => setShowAdv(v => !v)}>
                  高级（权重 · 单价 · 最大输出 · 自定义路由名）
                  {showAdv ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
                {showAdv && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 10 }}>
                    <div className="form-group">
                      <label className="form-label">负载权重</label>
                      <input className="form-input" type="number" min={1} value={form.weight}
                        onChange={e => setForm({ ...form, weight: parseInt(e.target.value) || 1 })} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">输入单价 <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11 }}>元/百万</span></label>
                      <input className="form-input" type="number" min={0} step="0.01" value={form.inputPricePer1M}
                        onChange={e => setForm({ ...form, inputPricePer1M: e.target.value })} placeholder="留空=不计费" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">输出单价 <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11 }}>元/百万</span></label>
                      <input className="form-input" type="number" min={0} step="0.01" value={form.outputPricePer1M}
                        onChange={e => setForm({ ...form, outputPricePer1M: e.target.value })} placeholder="留空=不计费" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">最大输出 tokens</label>
                      <input className="form-input" type="number" min={0} step="1024" value={form.maxOutputTokens}
                        onChange={e => setForm({ ...form, maxOutputTokens: e.target.value })} placeholder="留空=默认 32768" />
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        留空即按产品默认下发（对话/推理 32768，视觉 8192）。混合推理模型会把思考过程算进输出预算，
                        给小了会「只思考、无正文」；厂商不认这个上限时网关会自动摘掉重发。
                      </div>
                    </div>
                    <div className="form-group" style={{ gridColumn: 'span 2' }}>
                      <label className="form-label">自定义路由名</label>
                      <input className="form-input" value={form.routeKey}
                        onChange={e => setForm({ ...form, routeKey: e.target.value })} placeholder="corp-default" />
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        改成非标值后，只有显式请求该名字的调用才会路由到这条通道。
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" className="btn-secondary" style={{ height: 38 }} onClick={() => setEditingId(null)}>取消</button>
                <button type="submit" className="btn-primary" style={{ height: 38 }}>保存修改</button>
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
                <th style={{ width: 120 }}>档位</th>
                <th style={{ width: 90 }}>权重</th>
                <th style={{ width: 150 }}>健康 / 延迟</th>
                <th style={{ width: 120 }}>请求 / 失败</th>
                <th style={{ width: 210 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map(p => (
                <tr key={p.id} style={{ opacity: p.enabled ? 1 : 0.5 }}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {vendorLogo(p.provider)}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{p.name}</div>
                        <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{p.model}</code>
                      </div>
                    </div>
                  </td>
                  <td>{tierBadge(p)}</td>
                  <td style={{ fontSize: 12 }}>{p.weight}</td>
                  <td>
                    {statusBadge(p.status)}
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
                      {p.avgLatencyMs}ms{p.message ? ` · ${p.message}` : ''}
                    </div>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {p.totalRequests} / <span style={{ color: p.failedRequests > 0 ? 'var(--accent-red, #ef4444)' : 'inherit' }}>{p.failedRequests}</span>
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
              ))}
              {items.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
                  暂无模型通道，点击「登记模型通道」开始配置
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
