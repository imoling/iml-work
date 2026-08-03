import React, { useState } from 'react'
import ModelPicker from './ModelPicker'
import { NETWORK_VENDORS, LOCAL_VENDORS, vendorLogo, type VendorDef } from './vendors'
import ProviderList from './ProviderList'
import {
  TIER_MODELS_KEY, parseTierModels, autoAssignTiers, type TierModels,
  PROVIDERS_KEY, DEFAULT_MODEL_KEY, parseProviders, parseModelRef, type LlmProvider,
} from '../../../../shared/llm-service'
import { Save, Check, ChevronDown, ChevronUp, Cloud, HardDrive, ShieldCheck } from 'lucide-react'
import { useUserStore } from '../../stores/userStore'
import { DEV_CORP_GATEWAY_KEY as CORP_GATEWAY_TOKEN } from '../../../../shared/corp-key'
import { type ServiceType, deriveServiceType } from '../../../../shared/llm-service'

// 模型服务页：三类服务（企业中转站/网络厂商/本地）选择、厂商预设、密钥与模型配置、
// 连接测试。样式沿用 SettingsPanel 的全局 <style>（provider-card / vendor-grid / model-* 等）。

// 三类模型服务（顶层）。企业模型中转站为默认推荐。
// 类型与"由已存配置反推服务类型"的判据在 shared/llm-service.ts（与 composer 的模型选择器同源）。
interface ServiceDef { key: ServiceType; name: string; use: string; icon: React.ReactNode }
const SERVICES: ServiceDef[] = [
  { key: 'gateway', name: '企业模型中转站', use: '企业统一调度 · 推荐', icon: <ShieldCheck size={18} /> },
  { key: 'network', name: '网络模型服务', use: '厂商 API 直连', icon: <Cloud size={18} /> },
  { key: 'local', name: '本地模型', use: '离线 · 隐私', icon: <HardDrive size={18} /> },
]

// CORP_GATEWAY_TOKEN（网关哨兵 key）单一来源见顶部 import：src/shared/corp-key.ts
// （与后端 DEV_DEFAULT_CORP_KEY 同值；服务端持真实上游密钥，生产由管理员下发）

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
  // 深度调研专用模型（可选）：规划/缺口盘点/分节成稿最吃推理，给调研单配推理档收益最大。
  // 空 = 跟随上面的默认模型。键 llm-research-model 由主进程 deep-research 引擎读取。
  const [researchModelInput, setResearchModelInput] = useState('')
  // 摘要模型：滚动折叠上下文时用（agent-steps 的 buildHistoryBlock）。空 = 跟随默认模型。
  const [summaryModelInput, setSummaryModelInput] = useState('')
  // 上下文窗口：composer 的占用圆环按它算百分比。空 = 128k（main.ts 的兜底）。
  const [contextWindowInput, setContextWindowInput] = useState('')
  // 企业策略：管理员可禁止员工自配模型（数据绕过企业闸的唯一入口）。
  // 值由心跳落本地 config，后端离线时沿用上次拿到的——不因为连不上就悄悄放开管控。
  const [allowCustom, setAllowCustom] = useState(true)
  React.useEffect(() => {
    window.api.invoke('db:config-get', 'policy-allow-custom-model')
      .then((v: unknown) => setAllowCustom(v !== '0'))
      .catch(() => {})
  }, [])
  // 拉到的模型按名推断的档位（后端 ModelTypeGuess 单一来源；后端不可达就不显示标注）
  const [modelTiers, setModelTiers] = useState<Record<string, { type: string; tierName: string; chatCapable: boolean }>>({})
  // 自配模式的「档位 → 真实模型」映射。企业中转站不需要它（网关按通道类型解析），
  // 自配直连没有网关做这一步，所以存在本地；主进程 currentLlmConfig 据此翻译档位别名。
  const [tierModels, setTierModels] = useState<TierModels>({})
  // 多提供商并存（自配侧）。企业中转站模式不走这套——那边的多通道调度在服务端。
  const [providers, setProviders] = useState<LlmProvider[]>([])
  const [defaultRef, setDefaultRef] = useState('')
  React.useEffect(() => {
    window.api.invoke('db:config-get', PROVIDERS_KEY)
      .then((v: unknown) => setProviders(parseProviders(typeof v === 'string' ? v : '')))
      .catch(() => {})
    window.api.invoke('db:config-get', DEFAULT_MODEL_KEY)
      .then((v: unknown) => setDefaultRef(typeof v === 'string' ? v : ''))
      .catch(() => {})
  }, [])
  React.useEffect(() => {
    window.api.invoke('db:config-get', TIER_MODELS_KEY)
      .then((v: unknown) => setTierModels(parseTierModels(typeof v === 'string' ? v : '')))
      .catch(() => {})
  }, [])
  /** 拉取上游模型名（ModelPicker 调用；返回数组或抛错，展示与状态由它自己管）。
   *  顺带把档位标注也取回来——两件事同源，分开取会出现"列表到了标注没到"的闪烁。 */
  const fetchModelList = async (): Promise<string[]> => {
    const effectiveKey = (connectionMode === 'proxy' && !apiKeyInput.trim()) ? CORP_GATEWAY_TOKEN : apiKeyInput.trim()
    const r: any = await window.api.invoke('llm:list-models', {
      mode: connectionMode, baseUrl: baseUrlInput.trim(), apiKey: effectiveKey,
    })
    if (!Array.isArray(r?.models) || !r.models.length) {
      throw new Error(r?.error || '未拉取到模型列表（部分厂商不提供该接口，手填即可）')
    }
    // 档位标注走后端（复用 ModelTypeGuess，不在客户端抄一份规则）；只传模型名、不传密钥。
    // 走 /model/guess-types（corp-key 鉴权，客户端可访问）而不是 /model/providers/*（管理员专用）。
    try {
      const res = await fetch(`${adminBaseUrlInput.replace(/\/$/, '')}/api/v1/model/guess-types`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CORP_GATEWAY_TOKEN}` },
        body: JSON.stringify({ models: r.models }),
      })
      if (res.ok) {
        const t = (await res.json()).results || {}
        setModelTiers(t)
        // 「导入模型服务」的关键一步：拉到列表就顺手把档位配好，用户不用自己琢磨哪个是推理模型。
        // 只在还没配过时自动填——已经手工调过就别覆盖人家的选择。
        setTierModels(prev => (Object.keys(prev).length ? prev : autoAssignTiers(r.models, t)))
      }
    } catch { setModelTiers({}) }   // 后端不可达 → 只是没有标注，不影响选择
    return r.models as string[]
  }

  // Admin backend root — used for expert claim, corporate RAG retrieval and file sync.
  const [adminBaseUrlInput, setAdminBaseUrlInput] = useState(import.meta.env.VITE_ADMIN_BASE_URL || 'http://localhost:8080')
  // 运行时配置的服务器地址优先于构建期默认（打包产物里 VITE_ADMIN_BASE_URL 多半是空 → localhost），
  // 否则「指向网关」按钮会把模型服务指到一个不存在的本机网关。
  React.useEffect(() => {
    window.api.invoke('db:config-get', 'adminBaseUrl').then((v: unknown) => {
      if (typeof v === 'string' && v.startsWith('http')) setAdminBaseUrlInput(v.replace(/\/$/, ''))
    }).catch(() => {})
  }, [])
  const [serviceType, setServiceType] = useState<ServiceType>('gateway')
  const [vendorKey, setVendorKey] = useState('agnes')       // 网络模型服务的厂商
  const [localVendorKey, setLocalVendorKey] = useState('ollama')

  // 应用一个厂商预设：带出接口地址/协议/默认模型；密钥按是否匹配已保存配置处理。
  const applyVendor = (v: VendorDef, isLocal: boolean) => {
    // 换厂商必须清掉上一家的拉取结果与档位分配——否则界面会出现
    // 「提供商选的是 DeepSeek、地址是 api.deepseek.com，列表里却是 agnes-* 模型」这种自相矛盾的状态
    //（实测截图 2026-08-03），用户还可能照着选中一个另一家根本不存在的模型。
    setModelTiers({}); setTierModels({})
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
  const selectLocalVendor = (key: string) => { setLocalVendorKey(key); applyVendor(LOCAL_VENDORS.find(v => v.key === key)!, true) }

  // 进入页面时，依据已保存配置自动识别服务类型与厂商（只做一次）。
  const detectedRef = React.useRef(false)
  React.useEffect(() => {
    if (detectedRef.current) return
    if (!llmBaseUrl && llmConnectionMode !== 'proxy') return
    detectedRef.current = true
    const url = (llmBaseUrl || '').toLowerCase()
    // 服务类型判据走共享函数；这里只额外做**厂商预设**的回显匹配（纯 UI，不属于判据本身）。
    const t = deriveServiceType(llmConnectionMode, url)
    setServiceType(t)
    if (t === 'gateway') return
    if (t === 'local') {
      const lv = LOCAL_VENDORS.find(v => { try { return v.baseUrl && url.includes(new URL(v.baseUrl).host) } catch { return false } })
      if (lv) setLocalVendorKey(lv.key)
      return
    }
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
    window.api.invoke('db:config-get', 'llm-summary-model').then((v: any) => {
      if (typeof v === 'string') setSummaryModelInput(v)
    }).catch(() => {})
    window.api.invoke('db:config-get', 'llm-context-window').then((v: any) => {
      if (typeof v === 'string') setContextWindowInput(v)
    }).catch(() => {})
    window.api.invoke('db:config-get', 'llm-research-model').then((v: any) => {
      if (typeof v === 'string') setResearchModelInput(v)
    }).catch(() => {})
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
      // 测的必须是**真正会生效**的那套连接（多提供商下来自默认模型所属的提供商）
      const c = effectiveConn()
      const result = await window.api.invoke('llm:test', {
        mode: connectionMode as string,
        apiMode: (c.apiMode === 'chat' || c.apiMode === 'anthropic') ? c.apiMode : 'chat',
        baseUrl: c.baseUrl,
        apiKey: c.apiKey,
        modelName: c.modelName,
      })
      setTestResult(result)
    } catch (err: any) {
      setTestResult({ error: err.message, success: false })
    }
    setTesting(false)
  }

  /**
   * 当前**真正会生效**的连接参数。
   *
   * 网络模型服务改成多提供商后，界面上已经没有那三个平铺输入框了——
   * 测试连接与保存却还在读它们，于是必然拿到空值，报「配置不完整」（实测截图 2026-08-03）。
   * 这里按默认模型反查它所属的提供商，取出真实的地址/密钥/模型。
   */
  const effectiveConn = (): { baseUrl: string; apiKey: string; apiMode: string; modelName: string } => {
    if (serviceType !== 'network') {
      return {
        baseUrl: baseUrlInput.trim(),
        apiKey: (connectionMode === 'proxy' && !apiKeyInput.trim()) ? CORP_GATEWAY_TOKEN : apiKeyInput.trim(),
        apiMode: (apiMode === 'chat' || apiMode === 'anthropic') ? apiMode : 'chat',
        modelName: modelNameInput.trim(),
      }
    }
    const ref = parseModelRef(defaultRef) || (providers[0] ? { providerId: providers[0].id, model: providers[0].enabled[0] || '' } : null)
    const pr = ref ? providers.find(x => x.id === ref.providerId) : undefined
    return {
      baseUrl: pr?.baseUrl || '', apiKey: pr?.apiKey || '',
      apiMode: pr?.apiMode || 'chat', modelName: ref?.model || '',
    }
  }

  const handleSaveLlm = (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setTimeout(() => {
      // 平铺的三个键仍要写：它们是 currentLlmConfig 的兜底底座（引用解析不中时用），
      // 多提供商模式下就写默认模型所属提供商的那一份，别写成空。
      const c = effectiveConn()
      updateLlmConfig({
        llmConnectionMode: connectionMode,
        llmApiMode: (c.apiMode === 'chat' || c.apiMode === 'anthropic') ? c.apiMode : 'chat',
        llmBaseUrl: c.baseUrl,
        llmApiKey: c.apiKey,
        llmModelName: serviceType === 'network' ? (defaultRef || c.modelName) : c.modelName,
      })
      window.api.invoke('db:config-set', 'adminBaseUrl', adminBaseUrlInput.trim())
      window.api.invoke('db:config-set', 'llm-research-model', researchModelInput.trim())
      window.api.invoke('db:config-set', 'llm-summary-model', summaryModelInput.trim())
      window.api.invoke('db:config-set', TIER_MODELS_KEY, JSON.stringify(tierModels))
      window.api.invoke('db:config-set', PROVIDERS_KEY, JSON.stringify(providers))
      window.api.invoke('db:config-set', DEFAULT_MODEL_KEY, defaultRef)
      window.api.invoke('db:config-set', 'llm-context-window', String(parseInt(contextWindowInput) || ''))
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
          const locked = !allowCustom && s.key !== 'gateway'
          return (
            <button type="button" key={s.key} disabled={locked}
              className={`provider-card ${active ? 'selected' : ''}`}
              style={locked ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
              title={locked ? '管理员已禁止自配模型，只能走企业模型中转站' : undefined}
              onClick={() => { if (!locked) selectService(s.key) }}>
              <div className="svc-ic">{s.icon}</div>
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div className="svc-name">{s.name}</div>
                <div className="svc-type">{locked ? '管理员已禁用' : s.use}</div>
              </div>
              {active
                ? <span className="pill pill-mint"><Check size={12} />当前</span>
                : <span className="provider-pick">{locked ? '已锁定' : '选用'}</span>}
            </button>
          )
        })}
      </div>
      {!allowCustom && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
          企业已统一模型出口：自配厂商端点会让业务数据绕过中转站、平台侧无法审计，因此由管理员关闭。
          {serviceType !== 'gateway' && ' 你当前仍是自配配置，请切回「企业模型中转站」。'}
        </p>
      )}

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
          <ProviderList
            providers={providers} onChange={setProviders}
            tiers={tierModels} onTiers={setTierModels}
            defaultRef={defaultRef} onDefaultRef={setDefaultRef}
            vendors={NETWORK_VENDORS}
            fetchModels={async (baseUrl, apiKey, apiMode) => {
              const r: any = await window.api.invoke('llm:list-models', { mode: 'direct', baseUrl, apiKey, apiMode })
              if (!Array.isArray(r?.models) || !r.models.length) throw new Error(r?.error || '未拉取到模型列表')
              // 档位判定走后端 ModelTypeGuess（不在客户端抄一份规则）；拿不到就只是没有标注
              let types = {}
              try {
                const res = await fetch(`${adminBaseUrlInput.replace(/\/$/, '')}/api/v1/model/guess-types`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CORP_GATEWAY_TOKEN}` },
                  body: JSON.stringify({ models: r.models }),
                })
                if (res.ok) types = (await res.json()).results || {}
              } catch { /* 后端不可达 → 无标注，不影响选择 */ }
              return { models: r.models as string[], types }
            }}
          />
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
            <ModelPicker
              value={modelNameInput} onChange={setModelNameInput}
              fetchModels={fetchModelList} tiers={modelTiers}
              readyKey={baseUrlInput.trim()}
              placeholder="如 qwen2.5 / llama3.1"
              hint="本地部署无需 API Key。"
            />
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
              <div className="model-field">
                <label className="model-label">深度调研模型（可选）</label>
                <input className="settings-input" list="llm-model-options" value={researchModelInput} onChange={(e) => setResearchModelInput(e.target.value)} placeholder="如 deepseek-reasoner · 留空则跟随上面的默认模型" />
                <span className="model-hint">留空即自动：企业网关模式下按管理端「模型类型=推理档」的通道自动路由（未标注则用默认档）；此处手填则强制指定。</span>
              </div>
              <div className="model-field">
                <label className="model-label">上下文整理模型（可选）</label>
                <input className="settings-input" list="llm-model-options" value={summaryModelInput} onChange={(e) => setSummaryModelInput(e.target.value)} placeholder="留空则跟随上面的默认模型" />
                <span className="model-hint">长会话里早前轮次会被滚动折叠成要点摘要，这一步由该模型执行。摘要是纯提炼、不需要强推理，指一个便宜的快档模型即可省钱。</span>
              </div>
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
                <div className="model-field" style={{ width: 160 }}>
                  <label className="model-label">上下文窗口</label>
                  <input type="number" className="settings-input" min={1024} step={1024} value={contextWindowInput}
                    onChange={(e) => setContextWindowInput(e.target.value)} placeholder="128000" />
                </div>
              </div>
              <span className="model-hint">
                上下文窗口只影响输入框上那个占用圆环的百分比刻度，不改变实际请求。填成当前模型的真实窗口
                （如 64k 档填 64000、200k 档填 200000），留空按 128000 计——刻度不对会让「快满了」的提示要么虚惊、要么来不及。
              </span>
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
