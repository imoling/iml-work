import { useState, useEffect, useMemo } from 'react'
import {
  ListChecks, Boxes, MessagesSquare,
  AlertTriangle, FileCheck2, ReceiptText, Database, Bot, Pin, Trash2, Loader2, Search as SearchIcon, PanelLeft, ArrowLeft
} from 'lucide-react'
import BrandMark from './components/BrandMark'
import { swallow } from './utils'

const ROLE_ICONS: Record<string, React.ReactNode> = {
  'expert-1': <FileCheck2 size={18} />,
  'expert-2': <ReceiptText size={18} />,
  'expert-3': <Database size={18} />,
}
import { useUserStore } from './stores/userStore'
import { useChatStore } from './stores/chatStore'
import { SearchModal } from './components/SearchModal'
import { useHistoryStore } from './stores/historyStore'
import { useSpaceStore } from './stores/spaceStore'
import { useMemoryStore } from './stores/memoryStore'
import { useAuthStore } from './stores/authStore'
import DialoguePanel from './components/DialoguePanel'
import PersonalSpace from './components/PersonalSpace'
import SettingsPanel from './components/SettingsPanel'
import { SETTINGS_GROUPS, type SettingsTab } from './components/settings/nav'
import SkillsView from './components/SkillsView'
import AutomationView from './components/AutomationView'
import UserCard from './components/UserCard'
import LoginScreen from './components/LoginScreen'
import ChangePasswordScreen from './components/ChangePasswordScreen'

type Tab = 'tasks' | 'skills' | 'files' | 'automation' | 'settings'

// 主导航只留高频入口（2026-07-31 拍板对齐主流形态）：技能/文件/设置收敛到用户卡浮层
// 会话行右侧的相对时间（unixepoch 秒）：与操作按钮互斥显示（hover 时让位）
function timeAgo(sec: number): string {
  if (!sec) return ''
  const d = Math.floor(Date.now() / 1000) - sec
  if (d < 60) return '刚刚'
  if (d < 3600) return `${Math.floor(d / 60)}分钟前`
  if (d < 86400) return `${Math.floor(d / 3600)}小时前`
  if (d < 86400 * 60) return `${Math.floor(d / 86400)}天前`
  return new Date(sec * 1000).toLocaleDateString()
}

const NAV: { tab: Tab; label: string; icon: React.ReactNode }[] = [
  { tab: 'tasks', label: '会话', icon: <MessagesSquare size={17} /> },
  { tab: 'automation', label: '任务', icon: <ListChecks size={17} /> },
]
// 「搜索」不是 tab：弹窗形态，在导航渲染处单独插一项

export default function App() {
  const { claimedExpertId, expertList, claimExpert, applyClaimedSkills, isClaiming, isLoadingExperts, loadLlmConfig, fetchExperts } = useUserStore()
  const { initIpcListeners, sendMessage, loadMessages } = useChatStore()
  const { activeConversationId, loadConversations, setActiveConversationId } = useHistoryStore()
  const conversations = useHistoryStore(s => s.conversations)
  // 侧栏最近会话：折叠态与显示数量（数量在 设置→工作空间 配置）
  const [recentExpanded, setRecentExpanded] = useState(false)   // 查看更多：展开全部（区域内滚动），收起回到 N 条
  const recentConvCount = useUserStore(s => s.recentConvCount)
  const togglePin = useHistoryStore(s => s.togglePin)
  const deleteConversation = useHistoryStore(s => s.deleteConversation)
  // 三段数据：置顶 / 定时任务 / 最近（排除已置顶，两边重复出现很怪）
  const pinnedConvs = useMemo(() => conversations.filter(c => c.pinned), [conversations])
  // 定时任务的专属会话不进「最近会话」：入口在任务详情页的运行记录里，
  // 以及任务行的未读角标。⏰ 前缀是运行会话创建处的统一约定。
  const recentConvs = useMemo(() => conversations.filter(c => !c.pinned && !(c.title || '').startsWith('⏰')), [conversations])
  const [schedTasks, setSchedTasks] = useState<any[]>([])
  // 侧栏定时任务 → 任务详情页：经 prop 告诉 AutomationView 打开哪个任务
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(o => !o) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // 任务 → 运行会话 映射：未读角标/运行中转圈按它把会话状态归到任务行
  const [taskConvMap, setTaskConvMap] = useState<Record<string, string[]>>({})
  useEffect(() => {
    const load = () => {
      window.api.invoke('schedule:list').then((r: any) => setSchedTasks(Array.isArray(r) ? r : [])).catch(() => {})
      window.api.invoke('task-run:recent-convs').then((rows: any) => {
        const m: Record<string, string[]> = {}
        for (const r of (Array.isArray(rows) ? rows : [])) { (m[r.task_id] = m[r.task_id] || []).push(r.conv_id) }
        setTaskConvMap(m)
      }).catch(() => {})
    }
    load()
    const t = setInterval(load, 30_000)   // 兜底轮询：首拉可能早于登录/认领就绪（实测偶发空列表，"后来又正常"）
    const un = window.api.on('schedule:changed', load)
    return () => { clearInterval(t); if (typeof un === 'function') un() }
  }, [claimedExpertId])
  const schedCadence = (t: any): string => {
    const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    if (t.freq === 'daily') return `每天 ${t.time}`
    if (t.freq === 'weekday') return `工作日 ${t.time}`
    if (t.freq === 'weekly') return `每${DOW[t.dow] || ''} ${t.time}`
    if (t.freq === 'monthly') return `每月${t.dom}日 ${t.time}`
    return t.time || ''
  }
  // 侧栏会话行：点击切换；hover 出 置顶/删除（会话页历史列表移除后，管理能力收敛到这里）
  const generatingConvs = useChatStore(s => s.generatingConvs)
  const unreadConvs = useChatStore(s => s.unreadConvs)
  const ConvRow = ({ c }: { c: (typeof conversations)[number] }) => (
    <div className={`side-recent-item side-conv ${activeTab === 'tasks' && activeConversationId === c.id ? 'active' : ''}`}
      title={c.title}
      onClick={() => { setActiveConversationId(c.id); setActiveTab('tasks') }}>
      {/* 运行中转圈 / 未读圆点（绿=新回复 黄=待人工确认 红=异常）——原历史面板的状态，移除 rail 后补回侧栏 */}
      {generatingConvs[c.id]
        ? <Loader2 size={12} className="drawer-spin side-conv-state" />
        : unreadConvs[c.id]
          ? <span className={`side-conv-dot dot-${unreadConvs[c.id]}`} />
          : null}
      <span className="side-conv-title">{c.title || '新对话'}</span>
      <span className="side-conv-time">{timeAgo(c.updated_at)}</span>
      <span className="side-conv-ops" onClick={e => e.stopPropagation()}>
        <button type="button" className="side-conv-op" title={c.pinned ? '取消置顶' : '置顶'} onClick={() => togglePin(c.id)}>
          <Pin size={12} fill={c.pinned ? 'currentColor' : 'none'} />
        </button>
        <button type="button" className="side-conv-op" title="删除会话"
          onClick={() => { if (confirm(`删除会话「${c.title || '新对话'}」？`)) deleteConversation(c.id) }}>
          <Trash2 size={12} />
        </button>
      </span>
    </div>
  )
  const { initSpaceListeners, loadFiles } = useSpaceStore()
  const { loadMemories } = useMemoryStore()
  const { user, ready: authReady, loadSession, logout, has } = useAuthStore()

  const [activeTab, setActiveTab] = useState<Tab>('tasks')
  const [selectedExpertId, setSelectedExpertId] = useState<string>('')
  // 「常驻」开关（设置里，持久化）→ 决定历史栏是否默认展开

  useEffect(() => {
    loadSession()
    loadLlmConfig()
    const unsubChat = initIpcListeners()
    const unsubSpace = initSpaceListeners()
    loadFiles()
    // 主进程近实时同步到岗位技能变更 → 刷新业务技能列表
    const unsubSkills = window.api.on('skills:changed', (p: any) => { if (p?.expertId) applyClaimedSkills(p.expertId, p.skills || []) })
    // 定时任务触发 → **为该次运行开专属会话**（"每次运行是一个独立会话"）。
    // 曾直接灌进用户当前正在看的会话——正聊着天突然被定时任务插进来一条指令，且运行历史无从回看。
    const unsubSched = window.api.on('schedule:fire', async (p: any) => {
      if (!p?.prompt) return
      try {
        const expertId = useUserStore.getState().claimedExpertId || p.expertId || ''
        const d = new Date()
        const convId = await useHistoryStore.getState().createConversation(
          expertId, `⏰ ${p.title || '定时任务'} · ${d.getMonth() + 1}/${d.getDate()}`)
        const runId = await window.api.invoke('task-run:add', { taskId: p.id, convId, trigger: p.trigger || 'schedule' })
        // 映射即时更新：任务行的运行转圈靠它；等下一次轮询的话，短任务跑完了圈还没出现（实测"执行时没状态"）
        setTaskConvMap(prev => ({ ...prev, [p.id]: [convId, ...(prev[p.id] || [])] }))
        setActiveTab('tasks')
        await sendMessage(p.prompt, { unattended: true, convId, taskRun: { runId: Number(runId) } })
      } catch (e) { console.error('定时任务运行失败:', e) }
    })
    // 登录过期（token 失效 / 后端换密钥）→ 直接踢回登录页。
    // 否则各页面会把 401/403 各自渲染成"服务不可达/沙箱不可用"，把「该重登了」误报成「系统故障」。
    const unsubAuth = window.api.on('auth:expired', (p: any) => {
      alert(p?.reason || '登录已过期，请重新登录。')
      logout()
    })
    return () => { unsubChat(); unsubSpace(); unsubSkills(); unsubSched(); unsubAuth() }
  }, [])

  /**
   * 账号确定后**重新**加载一次本地配置。
   *
   * 本地库是按账号分的，而活跃库要等 `auth:session` 内部的 setActiveUser 才切过去——
   * 上面那次 loadLlmConfig() 与 loadSession() 是**并发发起**的，它读到的是切库之前的
   * 匿名库（iml-work-user-_anon.db），于是 per-account 的配置全部落空：
   * 分身的自定义昵称（expert-rename-map）读不到 → 界面回退显示岗位原名
   *（实测：销售岗改名叫「小璇」，界面一直显示「销售」，而数据一直好端端在账号库里）。
   * 岗位本身没错，是因为 fetchExperts 等了 user 才读 claimed-expert-id。
   *
   * 保留启动时那一次：登录页也要用 theme / adminBaseUrl。这里是补一次正确库的读取，
   * 幂等，换账号时也会重跑。
   */
  useEffect(() => { if (authReady) loadLlmConfig() }, [authReady, user?.id])

  // 登录后（或换用户）按「可领用岗位」重新拉取岗位列表
  useEffect(() => { if (user) fetchExperts() }, [user?.id])

  // 该账号未设置过「称呼」→ 用登录账号的显示名/用户名兜底，避免出现写死或别账号的默认称呼
  useEffect(() => { if (user) useUserStore.getState().applyDefaultNickname(user.displayName || user.username || '') }, [user?.id])

  // 岗位列表来自后端真实数据（无内置假岗位）→ 选中项指向首个真实岗位
  useEffect(() => {
    if (expertList.length && !expertList.some(e => e.id === selectedExpertId)) setSelectedExpertId(expertList[0].id)
  }, [expertList])

  useEffect(() => { loadMemories(claimedExpertId) }, [claimedExpertId])

  // 进入岗位：载入历史会话，并按「启动会话」偏好决定 恢复上次对话 / 每次新对话（不依赖历史栏是否展开）
  useEffect(() => {
    if (!claimedExpertId) return
    ;(async () => {
      await loadConversations(claimedExpertId)   // 内部会自动选中最近一次对话（若当前无选中）
      let restoreLast = true
      try { const v = await window.api.invoke('db:config-get', 'startup-restore-last'); if (v === 'false') restoreLast = false } catch (e) { swallow(e, 'config-get startup-restore-last') }
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
  // 侧栏收起/展开（Codex 形态）：按钮常驻标题栏左段，状态本地记住
  // 设置分页：导航在左侧栏（设置态整栏切换），内容在右侧 SettingsPanel
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('profile')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === '1')
  const toggleSidebar = () => setSidebarCollapsed(v => { localStorage.setItem('sidebar-collapsed', v ? '0' : '1'); return !v })
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
      {/* Titlebar：左段与侧栏同宽同色、右边线与侧栏边线连成一条（Codex 形态的左右分界）。
          品牌文字不再放这里（侧栏 logo 区已有）；左段只留交通灯 + 侧栏收起/展开按钮。 */}
      <div className={`titlebar ${isMac ? 'is-mac' : 'is-win'}`}>
        <div className={`titlebar-side ${claimedExpertId !== null && !sidebarCollapsed ? 'with-side' : ''}`}>
          {isMac && windowControls}
          {claimedExpertId !== null && (
            <button className="titlebar-collapse" onClick={toggleSidebar} title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}>
              <PanelLeft size={15} />
            </button>
          )}
        </div>
        <div className="titlebar-section titlebar-right">
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
                <p>选择一个岗位分身开始 · 安全沙箱</p>
              </div>
            </div>

            {expertList.length === 0 ? (
              <div className="claim-empty">
                <AlertTriangle size={22} color="var(--accent-orange)" />
                <div className="claim-empty-title">暂无可领用岗位</div>
                <div className="claim-empty-desc">未从企业管理端获取到分配给你的岗位分身。请确认管理员已为你分配岗位，或稍后重试同步。</div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="settings-btn" onClick={() => fetchExperts()} disabled={isLoadingExperts}>{isLoadingExperts ? '同步中…' : '重试同步'}</button>
                  <button className="btn-secondary" onClick={logout}>退出登录</button>
                </div>
              </div>
            ) : (<>
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
                <span>领用后会把该工作分身的业务知识与自动化技能同步至安全沙箱。</span>
              </div>
              <button className="settings-btn" onClick={handleClaim} disabled={isClaiming || !selectedExpertId} style={{ width: '100%', padding: 12 }}>
                {isClaiming ? '正在同步工作分身技能…' : `确认领用「${expertList.find(e => e.id === selectedExpertId)?.title || ''}」`}
              </button>
            </div>
            </>)}
          </div>
        </div>
      )}

      {/* Workspace */}
      {claimedExpertId !== null && (
        <div className="app-container">
          <div className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
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
            {activeTab === 'settings' ? (
              <>
                <div className="settings-side-groups">
                  <button type="button" className="settings-side-back" onClick={() => setActiveTab('tasks')}>
                    <ArrowLeft size={15} /><span>返回应用</span>
                  </button>
                  {SETTINGS_GROUPS.map(g => (
                    <div key={g.title} className="settings-nav-group">
                      <div className="settings-nav-header">{g.title}</div>
                      {g.tabs.map(t => (
                        <button key={t.key} type="button"
                          className={`settings-nav-item ${settingsTab === t.key ? 'active' : ''}`}
                          onClick={() => setSettingsTab(t.key)}>
                          {t.icon}<span>{t.label}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
            <div className="sidebar-menu">
              {NAV.map(item => (
                <button key={item.tab} className={`sidebar-item ${activeTab === item.tab ? 'active' : ''}`}
                  onClick={() => {
                    // 「会话」＝新建会话（「新建会话」语义）：清空当前会话进入欢迎态，
                    // 输入第一句自动落成新会话；想回旧会话走下面的 置顶/最近 列表。
                    if (item.tab === 'tasks') setActiveConversationId(null)
                    setActiveTab(item.tab)
                  }}>
                  {item.icon}
                  <span>{item.tab === 'tasks' ? '新会话' : item.label}</span>
                </button>
              ))}
              <button className="sidebar-item" onClick={() => setSearchOpen(true)} title="搜索会话（⌘K）">
                <SearchIcon size={17} />
                <span>搜索</span>
              </button>
            </div>
            {/* 三段式侧栏（置顶 / 定时 / 最近 三段）。
                会话页内的历史列表已按用户指示移除，切换/置顶/删除全部收敛到这里。 */}
            <div className="side-sections">
              {pinnedConvs.length > 0 && (
                <div className="side-sec">
                  <div className="side-sec-title">置顶会话</div>
                  {pinnedConvs.map(c => <ConvRow key={c.id} c={c} />)}
                </div>
              )}
              {schedTasks.length > 0 && (
                <div className="side-sec">
                  <div className="side-sec-title">定时任务</div>
                  {schedTasks.map(t => {
                    const unread = (taskConvMap[t.id] || []).filter(cid => unreadConvs[cid]).length
                    const running = (taskConvMap[t.id] || []).some(cid => generatingConvs[cid])
                    return (
                      <button key={t.id} type="button" className="side-recent-item side-sched"
                        title={t.prompt}
                        onClick={() => { setOpenTaskId(t.id); setActiveTab('automation') }}>
                        <span className="side-sched-row">
                          {running && <Loader2 size={11} className="drawer-spin side-conv-state" />}
                          <span className="side-sched-name">{t.title}</span>
                          {unread > 0 && <span className="side-sched-badge">{unread}</span>}
                        </span>
                        <span className="side-sched-cad">{t.enabled ? schedCadence(t) : '已暂停'}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              {recentConvs.length > 0 && (
                <div className={`side-sec side-sec-recent ${recentExpanded ? 'expanded' : ''}`}>
                  <div className="side-sec-title">最近会话（{recentConvs.length}）</div>
                  <div className="side-recent-list">
                    {(recentExpanded ? recentConvs : recentConvs.slice(0, recentConvCount)).map(c => <ConvRow key={c.id} c={c} />)}
                  </div>
                  {recentConvs.length > recentConvCount && (
                    <button type="button" className="side-recent-more" onClick={() => setRecentExpanded(e => !e)}>
                      {recentExpanded ? '收起' : `查看更多（${recentConvs.length - recentConvCount}）`}
                    </button>
                  )}
                </div>
              )}
            </div>
              </>
            )}
            <UserCard onNavigate={(tab) => setActiveTab(tab as any)} />
            {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} onOpen={(cid) => { setActiveConversationId(cid); setActiveTab('tasks') }} />}
          </div>

          <div className="content-area" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            {activeTab === 'tasks' && (
              <div style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%', position: 'relative' }}>
                {/* 会话页内的历史列表已移除（2026-07-31 拍板）：
                    会话切换/置顶/删除全部收敛到左侧导航的三段区（置顶/定时任务/最近会话）。 */}
                <div style={{ flex: 1, minWidth: 0, height: '100%' }}><DialoguePanel /></div>
              </div>
            )}
            {activeTab === 'skills' && <SkillsView />}
            {activeTab === 'files' && <PersonalSpace />}
            {activeTab === 'automation' && <AutomationView openTaskId={openTaskId} onTaskOpened={() => setOpenTaskId(null)} onOpenConversation={(convId) => { setActiveConversationId(convId); setActiveTab('tasks') }} />}
            {activeTab === 'settings' && <SettingsPanel tab={settingsTab} />}
          </div>
        </div>
      )}
      </>)}
    </div>
  )
}
