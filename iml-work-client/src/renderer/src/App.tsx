import { useState, useEffect } from 'react'
import {
  LayoutGrid, ListChecks, Boxes, FolderClosed, Workflow, Settings as SettingsIcon,
  Sun, Moon, AlertTriangle, FileCheck2, ReceiptText, Database, Bot
} from 'lucide-react'
import logoMark from './assets/brand/logo-mark.svg'

const ROLE_ICONS: Record<string, React.ReactNode> = {
  'expert-1': <FileCheck2 size={18} />,
  'expert-2': <ReceiptText size={18} />,
  'expert-3': <Database size={18} />,
}
import { useUserStore } from './stores/userStore'
import { useChatStore } from './stores/chatStore'
import { useSpaceStore } from './stores/spaceStore'
import { useMemoryStore } from './stores/memoryStore'
import Workbench from './components/Workbench'
import DialoguePanel from './components/DialoguePanel'
import PersonalSpace from './components/PersonalSpace'
import SettingsPanel from './components/SettingsPanel'
import SkillsView from './components/SkillsView'
import AutomationView from './components/AutomationView'
import UserCard from './components/UserCard'

type Tab = 'workbench' | 'tasks' | 'skills' | 'files' | 'automation' | 'settings'

const NAV: { tab: Tab; label: string; icon: React.ReactNode }[] = [
  { tab: 'workbench', label: '工作台', icon: <LayoutGrid size={17} /> },
  { tab: 'tasks', label: '任务', icon: <ListChecks size={17} /> },
  { tab: 'skills', label: '业务技能', icon: <Boxes size={17} /> },
  { tab: 'files', label: '文件', icon: <FolderClosed size={17} /> },
  { tab: 'automation', label: '自动化', icon: <Workflow size={17} /> },
  { tab: 'settings', label: '设置', icon: <SettingsIcon size={17} /> },
]

export default function App() {
  const { claimedExpertId, expertList, claimExpert, isClaiming, loadLlmConfig, fetchExperts, theme, toggleTheme } = useUserStore()
  const { initIpcListeners, sendMessage } = useChatStore()
  const { initSpaceListeners, loadFiles } = useSpaceStore()
  const { loadMemories } = useMemoryStore()

  const [activeTab, setActiveTab] = useState<Tab>('workbench')
  const [selectedExpertId, setSelectedExpertId] = useState<string>('expert-1')

  useEffect(() => {
    loadLlmConfig()
    fetchExperts()
    const unsubChat = initIpcListeners()
    const unsubSpace = initSpaceListeners()
    loadFiles()
    return () => { unsubChat(); unsubSpace() }
  }, [])

  useEffect(() => { loadMemories(claimedExpertId) }, [claimedExpertId])

  const handleClaim = async () => {
    const success = await claimExpert(selectedExpertId)
    if (success) setActiveTab('workbench')
  }

  const handleWindowAction = (action: string) => window.api.invoke(`window:${action}`)

  // macOS shows window controls top-left, Windows/Linux top-right.
  const platform: string = (window as any).api?.platform || ''
  const isMac = platform === 'darwin'
  const [isMaximized, setIsMaximized] = useState(false)
  useEffect(() => {
    window.api.invoke('window:is-maximized').then((v: boolean) => setIsMaximized(!!v)).catch(() => {})
    return window.api.on('window:maximized-changed', (v: boolean) => setIsMaximized(!!v))
  }, [])

  const startTaskFromWorkbench = async (text: string) => {
    setActiveTab('tasks')
    await sendMessage(text)
  }

  const windowControls = (
    <div className="titlebar-lights">
      {isMac ? (
        <>
          <button className="titlebar-btn titlebar-close" onClick={() => handleWindowAction('close')} title="关闭"><span className="tl-sym">✕</span></button>
          <button className="titlebar-btn titlebar-minimize" onClick={() => handleWindowAction('minimize')} title="最小化"><span className="tl-sym">－</span></button>
          <button className="titlebar-btn titlebar-maximize" onClick={() => handleWindowAction('maximize')} title={isMaximized ? '还原' : '最大化'}><span className="tl-sym">＋</span></button>
        </>
      ) : (
        <>
          <button className="titlebar-btn titlebar-minimize" onClick={() => handleWindowAction('minimize')} title="最小化"><span className="tl-sym">－</span></button>
          <button className="titlebar-btn titlebar-maximize" onClick={() => handleWindowAction('maximize')} title={isMaximized ? '还原' : '最大化'}><span className="tl-sym">{isMaximized ? '❐' : '☐'}</span></button>
          <button className="titlebar-btn titlebar-close" onClick={() => handleWindowAction('close')} title="关闭"><span className="tl-sym">✕</span></button>
        </>
      )}
    </div>
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Titlebar */}
      <div className={`titlebar ${isMac ? 'is-mac' : 'is-win'}`}>
        <div className="titlebar-section titlebar-left">
          {isMac && windowControls}
          <div className="titlebar-brand"><span>iML Work</span></div>
        </div>
        <div className="titlebar-section titlebar-right">
          <button className="titlebar-theme-toggle" onClick={toggleTheme} title={theme === 'dark' ? '切换为亮色主题' : '切换为暗色主题'}>
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          {!isMac && windowControls}
        </div>
      </div>

      {/* Claim screen */}
      {claimedExpertId === null && (
        <div className="login-screen">
          <div className="claim-panel">
            <div className="claim-header">
              <img src={logoMark} alt="" style={{ height: 40, width: 'auto' }} />
              <div>
                <h1>领用你的工作分身</h1>
                <p>选择一个岗位分身开始 · 本地安全环境</p>
              </div>
            </div>

            <div className="claim-grid">
              {expertList.map((exp) => (
                <button
                  key={exp.id}
                  className={`claim-card ${selectedExpertId === exp.id ? 'selected' : ''}`}
                  onClick={() => setSelectedExpertId(exp.id)}
                >
                  <div className="claim-card-top">
                    <div className="claim-ic">{ROLE_ICONS[exp.id] || <Bot size={18} />}</div>
                    <span className="claim-name">{exp.title}</span>
                    <span className={`pill ${selectedExpertId === exp.id ? 'pill-mint' : 'pill-gray'}`}>
                      {selectedExpertId === exp.id ? '已选中' : '可领用'}
                    </span>
                  </div>
                  <div className="claim-desc">{exp.description}</div>
                  <div className="claim-skill-count"><Boxes size={13} />包含 {exp.skills?.length || 0} 项业务技能</div>
                </button>
              ))}
            </div>

            <div className="claim-footer">
              <div className="claim-note">
                <AlertTriangle size={15} color="var(--accent-orange)" style={{ flexShrink: 0 }} />
                <span>领用后会把该工作分身的业务知识与自动化技能同步至本地安全环境。</span>
              </div>
              <button className="settings-btn" onClick={handleClaim} disabled={isClaiming} style={{ width: '100%', padding: 12 }}>
                {isClaiming ? '正在同步工作分身技能…' : `确认领用「${expertList.find(e => e.id === selectedExpertId)?.title || ''}」`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Workspace */}
      {claimedExpertId !== null && (
        <div className="app-container">
          <div className="sidebar">
            <div className="sidebar-logo" style={{ borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 11 }}>
              <img src={logoMark} alt="" style={{ height: 40, width: 'auto', display: 'block', flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.5px', color: 'var(--text-primary)', lineHeight: 1.1 }}>
                  iML <span style={{ color: 'var(--brand-primary)' }}>Work</span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: '0.2px', marginTop: 3, whiteSpace: 'nowrap' }}>
                  工作分身 · 本地安全 · 高效执行
                </div>
              </div>
            </div>
            <div className="sidebar-menu">
              {NAV.map(item => (
                <button key={item.tab} className={`sidebar-item ${activeTab === item.tab ? 'active' : ''}`} onClick={() => setActiveTab(item.tab)}>
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
            <UserCard onNavigateToSettings={() => setActiveTab('settings')} />
          </div>

          <div className="content-area" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            {activeTab === 'workbench' && <Workbench onStartTask={startTaskFromWorkbench} onNavigate={(t) => setActiveTab(t as Tab)} />}
            {activeTab === 'tasks' && <DialoguePanel />}
            {activeTab === 'skills' && <SkillsView />}
            {activeTab === 'files' && <PersonalSpace />}
            {activeTab === 'automation' && <AutomationView />}
            {activeTab === 'settings' && <SettingsPanel onBackToChat={() => setActiveTab('workbench')} />}
          </div>
        </div>
      )}
    </div>
  )
}
