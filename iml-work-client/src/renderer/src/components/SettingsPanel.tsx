import React, { useState } from 'react'
import {
  QrCode, Save, User, Cpu, Brain, FolderOpen, Info, ChevronDown, ChevronUp, Database, ShieldCheck,
  Send, MessageCircle, MessagesSquare, Building2, Users, Server, Cloud, HardDrive, Boxes, Check, Github,
  FileCheck2, ReceiptText, Sparkles, Moon, Settings2, RefreshCw
} from 'lucide-react'
import { useUserStore } from '../stores/userStore'
import MemoryPanel from './MemoryPanel'
import logoMark from '../assets/brand/logo-mark.svg'

type SettingsTab = 'profile' | 'llm' | 'robot' | 'folder' | 'about' | 'memory' | 'systems'

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

interface SettingsPanelProps {
  onBackToChat: () => void
  initialTab?: SettingsTab
}

export default function SettingsPanel({ initialTab }: SettingsPanelProps) {
  const { 
    claimedExpertId, 
    expertRenameMap, 
    userBackground, 
    expertList, 
    updateRename,
    fetchExperts,
    isLoadingExperts,
    updateBackground,
    userNickname,
    updateNickname,
    claimExpert,
    keepBusinessSession,
    updateBusinessSession,
    llmConnectionMode,
    llmApiMode,
    llmBaseUrl,
    llmApiKey,
    llmModelName,
    updateLlmConfig
  } = useUserStore()

  // Navigation: active settings section
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab || 'profile')

  // Local state for forms
  const [bgInput, setBgInput] = useState(userBackground)
  const [nicknameInput, setNicknameInput] = useState(userNickname)
  const currentExpert = expertList.find(e => e.id === claimedExpertId)
  const [renameInput, setRenameInput] = useState(
    claimedExpertId ? (expertRenameMap[claimedExpertId] || currentExpert?.title || '') : ''
  )
  const [connectionMode, setConnectionMode] = useState<'proxy' | 'direct'>(llmConnectionMode)
  const [apiMode, setApiMode] = useState<'chat' | 'anthropic'>(llmApiMode)
  const [baseUrlInput, setBaseUrlInput] = useState(llmBaseUrl)
  const [apiKeyInput, setApiKeyInput] = useState(llmApiKey)
  const [modelNameInput, setModelNameInput] = useState(llmModelName)
  // Admin backend root — used for expert claim, corporate RAG retrieval and file sync.
  const [adminBaseUrlInput, setAdminBaseUrlInput] = useState('http://localhost:8080')
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
    window.api.invoke('db:config-get-all').then((configs: any) => {
      if (configs && typeof configs['adminBaseUrl'] === 'string' && configs['adminBaseUrl']) {
        setAdminBaseUrlInput(configs['adminBaseUrl'])
      }
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

  // Local folder config
  const [workDir, setWorkDir] = useState('/Users/imoling/Documents/iML Work Workspace')
  const [autoStart, setAutoStart] = useState(true)
  const [showFloatBall, setShowFloatBall] = useState(false)

  // Remote IM Gateway states
  const [larkConnected, setLarkConnected] = useState(false)
  const [larkAppId, setLarkAppId] = useState('cli_a1b2c3d4e5f6g7')
  const [wechatConnected, setWechatConnected] = useState(false)
  const [showWechatQr, setShowWechatQr] = useState(false)
  const [qqConnected, setQqConnected] = useState(false)
  const [qqNumber, setQqNumber] = useState('2849502934')

  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)
  const [testing, setTesting] = useState(false)

  // 企业业务系统连接：从管理端拉取系统清单，在本地完成个人登录。
  interface BizSystem { id: string; type: string; name: string; baseUrl: string; status: string; linked: boolean }
  const [bizSystems, setBizSystems] = useState<BizSystem[]>([])
  const [bizAdminUrl, setBizAdminUrl] = useState('')
  const [bizLoading, setBizLoading] = useState(false)
  const [bizStatus, setBizStatus] = useState<Record<string, 'unknown' | 'checking' | 'logged-in' | 'logged-out'>>({})
  // 登录保活心跳状态（主进程常驻运行）
  const [hb, setHb] = useState<{ enabled: boolean; busy: boolean; lastAt: string; online: number; total: number }>({ enabled: true, busy: false, lastAt: '', online: 0, total: 0 })

  const loadBizSystems = async () => {
    setBizLoading(true)
    try {
      const r = await window.api.invoke('systems:list')
      if (r?.ok) {
        setBizSystems(r.systems || [])
        setBizAdminUrl(r.adminBaseUrl || '')
        const m: Record<string, any> = {}
        ;(r.systems || []).forEach((s: BizSystem) => { m[s.id] = s.linked ? 'logged-in' : 'unknown' })
        setBizStatus(m)
      } else {
        setBizSystems([])
      }
    } catch (_) { setBizSystems([]) }
    setBizLoading(false)
  }

  React.useEffect(() => { loadBizSystems() }, [])
  React.useEffect(() => {
    window.api.invoke('systems:heartbeat-get').then((s: any) => { if (s) setHb(s) }).catch(() => {})
    const un = window.api.on('systems:heartbeat', (s: any) => { setHb(s); if (s && !s.busy) loadBizSystems() })
    return un
  }, [])
  const toggleHb = async () => { const s = await window.api.invoke('systems:heartbeat-set', !hb.enabled); if (s) setHb(s) }
  const hbNow = async () => { await window.api.invoke('systems:heartbeat-now') }

  const bizLogin = async (sys: BizSystem) => {
    setBizStatus(s => ({ ...s, [sys.id]: 'checking' }))
    await window.api.invoke('systems:login', { systemId: sys.id, baseUrl: sys.baseUrl })
    const c = await window.api.invoke('systems:check', { systemId: sys.id, baseUrl: sys.baseUrl })
    setBizStatus(s => ({ ...s, [sys.id]: c?.loggedIn ? 'logged-in' : 'logged-out' }))
  }
  const bizCheck = async (sys: BizSystem) => {
    setBizStatus(s => ({ ...s, [sys.id]: 'checking' }))
    const c = await window.api.invoke('systems:check', { systemId: sys.id, baseUrl: sys.baseUrl })
    setBizStatus(s => ({ ...s, [sys.id]: c?.loggedIn ? 'logged-in' : 'logged-out' }))
  }
  const bizLogout = async (sys: BizSystem) => {
    await window.api.invoke('systems:logout', { systemId: sys.id })
    setBizStatus(s => ({ ...s, [sys.id]: 'logged-out' }))
  }

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

  // Local state for switching claimed assistant
  const [isClaimingLocal, setIsClaimingLocal] = useState(false)
  
  const handleSwitchExpert = async (newExpertId: string) => {
    if (newExpertId === claimedExpertId) return
    setIsClaimingLocal(true)
    const success = await claimExpert(newExpertId)
    setIsClaimingLocal(false)
    if (success) {
      const target = expertList.find(e => e.id === newExpertId)
      setRenameInput(expertRenameMap[newExpertId] || target?.title || '')
      alert(`已成功切换并下载加载岗位助手: ${target?.title}`)
    } else {
      alert('切换岗位助手失败，请检查网络或配置。')
    }
  }

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setTimeout(() => {
      updateBackground(bgInput)
      updateNickname(nicknameInput)
      if (claimedExpertId && renameInput.trim()) {
        updateRename(claimedExpertId, renameInput.trim())
      }
      setSaving(false)
      alert('已成功保存您的画像背景、昵称与助手配置。')
    }, 500)
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

  const handleWeChatQrScan = () => {
    setWechatConnected(true)
    setShowWechatQr(false)
  }


  const settingsTabs: { key: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { key: 'profile', label: '账号与画像', icon: <User size={14} /> },
    { key: 'llm', label: '模型服务', icon: <Brain size={14} /> },
    { key: 'memory', label: '资料与记忆', icon: <Database size={14} /> },
    { key: 'folder', label: '工作空间', icon: <FolderOpen size={14} /> },
    { key: 'systems', label: '企业系统连接', icon: <ShieldCheck size={14} /> },
    { key: 'robot', label: '远程执行通道', icon: <Cpu size={14} /> },
    { key: 'about', label: '关于', icon: <Info size={14} /> },
  ]

  return (
    <div className="settings-page">
      {/* Horizontal tab bar (single sidebar = the app sidebar) */}
      <div className="settings-tabbar">
        {settingsTabs.map((t) => (
          <button
            key={t.key}
            className={`settings-tab ${activeTab === t.key ? 'active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Settings Content Area */}
      <div className="settings-right-pane">
        
        {/* View 1: Profile & Renaming */}
        {activeTab === 'profile' && (
          <div className="settings-tab-content">
            <h2 className="tab-title">账号与画像</h2>
            
            <form onSubmit={handleSaveProfile} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              {/* Row 1: Switch the active work avatar (分身) */}
              <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
                <div className="setting-info" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                  <div>
                    <div className="setting-label">当前工作分身</div>
                    <div className="setting-desc">切换工作分身，系统会把对应的业务技能自动同步到本地安全环境。</div>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => fetchExperts()}
                    disabled={isLoadingExperts}
                    title="从企业管理端同步最新岗位"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', flexShrink: 0, whiteSpace: 'nowrap' }}
                  >
                    <RefreshCw size={13} className={isLoadingExperts ? 'spin' : ''} />
                    <span>{isLoadingExperts ? '同步中…' : '同步岗位'}</span>
                  </button>
                </div>
                <div className="agent-switch-grid">
                  {expertList.map((exp) => {
                    const Icon = exp.id === 'expert-1' ? FileCheck2 : exp.id === 'expert-2' ? ReceiptText : exp.id === 'expert-3' ? Database : Boxes
                    const active = claimedExpertId === exp.id
                    return (
                      <button
                        type="button"
                        key={exp.id}
                        className={`agent-switch-card ${active ? 'selected' : ''}`}
                        onClick={() => handleSwitchExpert(exp.id)}
                        disabled={isClaimingLocal}
                      >
                        <div className="claim-ic"><Icon size={18} /></div>
                        <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                          <div className="agent-switch-name">{exp.title}</div>
                          <div className="agent-switch-sub">{exp.skills?.length || 0} 项业务技能</div>
                        </div>
                        {active && <Check size={16} color="var(--brand-primary)" style={{ flexShrink: 0 }} />}
                      </button>
                    )
                  })}
                </div>
                {isClaimingLocal && (
                  <span style={{ fontSize: '11px', color: 'var(--brand-primary)' }}>正在同步工作分身技能…</span>
                )}
              </div>

              {currentExpert && (
                <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px', borderBottom: '1px dashed rgba(255,255,255,0.04)', paddingBottom: '16px' }}>
                  <div className="glass-card" style={{ padding: '16px', background: 'rgba(255,255,255,0.015)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '10px', borderRadius: 'var(--radius-lg)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)' }}>
                        {currentExpert.title} · 岗位职责
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.6', textAlign: 'left' }}>
                      {currentExpert.description}
                    </div>
                    {currentExpert.skills && currentExpert.skills.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', borderTop: '1px dashed var(--border-color)', paddingTop: '10px' }}>
                        {currentExpert.skills.map(sk => (
                          <span key={sk.id} style={{ fontSize: '10px', background: 'rgba(59, 130, 246, 0.04)', border: '1px solid rgba(59, 130, 246, 0.15)', color: 'var(--brand-primary)', padding: '2px 8px', borderRadius: 'var(--radius-full)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            ⚡ {sk.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Row 2: Rename Assistant */}
              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">工作分身自定义昵称</div>
                  <div className="setting-desc">您可以为当前领用的专家起一个个性化的名字。</div>
                </div>
                <div className="setting-control" style={{ width: '300px' }}>
                  {claimedExpertId ? (
                    <input 
                      type="text" 
                      className="settings-input" 
                      value={renameInput}
                      onChange={(e) => setRenameInput(e.target.value)}
                      placeholder="自定义昵称，如：小审批"
                    />
                  ) : (
                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>请先领用一个助手</span>
                  )}
                </div>
              </div>

              {/* Row 3: How to Address You */}
              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">助手对您的称呼</div>
                  <div className="setting-desc">设置助手在对话中应该如何称呼您。</div>
                </div>
                <div className="setting-control" style={{ width: '300px' }}>
                  <input 
                    type="text" 
                    className="settings-input" 
                    value={nicknameInput}
                    onChange={(e) => setNicknameInput(e.target.value)}
                    placeholder="例如：张经理、老张"
                  />
                </div>
              </div>

              {/* Row 4: Background Context */}
              <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
                <div className="setting-info">
                  <div className="setting-label">员工背景画像 (User Background Context)</div>
                  <div className="setting-desc">
                    详细背景将作为系统级 Context 注入安全沙箱，以便助手更智能地理解表单申报需求。
                  </div>
                </div>
                <textarea 
                  className="settings-input" 
                  style={{ minHeight: '120px', resize: 'vertical', fontFamily: 'inherit' }}
                  value={bgInput}
                  onChange={(e) => setBgInput(e.target.value)}
                  placeholder="请输入您的职责范围、偏好及出差报销常用格式，例如：主要负责华东大区，报销抬头使用分公司抬头。"
                />
              </div>

              <button type="submit" className="settings-btn" style={{ alignSelf: 'flex-start' }} disabled={saving}>
                <Save size={14} />
                <span>保存账号画像</span>
              </button>
            </form>
          </div>
        )}

        {/* View 2: LLM Configuration */}
        {activeTab === 'llm' && (
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
        )}

        {/* View 3: Remote Control Gateway */}
        {activeTab === 'robot' && (
          <div className="settings-tab-content">
            <h2 className="tab-title">远程执行通道</h2>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              启用远程执行通道，可以在外部 IM 工具通过消息指令远程触发本地客户端 RPA 执行并回传执行链路日志。
            </p>

            <div className="svc-grid">
              {/* 飞书 */}
              <div className="svc-card">
                <div className="svc-head">
                  <div className="svc-ic"><Send size={18} /></div>
                  <div style={{ flex: 1 }}>
                    <div className="svc-name">飞书机器人</div>
                    <div className="svc-type">Lark Webhook</div>
                  </div>
                  <span className={`pill ${larkConnected ? 'pill-mint' : 'pill-gray'}`}><span className="pill-dot" />{larkConnected ? '已启用' : '未启用'}</span>
                </div>
                <div className="svc-meta">允许飞书群组消息远程中转指令，回传执行链路日志。</div>
                <input className="settings-input" placeholder="App ID" value={larkAppId}
                  onChange={(e) => setLarkAppId(e.target.value)} disabled={larkConnected}
                  style={{ marginTop: 12, width: '100%', fontSize: 12 }} />
                <div className="svc-actions">
                  <button className={larkConnected ? 'btn-secondary' : 'settings-btn'} style={{ flex: 1 }} onClick={() => setLarkConnected(!larkConnected)}>
                    {larkConnected ? '断开连接' : '启用监听'}
                  </button>
                </div>
              </div>

              {/* 微信 */}
              <div className="svc-card">
                <div className="svc-head">
                  <div className="svc-ic"><MessageCircle size={18} /></div>
                  <div style={{ flex: 1 }}>
                    <div className="svc-name">微信机器人</div>
                    <div className="svc-type">扫码授权</div>
                  </div>
                  <span className={`pill ${wechatConnected ? 'pill-mint' : 'pill-amber'}`}><span className="pill-dot" />{wechatConnected ? '已授权' : '未授权'}</span>
                </div>
                <div className="svc-meta">使用个人或企业微信扫码授权，实现微信指令交互。</div>
                <div className="svc-actions">
                  {wechatConnected ? (
                    <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setWechatConnected(false)}>断开绑定</button>
                  ) : (
                    <button className="settings-btn" style={{ flex: 1 }} onClick={() => setShowWechatQr(true)}><QrCode size={14} />扫码授权</button>
                  )}
                </div>
              </div>

              {/* QQ */}
              <div className="svc-card">
                <div className="svc-head">
                  <div className="svc-ic"><MessagesSquare size={18} /></div>
                  <div style={{ flex: 1 }}>
                    <div className="svc-name">QQ 机器人</div>
                    <div className="svc-type">Go-CqHttp · WS</div>
                  </div>
                  <span className={`pill ${qqConnected ? 'pill-mint' : 'pill-gray'}`}><span className="pill-dot" />{qqConnected ? '已启用' : '未启用'}</span>
                </div>
                <div className="svc-meta">基于本地 WebSocket 的 QQ 机器人指令推送接收。</div>
                <input className="settings-input" placeholder="机器人 QQ 账号" value={qqNumber}
                  onChange={(e) => setQqNumber(e.target.value)} disabled={qqConnected}
                  style={{ marginTop: 12, width: '100%', fontSize: 12 }} />
                <div className="svc-actions">
                  <button className={qqConnected ? 'btn-secondary' : 'settings-btn'} style={{ flex: 1 }} onClick={() => setQqConnected(!qqConnected)}>
                    {qqConnected ? '关闭监听' : '开启监听'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* View 4: Workspace Folder (Mirroring Reference Design) */}
        {activeTab === 'folder' && (
          <div className="settings-tab-content">
            <h2 className="tab-title">工作空间</h2>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div className="setting-row">
                <div className="setting-info" style={{ flex: 1 }}>
                  <div className="setting-label">本地数据监听工作目录 (Workspace Directory)</div>
                  <div className="setting-desc">
                    iML Work 监听该目录物理变化，自动切片分块、向量化索引，并将其差量备份至企业云端。
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', padding: '8px 12px', borderRadius: '6px', color: 'var(--text-secondary)', fontFamily: 'monospace', marginTop: '10px' }}>
                    📂 {workDir}
                  </div>
                </div>
                <button 
                  type="button" 
                  className="robot-btn" 
                  onClick={() => {
                    const next = prompt('请输入要监听的工作空间绝对路径：', workDir)
                    if (next) setWorkDir(next)
                  }}
                  style={{ height: 'fit-content' }}
                >
                  修改目录
                </button>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">开机自动启动</div>
                  <div className="setting-desc">登录操作系统后，自动后台静默打开并加载 iML Work 本地沙箱</div>
                </div>
                <div className="setting-control">
                  <label className="toggle-switch">
                    <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} />
                    <span className="slider" />
                  </label>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">显示悬浮球 (Desktop Float Overlay)</div>
                  <div className="setting-desc">在桌面边缘显示快捷截图、快速提问和日志查看悬浮球</div>
                </div>
                <div className="setting-control">
                  <label className="toggle-switch">
                    <input type="checkbox" checked={showFloatBall} onChange={(e) => setShowFloatBall(e.target.checked)} />
                    <span className="slider" />
                  </label>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* View 5: About iML Work */}
        {activeTab === 'about' && (
          <div className="settings-tab-content">
            <h2 className="tab-title">关于 iML Work</h2>
            
            <div className="glass-card" style={{ padding: '28px', display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center', textAlign: 'center', maxWidth: 420 }}>
              <img src={logoMark} alt="iML Work" style={{ height: 72, width: 'auto' }} />
              <div>
                <h3 style={{ fontSize: '20px', fontWeight: 800, letterSpacing: '-0.5px' }}>
                  <span style={{ color: 'var(--text-primary)' }}>iML</span> <span style={{ color: 'var(--brand-primary)' }}>Work</span>
                </h3>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '6px' }}>你的工作分身，安全连接企业流程。</p>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '8px' }}>Version 1.0.0 Alpha</p>
              </div>

              <div style={{ borderTop: '1px solid var(--border-color)', width: '100%', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {['本地安全环境', '企业系统连接', '业务技能执行', '执行记录沉淀'].map(t => (
                  <div key={t} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--brand-primary)' }} />{t}
                  </div>
                ))}
                <button
                  className="btn-secondary"
                  style={{ marginTop: 14, alignSelf: 'center' }}
                  onClick={() => window.api.invoke('window:open-url', 'https://github.com/imoling/iml-work')}
                >
                  <Github size={14} />github.com/imoling/iml-work
                </button>
                <p style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>iML Studio · 由个人开发者 imoling 打造 · © 2026</p>
              </div>
            </div>
          </div>
        )}

        {/* View 6: Knowledge Memory */}
        {activeTab === 'memory' && (
          <div className="settings-tab-content" style={{ maxWidth: '100%' }}>
            <MemoryPanel />
          </div>
        )}

        {/* View 7: Business Systems Integration */}
        {activeTab === 'systems' && (
          <div className="settings-tab-content" style={{ maxWidth: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <h2 className="tab-title">企业系统连接</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }} title="开启后每 4 分钟在本地登录态分区静默访问一次，刷新会话有效期、检测掉线">
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: !hb.enabled ? '#9ca3af' : hb.busy ? '#d97706' : '#16a34a' }} />
                  登录保活：<a style={{ cursor: 'pointer', color: 'var(--accent, #16a34a)' }} onClick={toggleHb}>{hb.enabled ? '开' : '关'}</a>
                  {hb.enabled ? (hb.busy ? ' · 保活中' : hb.lastAt ? ` · 在线 ${hb.online}/${hb.total} · ${hb.lastAt}` : ' · 待心跳') : ''}
                </span>
                <button className="btn-secondary" onClick={hbNow} disabled={hb.busy}>立即保活</button>
                <button className="btn-secondary" onClick={loadBizSystems} disabled={bizLoading}>
                  {bizLoading ? '加载中…' : '刷新系统'}
                </button>
              </div>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              下列业务系统由企业管理端统一定义（来源：{bizAdminUrl || '管理端'}）。请在此完成你的个人登录——登录态会按系统隔离保存在本地，供工作分身执行技能时直接复用，无需重复登录。
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {!bizLoading && bizSystems.length === 0 && (
                <div className="svc-card" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  未从管理端获取到业务系统。请确认管理端「业务系统连接」已定义系统，且服务地址（设置 → 模型服务 → 高级设置 → 企业网关地址）可访问。
                </div>
              )}

              <div className="svc-grid">
                {bizSystems.map(sys => {
                  const Icon = sys.type === 'OA' ? Building2 : sys.type === 'ERP' ? Server
                    : sys.type === 'GITHUB' ? Github : sys.type === 'EMAIL' ? MessageCircle
                    : sys.type === 'CRM' ? Users : Boxes
                  const st = bizStatus[sys.id] || 'unknown'
                  const pill = st === 'logged-in' ? { cls: 'pill-mint', txt: '已登录' }
                    : st === 'logged-out' ? { cls: 'pill-amber', txt: '未登录' }
                    : st === 'checking' ? { cls: 'pill-gray', txt: '检测中…' }
                    : { cls: 'pill-gray', txt: '未检测' }
                  return (
                    <div key={sys.id} className="svc-card">
                      <div className="svc-head">
                        <div className="svc-ic"><Icon size={18} /></div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="svc-name">{sys.name}</div>
                          <div className="svc-type">{sys.type} · 管理端定义</div>
                        </div>
                        <span className={`pill ${pill.cls}`}><span className="pill-dot" />{pill.txt}</span>
                      </div>
                      <div className="svc-meta" style={{ wordBreak: 'break-all' }}>系统地址：{sys.baseUrl}</div>
                      <div className="svc-actions">
                        <button className="settings-btn" style={{ flex: 1 }} onClick={() => bizLogin(sys)} disabled={st === 'checking'}>
                          {st === 'logged-in' ? '重新登录' : '登录'}
                        </button>
                        <button className="btn-secondary" onClick={() => bizCheck(sys)} disabled={st === 'checking'}>检测</button>
                        {st === 'logged-in' && (
                          <button className="btn-secondary" onClick={() => bizLogout(sys)}>退出</button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="setting-row" style={{ marginTop: 4 }}>
                <div className="setting-info">
                  <div className="setting-label">保留登录会话</div>
                  <div className="setting-desc">开启后，登录态在本地按系统隔离持久保存，技能执行时直接复用，无需每次重新登录。</div>
                </div>
                <div className="setting-control">
                  <label className="toggle-switch">
                    <input type="checkbox" checked={keepBusinessSession} onChange={(e) => updateBusinessSession(e.target.checked)} />
                    <span className="slider" />
                  </label>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* WeChat QR Scan Modal */}
      {showWechatQr && (
        <div className="wechat-qr-modal" onClick={() => setShowWechatQr(false)}>
          <div className="wechat-qr-box" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ fontSize: '14px', fontWeight: 'bold' }}>微信扫码授权绑定</h3>
            <p style={{ fontSize: '11px', color: 'var(--text-secondary)', textAlign: 'center' }}>
              请使用企业微信或个人微信扫描下方模拟二维码授权机器人代收指令：
            </p>
            
            <div 
              className="qr-placeholder" 
              onClick={handleWeChatQrScan}
              title="点击模拟扫码成功"
            >
              <div style={{ padding: '10px', border: '1px solid #000', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <QrCode size={100} color="#000" />
                <span style={{ fontSize: '9px', marginTop: '6px', color: '#666' }}>[ 点击模拟扫码 ]</span>
              </div>
            </div>

            <button 
              className="delete-cancel-btn" 
              style={{ width: '100%' }}
              onClick={() => setShowWechatQr(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Custom Styles for Double-Column Layout */}
      <style>{`
        .settings-page {
          display: flex;
          flex-direction: column;
          height: 100%;
          width: 100%;
          background-color: var(--bg-deep);
        }
        .settings-tabbar {
          display: flex;
          gap: 2px;
          padding: 10px 24px 0;
          border-bottom: 1px solid var(--border-color);
          background: var(--bg-surface);
          overflow-x: auto;
          flex-shrink: 0;
        }
        .settings-tab {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 10px 14px;
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          color: var(--text-secondary);
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          white-space: nowrap;
          transition: color var(--transition-fast), border-color var(--transition-fast);
        }
        .settings-tab:hover { color: var(--text-primary); }
        .settings-tab.active {
          color: var(--brand-primary);
          border-bottom-color: var(--brand-primary);
          font-weight: 600;
        }
        .settings-left-sidebar {
          width: 220px;
          border-right: 1px solid var(--border-color);
          background-color: rgba(15, 23, 42, 0.25);
          padding: 16px 12px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          flex-shrink: 0;
        }
        .settings-back-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 14px;
          width: 100%;
          background: transparent;
          border: 1px solid var(--border-color);
          border-radius: var(--radius-md);
          color: var(--text-primary);
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: background var(--transition-fast);
        }
        .settings-back-btn:hover {
          background: var(--bg-hover);
        }
        .settings-nav-group {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .settings-nav-header {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          color: var(--text-muted);
          padding: 4px 12px;
          letter-spacing: 0.5px;
        }
        .settings-nav-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          background: transparent;
          border: none;
          color: var(--text-secondary);
          font-size: 13px;
          font-weight: 500;
          border-radius: var(--radius-md);
          cursor: pointer;
          text-align: left;
          width: 100%;
          transition: all var(--transition-fast);
        }
        .settings-nav-item:hover {
          background-color: var(--bg-hover);
          color: var(--text-primary);
        }
        .settings-nav-item.active {
          background-color: var(--bg-active);
          color: var(--text-primary);
          font-weight: 600;
        }
        
        .settings-user-card {
          margin-top: auto;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid var(--border-color);
          padding: 10px;
          border-radius: var(--radius-md);
        }
        .settings-user-avatar {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: var(--brand-gradient);
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          font-size: 13px;
        }
        .settings-user-name {
          font-size: 12px;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .settings-user-phone {
          font-size: 10px;
          color: var(--text-muted);
        }
        .settings-logout-btn {
          background: transparent;
          border: none;
          color: var(--accent-red);
          cursor: pointer;
          opacity: 0.8;
          transition: opacity 0.15s;
        }
        .settings-logout-btn:hover {
          opacity: 1;
        }

        .settings-right-pane {
          flex: 1;
          padding: 30px;
          overflow-y: auto;
        }
        .settings-tab-content {
          max-width: 700px;
          display: flex;
          flex-direction: column;
          gap: 20px;
          animation: fadeIn 0.2s ease;
        }
        .tab-title {
          font-size: 18px;
          font-weight: 700;
          border-bottom: 1px solid var(--border-color);
          padding-bottom: 10px;
        }
        
        /* Spaced settings rows mirroring reference style */
        .setting-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 16px;
          border-bottom: 1px dashed rgba(255, 255, 255, 0.04);
        }
        .setting-info {
          display: flex;
          flex-direction: column;
          gap: 4px;
          max-width: 420px;
        }
        .setting-label {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
        }
        .setting-desc {
          font-size: 11px;
          color: var(--text-secondary);
          line-height: 1.4;
        }
        
        .settings-accordion-trigger {
          width: 100%;
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 0;
          background: transparent;
          border: none;
          color: var(--brand-primary);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        
        /* Toggle Switch */
        .toggle-switch {
          position: relative;
          display: inline-block;
          width: 38px;
          height: 20px;
        }
        .toggle-switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }
        .toggle-switch .slider {
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: var(--bg-hover);
          transition: .3s;
          border-radius: 20px;
          border: 1px solid var(--border-color);
        }
        .toggle-switch .slider:before {
          position: absolute;
          content: "";
          height: 14px;
          width: 14px;
          left: 2px;
          bottom: 2px;
          background-color: var(--text-secondary);
          transition: .3s;
          border-radius: 50%;
        }
        .toggle-switch input:checked + .slider {
          background-color: var(--brand-primary);
          border-color: var(--brand-primary);
        }
        .toggle-switch input:checked + .slider:before {
          transform: translateX(18px);
          background-color: #fff;
        }
        
        .badge-muted {
          background-color: rgba(255,255,255,0.04);
          color: var(--text-muted);
          border: 1px solid var(--border-color);
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
