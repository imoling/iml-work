import { create } from 'zustand'
import { swallow } from '../utils'

export type ThemeMode = 'dark' | 'light'

// Apply the theme to the document root so the CSS variable overrides take effect.
export function applyTheme(theme: ThemeMode) {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme)
  }
}

export interface Skill {
  id: string
  name: string
  type: string
  description?: string
  category?: string
  version?: string
  status?: string
  triggerKeywords?: string[]
}

export interface Expert {
  id: string
  title: string
  spec: string
  description: string
  skills?: Skill[]
  principles?: string[]
  workStyle?: string[]
  ontologyDomains?: string[]     // 业务域侧重（管理端配置，本体解析优先域）
  webSearchEnabled?: boolean     // 岗位是否开通联网检索
}

export interface BusinessSystem {
  id: string
  name: string
  type: string
  account: string
  isAuthorized: boolean
}

interface UserState {
  claimedExpertId: string | null
  expertRenameMap: Record<string, string>
  userBackground: string
  isClaiming: boolean
  isLoadingExperts: boolean
  expertList: Expert[]
  fetchExperts: () => Promise<void>
  llmConnectionMode: 'proxy' | 'direct'
  llmApiMode: 'chat' | 'anthropic'
  llmBaseUrl: string
  llmApiKey: string
  llmModelName: string
  claimExpert: (expertId: string) => Promise<boolean>
  applyClaimedSkills: (expertId: string, skills: any[]) => void
  updateRename: (expertId: string, name: string) => void
  updateBackground: (bg: string) => void
  userNickname: string
  updateNickname: (nickname: string) => void
  applyDefaultNickname: (name: string) => void   // 无自定义称呼时用登录账号名兜底
  keepBusinessSession: boolean
  businessSystems: BusinessSystem[]
  updateBusinessSession: (keep: boolean) => void
  resetBusinessSession: (systemId: string) => void
  updateLlmConfig: (config: Partial<{ llmConnectionMode: 'proxy' | 'direct'; llmApiMode: 'chat' | 'anthropic'; llmBaseUrl: string; llmApiKey: string; llmModelName: string }>) => void
  loadLlmConfig: () => Promise<void>
  getCurrentExpertName: () => string
  theme: ThemeMode
  setTheme: (theme: ThemeMode) => void
  toggleTheme: () => void
  historyRailPinned: boolean          // 历史会话常驻（默认关闭，保持界面清爽）
  setHistoryRailPinned: (pinned: boolean) => void
  startupRestoreLast: boolean         // 进入时恢复上次对话（默认开）；关闭则每次新对话
  setStartupRestoreLast: (v: boolean) => void
  showExecLivefeed: boolean           // 执行进度前台 livefeed（默认开）；关闭则生成时气泡区不滚动执行日志
  setShowExecLivefeed: (v: boolean) => void
}

export const useUserStore = create<UserState>((set, get) => ({
  claimedExpertId: null,
  expertRenameMap: {},
  isLoadingExperts: false,
  userBackground: "",   // 背景画像不预置假人设——留空由用户填（占位符引导），空着就是空着
  isClaiming: false,
  // 岗位列表只来自管理端真实数据（expert:list），绝不内置假岗位——后端离线时应回登录页、不展示编造岗位。
  expertList: [],
  fetchExperts: async () => {
    set({ isLoadingExperts: true })
    try {
      const res = await window.api.invoke('expert:list')
      if (res && res.success && Array.isArray(res.experts) && res.experts.length > 0) {
        // 恢复上次领用的岗位（持久化在本地配置库）——下次进入无需重新领用。
        let persisted: string | null = null
        try { const p = await window.api.invoke('db:config-get', 'claimed-expert-id'); if (typeof p === 'string' && p) persisted = p } catch (e) { swallow(e, 'config-get claimed-expert-id') }
        set((state) => {
          const wanted = state.claimedExpertId || persisted
          // 已领用的分身若在管理端被删除，则清空领用态。
          const stillExists = wanted && res.experts.some((e: Expert) => e.id === wanted)
          return {
            expertList: res.experts,
            claimedExpertId: stillExists ? wanted : null,
            isLoadingExperts: false
          }
        })
        return
      }
    } catch (error) {
      console.error('Failed to fetch experts from admin:', error)
    }
    // 拉取失败（管理端离线等）时保留现有列表，仅复位加载态。
    set({ isLoadingExperts: false })
  },
  claimExpert: async (expertId: string) => {
    set({ isClaiming: true })
    try {
      const response = await window.api.invoke('expert:claim', expertId)
      if (response && response.success) {
        // 持久化领用的岗位，下次启动自动恢复、无需重新领用。
        window.api.invoke('db:config-set', 'claimed-expert-id', expertId)
        set((state) => {
          const updatedExperts = state.expertList.map(exp => {
            if (exp.id === expertId) {
              return { ...exp, skills: response.skillsSynced }
            }
            return exp
          })
          return {
            claimedExpertId: expertId,
            expertList: updatedExperts,
            isClaiming: false
          }
        })
        return true
      }
    } catch (error) {
      console.error("Failed to claim expert:", error)
    }
    set({ isClaiming: false })
    return false
  },
  // 主进程近实时同步到技能集变更时，刷新对应岗位的技能列表（业务技能 UI 实时更新）
  applyClaimedSkills: (expertId: string, skills: any[]) => {
    set((state) => ({
      expertList: state.expertList.map(exp => exp.id === expertId ? { ...exp, skills: skills as any } : exp)
    }))
  },
  updateRename: (expertId: string, name: string) => {
    set((state) => {
      const newMap = { ...state.expertRenameMap, [expertId]: name }
      window.api.invoke('db:config-set', 'expert-rename-map', JSON.stringify(newMap))
      return { expertRenameMap: newMap }
    })
  },
  updateBackground: (bg: string) => {
    set({ userBackground: bg })
    window.api.invoke('db:config-set', 'user-background', bg)
  },
  userNickname: "",   // 默认空——由登录账号的显示名/用户名兜底（applyDefaultNickname），不写死"张经理"
  updateNickname: (nickname: string) => {
    set({ userNickname: nickname })
    window.api.invoke('db:config-set', 'user-nickname', nickname)
  },
  // 该账号未设置过"称呼"时，用登录名/显示名兜底（不落库，用户点保存才持久化），避免出现别的账号或写死的默认值
  applyDefaultNickname: (name: string) => {
    if (!get().userNickname && name) set({ userNickname: name })
  },
  keepBusinessSession: true,
  businessSystems: [
    { id: 'sys-1', name: '企业内部 OA 办公审批系统', type: 'OA', account: '185****6788', isAuthorized: true },
    { id: 'sys-2', name: '共享财务报销平台 (Oracle ERP)', type: 'ERP', account: 'finance.manager@corp.com', isAuthorized: true },
    { id: 'sys-3', name: 'HR 人事申报与薪酬系统', type: 'HR', account: '', isAuthorized: false }
  ],
  updateBusinessSession: (keep: boolean) => {
    set({ keepBusinessSession: keep })
    window.api.invoke('db:config-set', 'keep-business-session', keep ? 'true' : 'false')
  },
  resetBusinessSession: (systemId: string) => {
    set((state) => ({
      businessSystems: state.businessSystems.map(sys => {
        if (sys.id === systemId) {
          return { ...sys, isAuthorized: false, account: '' }
        }
        return sys
      })
    }))
    alert('已清除该系统的本地会话凭据及 Cookie 缓存。')
  },
  llmConnectionMode: 'proxy',
  llmApiMode: 'chat',
  llmBaseUrl: (import.meta.env.VITE_ADMIN_BASE_URL || 'http://localhost:8080') + '/api/v1/model',
  llmApiKey: 'sk-corp-default-key',
  llmModelName: 'deepseek-chat',
  updateLlmConfig: (config) => {
    // Only update fields that are valid strings
    const safeConfig: any = {}
    if (config.llmConnectionMode === 'proxy' || config.llmConnectionMode === 'direct') safeConfig.llmConnectionMode = config.llmConnectionMode
    if (config.llmApiMode === 'chat' || config.llmApiMode === 'anthropic') safeConfig.llmApiMode = config.llmApiMode
    if (typeof config.llmBaseUrl === 'string') safeConfig.llmBaseUrl = config.llmBaseUrl
    if (typeof config.llmApiKey === 'string') safeConfig.llmApiKey = config.llmApiKey
    if (typeof config.llmModelName === 'string') safeConfig.llmModelName = config.llmModelName
    set((state) => ({ ...state, ...safeConfig }))
    if (safeConfig.llmBaseUrl !== undefined) window.api.invoke('db:config-set', 'llm-base-url', safeConfig.llmBaseUrl)
    if (safeConfig.llmApiKey !== undefined) window.api.invoke('db:config-set', 'llm-api-key', safeConfig.llmApiKey)
    if (safeConfig.llmModelName !== undefined) window.api.invoke('db:config-set', 'llm-model-name', safeConfig.llmModelName)
    if (safeConfig.llmConnectionMode !== undefined) window.api.invoke('db:config-set', 'llm-connection-mode', safeConfig.llmConnectionMode)
    if (safeConfig.llmApiMode !== undefined) window.api.invoke('db:config-set', 'llm-api-mode', safeConfig.llmApiMode)
  },
  loadLlmConfig: async () => {
    try {
      const configs = await window.api.invoke('db:config-get-all')
      if (!configs) return

      const mode = configs['llm-connection-mode']
      const apiMode = configs['llm-api-mode']
      const baseUrl = configs['llm-base-url']
      const apiKey = configs['llm-api-key']
      const modelName = configs['llm-model-name']
      const keepSession = configs['keep-business-session']
      
      const savedBackground = configs['user-background']
      const savedNickname = configs['user-nickname']
      const savedRenameMap = configs['expert-rename-map']
      const savedTheme = configs['theme']
      const savedHistoryPinned = configs['history-rail-pinned']

      const savedStartupRestore = configs['startup-restore-last']
      const savedLivefeed = configs['show-exec-livefeed']

      const updates: any = {}
      if (savedHistoryPinned === 'true' || savedHistoryPinned === 'false') updates.historyRailPinned = savedHistoryPinned === 'true'
      if (savedStartupRestore === 'true' || savedStartupRestore === 'false') updates.startupRestoreLast = savedStartupRestore === 'true'
      if (savedLivefeed === 'true' || savedLivefeed === 'false') updates.showExecLivefeed = savedLivefeed === 'true'
      if (savedTheme === 'light' || savedTheme === 'dark') {
        updates.theme = savedTheme
        applyTheme(savedTheme)
      }
      if (mode === 'proxy' || mode === 'direct') updates.llmConnectionMode = mode
      if (apiMode === 'chat' || apiMode === 'anthropic') updates.llmApiMode = apiMode
      if (typeof baseUrl === 'string' && baseUrl.startsWith('http')) updates.llmBaseUrl = baseUrl
      if (typeof apiKey === 'string' && apiKey.length > 0) updates.llmApiKey = apiKey
      if (typeof modelName === 'string' && modelName.length > 0) updates.llmModelName = modelName
      if (keepSession === 'true' || keepSession === 'false') updates.keepBusinessSession = keepSession === 'true'
      
      if (typeof savedBackground === 'string') updates.userBackground = savedBackground
      // 仅当该账号确有非空自定义称呼才覆盖；否则留空，交给 applyDefaultNickname 用登录名兜底
      if (typeof savedNickname === 'string' && savedNickname.trim()) updates.userNickname = savedNickname
      if (typeof savedRenameMap === 'string') {
        try {
          updates.expertRenameMap = JSON.parse(savedRenameMap)
        } catch (e) { swallow(e, 'parse expertRenameMap') }
      }

      if (Object.keys(updates).length > 0) {
        set(updates)
      }
    } catch (err) {
      console.error('Failed to load LLM config:', err)
    }
  },
  getCurrentExpertName: () => {
    const { claimedExpertId, expertRenameMap, expertList } = get()
    if (!claimedExpertId) return '未激活专家'
    if (expertRenameMap[claimedExpertId]) return expertRenameMap[claimedExpertId]
    const expert = expertList.find(e => e.id === claimedExpertId)
    return expert ? expert.title : '未激活专家'
  },
  theme: 'dark',
  setTheme: (theme: ThemeMode) => {
    applyTheme(theme)
    set({ theme })
    window.api.invoke('db:config-set', 'theme', theme)
  },
  historyRailPinned: false,
  setHistoryRailPinned: (pinned: boolean) => {
    set({ historyRailPinned: pinned })
    window.api.invoke('db:config-set', 'history-rail-pinned', pinned ? 'true' : 'false')
  },
  startupRestoreLast: true,
  setStartupRestoreLast: (v: boolean) => {
    set({ startupRestoreLast: v })
    window.api.invoke('db:config-set', 'startup-restore-last', v ? 'true' : 'false')
  },
  showExecLivefeed: true,
  setShowExecLivefeed: (v: boolean) => {
    set({ showExecLivefeed: v })
    window.api.invoke('db:config-set', 'show-exec-livefeed', v ? 'true' : 'false')
  },
  toggleTheme: () => {
    const next: ThemeMode = get().theme === 'dark' ? 'light' : 'dark'
    get().setTheme(next)
  }
}))
