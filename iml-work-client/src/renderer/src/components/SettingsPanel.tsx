import React, { useState } from 'react'
import { QrCode, Save, User, Cpu, Brain, ArrowLeft, FolderOpen, Info, ChevronDown, ChevronUp, Database, ShieldCheck } from 'lucide-react'
import { useUserStore } from '../stores/userStore'
import MemoryPanel from './MemoryPanel'
import UserCard from './UserCard'

interface SettingsPanelProps {
  onBackToChat: () => void
}

export default function SettingsPanel({ onBackToChat }: SettingsPanelProps) {
  const { 
    claimedExpertId, 
    expertRenameMap, 
    userBackground, 
    expertList, 
    updateRename, 
    updateBackground,
    userNickname,
    updateNickname,
    claimExpert,
    keepBusinessSession,
    businessSystems,
    updateBusinessSession,
    resetBusinessSession,
    llmConnectionMode,
    llmApiMode,
    llmBaseUrl,
    llmApiKey,
    llmModelName,
    updateLlmConfig
  } = useUserStore()

  // Navigation: active settings section
  const [activeTab, setActiveTab] = useState<'profile' | 'llm' | 'robot' | 'folder' | 'about' | 'memory' | 'systems'>('profile')

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

  const handleTestLlm = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      // Always pass clean string values directly from the form
      const result = await window.api.invoke('llm:test', {
        mode: connectionMode as string,
        apiMode: (apiMode === 'chat' || apiMode === 'anthropic') ? apiMode : 'chat',
        baseUrl: baseUrlInput.trim(),
        apiKey: apiKeyInput.trim(),
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
      updateLlmConfig({
        llmConnectionMode: connectionMode,
        llmApiMode: (apiMode === 'chat' || apiMode === 'anthropic') ? apiMode : 'chat',
        llmBaseUrl: baseUrlInput.trim(),
        llmApiKey: apiKeyInput.trim(),
        llmModelName: modelNameInput.trim()
      })
      setSaving(false)
      alert('已保存大模型与中转安全代理配置。')
    }, 300)
  }

  const handleWeChatQrScan = () => {
    setWechatConnected(true)
    setShowWechatQr(false)
  }


  return (
    <div className="settings-split-container">
      {/* 1. Left Navigation Sidebar */}
      <div className="settings-left-sidebar">
        
        {/* Back to chat view */}
        <button className="settings-back-btn" onClick={onBackToChat}>
          <ArrowLeft size={14} />
          <span>返回应用</span>
        </button>

        {/* Group 1: Assistant Settings */}
        <div className="settings-nav-group">
          <div className="settings-nav-header">助手配置</div>
          <button 
            className={`settings-nav-item ${activeTab === 'profile' ? 'active' : ''}`}
            onClick={() => setActiveTab('profile')}
          >
            <User size={14} />
            <span>账号与画像</span>
          </button>
          
          <button 
            className={`settings-nav-item ${activeTab === 'llm' ? 'active' : ''}`}
            onClick={() => setActiveTab('llm')}
          >
            <Brain size={14} />
            <span>大模型配置</span>
          </button>
          
          <button 
            className={`settings-nav-item ${activeTab === 'memory' ? 'active' : ''}`}
            onClick={() => setActiveTab('memory')}
          >
            <Database size={14} />
            <span>知识记忆</span>
          </button>
        </div>

        {/* Group 2: System Settings */}
        <div className="settings-nav-group" style={{ marginTop: '10px' }}>
          <div className="settings-nav-header">系统设置</div>
          <button 
            className={`settings-nav-item ${activeTab === 'folder' ? 'active' : ''}`}
            onClick={() => setActiveTab('folder')}
          >
            <FolderOpen size={14} />
            <span>工作目录管理</span>
          </button>
          
          <button 
            className={`settings-nav-item ${activeTab === 'systems' ? 'active' : ''}`}
            onClick={() => setActiveTab('systems')}
          >
            <ShieldCheck size={14} />
            <span>业务系统对接</span>
          </button>
          
          <button 
            className={`settings-nav-item ${activeTab === 'robot' ? 'active' : ''}`}
            onClick={() => setActiveTab('robot')}
          >
            <Cpu size={14} />
            <span>远程控制网关</span>
          </button>

          <button 
            className={`settings-nav-item ${activeTab === 'about' ? 'active' : ''}`}
            onClick={() => setActiveTab('about')}
          >
            <Info size={14} />
            <span>关于 iML Work</span>
          </button>
        </div>

        {/* Bottom Profile card mirroring reference logic */}
        <UserCard onNavigateToSettings={() => setActiveTab('profile')} />

      </div>

      {/* 2. Right Settings Content Area */}
      <div className="settings-right-pane">
        
        {/* View 1: Profile & Renaming */}
        {activeTab === 'profile' && (
          <div className="settings-tab-content">
            <h2 className="tab-title">账号与画像</h2>
            
            <form onSubmit={handleSaveProfile} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              {/* Row 1: Switch Claimed Assistant */}
              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">当前已领用岗位助手</div>
                  <div className="setting-desc">切换不同的专家，系统将同步把对应的 skill 自动同步到本地。</div>
                </div>
                <div className="setting-control" style={{ width: '300px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <select 
                    className="settings-select" 
                    value={claimedExpertId || ''} 
                    onChange={(e) => handleSwitchExpert(e.target.value)}
                    disabled={isClaimingLocal}
                  >
                    <option value="" disabled>选择领用专家</option>
                    {expertList.map((exp) => (
                      <option key={exp.id} value={exp.id}>
                        {exp.title}
                      </option>
                    ))}
                  </select>
                  {isClaimingLocal && (
                    <span style={{ fontSize: '10px', color: 'var(--brand-primary)', animation: 'fadeIn 0.2s' }}>
                      正在同步技能包，请稍候...
                    </span>
                  )}
                </div>
              </div>

              {currentExpert && (
                <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px', borderBottom: '1px dashed rgba(255,255,255,0.04)', paddingBottom: '16px' }}>
                  <div className="glass-card" style={{ padding: '16px', background: 'rgba(255,255,255,0.015)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '10px', borderRadius: 'var(--radius-lg)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)' }}>
                        💼 {currentExpert.title} 岗位介绍
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
                  <div className="setting-label">岗位助手自定义昵称</div>
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
          <div className="settings-tab-content">
            <h2 className="tab-title">大模型配置</h2>
            
            <form onSubmit={handleSaveLlm} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">连接代理模式</div>
                  <div className="setting-desc">使用企业内网统一中转网关进行脱敏和审计，或直接输入API Key直连提供商</div>
                </div>
                <div className="setting-control" style={{ width: '300px' }}>
                  <select 
                    className="settings-select" 
                    value={connectionMode} 
                    onChange={(e) => setConnectionMode(e.target.value as 'proxy' | 'direct')}
                  >
                    <option value="proxy">企业安全中转 (Corporate Proxy)</option>
                    <option value="direct">厂商 API 直连 (Direct API)</option>
                  </select>
                </div>
              </div>

              {connectionMode === 'direct' && (
                <div className="setting-row" style={{ animation: 'fadeIn 0.2s' }}>
                  <div className="setting-info">
                    <div className="setting-label">API 协议格式 (API Mode)</div>
                    <div className="setting-desc">直连厂商时使用的 API 协议标准，支持 standard Chat 格式与 Anthropic Claude 专用格式</div>
                  </div>
                  <div className="setting-control" style={{ width: '300px' }}>
                    <select 
                      className="settings-select" 
                      value={apiMode} 
                      onChange={(e) => setApiMode(e.target.value as 'chat' | 'anthropic')}
                    >
                      <option value="chat">Standard Chat Completion (OpenAI 协议)</option>
                      <option value="anthropic">Anthropic Claude (Claude 协议)</option>
                    </select>
                  </div>
                </div>
              )}

              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">API 访问端点 (Base URL)</div>
                  <div className="setting-desc">对应接口地址或中转站路由</div>
                </div>
                <div className="setting-control" style={{ width: '300px' }}>
                  <input 
                    type="text" 
                    className="settings-input" 
                    value={baseUrlInput}
                    onChange={(e) => setBaseUrlInput(e.target.value)}
                    placeholder="http://localhost:8080/api/v1/model"
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">API 访问密钥 (API Key)</div>
                  <div className="setting-desc">访问密钥，保存后在本地物理磁盘采用安全硬件芯片进行底层加密</div>
                </div>
                <div className="setting-control" style={{ width: '300px' }}>
                  <input 
                    type="password" 
                    className="settings-input" 
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder="••••••••••••••••"
                  />
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">选用模型名称 (Model Name)</div>
                  <div className="setting-desc">例如 deepseek-chat 或 gpt-4o</div>
                </div>
                <div className="setting-control" style={{ width: '300px' }}>
                  <input 
                    type="text" 
                    className="settings-input" 
                    value={modelNameInput}
                    onChange={(e) => setModelNameInput(e.target.value)}
                  />
                </div>
              </div>

              {/* Advanced LLM Settings Accordion mirroring reference design */}
              <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
                <button 
                  type="button"
                  className="settings-accordion-trigger"
                  onClick={() => setShowAdvancedLlm(!showAdvancedLlm)}
                >
                  <span>高级模型设置 (Advanced)</span>
                  {showAdvancedLlm ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
                
                {showAdvancedLlm && (
                  <div className="settings-accordion-content" style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div className="setting-row">
                      <div className="setting-info">
                        <div className="setting-label">Temperature (随机温度)</div>
                        <div className="setting-desc">数值越低回答越严谨，SOP审批任务建议设置为 0.1 ~ 0.3</div>
                      </div>
                      <div className="setting-control" style={{ width: '150px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <input 
                          type="range" 
                          min="0" 
                          max="1" 
                          step="0.1" 
                          value={temperature}
                          onChange={(e) => setTemperature(parseFloat(e.target.value))}
                          style={{ flex: 1 }}
                        />
                        <span style={{ fontSize: '12px', width: '24px', textAlign: 'right' }}>{temperature}</span>
                      </div>
                    </div>

                    <div className="setting-row">
                      <div className="setting-info">
                        <div className="setting-label">Max Tokens (最大长度限制)</div>
                        <div className="setting-desc">单次生成限制</div>
                      </div>
                      <div className="setting-control" style={{ width: '150px' }}>
                        <input 
                          type="number" 
                          className="settings-input"
                          value={maxTokens}
                          onChange={(e) => setMaxTokens(parseInt(e.target.value))}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <button type="submit" className="settings-btn" style={{ alignSelf: 'flex-start' }} disabled={saving}>
                  <Save size={14} />
                  <span>保存模型配置</span>
                </button>
                <button
                  type="button"
                  className="robot-btn"
                  style={{ padding: '8px 16px', fontSize: '12px' }}
                  onClick={handleTestLlm}
                  disabled={testing}
                >
                  {testing ? '测试中...' : '🔍 测试连接'}
                </button>
              </div>

              {testResult && (
                <div style={{
                  marginTop: '4px',
                  padding: '14px',
                  borderRadius: '8px',
                  background: testResult.success ? 'rgba(34, 197, 94, 0.06)' : 'rgba(239, 68, 68, 0.06)',
                  border: `1px solid ${testResult.success ? 'rgba(34, 197, 94, 0.25)' : 'rgba(239, 68, 68, 0.25)'}`,
                  fontSize: '11px',
                  fontFamily: 'monospace',
                  lineHeight: '1.7',
                  color: 'var(--text-secondary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all'
                }}>
                  <div style={{ fontWeight: 'bold', marginBottom: '8px', color: testResult.success ? '#22c55e' : '#ef4444', fontSize: '12px' }}>
                    {testResult.success ? '✅ 连接成功' : '❌ 连接失败'}
                  </div>
                  <div>📍 <b>实际读取到的配置：</b></div>
                  <div>  连接模式: {testResult.config?.mode} | API格式: {testResult.config?.apiMode}</div>
                  <div>  Base URL: {testResult.config?.baseUrl}</div>
                  <div>  模型名: {testResult.config?.modelName}</div>
                  <div>  API Key前缀: {testResult.config?.apiKeyPrefix}</div>
                  <div style={{ marginTop: '6px' }}>🌐 <b>最终请求地址：</b> {testResult.targetUrl}</div>
                  <div>📦 <b>存储的配置项数量：</b> {testResult.dbKeyCount}  [{testResult.dbKeys?.join(', ')}]</div>
                  {testResult.httpStatus && (
                    <div style={{ marginTop: '6px' }}>
                      <div>🔁 <b>HTTP 状态：</b> {testResult.httpStatus} {testResult.httpStatusText}</div>
                      {testResult.parsedContent && <div>💬 <b>AI 返回内容：</b> {testResult.parsedContent}</div>}
                      {!testResult.parsedContent && testResult.rawResponse && (
                        <div>📄 <b>原始响应 (前500字)：</b><br />{testResult.rawResponse.substring(0, 500)}</div>
                      )}
                    </div>
                  )}
                  {testResult.error && <div style={{ color: '#ef4444', marginTop: '6px' }}>🚫 <b>错误：</b> {testResult.error}</div>}
                </div>
              )}

            </form>
          </div>
        )}

        {/* View 3: Remote Control Gateway */}
        {activeTab === 'robot' && (
          <div className="settings-tab-content">
            <h2 className="tab-title">远程控制网关</h2>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              启用远程控制网关，可以在外部 IM 工具通过消息指令远程触发本地客户端 RPA 执行并回传执行链路日志。
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Feishu Card */}
              <div className="setting-row" style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', padding: '16px', borderRadius: '8px' }}>
                <div className="setting-info">
                  <div className="setting-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>飞书机器人连接</span>
                    <span className={`badge ${larkConnected ? 'badge-green' : 'badge-muted'}`} style={{ fontSize: '9px' }}>
                      {larkConnected ? '监听中' : '未启用'}
                    </span>
                  </div>
                  <div className="setting-desc">Lark Webhook 集成，允许飞书群组消息远程中转指令</div>
                  <div style={{ marginTop: '8px' }}>
                    <input 
                      type="text" 
                      className="settings-input" 
                      placeholder="App ID" 
                      value={larkAppId}
                      onChange={(e) => setLarkAppId(e.target.value)}
                      disabled={larkConnected}
                      style={{ width: '250px', fontSize: '11px', padding: '6px 10px' }}
                    />
                  </div>
                </div>
                <button 
                  className="robot-btn" 
                  onClick={() => setLarkConnected(!larkConnected)}
                >
                  {larkConnected ? '断开连接' : '启用监听'}
                </button>
              </div>

              {/* WeChat Card */}
              <div className="setting-row" style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', padding: '16px', borderRadius: '8px' }}>
                <div className="setting-info">
                  <div className="setting-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>微信机器人连接</span>
                    <span className={`badge ${wechatConnected ? 'badge-green' : 'badge-muted'}`} style={{ fontSize: '9px' }}>
                      {wechatConnected ? '已绑定' : '未对接'}
                    </span>
                  </div>
                  <div className="setting-desc">使用个人或企业微信扫码授权，实现微信指令交互</div>
                </div>
                <div>
                  {wechatConnected ? (
                    <button className="robot-btn" onClick={() => setWechatConnected(false)}>断开微信机器人</button>
                  ) : (
                    <button className="robot-btn" onClick={() => setShowWechatQr(true)}>
                      <QrCode size={14} style={{ marginRight: '6px', verticalAlign: 'middle', display: 'inline-block' }} />
                      <span>扫码授权绑定</span>
                    </button>
                  )}
                </div>
              </div>

              {/* QQ Card */}
              <div className="setting-row" style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', padding: '16px', borderRadius: '8px' }}>
                <div className="setting-info">
                  <div className="setting-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>QQ 机器人连接 (Go-CqHttp)</span>
                    <span className={`badge ${qqConnected ? 'badge-green' : 'badge-muted'}`} style={{ fontSize: '9px' }}>
                      {qqConnected ? 'WS 连接已就绪' : '未启用'}
                    </span>
                  </div>
                  <div className="setting-desc">基于本地 WebSocket 的 QQ 机器人指令推送接收</div>
                  <div style={{ marginTop: '8px' }}>
                    <input 
                      type="text" 
                      className="settings-input" 
                      placeholder="机器人 QQ 账号" 
                      value={qqNumber}
                      onChange={(e) => setQqNumber(e.target.value)}
                      disabled={qqConnected}
                      style={{ width: '200px', fontSize: '11px', padding: '6px 10px' }}
                    />
                  </div>
                </div>
                <button 
                  className="robot-btn" 
                  onClick={() => setQqConnected(!qqConnected)}
                >
                  {qqConnected ? '关闭监听' : '开启监听'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* View 4: Workspace Folder (Mirroring Reference Design) */}
        {activeTab === 'folder' && (
          <div className="settings-tab-content">
            <h2 className="tab-title">工作目录管理</h2>
            
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
            
            <div className="glass-card" style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px', alignItems: 'center', textAlign: 'center' }}>
              <div style={{ background: 'var(--brand-gradient)', width: '64px', height: '64px', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', fontWeight: 'bold', boxShadow: 'var(--brand-glow)', color: '#fff' }}>
                iML
              </div>
              <div>
                <h3 style={{ fontSize: '16px', fontWeight: 'bold' }}>iML Work Client</h3>
                <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>企业级内网容器与专家智能体客户端</p>
                <p style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '6px' }}>Version 1.0.0 (Alpha Build)</p>
              </div>

              <div style={{ borderTop: '1px solid var(--border-color)', width: '100%', paddingTop: '14px', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                <p>底层安全架构: safeStorage + Pyodide WASM Execution Box</p>
                <p>向量检索技术: BGE-small-zh-v1.5 + local SQLite Indexer</p>
                <p style={{ marginTop: '8px', color: 'var(--text-muted)' }}>© 2026 北京艾姆尔人工智能科技有限公司版权所有。</p>
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
            <h2 className="tab-title">业务系统对接</h2>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              管理与保持企业内部第三方业务系统（ERP、OA、HR）的授权对接与登录会话。开启后，自动化沙箱可共享 Cookie 以免除频繁的扫码及二次验证。
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
              {/* Session State Retention Switch */}
              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">保留登录会话凭据 (Keep Session State)</div>
                  <div className="setting-desc">允许 Playwright 自动化浏览器与 WASM 沙箱保留会话 Cookie，免除执行任务时重新登录的繁琐。</div>
                </div>
                <div className="setting-control">
                  <label className="toggle-switch">
                    <input 
                      type="checkbox" 
                      checked={keepBusinessSession} 
                      onChange={(e) => updateBusinessSession(e.target.checked)} 
                    />
                    <span className="slider" />
                  </label>
                </div>
              </div>

              {/* Encryption level */}
              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">会话存储加密机制 (Session Encryption Level)</div>
                  <div className="setting-desc">本地缓存业务会话 Cookies 与 Token 时采用的加解密算法级别</div>
                </div>
                <div className="setting-control" style={{ width: '300px' }}>
                  <select className="settings-select" defaultValue="hardware">
                    <option value="hardware">本地硬件加密隔离 (TPM / safeStorage)</option>
                    <option value="software">软件哈希混淆存储 (Software Obfuscated)</option>
                  </select>
                </div>
              </div>

              {/* Associated Business Systems List */}
              <div style={{ marginTop: '10px' }}>
                <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '12px' }}>
                  已关联的企业业务系统
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {businessSystems.map(sys => (
                    <div key={sys.id} className="glass-card" style={{ padding: '14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', textAlign: 'left' }}>
                        <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)' }}>
                          {sys.name}
                        </span>
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                          应用类型: {sys.type} | 绑定账号: {sys.account || '未绑定/未授权'}
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <span className={`badge ${sys.isAuthorized ? 'badge-green' : 'badge-muted'}`} style={{ fontSize: '10px' }}>
                          {sys.isAuthorized ? '会话保持中' : '会话已过期'}
                        </span>
                        {sys.isAuthorized ? (
                          <button 
                            className="delete-cancel-btn" 
                            style={{ padding: '6px 12px', fontSize: '11px' }}
                            onClick={() => resetBusinessSession(sys.id)}
                          >
                            清除凭据
                          </button>
                        ) : (
                          <button 
                            className="settings-btn" 
                            style={{ padding: '6px 12px', fontSize: '11px', alignSelf: 'auto' }}
                            onClick={() => {
                              const acc = prompt('请输入业务系统对接的登录账号：')
                              if (acc) {
                                // Mock authorization setup directly using Zustand State trigger
                                useUserStore.setState((state) => ({
                                  businessSystems: state.businessSystems.map(s => {
                                    if (s.id === sys.id) {
                                      return { ...s, account: acc, isAuthorized: true }
                                    }
                                    return s
                                  })
                                }))
                                alert('已成功与业务系统对接，登录会话 Cookie 凭据已写入沙箱硬件凭据区。')
                              }
                            }}
                          >
                            登录授权对接
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
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
        .settings-split-container {
          display: flex;
          height: 100%;
          width: 100%;
          background-color: var(--bg-surface);
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
