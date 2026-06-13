import { create } from 'zustand'
import { useUserStore } from './userStore'

export interface MemoryFact {
  id: string
  level: 'assistant' | 'personal' | 'corporate'
  content: string
  source: string
  timestamp: string
}

interface MemoryState {
  memories: MemoryFact[]
  isLoading: boolean
  addPersonalFact: (content: string) => Promise<void>
  deletePersonalFact: (id: string) => Promise<void>
  loadMemories: (expertId: string | null) => Promise<void>
}

export const useMemoryStore = create<MemoryState>((set) => ({
  memories: [],
  isLoading: false,

  addPersonalFact: async (content: string) => {
    const userStore = useUserStore.getState()
    const expertId = userStore.claimedExpertId
    if (!expertId) return

    const newFact: MemoryFact = {
      id: `fact-${Date.now()}`,
      level: 'personal',
      content,
      source: 'User Input',
      timestamp: new Date().toLocaleString()
    }

    set((state) => {
      const updatedMemories = [newFact, ...state.memories]
      const personalFacts = updatedMemories.filter(m => m.level === 'personal')
      window.api.invoke('db:memory-set', expertId, 'personal', JSON.stringify(personalFacts))
      return { memories: updatedMemories }
    })
  },

  deletePersonalFact: async (id: string) => {
    const userStore = useUserStore.getState()
    const expertId = userStore.claimedExpertId
    if (!expertId) return

    set((state) => {
      const updatedMemories = state.memories.filter(m => m.id !== id)
      const personalFacts = updatedMemories.filter(m => m.level === 'personal')
      window.api.invoke('db:memory-set', expertId, 'personal', JSON.stringify(personalFacts))
      return { memories: updatedMemories }
    })
  },

  loadMemories: async (expertId: string | null) => {
    if (!expertId) {
      set({ memories: [], isLoading: false })
      return
    }

    set({ isLoading: true })
    try {
      // 1. Fetch personal facts from SQLite
      const personalStr = await window.api.invoke('db:memory-get', expertId, 'personal')
      let personalFacts: MemoryFact[] = []
      if (typeof personalStr === 'string' && personalStr) {
        try {
          personalFacts = JSON.parse(personalStr)
        } catch (_) {
          console.error('Failed to parse personal memories JSON')
        }
      } else {
        // Default dummy personal facts if empty
        personalFacts = [{
          id: 'pers-1',
          level: 'personal',
          content: '个人差旅习惯：通常出差乘坐高铁，常去城市为上海、南京。',
          source: '用户历史会话沉淀',
          timestamp: '2026-06-13 09:12'
        }]
        // Save defaults
        await window.api.invoke('db:memory-set', expertId, 'personal', JSON.stringify(personalFacts))
      }

      // 2. Mock corporate facts
      const corporateFacts: MemoryFact[] = [
        {
          id: 'corp-1',
          level: 'corporate',
          content: '公司全称：北京艾姆尔人工智能科技有限公司。纳税人识别号：91110108MA01XXXXXX。',
          source: '企业知识库同步',
          timestamp: '2026-06-10 10:00'
        },
        {
          id: 'corp-2',
          level: 'corporate',
          content: '差旅报销规定：华东/华北区酒店限额 500元/天，伙食补贴 100元/天。超出需VP审批。',
          source: '企业行政管理手册',
          timestamp: '2026-06-11 14:30'
        }
      ]

      // 3. Fetch assistant SOP facts from SQLite
      const agentStr = await window.api.invoke('db:memory-get', expertId, 'agent')
      let assistantFacts: MemoryFact[] = []
      if (typeof agentStr === 'string' && agentStr) {
        try {
          assistantFacts = JSON.parse(agentStr)
        } catch (_) {}
      }

      if (assistantFacts.length === 0) {
        if (expertId === 'expert-1') {
          assistantFacts.push(
            {
              id: 'asst-1',
              level: 'assistant',
              content: 'SOP-01：OA审批填写格式约定 - 标题格式为 [拜访业务]-[客户名称]-[日期]，类型选择[市场拓展]。',
              source: '专家内置技能包',
              timestamp: '2026-06-12 18:00'
            },
            {
              id: 'asst-2',
              level: 'assistant',
              content: 'SOP-02：当审批金额大于1000元时，系统会自动增加财务部门二级会签流程，需提前上传报销电子发票。',
              source: '专家内置技能包',
              timestamp: '2026-06-12 18:00'
            }
          )
        } else if (expertId === 'expert-2') {
          assistantFacts.push(
            {
              id: 'asst-3',
              level: 'assistant',
              content: '发票识别规则：只接受增值税电子普通发票/电子专用发票，不接受手写或剪贴发票。',
              source: '专家内置技能包',
              timestamp: '2026-06-12 18:00'
            }
          )
        } else if (expertId === 'expert-3') {
          assistantFacts.push(
            {
              id: 'asst-4',
              level: 'assistant',
              content: '同步策略：每5分钟扫描本地 documents 目录下的新增变更文件，并生成 MD5 块比对，同步至云端。',
              source: '专家内置技能包',
              timestamp: '2026-06-12 18:00'
            }
          )
        }
        // Save back to DB to ensure persistence
        await window.api.invoke('db:memory-set', expertId, 'agent', JSON.stringify(assistantFacts))
      }

      set({ 
        memories: [...personalFacts, ...assistantFacts, ...corporateFacts], 
        isLoading: false 
      })
    } catch (err) {
      console.error('Failed to load memories:', err)
      set({ isLoading: false })
    }
  }
}))
