import { create } from 'zustand'

export interface Conversation {
  id: string
  expert_id: string
  title: string
  created_at: number
  updated_at: number
}

interface HistoryState {
  conversations: Conversation[]
  activeConversationId: string | null
  isLoading: boolean
  loadConversations: (expertId: string) => Promise<void>
  createConversation: (expertId: string, title?: string) => Promise<string>
  deleteConversation: (id: string) => Promise<void>
  setActiveConversationId: (id: string | null) => void
  updateConversationTitle: (id: string, title: string) => Promise<void>
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  isLoading: false,

  loadConversations: async (expertId: string) => {
    set({ isLoading: true })
    try {
      const list = await window.api.invoke('db:conv-list', expertId)
      const validList = Array.isArray(list) ? list : []
      set({ conversations: validList, isLoading: false })
      
      // Auto select the first conversation if none is active
      if (validList.length > 0 && !get().activeConversationId) {
        set({ activeConversationId: validList[0].id })
      }
    } catch (err) {
      console.error('Failed to load conversations:', err)
      set({ isLoading: false })
    }
  },

  createConversation: async (expertId: string, title = '新对话') => {
    try {
      const id = await window.api.invoke('db:conv-create', expertId, title)
      // Reload the list
      const list = await window.api.invoke('db:conv-list', expertId)
      set({ conversations: Array.isArray(list) ? list : [], activeConversationId: id })
      return id
    } catch (err) {
      console.error('Failed to create conversation:', err)
      throw err
    }
  },

  deleteConversation: async (id: string) => {
    try {
      await window.api.invoke('db:conv-delete', id)
      const { activeConversationId, conversations } = get()
      const updatedList = conversations.filter(c => c.id !== id)
      
      let nextActiveId = activeConversationId
      if (activeConversationId === id) {
        nextActiveId = updatedList.length > 0 ? updatedList[0].id : null
      }
      
      set({ conversations: updatedList, activeConversationId: nextActiveId })
    } catch (err) {
      console.error('Failed to delete conversation:', err)
    }
  },

  setActiveConversationId: (id: string | null) => {
    set({ activeConversationId: id })
  },

  updateConversationTitle: async (id: string, title: string) => {
    try {
      await window.api.invoke('db:conv-update-title', id, title)
      set((state) => ({
        conversations: state.conversations.map(c => c.id === id ? { ...c, title } : c)
      }))
    } catch (err) {
      console.error('Failed to update conversation title:', err)
    }
  }
}))
