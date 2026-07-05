import { useState, useEffect } from 'react'
import {
  ListChecks, Boxes, FolderClosed, Settings as SettingsIcon, MessagesSquare,
  Sun, Moon, AlertTriangle, FileCheck2, ReceiptText, Database, Bot, PanelLeftOpen
} from 'lucide-react'
import BrandMark from './components/BrandMark'

const ROLE_ICONS: Record<string, React.ReactNode> = {
  'expert-1': <FileCheck2 size={18} />,
  'expert-2': <ReceiptText size={18} />,
  'expert-3': <Database size={18} />,
}
import { useUserStore } from './stores/userStore'
import { useChatStore } from './stores/chatStore'
import { useHistoryStore } from './stores/historyStore'
import { useSpaceStore } from './stores/spaceStore'
import { useMemoryStore } from './stores/memoryStore'
import { useAuthStore } from './stores/authStore'
import DialoguePanel from './components/DialoguePanel'
import HistoryPanel from './components/HistoryPanel'
import PersonalSpace from './components/PersonalSpace'
import SettingsPanel from './components/SettingsPanel'
import SkillsView from './components/SkillsView'
import AutomationView from './components/AutomationView'
import UserCard from './components/UserCard'
import LoginScreen from './components/LoginScreen'
import ChangePasswordScreen from './components/ChangePasswordScreen'

type Tab = 'tasks' | 'skills' | 'files' | 'automation' | 'settings'

const NAV: { tab: Tab; label: string; icon: React.ReactNode }[] = [
  { tab: 'tasks', label: '会话', icon: <MessagesSquare size={17} /> },
  { tab: 'skills', label: '技能', icon: <Boxes size={17} /> },
  { tab: 'files', label: '文件', icon: <FolderClosed size={17} /> },
  { tab: 'automation', label: '任务', icon: <ListChecks size={17} /> },
  { tab: 'settings', label: '设置', icon: <SettingsIcon size={17} /> },
]

export default function App() {
  const { claimedExpertId, expertList, claimExpert, applyClaimedSkills, isClaiming, loadLlmConfig, fetchExperts, theme, toggleTheme, historyRailPinned } = useUserStore()
  const { initIpcListeners, sendMessage, loadMessages } = useChatStore()
  const { activeConversationId, loadConversations, setActiveConversationId } = useHistoryStore()
  const { initSpaceListeners, loadFiles } = useSpaceStore()
  const { loadMemories } = useMemoryStore()
  const { user, ready: authReady, loadSession, logout, has } = useAuthStore()

  const [activeTab, setActiveTab] = useState<Tab>('tasks')
  const [selectedExpertId, setSelectedExpertId] = useState<string>('expert-1')
  const [historyOpen, setHistoryOpen] = useState(false)
  // 「常驻」开关（设置里，持久化）→ 决定历史栏是否默认展开
  useEffect(() => { setHistoryOpen(historyRailPinned) }, [historyRailPinned])

  useEffect(() => {
    loadSession()
    loadLlmConfig()
    const unsubChat = initIpcListeners()
    const unsubSpace = initSpaceListeners()
    loadFiles()
    // 主进程近实时同步到岗位技能变更 → 刷新业务技能列表
    const unsubSkills = window.api.on('skills:changed', (p: any) => { if (p?.expertId) applyClaimedSkills(p.expertId, p.skills || []) })
    // 定时任务到点触发 → 切到对话并把指令发给分身执行
    const unsubSched = window.api.on('schedule:fire', (p: any) => { if (p?.prompt) { setActiveTab('tasks'); sendMessage(p.prompt) } })
    return () => { unsubChat(); unsubSpace(); unsubSkills(); unsubSched() }
  }, [])

  // 登录后（或换用户）按「可领用岗位」重新拉取岗位列表
  useEffect(() => { if (user) fetchExperts() }, [user?.id])

  useEffect(() => { loadMemories(claimedExpertId) }, [claimedExpertId])

  // 进入岗位：载入历史会话，并按「启动会话」偏好决定 恢复上次对话 / 每次新对话（不依赖历史栏是否展开）
  useEffect(() => {
    if (!claimedExpertId) return
    ;(async () => {
      await loadConversations(claimedExpertId)   // 内部会自动选中最近一次对话（若当前无选中）
      let restoreLast = true
      try { const v = await window.api.invoke('db:config-get', 'startup-restore-last'); if (v === 'false') restoreLast = false } catch (_) {}
      if (!restoreLast) setActiveConversationId(null)
    })()
  }, [claimedExpertId])

  // 当前会话变化 → 载入其消息（历史栏收起时也生效）
  useEffect(() => { loadMessages(activeConversationId) }, [activeConversationId])

  const handleClaim = async () => {
    const success = await claimExpert(selectedExpertId)
    if (success) setActiveTab('tasks')
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

      {/* 未就绪 / 未登录 / 无权限 门禁 */}
      {!authReady && (
        <div className="login-screen"><div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>加载中…</div></div>
      )}
      {authReady && !user && <LoginScreen />}
      {authReady && user && user.mustChangePassword && <ChangePasswordScreen />}
      {authReady && user && !user.mustChangePassword && !has('client.use') && (
        <div className="login-screen">
          <div className="claim-panel" style={{ maxWidth: 420, textAlign: 'center' }}>
            <h1 style={{ fontSize: 18, marginBottom: 8 }}>无客户端使用权限</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 18px', lineHeight: 1.6 }}>
              当前账号「{user.displayName || user.username}」未被授予「客户端使用」权限。<br />请联系管理员为你分配「员工」等含该权限的角色。
            </p>
            <button className="settings-btn" onClick={logout} style={{ padding: '8px 16px' }}>退出登录</button>
          </div>
        </div>
      )}

      {authReady && user && !user.mustChangePassword && has('client.use') && (<>
      {/* Claim screen */}
      {claimedExpertId === null && (
        <div className="login-screen">
          <div className="claim-panel">
            <div className="claim-header">
              <BrandMark height={40} />
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
                  <div className="claim-skill-count"><Boxes size={13} />包含 {exp.skills?.length || 0} 项技能</div>
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
              <BrandMark height={40} style={{ flexShrink: 0 }} />
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
            <UserCard />
          </div>

          <div className="content-area" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            {activeTab === 'tasks' && (
              <div style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%', position: 'relative' }}>
                {historyOpen ? (
                  <HistoryPanel onClose={historyRailPinned ? undefined : () => setHistoryOpen(false)} />
                ) : (
                  <button className="conv-rail-handle" onClick={() => setHistoryOpen(true)} title="展开历史会话">
                    <PanelLeftOpen size={16} />
                  </button>
                )}
                <div className={historyOpen ? '' : 'has-history-handle'} style={{ flex: 1, minWidth: 0, height: '100%' }}><DialoguePanel /></div>
              </div>
            )}
            {activeTab === 'skills' && <SkillsView />}
            {activeTab === 'files' && <PersonalSpace />}
            {activeTab === 'automation' && <AutomationView />}
            {activeTab === 'settings' && <SettingsPanel onBackToChat={() => setActiveTab('tasks')} />}
          </div>
        </div>
      )}
      </>)}
    </div>
  )
}
