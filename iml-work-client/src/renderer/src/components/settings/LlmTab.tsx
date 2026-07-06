import React, { useState } from 'react'
import { Save, Check, ChevronDown, ChevronUp, Cloud, HardDrive, ShieldCheck, Sparkles, Moon, Settings2 } from 'lucide-react'
import { useUserStore } from '../../stores/userStore'

// 模型服务页：三类服务（企业中转站/网络厂商/本地）选择、厂商预设、密钥与模型配置、
// 连接测试。样式沿用 SettingsPanel 的全局 <style>（provider-card / vendor-grid / model-* 等）。

// 三类模型服务（顶层）。企业模型中转站为默认推荐。
type ServiceType = 'gateway' | 'network' | 'local'
interface ServiceDef { key: ServiceType; name: string; use: string; icon: React.ReactNode }
const SERVICES: ServiceDef[] = [
  { key: 'gateway', name: '企业模型中转站', use: '企业统一调度 · 推荐', icon: <ShieldCheck size={18} /> },
  { key: 'network', name: '网络模型服务', use: '厂商 API 直连', icon: <Cloud size={18} /> },
  { key: 'local', name: '本地模型', use: '离线 · 隐私', icon: <HardDrive size={18} /> },
]

// 网络模型服务的厂商预设（选了自动带出接口地址 / 协议 / 默认模型）。
interface VendorDef { key: string; name: string; baseUrl: string; apiMode: 'chat' | 'anthropic'; model: string; doc?: string }
const NETWORK_VENDORS: VendorDef[] = [
  { key: 'agnes', name: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1', apiMode: 'chat', model: 'agnes-2.0-flash', doc: 'https://apihub.agnes-ai.com' },
  { key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiMode: 'chat', model: 'deepseek-chat', doc: 'https://platform.deepseek.com' },
  { key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiMode: 'chat', model: 'gpt-4o', doc: 'https://platform.openai.com/docs' },
  { key: 'anthropic', name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com', apiMode: 'anthropic', model: 'claude-3-5-sonnet-latest', doc: 'https://docs.anthropic.com' },
  { key: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiMode: 'chat', model: 'qwen-plus', doc: 'https://help.aliyun.com/zh/dashscope' },
  { key: 'moonshot', name: 'Moonshot · Kimi', baseUrl: 'https://api.moonshot.cn/v1', apiMode: 'chat', model: 'moonshot-v1-8k', doc: 'https://platform.moonshot.cn' },
  { key: 'custom', name: '自定义 · OpenAI 兼容', baseUrl: '', apiMode: 'chat', model: '' },
]

// 本地模型服务的预设。
const LOCAL_VENDORS: VendorDef[] = [
  { key: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', apiMode: 'chat', model: 'qwen2.5', doc: 'https://ollama.com' },
  { key: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiMode: 'chat', model: '', doc: 'https://lmstudio.ai' },
  { key: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1', apiMode: 'chat', model: '', doc: 'https://docs.vllm.ai' },
  { key: 'custom', name: '自定义本地端点', baseUrl: 'http://localhost:11434/v1', apiMode: 'chat', model: '' },
]

// 厂商标识：品牌色圆角底 + 风格化字形（非官方 LOGO 精确复刻，仅作辨识）。
const VENDOR_BRAND: Record<string, { bg: string; node: React.ReactNode }> = {
  agnes: { bg: 'linear-gradient(135deg,#62E0B1,#37C98B)', node: <Sparkles size={16} color="#fff" /> },
  deepseek: { bg: '#4D6BFE', node: <span style={{ fontSize: 15 }}>🐳</span> },
  openai: {
    bg: '#0B0B0B', node: (
      <svg width="16" height="16" viewBox="0 0 24 24">
        {[0, 60, 120, 180, 240, 300].map(a => (
          <ellipse key={a} cx="12" cy="6.5" rx="2.1" ry="4.2" fill="#fff" transform={`rotate(${a} 12 12)`} />
        ))}
      </svg>
    )
  },
  anthropic: {
    bg: '#D97757', node: (
      <svg width="16" height="16" viewBox="0 0 24 24" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" />
        <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" /><line x1="18.4" y1="5.6" x2="5.6" y2="18.4" />
      </svg>
    )
  },
  qwen: { bg: '#615CED', node: <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>通</span> },
  moonshot: { bg: '#101426', node: <Moon size={15} color="#fff" /> },
  ollama: { bg: '#111111', node: <span style={{ fontSize: 15 }}>🦙</span> },
  lmstudio: { bg: '#4F46E5', node: <span style={{ fontSize: 11, fontWeight: 800, color: '#fff' }}>LM</span> },
  vllm: { bg: '#FF6B35', node: <span style={{ fontSize: 11, fontWeight: 800, color: '#fff' }}>vL</span> },
  custom: { bg: 'var(--bg-subtle)', node: <Settings2 size={15} color="var(--text-secondary)" /> },
}
function vendorLogo(key: string): React.ReactNode {
  const b = VENDOR_BRAND[key] || VENDOR_BRAND.custom
  return <span className="vendor-logo" style={{ background: b.bg }}>{b.node}</span>
}

// The enterprise gateway resolves the real upstream key server-side; the client
// sends this sentinel so the backend uses its managed key instead of a user one.
const CORP_GATEWAY_TOKEN = 'sk-corp-default-key'

// Extract the host from a base URL for loose matching against the saved config.
function hostOf(url: string): string {
  try { return new URL(url).host.replace(/[.\-]/g, '\\$&') } catch { return url }
}

export default function LlmTab() {
  const { llmConnectionMode, llmApiMode, llmBaseUrl, llmApiKey, llmModelName, updateLlmConfig } = useUserStore()

  const [connectionMode, setConnectionMode] = useState<'proxy' | 'direct'>(llmConnectionMode)
  const [apiMode, setApiMode] = useState<'chat' | 'anthropic'>(llmApiMode)
  const [baseUrlInput, setBaseUrlInput] = useState(llmBaseUrl)
  const [apiKeyInput, setApiKeyInput] = useState(llmApiKey)
  const [modelNameInput, setModelNameInput] = useState(llmModelName)
  // Admin backend root — used for expert claim, corporate RAG retrieval and file sync.
  const [adminBaseUrlInput, setAdminBaseUrlInput] = useState(import.meta.env.VITE_ADMIN_BASE_URL || 'http://localhost:8080')
  const [serviceType, setServiceType] = useState<ServiceType>('gateway')
  const [vendorKey, setVendorKey] = useState('agnes')       // 网络模型服务的厂商
  const [localVendorKey, setLocalVendorKey] = useState('ollama')

  // 应用一个厂商预设：带出接口地址/协议/默认模型；密钥按是否匹配已保存配置处理。
  const applyVendor = (v: VendorDef, isLocal: boolean) => {
    setApiMode(v.apiMode)
    if (v.baseUrl) setBaseUrlInput(v.baseUrl)
    setModelNameInput(v.model)
    if (isLocal) { setApiKeyInput(''); return }
    if (v.baseUrl && llmBaseUrl && new RegExp(hostOf(v.baseUrl), 'i').test(llmBaseUrl) && llmApiKey) setApiKeyInput(llmApiKey)
    else setApiKeyInput('')
  }

  // 选择顶层服务类型。
  const selectService = (t: ServiceType) => {
    setServiceType(t)
    if (t === 'gateway') {
      setConnectionMode('proxy'); setApiMode('chat')
      setBaseUrlInput(`${adminBaseUrlInput.trim().replace(/\/$/, '')}/api/v1/model`)
      setModelNameInput(modelNameInput && llmConnectionMode === 'proxy' ? modelNameInput : 'corp-default')
      setApiKeyInput(CORP_GATEWAY_TOKEN)
    } else if (t === 'network') {
      setConnectionMode('direct')
      applyVendor(NETWORK_VENDORS.find(v => v.key === vendorKey) || NETWORK_VENDORS[0], false)
    } else {
      setConnectionMode('direct')
      applyVendor(LOCAL_VENDORS.find(v => v.key === localVendorKey) || LOCAL_VENDORS[0], true)
    }
  }
  const selectNetworkVendor = (key: string) => { setVendorKey(key); applyVendor(NETWORK_VENDORS.find(v => v.key === key)!, false) }
  const selectLocalVendor = (key: string) => { setLocalVendorKey(key); applyVendor(LOCAL_VENDORS.find(v => v.key === key)!, true) }

  // 进入页面时，依据已保存配置自动识别服务类型与厂商（只做一次）。
  const detectedRef = React.useRef(false)
  React.useEffect(() => {
    if (detectedRef.current) return
    if (!llmBaseUrl && llmConnectionMode !== 'proxy') return
    detectedRef.current = true
    const url = (llmBaseUrl || '').toLowerCase()
    if (llmConnectionMode === 'proxy') { setServiceType('gateway'); return }
    if (/localhost|127\.0\.0\.1|11434|1234|:8000/.test(url)) {
      setServiceType('local')
      const lv = LOCAL_VENDORS.find(v => { try { return v.baseUrl && url.includes(new URL(v.baseUrl).host) } catch { return false } })
      if (lv) setLocalVendorKey(lv.key)
      return
    }
    setServiceType('network')
    const nv = NETWORK_VENDORS.find(v => { try { return v.baseUrl && url.includes(new URL(v.baseUrl).hostname) } catch { return false } })
    setVendorKey(nv ? nv.key : 'custom')
  }, [llmConnectionMode, llmBaseUrl])

  React.useEffect(() => {
    window.api.invoke('db:config-get', 'adminBaseUrl').then((v: any) => {
      if (typeof v === 'string' && v) setAdminBaseUrlInput(v)
    }).catch(() => {})
  }, [])

  // Sync local inputs when store async loads settings from disk
  React.useEffect(() => {
    // Sanitize: only accept known-good types from store
    if (llmConnectionMode === 'proxy' || llmConnectionMode === 'direct') setConnectionMode(llmConnectionMode)
    if (llmApiMode === 'chat' || llmApiMode === 'anthropic') setApiMode(llmApiMode)
    if (typeof llmBaseUrl === 'string') setBaseUrlInput(llmBaseUrl)
    if (typeof llmApiKey === 'string') setApiKeyInput(llmApiKey)
    if (typeof llmModelName === 'string') setModelNameInput(llmModelName)
  }, [llmConnectionMode, llmApiMode, llmBaseUrl, llmApiKey, llmModelName])

  // Advanced LLM settings accordion
  const [showAdvancedLlm, setShowAdvancedLlm] = useState(false)
  const [temperature, setTemperature] = useState(0.3)
  const [maxTokens, setMaxTokens] = useState(4096)

  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)
  const [testing, setTesting] = useState(false)

  const handleTestLlm = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      // Gateway mode with no user key → send the corp sentinel so the backend
      // resolves its managed upstream key (keeps test consistent with chat).
      const effectiveKey = (connectionMode === 'proxy' && !apiKeyInput.trim())
        ? CORP_GATEWAY_TOKEN
        : apiKeyInput.trim()
      // Always pass clean string values directly from the form
      const result = await window.api.invoke('llm:test', {
        mode: connectionMode as string,
        apiMode: (apiMode === 'chat' || apiMode === 'anthropic') ? apiMode : 'chat',
        baseUrl: baseUrlInput.trim(),
        apiKey: effectiveKey,
        modelName: modelNameInput.trim()
      })
      setTestResult(result)
    } catch (err: any) {
      setTestResult({ error: err.message, success: false })
    }
    setTesting(false)
  }

  const handleSaveLlm = (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setTimeout(() => {
      const effectiveKey = (connectionMode === 'proxy' && !apiKeyInput.trim())
        ? CORP_GATEWAY_TOKEN
        : apiKeyInput.trim()
      updateLlmConfig({
        llmConnectionMode: connectionMode,
        llmApiMode: (apiMode === 'chat' || apiMode === 'anthropic') ? apiMode : 'chat',
        llmBaseUrl: baseUrlInput.trim(),
        llmApiKey: effectiveKey,
        llmModelName: modelNameInput.trim()
      })
      window.api.invoke('db:config-set', 'adminBaseUrl', adminBaseUrlInput.trim())
      setSaving(false)
      alert('已保存大模型与中转安全代理配置。')
    }, 300)
  }

  return (
    <div className="settings-tab-content" style={{ maxWidth: '100%' }}>
      <h2 className="tab-title">模型服务</h2>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: -6, marginBottom: 4 }}>
        为工作分身选择推理后端：先选一个服务，再填好密钥与模型即可。
      </p>

      <div className="step-label"><span className="step-num">1</span> 选择模型服务</div>
      <div className="svc-grid">
        {SERVICES.map((s) => {
          const active = serviceType === s.key
          return (
            <button type="button" key={s.key} className={`provider-card ${active ? 'selected' : ''}`} onClick={() => selectService(s.key)}>
              <div className="svc-ic">{s.icon}</div>
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div className="svc-name">{s.name}</div>
                <div className="svc-type">{s.use}</div>
              </div>
              {active
                ? <span className="pill pill-mint"><Check size={12} />当前</span>
                : <span className="provider-pick">选用</span>}
            </button>
          )
        })}
      </div>

      <div className="step-label" style={{ marginTop: 22 }}>
        <span className="step-num">2</span> 配置「{SERVICES.find((s) => s.key === serviceType)?.name}」
      </div>
      <form onSubmit={handleSaveLlm} className="model-config">
        {serviceType === 'gateway' && (
          <>
            <div className="model-field">
              <label className="model-label">企业网关地址</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="settings-input" style={{ flex: 1 }} value={adminBaseUrlInput} onChange={(e) => setAdminBaseUrlInput(e.target.value)} placeholder="http://localhost:8080" />
                <button type="button" className="btn-secondary" onClick={() => setBaseUrlInput(`${adminBaseUrlInput.trim().replace(/\/$/, '')}/api/v1/model`)}>指向网关</button>
              </div>
              <span className="model-hint">由企业模型中转站统一调度（负载均衡 · 脱敏 · 审计），无需在此填写密钥。</span>
            </div>
            <div className="model-field">
              <label className="model-label">逻辑路由名（模型）</label>
              <input className="settings-input" value={modelNameInput} onChange={(e) => setModelNameInput(e.target.value)} placeholder="corp-default" />
              <span className="model-hint">对应管理端「模型中转站」里的 routeKey，由中转站决定实际通道。</span>
            </div>
          </>
        )}

        {serviceType === 'network' && (
          <>
            <div className="model-field">
              <label className="model-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>提供商</span>
                {NETWORK_VENDORS.find((v) => v.key === vendorKey)?.doc && (
                  <a className="model-doc-link" onClick={() => window.api.invoke('window:open-url', NETWORK_VENDORS.find((v) => v.key === vendorKey)!.doc)}>查看文档</a>
                )}
              </label>
              <div className="vendor-grid">
                {NETWORK_VENDORS.map((v) => (
                  <button type="button" key={v.key} className={`vendor-card ${vendorKey === v.key ? 'selected' : ''}`} onClick={() => selectNetworkVendor(v.key)}>
                    {vendorLogo(v.key)}
                    <span className="vendor-name">{v.name}</span>
                    {vendorKey === v.key && <Check size={13} className="vendor-check" />}
                  </button>
                ))}
              </div>
            </div>
            <div className="model-field">
              <label className="model-label">接口地址 (Base URL)</label>
              <input className="settings-input" value={baseUrlInput} onChange={(e) => setBaseUrlInput(e.target.value)} placeholder="https://api.example.com/v1" />
            </div>
            <div className="model-field">
              <label className="model-label">模型名称</label>
              <input className="settings-input" value={modelNameInput} onChange={(e) => setModelNameInput(e.target.value)} placeholder="如 deepseek-chat / gpt-4o" />
            </div>
            <div className="model-field">
              <label className="model-label">API 密钥</label>
              <input type="password" className="settings-input" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="必填 · 粘贴该服务的 API Key" />
              <span className="model-hint">保存后在本地加密存储。</span>
            </div>
          </>
        )}

        {serviceType === 'local' && (
          <>
            <div className="model-field">
              <label className="model-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>提供商</span>
                {LOCAL_VENDORS.find((v) => v.key === localVendorKey)?.doc && (
                  <a className="model-doc-link" onClick={() => window.api.invoke('window:open-url', LOCAL_VENDORS.find((v) => v.key === localVendorKey)!.doc)}>查看文档</a>
                )}
              </label>
              <div className="vendor-grid">
                {LOCAL_VENDORS.map((v) => (
                  <button type="button" key={v.key} className={`vendor-card ${localVendorKey === v.key ? 'selected' : ''}`} onClick={() => selectLocalVendor(v.key)}>
                    {vendorLogo(v.key)}
                    <span className="vendor-name">{v.name}</span>
                    {localVendorKey === v.key && <Check size={13} className="vendor-check" />}
                  </button>
                ))}
              </div>
            </div>
            <div className="model-field">
              <label className="model-label">接口地址 (Base URL)</label>
              <input className="settings-input" value={baseUrlInput} onChange={(e) => setBaseUrlInput(e.target.value)} placeholder="http://localhost:11434/v1" />
            </div>
            <div className="model-field">
              <label className="model-label">模型名称</label>
              <input className="settings-input" value={modelNameInput} onChange={(e) => setModelNameInput(e.target.value)} placeholder="如 qwen2.5 / llama3.1" />
              <span className="model-hint">本地部署无需 API Key。</span>
            </div>
          </>
        )}

        {/* 高级设置：协议 / 参数 */}
        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
          <button type="button" className="settings-accordion-trigger" onClick={() => setShowAdvancedLlm(!showAdvancedLlm)}>
            <span>高级设置（{serviceType === 'network' ? '协议 · ' : ''}参数）</span>
            {showAdvancedLlm ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {showAdvancedLlm && (
            <div className="settings-accordion-content" style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {serviceType === 'network' && (
                <div className="model-field">
                  <label className="model-label">API 协议</label>
                  <select className="settings-select" value={apiMode} onChange={(e) => setApiMode(e.target.value as 'chat' | 'anthropic')}>
                    <option value="chat">OpenAI Chat 协议</option>
                    <option value="anthropic">Anthropic Claude 协议</option>
                  </select>
                </div>
              )}
              <div style={{ display: 'flex', gap: 16 }}>
                <div className="model-field" style={{ flex: 1 }}>
                  <label className="model-label">Temperature · {temperature}</label>
                  <input type="range" min="0" max="1" step="0.1" value={temperature} onChange={(e) => setTemperature(parseFloat(e.target.value))} />
                </div>
                <div className="model-field" style={{ width: 140 }}>
                  <label className="model-label">最大输出 Tokens</label>
                  <input type="number" className="settings-input" value={maxTokens} onChange={(e) => setMaxTokens(parseInt(e.target.value))} />
                </div>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: 4 }}>
          <button type="submit" className="settings-btn" disabled={saving}>
            <Save size={14} />保存配置
          </button>
          <button type="button" className="btn-secondary" onClick={handleTestLlm} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          {testResult && (
            <span className={`pill ${testResult.success ? 'pill-mint' : 'pill-red'}`}><span className="pill-dot" />{testResult.success ? '连接成功' : '连接失败'}</span>
          )}
        </div>

        {testResult && (
          <div className="model-test-result">
            {testResult.success
              ? <>已连通{testResult.config?.modelName ? ` ${testResult.config.modelName}` : ''}{testResult.parsedContent ? ` · 模型回复：${String(testResult.parsedContent).slice(0, 40)}` : ''}</>
              : <span style={{ color: 'var(--accent-red)' }}>{testResult.error || `请求失败 HTTP ${testResult.httpStatus || ''} ${testResult.httpStatusText || ''}`}</span>}
          </div>
        )}

      </form>
    </div>
  )
}
