import { create } from 'zustand'
import { useUserStore } from './userStore'

// 个人长期记忆：用户手动沉淀的背景/偏好，持久化在本地 SQLite（按岗位隔离），
// 每次对话自动注入 System Prompt。这是真正意义上的"记忆"——分身会记住并复用。
export interface PersonalFact {
  id: string
  content: string
  timestamp: string
}

// 岗位知识：领用岗位后内置的技能能力（只读，随技能同步）——由真实领用技能派生，非编造。
export interface RoleSkill {
  id: string
  name: string
  type: string
  description: string
}

// 岗位 Soul：领用岗位的完整人格画像（职责/准则/风格/侧重域），全部来自管理端岗位配置的真实字段。
export interface RoleProfile {
  title: string
  spec: string
  description: string
  principles: string[]
  workStyle: string[]
  ontologyDomains: string[]
  webSearchEnabled?: boolean
}

// 企业知识：本岗位可检索的企业知识库范围（分类 + 真实文档），问答时按需 RAG 召回。
export interface EnterpriseDoc {
  name: string
  category: string
  updatedAt: string
}

interface MemoryState {
  personalFacts: PersonalFact[]
  roleProfile: RoleProfile | null
  roleSkills: RoleSkill[]
  entCategories: string[]
  entDocs: EnterpriseDoc[]
  entTotal: number
  isLoading: boolean
  addPersonalFact: (content: string) => Promise<void>
  deletePersonalFact: (id: string) => Promise<void>
  loadMemories: (expertId: string | null) => Promise<void>
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  personalFacts: [],
  roleProfile: null,
  roleSkills: [],
  entCategories: [],
  entDocs: [],
  entTotal: 0,
  isLoading: false,

  addPersonalFact: async (content: string) => {
    const expertId = useUserStore.getState().claimedExpertId
    if (!expertId || !content.trim()) return
    const fact: PersonalFact = { id: `fact-${Date.now()}`, content: content.trim(), timestamp: new Date().toLocaleString() }
    const next = [fact, ...get().personalFacts]
    set({ personalFacts: next })
    try { await window.api.invoke('db:memory-set', expertId, 'personal', JSON.stringify(next)) } catch (e) { console.error(e) }
  },

  deletePersonalFact: async (id: string) => {
    const expertId = useUserStore.getState().claimedExpertId
    if (!expertId) return
    const next = get().personalFacts.filter(f => f.id !== id)
    set({ personalFacts: next })
    try { await window.api.invoke('db:memory-set', expertId, 'personal', JSON.stringify(next)) } catch (e) { console.error(e) }
  },

  loadMemories: async (expertId: string | null) => {
    if (!expertId) { set({ personalFacts: [], roleProfile: null, roleSkills: [], entCategories: [], entDocs: [], entTotal: 0, isLoading: false }); return }
    set({ isLoading: true })

    // 1) 个人长期记忆（真·SQLite，兼容旧结构：可能是 {content,...} 数组）
    let personalFacts: PersonalFact[] = []
    try {
      const raw = await window.api.invoke('db:memory-get', expertId, 'personal')
      if (typeof raw === 'string' && raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          personalFacts = parsed
            .filter((m: any) => m && typeof m.content === 'string' && m.content.trim())
            .map((m: any) => ({ id: m.id || `fact-${Math.random().toString(36).slice(2)}`, content: m.content, timestamp: m.timestamp || '' }))
        }
      }
    } catch (e) { console.error('load personal memory failed', e) }

    // 2) 岗位 Soul：完整人格画像 + 内置能力（都来自真实领用岗位的配置字段，只读）
    const expert = useUserStore.getState().expertList.find(e => e.id === expertId)
    const roleProfile: RoleProfile | null = expert ? {
      title: expert.title || '',
      spec: expert.spec || '',
      description: expert.description || '',
      principles: expert.principles || [],
      workStyle: expert.workStyle || [],
      ontologyDomains: expert.ontologyDomains || [],
      webSearchEnabled: expert.webSearchEnabled
    } : null
    const roleSkills: RoleSkill[] = (expert?.skills || []).map(s => ({
      id: s.id, name: s.name, type: s.type, description: s.description || ''
    }))

    // 3) 企业知识：真实可检索范围 + 文档（主进程拉后端）
    let entCategories: string[] = [], entDocs: EnterpriseDoc[] = [], entTotal = 0
    try {
      const r: any = await window.api.invoke('memory:enterprise', expertId)
      if (r && r.ok) { entCategories = r.categories || []; entDocs = r.docs || []; entTotal = r.total || 0 }
    } catch (e) { console.error('load enterprise memory failed', e) }

    set({ personalFacts, roleProfile, roleSkills, entCategories, entDocs, entTotal, isLoading: false })
  }
}))
