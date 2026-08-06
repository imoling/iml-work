import { useEffect, useState } from 'react'
import { X, Check, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import BatchModelPicker, { type UpstreamModel, type ProbeResult } from './BatchModelPicker'
import { VENDOR_PRESETS, LOCAL_PROVIDERS, vendorLogo, fetchTiers, FALLBACK_TIERS, type VendorPreset, type TierDef } from './model-vendors'

// 登记模型通道的两步向导。
//
// 原先是一张 3 列 10 字段的大表单，把「连上游」和「这个模型干什么用」两件不同的事
// 混在一屏里，且逻辑路由名 / 模型类型 / 负载权重这些内部概念和必填项平铺同级。
// 现在按管理员的真实顺序切成两步：
//   ① 连上哪个厂商（地址 + 密钥）→ 拉模型
//   ② 这些模型各归哪一档 → 一次登记多条
// 权重/单价/最大输出这类调优项收进「高级」，默认不占视线。

interface Props {
  onClose: () => void
  onDone: () => void
}

const num = (s: string) => { const v = parseFloat(s); return s.trim() === '' || isNaN(v) || v < 0 ? null : v }

export default function ProviderWizard({ onClose, onDone }: Props) {
  const [step, setStep] = useState<1 | 2>(1)
  // 档位定义来自后端（唯一来源 ModelTiers）；拉到之前先用兜底值，界面不空窗
  const [tiers, setTiers] = useState<TierDef[]>(FALLBACK_TIERS)
  useEffect(() => { fetchTiers().then(setTiers) }, [])
  // 默认 DeepSeek。按 key 找而非写死下标——预设表插条目（如 Agnes 拆中国/国际站）会让下标漂移
  const defaultPreset = VENDOR_PRESETS.find(v => v.key === 'deepseek') || VENDOR_PRESETS[0]
  const [preset, setPreset] = useState<VendorPreset>(defaultPreset)
  const [baseUrl, setBaseUrl] = useState(defaultPreset.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [fetching, setFetching] = useState(false)
  const [upstream, setUpstream] = useState<UpstreamModel[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // 高级：整批共用的调优项
  const [showAdv, setShowAdv] = useState(false)
  const [weight, setWeight] = useState('1')
  const [inPrice, setInPrice] = useState('')
  const [outPrice, setOutPrice] = useState('')
  const [maxOut, setMaxOut] = useState('')

  const isLocal = LOCAL_PROVIDERS.includes(preset.provider)

  const applyPreset = (v: VendorPreset) => {
    setPreset(v)
    setBaseUrl(v.baseUrl)
    setErr('')
  }

  const goFetch = async () => {
    if (!baseUrl.trim()) { setErr('请先填上游地址'); return }
    if (!isLocal && !apiKey.trim()) { setErr('请先填 API 密钥（本地部署的服务才可留空）'); return }
    setFetching(true); setErr('')
    try {
      const res = await fetch('/api/v1/model/providers/models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() })
      })
      const d = await res.json()
      if (Array.isArray(d.items) && d.items.length) { setUpstream(d.items); setStep(2) }
      else setErr(d.error || '上游没有返回模型列表（部分厂商不提供该接口）')
    } catch { setErr('拉取失败：网络或服务异常') }
    setFetching(false)
  }

  const probeTypes = async (models: string[]): Promise<Record<string, ProbeResult>> => {
    const res = await fetch('/api/v1/model/providers/probe-types', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), models })
    })
    if (!res.ok) return {}
    return (await res.json()).results || {}
  }

  const submit = async (picks: { model: string; modelType: string; routeKey: string }[]) => {
    setBusy(true); setErr('')
    try {
      const items = picks.map(p => ({
        name: `${preset.name} · ${p.model}`,
        provider: preset.provider,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: p.model,
        modelType: p.modelType,
        routeKey: p.routeKey,
        weight: parseInt(weight) || 1,
        enabled: true,
        inputPricePer1M: num(inPrice),
        outputPricePer1M: num(outPrice),
        maxOutputTokens: maxOut.trim() === '' ? null : parseInt(maxOut) || null,
      }))
      const res = await fetch('/api/v1/model/providers/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items })
      })
      if (res.ok) { onDone(); onClose() }
      else {
        const d = await res.json().catch(() => ({}))
        setErr(d.message || d.error || '登记失败')
      }
    } catch { setErr('登记失败：网络或服务异常') }
    setBusy(false)
  }

  const stepDot = (n: 1 | 2, label: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: step === n ? 1 : 0.45 }}>
      <span style={{
        width: 18, height: 18, borderRadius: '50%', fontSize: 11, fontWeight: 700,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: step === n ? 'var(--brand-primary)' : 'var(--bg-subtle)',
        color: step === n ? '#fff' : 'var(--text-muted)',
      }}>{n}</span>
      <span style={{ fontSize: 12.5, fontWeight: step === n ? 600 : 400 }}>{label}</span>
    </div>
  )

  return (
    <div className="skill-drawer-overlay" onClick={onClose}>
      <div className="skill-drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700 }}>登记模型通道</h3>
            {stepDot(1, '连接上游')}
            <span style={{ color: 'var(--text-muted)' }}>→</span>
            {stepDot(2, '分配档位')}
          </div>
          <button type="button" className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>

        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="form-group">
              <label className="form-label">选择厂商</label>
              <div className="vendor-grid">
                {VENDOR_PRESETS.map(v => (
                  <button type="button" key={v.key}
                    className={`vendor-card ${preset.key === v.key ? 'selected' : ''}`}
                    onClick={() => applyPreset(v)}>
                    {vendorLogo(v.provider)}
                    <span className="vendor-name">{v.name}</span>
                    {preset.key === v.key && <Check size={13} className="vendor-check" />}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">上游地址</label>
              <input className="form-input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1/chat/completions" />
            </div>
            <div className="form-group">
              <label className="form-label">API 密钥</label>
              <input className="form-input" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
                placeholder={isLocal ? '本地部署无需密钥，可留空' : 'sk-...'} />
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                密钥只存服务端，不会下发给客户端；客户端走网关时用的是另一套 corp-key。
              </span>
            </div>
            {err && <div style={{ fontSize: 12, color: '#b91c1c' }}>{err}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="btn-secondary" style={{ height: 38 }} onClick={onClose}>取消</button>
              <button type="button" className="btn-primary" style={{ height: 38 }} onClick={goFetch} disabled={fetching}>
                {fetching ? <><Loader2 size={14} className="spin" />拉取中…</> : '拉取模型列表'}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <BatchModelPicker items={upstream} busy={busy} onProbe={probeTypes} tiers={tiers}
              onCancel={() => setStep(1)} onSubmit={submit} />

            <div>
              <button type="button" className="btn-ghost" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                onClick={() => setShowAdv(v => !v)}>
                高级（负载权重 · 计费单价 · 最大输出）
                {showAdv ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
              {showAdv && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 10 }}>
                  <div className="form-group">
                    <label className="form-label">负载权重</label>
                    <input className="form-input" type="number" min={1} value={weight} onChange={e => setWeight(e.target.value)} />
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>同档位内按权重分流</span>
                  </div>
                  <div className="form-group">
                    <label className="form-label">输入单价</label>
                    <input className="form-input" type="number" min={0} step="0.01" value={inPrice} onChange={e => setInPrice(e.target.value)} placeholder="元/百万 tokens" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">输出单价</label>
                    <input className="form-input" type="number" min={0} step="0.01" value={outPrice} onChange={e => setOutPrice(e.target.value)} placeholder="元/百万 tokens" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">最大输出 tokens</label>
                    <input className="form-input" type="number" min={0} step="1024" value={maxOut} onChange={e => setMaxOut(e.target.value)} placeholder="留空=默认 32768" />
                  </div>
                </div>
              )}
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
                这几项对本次登记的所有通道生效，登记后可在列表里单条调整。
              </div>
            </div>

            {err && <div style={{ fontSize: 12, color: '#b91c1c' }}>{err}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
