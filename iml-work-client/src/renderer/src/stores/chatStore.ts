import { create } from 'zustand'
import { useUserStore } from './userStore'
import { useHistoryStore } from './historyStore'

export interface FormField {
  name: string
  label: string
  value: string
  type: string
}

export interface FormRequest {
  fields: FormField[]
}

export interface DeleteRequest {
  message: string
}

export interface Message {
  id: string
  sender: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  formRequest?: FormRequest
  deleteRequest?: DeleteRequest
  formSubmitted?: boolean
  deleteApproved?: boolean | null
}

export interface LogEntry {
  type: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed'
  text: string
  timestamp: string
}

interface ChatState {
  messages: Message[]
  logs: LogEntry[]
  isDrawerOpen: boolean
  isGenerating: boolean
  
  // CLI form state inside the terminal drawer
  activeCliForm: FormRequest | null
  cliFormData: Record<string, string>
  cliCurrentFieldIndex: number
  
  sendMessage: (content: string) => Promise<void>
  loadMessages: (conversationId: string | null) => Promise<void>
  submitBubbleForm: (messageId: string, formData: Record<string, string>) => Promise<void>
  submitDeleteConfirm: (messageId: string, authorized: boolean) => Promise<void>
  toggleDrawer: (open?: boolean) => void
  clearLogs: () => void
  initIpcListeners: () => () => void
  submitCliField: (value: string) => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [
    {
      id: 'welcome',
      sender: 'assistant',
      content: '您好！我是您的专家助手容器。在您领用岗位专家后，我将载入对应的专业技能并在安全沙箱内执行自动化RPA与数据分析任务。请问有什么我可以帮您的？',
      timestamp: new Date().toLocaleTimeString()
    }
  ],
  logs: [],
  isDrawerOpen: false,
  isGenerating: false,
  activeCliForm: null,
  cliFormData: {},
  cliCurrentFieldIndex: 0,

  loadMessages: async (conversationId: string | null) => {
    if (!conversationId) {
      set({
        messages: [
          {
            id: 'welcome',
            sender: 'assistant',
            content: '您好！我是您的专家助手容器。在您领用岗位专家后，我将载入对应的专业技能并在安全沙箱内执行自动化RPA与数据分析任务。请问有什么我可以帮您的？',
            timestamp: new Date().toLocaleTimeString()
          }
        ]
      })
      return
    }

    try {
      const dbMsgs = await window.api.invoke('db:msg-list', conversationId)
      const formattedMsgs = Array.isArray(dbMsgs) ? dbMsgs.map((m: any) => ({
        id: m.id,
        sender: m.role,
        content: m.content,
        timestamp: new Date(m.created_at * 1000).toLocaleTimeString()
      })) : []

      if (formattedMsgs.length === 0) {
        set({
          messages: [
            {
              id: 'welcome',
              sender: 'assistant',
              content: '您好！我是您的专家助手容器。在您领用岗位专家后，我将载入对应的专业技能并在安全沙箱内执行自动化RPA与数据分析任务。请问有什么我可以帮您的？',
              timestamp: new Date().toLocaleTimeString()
            }
          ]
        })
      } else {
        set({ messages: formattedMsgs })
      }
    } catch (err) {
      console.error('Failed to load messages from DB:', err)
    }
  },

  sendMessage: async (content: string) => {
    if (!content.trim() || get().isGenerating) return

    const historyStore = useHistoryStore.getState()
    const userStore = useUserStore.getState()
    const expertId = userStore.claimedExpertId
    if (!expertId) return

    let convId = historyStore.activeConversationId
    if (!convId) {
      try {
        // Use part of user message as conversation title
        const title = content.trim().substring(0, 15) || '新对话'
        convId = await historyStore.createConversation(expertId, title)
      } catch (err) {
        console.error('Failed to auto create conversation:', err)
        return
      }
    }

    const userMsg: Message = {
      id: `msg-${Date.now()}-user`,
      sender: 'user',
      content,
      timestamp: new Date().toLocaleTimeString()
    }

    set((state) => ({
      messages: [...state.messages, userMsg],
      isGenerating: true,
      logs: [], // Clear logs for new session
      activeCliForm: null,
      cliFormData: {},
      cliCurrentFieldIndex: 0
    }))

    // Save user message to DB
    try {
      await window.api.invoke('db:msg-add', convId, 'user', content)
    } catch (err) {
      console.error('Failed to save user message to DB:', err)
    }

    // Keep the execution drawer collapsed by default; its status bar reflects
    // "running" while generating. The user expands it manually to see the flow.

    const expertName = userStore.getCurrentExpertName()
    const background = userStore.userBackground
    const userNickname = userStore.userNickname
    const rawMode = userStore.llmConnectionMode
    const rawApiMode = userStore.llmApiMode
    const llmConfig = {
      mode: (rawMode === 'proxy' || rawMode === 'direct') ? rawMode : 'direct',
      apiMode: (rawApiMode === 'chat' || rawApiMode === 'anthropic') ? rawApiMode : 'chat',
      baseUrl: typeof userStore.llmBaseUrl === 'string' ? userStore.llmBaseUrl : '',
      apiKey: typeof userStore.llmApiKey === 'string' ? userStore.llmApiKey : '',
      modelName: typeof userStore.llmModelName === 'string' ? userStore.llmModelName : ''
    }

    try {
      const result = await window.api.invoke('agent:send-message', {
        content,
        expertId,
        expertName,
        userNickname,
        background,
        llmConfig
      })

      const replyContent = result?.content || '❌ 助手返回了空响应，请检查大模型配置是否正确。'
      const assistantMsg: Message = {
        id: `msg-${Date.now()}-assistant`,
        sender: 'assistant',
        content: replyContent,
        timestamp: new Date().toLocaleTimeString()
      }

      // Save assistant message to DB
      try {
        await window.api.invoke('db:msg-add', convId, 'assistant', replyContent)
      } catch (err) {
        console.error('Failed to save assistant message to DB:', err)
      }

      set((state) => ({
        messages: [...state.messages, assistantMsg],
        isGenerating: false
      }))
    } catch (err: any) {
      console.error('Agent communication failed', err)
      const errMsg: Message = {
        id: `msg-${Date.now()}-error`,
        sender: 'system',
        content: `❌ IPC 通信错误: ${err?.message || String(err)}\n\n请检查: 1) 大模型服务是否启动 2) Base URL / API Key 配置是否正确 3) 打开 DevTools 控制台查看详细日志`,
        timestamp: new Date().toLocaleTimeString()
      }
      set((state) => ({
        messages: [...state.messages, errMsg],
        isGenerating: false
      }))
    }
  },

  submitBubbleForm: async (messageId: string, formData: Record<string, string>) => {
    await window.api.invoke('agent:form-submit', formData)
    set((state) => ({
      messages: state.messages.map(msg => 
        msg.id === messageId ? { ...msg, formSubmitted: true } : msg
      ),
      activeCliForm: null // Also dismiss CLI form if done via bubble
    }))
  },

  submitDeleteConfirm: async (messageId: string, authorized: boolean) => {
    await window.api.invoke('agent:delete-confirm', authorized)
    set((state) => ({
      messages: state.messages.map(msg => 
        msg.id === messageId ? { ...msg, deleteApproved: authorized } : msg
      )
    }))
  },

  toggleDrawer: (open) => {
    set((state) => ({ isDrawerOpen: open !== undefined ? open : !state.isDrawerOpen }))
  },

  clearLogs: () => {
    set({ logs: [] })
  },

  submitCliField: (value: string) => {
    const { activeCliForm, cliCurrentFieldIndex, cliFormData } = get()
    if (!activeCliForm) return

    const field = activeCliForm.fields[cliCurrentFieldIndex]
    const updatedData = { ...cliFormData, [field.name]: value }

    set({ cliFormData: updatedData })

    if (cliCurrentFieldIndex + 1 < activeCliForm.fields.length) {
      set({ cliCurrentFieldIndex: cliCurrentFieldIndex + 1 })
    } else {
      // Completed CLI form! Submit it
      window.api.invoke('agent:form-submit', updatedData)
      
      // Update any pending form bubble in chat
      set((state) => ({
        messages: state.messages.map(msg => 
          msg.formRequest ? { ...msg, formSubmitted: true } : msg
        ),
        activeCliForm: null,
        cliFormData: {},
        cliCurrentFieldIndex: 0
      }))
    }
  },

  initIpcListeners: () => {
    const unsubLog = window.api.on('agent:log-stream', (log: LogEntry) => {
      set((state) => ({ logs: [...state.logs, log] }))
    })

    const unsubForm = window.api.on('agent:form-request', (data: FormRequest) => {
      const msgId = `msg-${Date.now()}-form`
      const newMsg: Message = {
        id: msgId,
        sender: 'assistant',
        content: '⚙️ 机器人执行中，需要您确认表单信息。您可以在下方表单直接确认，或在顶部的调试终端中通过命令行参数输入确认。',
        timestamp: new Date().toLocaleTimeString(),
        formRequest: data,
        formSubmitted: false
      }
      set((state) => ({
        messages: [...state.messages, newMsg],
        activeCliForm: data,
        cliFormData: data.fields.reduce((acc, f) => ({ ...acc, [f.name]: f.value }), {}),
        cliCurrentFieldIndex: 0
      }))
    })

    const unsubDelete = window.api.on('agent:delete-request', (data: DeleteRequest) => {
      const msgId = `msg-${Date.now()}-delete`
      const newMsg: Message = {
        id: msgId,
        sender: 'assistant',
        content: '⚠️ 警告：检测到敏感物理删除操作请求。',
        timestamp: new Date().toLocaleTimeString(),
        deleteRequest: data,
        deleteApproved: null
      }
      set((state) => ({
        messages: [...state.messages, newMsg]
      }))
    })

    return () => {
      unsubLog()
      unsubForm()
      unsubDelete()
    }
  }
}))
