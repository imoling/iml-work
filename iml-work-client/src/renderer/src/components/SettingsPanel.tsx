import React, { useState } from 'react'
import {
  Save, User, Cpu, Brain, FolderOpen, Info, ChevronDown, ChevronUp, Database, ShieldCheck,
  Boxes, Check, FileCheck2, ReceiptText, RefreshCw
} from 'lucide-react'
import { useUserStore } from '../stores/userStore'
import MemoryPanel from './MemoryPanel'
import SystemsTab from './settings/SystemsTab'
import AboutTab from './settings/AboutTab'
import RobotTab from './settings/RobotTab'
import FolderTab from './settings/FolderTab'
import LlmTab from './settings/LlmTab'

type SettingsTab = 'profile' | 'llm' | 'robot' | 'folder' | 'about' | 'memory' | 'systems'

// 模型服务常量与厂商预设已拆至 settings/LlmTab.tsx。

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
    claimExpert
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
  const [saving, setSaving] = useState(false)

  // Local state for switching claimed assistant
  const [isClaimingLocal, setIsClaimingLocal] = useState(false)
  // 岗位 SOUL 默认折叠：内容较长，展开态会把下方「昵称/称呼/背景画像」顶出视口
  const [soulOpen, setSoulOpen] = useState(false)
  
  const handleSwitchExpert = async (newExpertId: string) => {
    if (newExpertId === claimedExpertId) return
    setIsClaimingLocal(true)
    const success = await claimExpert(newExpertId)
    setIsClaimingLocal(false)
    if (success) {
      const target = expertList.find(e => e.id === newExpertId)
      setRenameInput(expertRenameMap[newExpertId] || target?.title || '')
      alert(`已切换到岗位「${target?.title}」，技能已同步到本地。`)
    } else {
      alert('切换岗位失败，请检查网络或配置。')
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
      alert('已保存账号画像。')
    }, 500)
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
                          <div className="agent-switch-sub">{exp.skills?.length || 0} 项技能</div>
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
                  <div className="glass-card" style={{ padding: 0, background: 'rgba(255,255,255,0.015)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
                    <button type="button" onClick={() => setSoulOpen(o => !o)}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '8px', padding: '13px 16px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', textAlign: 'left' }}>
                      <span style={{ fontSize: '13px', fontWeight: '700' }}>
                        {currentExpert.title} · 岗位 SOUL
                      </span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-full)', padding: '1px 8px' }}>只读 · 企业统一定义</span>
                      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                        {soulOpen ? '收起' : '查看'}{soulOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </span>
                    </button>
                    {soulOpen && (
                    <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {/* 我是谁 */}
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '4px' }}>我是谁</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>{currentExpert.description}</div>
                    </div>
                    {/* 我的原则（管理端定义；留空则用企业默认治理原则） */}
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '4px' }}>我的原则</div>
                      <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.7' }}>
                        {(currentExpert.principles && currentExpert.principles.length > 0 ? currentExpert.principles : [
                          '只依据真实抓取 / 检索到的内容作答，绝不编造任何业务数据',
                          '登录态与凭证只保存在你本地受管环境，平台绝不上传',
                          '增删改 / 批量 / 删除等写操作，执行前必须经你人工确认',
                          '高风险操作触发一次性签名授权锁，未授权不执行'
                        ]).map((p, i) => <li key={i}>{p}</li>)}
                      </ul>
                    </div>
                    {/* 我的工作方式（管理端定义；留空则用默认） */}
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '4px' }}>我的工作方式</div>
                      <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.7' }}>
                        {(currentExpert.workStyle && currentExpert.workStyle.length > 0 ? currentExpert.workStyle : [
                          '查询 / 读取类：自动直达目标页取数，按标准流程 SOP 整理后回你',
                          '写入 / 操作类：先从你的话里提炼参数 → 弹表单确认 → 再执行',
                          '只调用企业按本岗位装配的技能，越权不调用'
                        ]).map((w, i) => <li key={i}>{w}</li>)}
                      </ul>
                    </div>
                    {currentExpert.skills && currentExpert.skills.length > 0 && (
                      <div style={{ textAlign: 'left' }}>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '6px' }}>我会的技能（{currentExpert.skills.length}）</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {currentExpert.skills.map(sk => (
                            <span key={sk.id} style={{ fontSize: '10px', background: 'rgba(59, 130, 246, 0.04)', border: '1px solid rgba(59, 130, 246, 0.15)', color: 'var(--brand-primary)', padding: '2px 8px', borderRadius: 'var(--radius-full)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              ⚡ {sk.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    </div>
                    )}
                  </div>
                </div>
              )}

              {/* Row 2: Rename Assistant */}
              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">工作分身自定义昵称</div>
                  <div className="setting-desc">为当前领用的工作分身起一个个性化的名字。</div>
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
                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>请先领用一个工作分身</span>
                  )}
                </div>
              </div>

              {/* Row 3: How to Address You */}
              <div className="setting-row">
                <div className="setting-info">
                  <div className="setting-label">分身对你的称呼</div>
                  <div className="setting-desc">设置分身在对话中如何称呼你。</div>
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
                  <div className="setting-label">员工背景画像</div>
                  <div className="setting-desc">
                    背景信息会注入对话上下文，帮助分身更准确地理解你的业务与偏好。仅保存在本地。
                  </div>
                </div>
                <textarea 
                  className="settings-input" 
                  style={{ minHeight: '120px', resize: 'vertical', fontFamily: 'inherit' }}
                  value={bgInput}
                  onChange={(e) => setBgInput(e.target.value)}
                  placeholder="你的职责范围、偏好与常用格式，例如：主要负责华东大区，报销抬头使用分公司抬头。"
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
        {activeTab === 'llm' && <LlmTab />}

        {/* View 3: Remote Control Gateway */}
        {activeTab === 'robot' && <RobotTab />}

        {/* View 4: Workspace Folder */}
        {activeTab === 'folder' && <FolderTab />}

        {/* View 5: About iML Work */}
        {activeTab === 'about' && <AboutTab />}

        {/* View 6: Knowledge Memory */}
        {activeTab === 'memory' && (
          <div className="settings-tab-content" style={{ maxWidth: '100%' }}>
            <MemoryPanel />
          </div>
        )}

        {/* View 7: Business Systems Integration */}
        {activeTab === 'systems' && <SystemsTab />}

      </div>

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
