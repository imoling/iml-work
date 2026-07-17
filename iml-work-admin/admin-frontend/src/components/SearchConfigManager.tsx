import { useState, useEffect } from 'react'
import { Globe, Save, RefreshCw } from 'lucide-react'

interface SearchCfg {
  provider: string
  apiKey: string
  endpoint: string
  maxResults: number
  deepReadCount: number
  browserEngine: string
}

const BLANK: SearchCfg = { provider: 'NONE', apiKey: '', endpoint: '', maxResults: 5, deepReadCount: 2, browserEngine: 'ELECTRON' }

export default function SearchConfigManager() {
  const [form, setForm] = useState<SearchCfg>(BLANK)
  const [hasKey, setHasKey] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/v1/search-config')
      if (res.ok) {
        const d = await res.json()
        setHasKey(!!d.hasKey)   // 后端不再下发 apiKey（WRITE_ONLY），改用 hasKey 判断是否已配置
        setForm({ provider: d.provider || 'NONE', apiKey: '', endpoint: d.endpoint || '', maxResults: d.maxResults || 5, deepReadCount: d.deepReadCount ?? 2, browserEngine: d.browserEngine || 'ELECTRON' })
      }
    } catch (err) { console.error(err) }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const save = async () => {
    setSaving(true)
    const res = await fetch('/api/v1/search-config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form)
    })
    setSaving(false)
    if (res.ok) { setForm(f => ({ ...f, apiKey: '' })); setHasKey(v => v || !!form.apiKey); alert('检索服务配置已保存。') } else { alert('保存失败') }
  }

  const needsKey = form.provider === 'TAVILY' || form.provider === 'BING'
  const needsEndpoint = form.provider === 'SEARXNG'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="page-header">
        <div className="page-intro">
          配置工作分身的联网检索通道。配置 Tavily / Bing 检索 API 后走专业检索服务；不配置则回退到客户端内置的浏览器检索（开箱即用，可能被搜索引擎限流）。
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={load}><RefreshCw size={14} /><span>刷新</span></button>
        </div>
      </div>

      <div className="glass-panel" style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Globe size={16} color="var(--brand-primary)" />联网检索服务
        </h3>

        {loading ? (
          <div style={{ color: 'var(--text-secondary)', padding: 20, textAlign: 'center' }}>正在加载...</div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div className="form-group">
                <label className="form-label">检索服务商</label>
                <select className="form-select" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}>
                  <option value="NONE">不启用 API · 内置浏览器检索</option>
                  <option value="SEARXNG">SearXNG（企业自托管聚合检索 · 免密钥）</option>
                  <option value="TAVILY">Tavily（面向 AI 的检索 API）</option>
                  <option value="BING">Bing Web Search API</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">内置浏览器抓取引擎</label>
                <select className="form-select" value={form.browserEngine} onChange={e => setForm({ ...form, browserEngine: e.target.value })}>
                  <option value="ELECTRON">内置离屏浏览器（默认）</option>
                  <option value="PLAYWRIGHT">Playwright（需客户端已安装）</option>
                </select>
              </div>
            </div>

            {needsKey && (
              <div className="form-group">
                <label className="form-label">API Key {hasKey && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>（已配置，留空则不变）</span>}</label>
                <input className="form-input" type="password" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder={form.provider === 'TAVILY' ? 'tvly-...' : 'Bing 订阅密钥'} />
              </div>
            )}

            {needsEndpoint && (
              <div className="form-group">
                <label className="form-label">SearXNG 服务地址</label>
                <input className="form-input" value={form.endpoint} onChange={e => setForm({ ...form, endpoint: e.target.value })} placeholder="http://127.0.0.1:8890" />
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  部署在企业内网的 SearXNG 实例（需在其 settings.yml 开启 JSON 输出）。检索由后端代理执行，客户端不直连。
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div className="form-group">
                <label className="form-label">最大结果数</label>
                <input className="form-input" type="number" min={1} max={20} value={form.maxResults} onChange={e => setForm({ ...form, maxResults: parseInt(e.target.value) || 5 })} />
              </div>
              <div className="form-group">
                <label className="form-label">深读网页篇数</label>
                <input className="form-input" type="number" min={0} max={6} value={form.deepReadCount} onChange={e => setForm({ ...form, deepReadCount: parseInt(e.target.value) || 0 })} />
              </div>
            </div>

            <div>
              <button className="btn-primary" onClick={save} disabled={saving}><Save size={14} /><span>{saving ? '保存中…' : '保存检索配置'}</span></button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
