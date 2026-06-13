import { useState, useEffect } from 'react'
import { MessageSquare, Folder, AlertTriangle, Plus } from 'lucide-react'
import { useUserStore } from './stores/userStore'
import { useChatStore } from './stores/chatStore'
import { useSpaceStore } from './stores/spaceStore'
import { useMemoryStore } from './stores/memoryStore'
import { useHistoryStore } from './stores/historyStore'
import DialoguePanel from './components/DialoguePanel'
import HistoryPanel from './components/HistoryPanel'
import PersonalSpace from './components/PersonalSpace'
import SettingsPanel from './components/SettingsPanel'
import UserCard from './components/UserCard'

export default function App() {
  const { claimedExpertId, expertList, claimExpert, isClaiming, getCurrentExpertName, loadLlmConfig } = useUserStore()
  const { initIpcListeners } = useChatStore()
  const { initSpaceListeners, loadFiles } = useSpaceStore()
  const { loadMemories } = useMemoryStore()
  const { createConversation } = useHistoryStore()
  
  const [activeTab, setActiveTab] = useState<'chat' | 'space' | 'memory' | 'settings'>('chat')
  const [selectedExpertId, setSelectedExpertId] = useState<string>('expert-1')

  // Listeners initialization
  useEffect(() => {
    loadLlmConfig()
    const unsubChat = initIpcListeners()
    const unsubSpace = initSpaceListeners()
    loadFiles()

    return () => {
      unsubChat()
      unsubSpace()
    }
  }, [])

  // Auto reload memories when expert changes
  useEffect(() => {
    loadMemories(claimedExpertId)
  }, [claimedExpertId])

  const handleClaim = async () => {
    const success = await claimExpert(selectedExpertId)
    if (success) {
      setActiveTab('chat')
    }
  }

  // Handle Electron native window chrome actions
  const handleWindowAction = (action: string) => {
    window.api.invoke(`window:${action}`)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Titlebar */}
      <div className="titlebar">
        <div className="titlebar-brand">
          <span>iML Work</span>
          <span className="titlebar-brand-subtitle">// {getCurrentExpertName()}</span>
        </div>
        <div className="titlebar-controls">
          <button className="titlebar-btn titlebar-minimize" onClick={() => handleWindowAction('minimize')} title="Minimize" />
          <button className="titlebar-btn titlebar-maximize" onClick={() => handleWindowAction('maximize')} title="Maximize" />
          <button className="titlebar-btn titlebar-close" onClick={() => handleWindowAction('close')} title="Close" />
        </div>
      </div>

      {/* Login Screen / Claim Expert Overlay */}
      {claimedExpertId === null && (
        <div className="login-screen">
          <div className="login-box glass-card">
            <div className="login-header">
              <h1>领用岗位专家助手</h1>
              <p>iML Work Container Setup</p>
            </div>
            
            <div className="experts-claim-list">
              {expertList.map((exp) => (
                <div 
                  key={exp.id} 
                  className={`expert-claim-card ${selectedExpertId === exp.id ? 'selected' : ''}`}
                  onClick={() => setSelectedExpertId(exp.id)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="expert-title" style={{ fontSize: '14px', fontWeight: '700', color: 'var(--text-primary)' }}>
                      💼 {exp.title}
                    </div>
                    <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: 'var(--radius-full)', background: selectedExpertId === exp.id ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255,255,255,0.03)', color: selectedExpertId === exp.id ? 'var(--brand-primary)' : 'var(--text-muted)', border: selectedExpertId === exp.id ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid var(--border-color)' }}>
                      {selectedExpertId === exp.id ? '已选中' : '可领用'}
                    </span>
                  </div>
                  
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.5', marginTop: '4px', textAlign: 'left' }}>
                    {exp.description}
                  </div>

                  {exp.skills && exp.skills.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px', borderTop: '1px dashed var(--border-color)', paddingTop: '10px' }}>
                      {exp.skills.map(sk => (
                        <span key={sk.id} style={{ fontSize: '10px', background: 'rgba(59, 130, 246, 0.04)', border: '1px solid rgba(59, 130, 246, 0.15)', color: 'var(--brand-primary)', padding: '2px 8px', borderRadius: 'var(--radius-full)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          ⚡ {sk.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
              <div style={{ display: 'flex', gap: '8px', fontSize: '11px', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
                <AlertTriangle size={16} color="var(--accent-yellow)" style={{ flexShrink: 0 }} />
                <span>领用后系统会自动将该专家的业务知识与 RPA 自动化动作包同步下载至本地沙箱容器中。</span>
              </div>
              <button 
                className="settings-btn" 
                onClick={handleClaim} 
                disabled={isClaiming}
                style={{ width: '100%', padding: '12px' }}
              >
                {isClaiming ? '正在同步下载岗位专家技能包...' : '确认领用并加载容器'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Workspace Workspace Layout */}
      {claimedExpertId !== null && (
        <div className="app-container">
          {activeTab !== 'settings' && (
            <div className="sidebar">
              <div className="sidebar-logo">
                <h2>iML Work</h2>
                <p>v1.0.0 Alpha</p>
              </div>
              
              <div className="sidebar-menu">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div 
                    className={`sidebar-item ${activeTab === 'chat' ? 'active' : ''}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingRight: '6px'
                    }}
                    onClick={() => setActiveTab('chat')}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <MessageSquare size={16} />
                      <span>专家对话</span>
                    </div>
                    
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (claimedExpertId) {
                          await createConversation(claimedExpertId, '新对话')
                        }
                      }}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'inherit',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        padding: '4px',
                        borderRadius: '4px',
                        opacity: 0.8
                      }}
                      title="新建对话"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  
                  {activeTab === 'chat' && <HistoryPanel />}
                </div>
                
                <button 
                  className={`sidebar-item ${activeTab === 'space' ? 'active' : ''}`}
                  onClick={() => setActiveTab('space')}
                >
                  <Folder size={16} />
                  <span>个人空间</span>
                </button>
                
              </div>

              <UserCard onNavigateToSettings={() => setActiveTab('settings')} />
            </div>
          )}

          <div className="content-area" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            {activeTab === 'chat' && (
              <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}>
                <DialoguePanel />
              </div>
            )}
            {activeTab === 'space' && <PersonalSpace />}

            {activeTab === 'settings' && <SettingsPanel onBackToChat={() => setActiveTab('chat')} />}
          </div>
        </div>
      )}
    </div>
  )
}
