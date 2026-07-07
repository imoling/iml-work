import { create } from 'zustand'
import { useUserStore } from './userStore'
import { useHistoryStore } from './historyStore'

export interface FormField {
  name: string
  label: string
  value: string
  type: string
  options?: string[]
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
  skillTag?: { id: string; name: string }   // 本次显式锁定的技能（在用户气泡上展示）
  traceId?: string                            // 该回答对应的 AgentTrace id（供 👍/👎 精确回填）
  sources?: { seq: number; name: string; scope?: string; score: number; excerpt?: string }[]   // 知识溯源(角标+悬浮卡)
  files?: { name: string; sizeBytes: number }[]   // 技能产出文件(文件卡：查看/打开所在位置)
  execLogs?: LogEntry[]                            // 该回复的执行流快照(思考/技能/沙箱时间线，供「执行详情」追溯)
  ontology?: string                                // 本体语义执行技术细节(对象/消解/动作/状态迁移/审计)，「本体执行」折叠区展示
  permGate?: { writeLabels: string[] }            // 先决权限闸(只读含写操作)：两选一卡片
  permGateResolved?: boolean                      // 已选择(禁用按钮)
}

export interface LogEntry {
  type: 'thinking' | 'acting' | 'stdout' | 'observing' | 'completed'
  text: string
  timestamp: string
}

// 会话未读状态：done=有新回复(绿) / attention=需人工介入·表单或权限确认(黄) / error=执行异常(红)
export type UnreadKind = 'done' | 'attention' | 'error'

/*
 * 多会话并行模型（渲染层）：
 * - 主进程 agent:send-message 已 per-run 隔离（runId ≡ convId，AsyncLocalStorage 上下文），
 *   不同会话的任务真并发执行；对同一业务系统的浏览器操作在主进程按 systemId 串行（物理资源保护）。
 *   runQueue 仍保留（FIFO），仅用作缺 runId 时的兜底路由。
 * - messages 只是「当前视图会话」的消息；生成中的会话切走时消息暂存 convCache，切回恢复（在途表单卡/乐观消息不丢）。
 * - 日志流/流式增量/表单请求/权限闸都按事件里的 runId(≡convId) 精确路由：只在正查看该会话时上屏，否则写入其缓存。
 * - 回复到达时若用户不在该会话 → unreadConvs 标未读（历史列表小圆点），切回即读。
 */
interface ChatState {
  messages: Message[]
  viewConvId: string | null                       // messages 当前属于哪个会话（null=新对话欢迎态）
  generatingConvs: Record<string, boolean>        // 会话 → 有在途任务（排队或执行中）
  unreadConvs: Record<string, UnreadKind>         // 会话 → 未读状态（绿/黄/红三态，见 UnreadKind）
  runQueue: string[]                              // 在途任务会话 FIFO（队头正在执行）
  convCache: Record<string, Message[]>            // 生成中会话切走时的内存消息缓存
  convLogs: Record<string, LogEntry[]>            // 会话 → 执行流日志（按队头路由）
  abortedConvs: Record<string, boolean>           // 会话 → 用户已点停止（结果到达时丢弃）
  isDrawerOpen: boolean

  // CLI form state inside the terminal drawer
  activeCliForm: FormRequest | null
  cliFormData: Record<string, string>
  cliCurrentFieldIndex: number

  sendMessage: (content: string, opts?: { forcedSkillId?: string; skillName?: string; permMode?: 'readonly' | 'full'; convId?: string }) => Promise<void>
  loadMessages: (conversationId: string | null) => Promise<void>
  submitBubbleForm: (messageId: string, formData: Record<string, string>) => Promise<void>
  resolvePermGate: (messageId: string, choice: 'continue' | 'switch') => Promise<void>
  cancelTask: () => Promise<void>
  submitDeleteConfirm: (messageId: string, authorized: boolean) => Promise<void>
  toggleDrawer: (open?: boolean) => void
  clearLogs: (convId?: string) => void
  markConvRead: (convId: string) => void
  initIpcListeners: () => () => void
  submitCliField: (value: string) => void
}

export const useChatStore = create<ChatState>((set, get) => {
  // loadMessages 的请求序号：DB 读是异步的，读回来时世界可能已变（用户切了会话/新会话乐观消息
  // 已上屏）。只有「最新一次」加载的结果才允许写屏，迟到的一律丢弃——否则会把在屏内容盖掉。
  let loadSeq = 0

  // 把消息追加到指定会话：正在查看→直接上屏；切走了但有缓存→进缓存；否则丢给 DB（调用方负责落库）
  const appendToConv = (convId: string, msg: Message) => {
    set((s) => {
      if (s.viewConvId === convId) return { messages: [...s.messages, msg] }
      if (s.convCache[convId]) return { convCache: { ...s.convCache, [convId]: [...s.convCache[convId], msg] } }
      return {}
    })
  }

  return {
  messages: [],
  viewConvId: null,
  generatingConvs: {},
  unreadConvs: {},
  runQueue: [],
  convCache: {},
  convLogs: {},
  abortedConvs: {},
  isDrawerOpen: false,
  activeCliForm: null,
  cliFormData: {},
  cliCurrentFieldIndex: 0,

  loadMessages: async (conversationId: string | null) => {
    const seq = ++loadSeq
    const { viewConvId, generatingConvs, convCache } = get()
    // 切走前：当前视图会话仍在生成 → 把在屏消息（含乐观消息/表单卡）缓存，切回时恢复；
    // 若屏上还有未处理的确认表单/权限卡，直接标黄点（需人工介入）
    if (viewConvId && viewConvId !== conversationId && generatingConvs[viewConvId]) {
      set((s) => {
        const pending = s.messages.some(m => (m.formRequest && !m.formSubmitted) || (m.permGate && !m.permGateResolved))
        return {
          convCache: { ...s.convCache, [viewConvId]: s.messages },
          ...(pending ? { unreadConvs: { ...s.unreadConvs, [viewConvId]: 'attention' as UnreadKind } } : {})
        }
      })
    }
    if (!conversationId) { set({ messages: [], viewConvId: null }); return }

    // 目标会话生成中且有缓存 → 用缓存恢复（DB 里还没有在途内容）
    if (generatingConvs[conversationId] && convCache[conversationId]) {
      set({ messages: convCache[conversationId], viewConvId: conversationId })
      get().markConvRead(conversationId)
      return
    }
    // 目标会话生成中且正是当前视图（新会话首条 createConversation 触发的重载）→ 不覆盖乐观消息
    if (generatingConvs[conversationId] && viewConvId === conversationId) return

    try {
      const dbMsgs = await window.api.invoke('db:msg-list', conversationId)
      // ⚠️ DB 读回来后世界可能已变，复核后再写屏（守卫只在 await 前查一次是不够的）：
      // ① 期间又发起了新的加载/切换 → 本次结果已过期；
      // ② 目标会话已开跑且正被查看（新会话首条的乐观消息已上屏，DB 里还没有它）→ 写屏会把消息盖没。
      if (seq !== loadSeq) return
      const cur = get()
      if (cur.generatingConvs[conversationId] && cur.viewConvId === conversationId) return
      const formattedMsgs = Array.isArray(dbMsgs) ? dbMsgs.map((m: any) => {
        let meta: any = null
        try { meta = m.meta ? JSON.parse(m.meta) : null } catch { /* 忽略坏元数据 */ }
        return {
          id: m.id,
          sender: m.role,
          content: m.content,
          timestamp: new Date(m.created_at * 1000).toLocaleTimeString(),
          ...(meta?.traceId ? { traceId: meta.traceId } : {}),
          ...(Array.isArray(meta?.sources) && meta.sources.length ? { sources: meta.sources } : {}),
          ...(Array.isArray(meta?.files) && meta.files.length ? { files: meta.files } : {}),
          ...(Array.isArray(meta?.execLogs) && meta.execLogs.length ? { execLogs: meta.execLogs } : {}),
          ...(typeof meta?.ontology === 'string' && meta.ontology ? { ontology: meta.ontology } : {})
        }
      }) : []
      set({ messages: formattedMsgs, viewConvId: conversationId })
      get().markConvRead(conversationId)
    } catch (err) {
      console.error('Failed to load messages from DB:', err)
    }
  },

  sendMessage: async (content: string, opts?: { forcedSkillId?: string; skillName?: string; permMode?: 'readonly' | 'full'; convId?: string }) => {
    if (!content.trim()) return

    const historyStore = useHistoryStore.getState()
    const userStore = useUserStore.getState()
    const expertId = userStore.claimedExpertId
    if (!expertId) return

    let convId = opts?.convId ?? historyStore.activeConversationId
    // 同一会话同时只允许一个在途任务（其他会话不受影响，可并行发起）
    if (convId && get().generatingConvs[convId]) return

    const userMsg: Message = {
      id: `msg-${Date.now()}-user`,
      sender: 'user',
      content,
      timestamp: new Date().toLocaleTimeString(),
      ...(opts?.forcedSkillId ? { skillTag: { id: opts.forcedSkillId, name: opts.skillName || opts.forcedSkillId } } : {})
    }

    if (!convId) {
      // 新会话：先乐观上屏，再建会话。建会话会改 activeConversationId 触发 App 的 loadMessages，
      // 下方紧接着置 generating+viewConvId，loadMessages 的「生成中且是当前视图」守卫会跳过重载，乐观消息不被冲掉。
      set((state) => ({ messages: [...state.messages, userMsg], activeCliForm: null, cliFormData: {}, cliCurrentFieldIndex: 0 }))
      try {
        const title = content.trim().substring(0, 15) || '新对话'
        convId = await historyStore.createConversation(expertId, title)
      } catch (err) {
        console.error('Failed to auto create conversation:', err)
        return
      }
      set((s) => ({
        viewConvId: convId,
        generatingConvs: { ...s.generatingConvs, [convId!]: true },
        runQueue: [...s.runQueue, convId!],
        convLogs: { ...s.convLogs, [convId!]: [] },
        abortedConvs: { ...s.abortedConvs, [convId!]: false }
      }))
    } else {
      set((s) => {
        const patch: Partial<ChatState> = {
          generatingConvs: { ...s.generatingConvs, [convId!]: true },
          runQueue: [...s.runQueue, convId!],
          convLogs: { ...s.convLogs, [convId!]: [] },
          abortedConvs: { ...s.abortedConvs, [convId!]: false }
        }
        if (s.viewConvId === convId) {
          patch.messages = [...s.messages, userMsg]
          patch.activeCliForm = null; patch.cliFormData = {}; patch.cliCurrentFieldIndex = 0
        } else if (s.convCache[convId!]) {
          patch.convCache = { ...s.convCache, [convId!]: [...s.convCache[convId!], userMsg] }
        }
        return patch
      })
    }

    // Save user message to DB
    try {
      await window.api.invoke('db:msg-add', convId, 'user', content)
    } catch (err) {
      console.error('Failed to save user message to DB:', err)
    }

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

    // 对话上文（供单会话多轮上下文）：取本会话本条之前的历史，只留 user/assistant 文本。
    // 放宽到最近 ~50 轮——主进程 buildHistoryBlock 再做「最近 8 轮逐字 + 更早的压成摘要」，
    // 早期约定/偏好/文件名不因超出最近窗口而丢失（若此处先砍到 8 条，摘要就成了死代码）。
    const convMsgs = get().viewConvId === convId ? get().messages : (get().convCache[convId] || [])
    const history = convMsgs
      .filter(m => (m.sender === 'user' || m.sender === 'assistant') && m.content && m.content.trim())
      .slice(-51, -1)   // 最近 50 轮，排除刚加入的当前用户消息（在末尾）
      .map(m => ({ role: m.sender as 'user' | 'assistant', content: m.content }))

    // 收尾：该会话任务出队 + 清生成态
    const settleConv = () => set((s) => {
      const gen = { ...s.generatingConvs }; delete gen[convId!]
      const cache = { ...s.convCache }; delete cache[convId!]
      const idx = s.runQueue.indexOf(convId!)
      const runQueue = idx >= 0 ? [...s.runQueue.slice(0, idx), ...s.runQueue.slice(idx + 1)] : s.runQueue
      return { generatingConvs: gen, convCache: cache, runQueue }
    })

    try {
      const result = await window.api.invoke('agent:send-message', {
        content,
        expertId,
        expertName,
        userNickname,
        background,
        llmConfig,
        forcedSkillId: opts?.forcedSkillId,
        permMode: opts?.permMode,
        history,
        convId   // runId ≡ convId：主进程 per-run 隔离 + 事件按会话精确路由
      })

      // 用户已对该会话点「停止」→ 丢弃本次结果，不再落库/上屏
      if (get().abortedConvs[convId!]) { settleConv(); return }

      const replyContent = result?.content || '❌ 助手返回了空响应，请检查大模型配置是否正确。'
      const execLogs = get().convLogs[convId!] || []
      const assistantMsg: Message = {
        id: `msg-${Date.now()}-assistant`,
        sender: 'assistant',
        content: replyContent,
        timestamp: new Date().toLocaleTimeString(),
        ...(result?.traceId ? { traceId: result.traceId } : {}),
        ...(Array.isArray(result?.sources) && result.sources.length ? { sources: result.sources } : {}),
        ...(Array.isArray(result?.files) && result.files.length ? { files: result.files } : {}),
        ...(typeof result?.ontology === 'string' && result.ontology ? { ontology: result.ontology } : {}),
        ...(execLogs.length ? { execLogs: [...execLogs] } : {})   // 快照本次执行流，供该消息「执行详情」追溯
      }

      // Save assistant message to DB(附带溯源/traceId/产出文件/执行流 元数据,切会话重载不丢)
      try {
        const meta = (assistantMsg.sources?.length || assistantMsg.traceId || assistantMsg.files?.length || assistantMsg.execLogs?.length || assistantMsg.ontology)
          ? JSON.stringify({ sources: assistantMsg.sources, traceId: assistantMsg.traceId, files: assistantMsg.files, execLogs: assistantMsg.execLogs, ontology: assistantMsg.ontology })
          : null
        await window.api.invoke('db:msg-add', convId, 'assistant', replyContent, meta)
      } catch (err) {
        console.error('Failed to save assistant message to DB:', err)
      }

      const viewing = get().viewConvId === convId
      set((s) => {
        const gen = { ...s.generatingConvs }; delete gen[convId!]
        const cache = { ...s.convCache }; delete cache[convId!]
        const idx = s.runQueue.indexOf(convId!)
        const runQueue = idx >= 0 ? [...s.runQueue.slice(0, idx), ...s.runQueue.slice(idx + 1)] : s.runQueue
        const unread = { ...s.unreadConvs }
        // 不在该会话 → 标未读（覆盖此前的待确认黄点）：正常回复=绿点，空响应兜底=红点
        if (!viewing) unread[convId!] = result?.content ? 'done' : 'error'
        return {
          generatingConvs: gen, convCache: cache, runQueue, unreadConvs: unread,
          ...(viewing ? { messages: [...s.messages, assistantMsg] } : {})
        }
      })

      // 先决权限闸：用户选了「切到允许操作重跑」→ 本次已结束，以 full 权限自动重发原任务（锚定原会话）
      if (result?.permSwitch) {
        const c = content
        setTimeout(() => { get().sendMessage(c, { permMode: 'full', forcedSkillId: opts?.forcedSkillId, skillName: opts?.skillName, convId: convId! }) }, 0)
      }
    } catch (err: any) {
      if (get().abortedConvs[convId!]) { settleConv(); return }
      console.error('Agent communication failed', err)
      const errMsg: Message = {
        id: `msg-${Date.now()}-error`,
        sender: 'system',
        content: `❌ IPC 通信错误: ${err?.message || String(err)}\n\n请检查: 1) 大模型服务是否启动 2) Base URL / API Key 配置是否正确 3) 打开 DevTools 控制台查看详细日志`,
        timestamp: new Date().toLocaleTimeString()
      }
      // 错误也落库：用户切走了也不丢，切回可见
      try { await window.api.invoke('db:msg-add', convId, 'system', errMsg.content) } catch (_) { /* 落库失败仅内存展示 */ }
      appendToConv(convId!, errMsg)
      settleConv()
      if (get().viewConvId !== convId) set((s) => ({ unreadConvs: { ...s.unreadConvs, [convId!]: 'error' } }))
    }
  },

  submitBubbleForm: async (messageId: string, formData: Record<string, string>) => {
    // runId ≡ 当前视图会话：确认卡属于当前会话的任务，回传带上以精确解挂对应 run
    await window.api.invoke('agent:form-submit', formData, get().viewConvId)
    set((state) => ({
      messages: state.messages.map(msg =>
        msg.id === messageId ? { ...msg, formSubmitted: true } : msg
      ),
      activeCliForm: null // Also dismiss CLI form if done via bubble
    }))
  },

  // 先决权限闸选择回传：'continue'（继续跳过写）| 'switch'（切档重跑，由组件负责切 permMode + 重发）
  resolvePermGate: async (messageId: string, choice: 'continue' | 'switch') => {
    set((state) => ({ messages: state.messages.map(m => m.id === messageId ? { ...m, permGateResolved: true } : m) }))
    try { await window.api.invoke('agent:perm-choice', choice, get().viewConvId) } catch (e) { console.error(e) }
  },

  // 终止当前视图会话的任务：标记丢弃结果 + 清生成态。per-run 隔离后 abort 带 runId 只作用于本会话，
  // 任何生成中的会话都可独立停止（不再受「只有队头」限制，因为其他会话是真并发在跑而非排队）。
  cancelTask: async () => {
    const convId = get().viewConvId
    if (!convId || !get().generatingConvs[convId]) return
    set((s) => {
      const gen = { ...s.generatingConvs }; delete gen[convId]
      return {
        abortedConvs: { ...s.abortedConvs, [convId]: true },
        generatingConvs: gen,
        messages: s.messages.map(msg => (msg.formRequest && !msg.formSubmitted) ? { ...msg, formSubmitted: true } : msg),
        activeCliForm: null
      }
    })
    try { window.api.invoke('agent:abort', convId) } catch (_) { /* 主进程不可达时静默 */ }
    try { window.api.invoke('agent:form-cancel', convId) } catch (_) { /* 同上 */ }
  },

  submitDeleteConfirm: async (messageId: string, authorized: boolean) => {
    await window.api.invoke('agent:delete-confirm', authorized, get().viewConvId)
    set((state) => ({
      messages: state.messages.map(msg =>
        msg.id === messageId ? { ...msg, deleteApproved: authorized } : msg
      )
    }))
  },

  toggleDrawer: (open) => {
    set((state) => ({ isDrawerOpen: open !== undefined ? open : !state.isDrawerOpen }))
  },

  clearLogs: (convId?: string) => {
    const target = convId ?? get().viewConvId
    if (!target) return
    set((s) => ({ convLogs: { ...s.convLogs, [target]: [] } }))
  },

  markConvRead: (convId: string) => {
    if (!get().unreadConvs[convId]) return
    set((s) => { const u = { ...s.unreadConvs }; delete u[convId]; return { unreadConvs: u } })
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
      // Completed CLI form! Submit it（带 runId ≡ 当前视图会话）
      window.api.invoke('agent:form-submit', updatedData, get().viewConvId)

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
    // 主进程 per-run 隔离 + 真并发：事件带 runId(≡convId) 精确路由到对应会话；
    // 缺 runId 时（兼容旧后端）退回队头会话。
    const routeConv = (runId?: string) => (runId && get().generatingConvs[runId] ? runId : get().runQueue[0])

    const unsubLog = window.api.on('agent:log-stream', (log: LogEntry & { runId?: string }) => {
      const h = routeConv(log.runId)
      if (!h) return
      set((s) => ({ convLogs: { ...s.convLogs, [h]: [...(s.convLogs[h] || []), log] } }))
    })


    const unsubForm = window.api.on('agent:form-request', (data: FormRequest & { runId?: string }) => {
      const h = routeConv(data.runId)
      if (!h) return
      const msgId = `msg-${Date.now()}-form`
      const newMsg: Message = {
        id: msgId,
        sender: 'assistant',
        content: '⚙️ 机器人执行中，需要您确认表单信息。您可以在下方表单直接确认，或在顶部的调试终端中通过命令行参数输入确认。',
        timestamp: new Date().toLocaleTimeString(),
        formRequest: data,
        formSubmitted: false
      }
      appendToConv(h, newMsg)
      if (get().viewConvId === h) {
        set({
          activeCliForm: data,
          cliFormData: data.fields.reduce((acc, f) => ({ ...acc, [f.name]: f.value }), {}),
          cliCurrentFieldIndex: 0
        })
      } else {
        // 人不在该会话：标黄点——任务停在确认表单上等人工介入
        set((s) => ({ unreadConvs: { ...s.unreadConvs, [h]: 'attention' } }))
      }
    })

    // 先决权限闸：只读模式下任务含写操作 → 主进程开跑前弹「两选一」卡（继续/切档重跑）
    const unsubPerm = window.api.on('agent:perm-gate', (data: { runId?: string; writeLabels: string[] }) => {
      const h = routeConv(data.runId)
      if (!h) return
      const msgId = `msg-${Date.now()}-permgate`
      appendToConv(h, {
        id: msgId, sender: 'assistant',
        content: '', timestamp: new Date().toLocaleTimeString(),
        permGate: { writeLabels: data.writeLabels || [] }, permGateResolved: false
      } as Message)
      // 人不在该会话：权限两选一也属于需人工介入 → 黄点
      if (get().viewConvId !== h) set((s) => ({ unreadConvs: { ...s.unreadConvs, [h]: 'attention' } }))
    })

    // 注：旧「agent:delete-request」订阅已移除——main 侧发射端早在移除“假复杂任务剧场”时就已删除，
    // 该通道也不在 preload 白名单（启动即报“拒绝未登记的 on 通道”）。删除类确认现走
    // 表单确认(agent:form-request) + 后端一次性签名令牌。消息里的 deleteRequest 渲染分支保留（不可达）。

    return () => {
      unsubLog()
      unsubForm()
      unsubPerm()
    }
  }
  }
})
