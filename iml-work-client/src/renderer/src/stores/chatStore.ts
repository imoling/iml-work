import { create } from 'zustand'
import { useUserStore } from './userStore'
import { useHistoryStore } from './historyStore'
import type { CoreEvent } from '../../../shared/core-protocol'
import { applyTurnEvent, toSnapshot, EMPTY_TURN_RUN, type CoreRunSnapshot, type CoreRunState } from './core-state'

export type { CoreRunSnapshot, CoreRunState }

export interface FormField {
  name: string
  label: string
  value: string
  type: string
  options?: string[]
  readonly?: boolean   // 真实读到的单据内容：只可核对，不可修改
}

export interface FormRequest {
  fields: FormField[]
  kind?: string          // 'confirm'=业务写确认（默认） / 'clarify'=任务前置澄清
  title?: string         // 卡片标题（缺省按 kind 取默认文案）
  submitLabel?: string   // 提交按钮文案
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
  /** 卡片是被「停止任务」关掉的，不是用户填完提交的——两者显示必须分开，
   *  否则取消后卡片写着"已完成表单数据确认与系统同步提交"，是在对用户说谎。 */
  formCancelled?: boolean
  planProposal?: { summary: string; steps: string[] }
  planApproved?: boolean
  deleteApproved?: boolean | null
  skillTag?: { id: string; name: string }   // 本次显式锁定的技能（在用户气泡上展示）
  traceId?: string                            // 该回答对应的 AgentTrace id（供 👍/👎 精确回填）
  sources?: { seq: number; name: string; scope?: string; score: number; excerpt?: string }[]   // 知识溯源(角标+悬浮卡)
  webSources?: { title: string; url: string }[]   // 联网检索来源(结果卡「联网来源」，可点开原网页，区别于知识来源)
  files?: { name: string; sizeBytes: number }[]   // 技能产出文件(文件卡：查看/打开所在位置)
  execLogs?: LogEntry[]                            // 该回复的执行流快照(思考/技能/沙箱时间线，供「执行详情」追溯)
  ontology?: string                                // 本体语义执行技术细节(对象/消解/动作/状态迁移/审计)，「本体执行」折叠区展示
  permGate?: { writeLabels: string[] }            // 先决权限闸(只读含写操作)：两选一卡片
  permGateResolved?: boolean                      // 已选择(禁用按钮)
  permGateChoice?: 'continue' | 'switch'          // 选了哪个：卡片原地显示切换态(合并"已切到…重跑"气泡)
  loginRequest?: { systemId: string; systemName: string; baseUrl: string; retryContent?: string; retrySkillId?: string; retrySkillName?: string }   // 登录卡(业务系统未登录：去登录+一键重试；retrySkill*=重试时还原技能锁)
  loginResolved?: boolean                          // 登录卡已落定(已登录并重跑)：按钮禁用、原地显示落定态
  turn?: CoreRunSnapshot                           // 新执行内核的过程快照(任务清单+工具调用行)，随消息回放
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
  turnRuns: Record<string, CoreRunState>          // 会话 → 新内核执行中的实时态（清单/工具行/叙述）
  turnEngineOn: boolean                           // 新执行内核是否启用（主进程 config 为真值，这里是缓存）
  // 会话 → 运行代次。每按一次「停止」就 +1；每次发送在开跑时记下当时的代次，
  // 结果回来发现代次变了 = 这一轮已被作废，直接丢弃。
  // 为什么不是布尔「已停止」：那个标记按会话存、且每次新发送都会重置为 false——
  // 「停止任务 → 在同一会话里再问一句」时，上一轮的停止标记就被抹掉了，
  // 于是被停掉的任务跑完后照样把答复插进来，插在新答复后面（2026-08-02 实测）。
  convEpoch: Record<string, number>
  isDrawerOpen: boolean

  // CLI form state inside the terminal drawer
  activeCliForm: FormRequest | null
  cliFormData: Record<string, string>
  cliCurrentFieldIndex: number

  /**
   * 新对话尚未建库时选中的模型档位（composer 的 ModelPicker 写入）。
   * 会话是首次发送时才创建的，选择没处安放；发送流程建完会话立即落库并清空。
   */
  pendingConvModel: string
  setPendingConvModel: (modelName: string) => void

  sendMessage: (content: string, opts?: { forcedSkillId?: string; skillName?: string; permMode?: 'readonly' | 'full'; convId?: string; unattended?: boolean; taskRun?: { runId: number } }) => Promise<void>
  compactContext: () => Promise<void>
  loadMessages: (conversationId: string | null) => Promise<void>
  submitBubbleForm: (messageId: string, formData: Record<string, string>) => Promise<void>
  approvePlan: (messageId: string) => Promise<void>
  resolvePermGate: (messageId: string, choice: 'continue' | 'switch') => Promise<void>
  resolveLoginCard: (messageId: string) => void
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
  turnRuns: {},
  turnEngineOn: false,
  convEpoch: {},
  isDrawerOpen: false,
  activeCliForm: null,
  cliFormData: {},
  cliCurrentFieldIndex: 0,
  pendingConvModel: '',
  setPendingConvModel: (modelName: string) => set({ pendingConvModel: modelName }),

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
          ...(Array.isArray(meta?.webSources) && meta.webSources.length ? { webSources: meta.webSources } : {}),
          ...(Array.isArray(meta?.files) && meta.files.length ? { files: meta.files } : {}),
          ...(Array.isArray(meta?.execLogs) && meta.execLogs.length ? { execLogs: meta.execLogs } : {}),
          ...(typeof meta?.ontology === 'string' && meta.ontology ? { ontology: meta.ontology } : {}),
          ...(meta?.loginRequest ? { loginRequest: meta.loginRequest } : {}),
          ...(meta?.loginResolved ? { loginResolved: true } : {}),
          ...(meta?.turn ? { turn: meta.turn } : {})
        }
      }) : []
      set({ messages: formattedMsgs, viewConvId: conversationId })
      get().markConvRead(conversationId)
    } catch (err) {
      console.error('Failed to load messages from DB:', err)
    }
  },

  // 手动「整理上下文」（对标 /compact）：把当前会话全部轮次压成持久要点摘要，
  // 之后的轮次只携带「摘要 + 新对话」。摘要落主进程本地库（按会话），跨重启保留。
  compactContext: async () => {
    const convId = get().viewConvId
    if (!convId) return
    const eligible = get().messages.filter(m => (m.sender === 'user' || m.sender === 'assistant') && m.content && m.content.trim())
    if (eligible.length < 2) return
    const userStore = useUserStore.getState()
    const rawMode = userStore.llmConnectionMode
    const llmConfig = {
      mode: (rawMode === 'proxy' || rawMode === 'direct') ? rawMode : 'direct',
      baseUrl: typeof userStore.llmBaseUrl === 'string' ? userStore.llmBaseUrl : '',
      apiKey: typeof userStore.llmApiKey === 'string' ? userStore.llmApiKey : '',
      modelName: typeof userStore.llmModelName === 'string' ? userStore.llmModelName : ''
    }
    const history = eligible.slice(-50).map(m => ({ role: m.sender as 'user' | 'assistant', content: m.content }))
    const r = await window.api.invoke('context:compact', { convId, history, histTotal: eligible.length, llmConfig })
    const markerText = r?.ok
      ? `✅ 已整理上下文：此前 ${eligible.length} 轮对话已压缩为要点摘要（跨重启保留），后续对话在摘要基础上继续，不再逐字携带早前轮次。`
      : `⚠️ 整理上下文失败：${r?.error || '未知错误'}`
    const marker = {
      id: `compact-${Date.now()}`,
      sender: 'assistant' as const,
      content: markerText,
      timestamp: new Date().toLocaleTimeString()
    }
    set(s => (s.viewConvId === convId ? { messages: [...s.messages, marker] } : {}))
    if (r?.ok) {
      try { await window.api.invoke('db:msg-add', convId, 'assistant', markerText) } catch (err) { console.error('保存整理标记失败:', err) }
    }
  },

  sendMessage: async (content: string, opts?: { forcedSkillId?: string; skillName?: string; permMode?: 'readonly' | 'full'; convId?: string; unattended?: boolean; taskRun?: { runId: number } }) => {
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
      // 会话刚建好，把 composer 上选的档位落到这条会话（选了才写，没选就跟随全局默认）
      const pendingModel = get().pendingConvModel
      if (pendingModel) {
        try { await window.api.invoke('turn:conv-model-set', { convId, modelName: pendingModel }) }
        catch (err) { console.error('保存会话模型档位失败:', err) }
      }
      set({ pendingConvModel: '' })
      set((s) => ({
        viewConvId: convId,
        generatingConvs: { ...s.generatingConvs, [convId!]: true },
        runQueue: [...s.runQueue, convId!],
        convLogs: { ...s.convLogs, [convId!]: [] }
      }))
    } else {
      set((s) => {
        const patch: Partial<ChatState> = {
          generatingConvs: { ...s.generatingConvs, [convId!]: true },
          runQueue: [...s.runQueue, convId!],
          convLogs: { ...s.convLogs, [convId!]: [] }
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
    // 模型配置与会话历史都以主进程为唯一真值（AgentCore 自持 turn_message 轨迹），渲染层不再拼装快照。

    // 收尾：该会话任务出队 + 清生成态
    // 本轮的代次快照：结果回来时与当前值比对，不等说明本轮已被停止作废。
    const myEpoch = get().convEpoch[convId!] ?? 0
    // 作废的轮次**什么都不做**：会话的生成态/缓存/队列此刻可能已归新一轮所有，
    // 这时候去 settleConv 会把正在跑的新任务的生成指示清掉。清理由 cancelTask 负责。
    const stale = () => (get().convEpoch[convId!] ?? 0) !== myEpoch

    const settleConv = () => set((s) => {
      const gen = { ...s.generatingConvs }; delete gen[convId!]
      const cache = { ...s.convCache }; delete cache[convId!]
      const idx = s.runQueue.indexOf(convId!)
      const runQueue = idx >= 0 ? [...s.runQueue.slice(0, idx), ...s.runQueue.slice(idx + 1)] : s.runQueue
      return { generatingConvs: gen, convCache: cache, runQueue }
    })

    try {
      // 新执行内核（AgentCore）与旧管线**并存**，由主进程 config 开关切换：
      // AgentCore 唯一链路（旧管线 v2.0.0 下线；上游不认 tools 时主进程内部降级，这里不感知）。
      set((s) => ({ turnRuns: { ...s.turnRuns, [convId!]: EMPTY_TURN_RUN }, turnEngineOn: true }))

      const result = await window.api.invoke('turn:send-message', {
        content, convId, expertId, expertName, userNickname, background,
        permMode: opts?.permMode,
        unattended: opts?.unattended,   // 定时任务等无人值守来源：阻塞式交互须放行（没人在屏幕前）
        forcedSkillId: opts?.forcedSkillId,   // 显式锁定 → 内核确定性直执，不赌模型会不会调
      })

      // 用户已对该会话点「停止」→ 丢弃本次结果，不再落库/上屏
      if (stale()) return

      const replyContent = result?.content || '❌ 助手返回了空响应，请检查大模型配置是否正确。'
      // 执行流以**主进程随结果返回的那份**为准（真值）。以前是回执到达后再去本地 store 里捞——
      // 日志走 webContents.send、结果走 invoke 回执，两条 IPC 通道到达顺序无保证：结果先到时，
      // 最后一条日志还在路上，快照就少一条，「执行详情」看着像卡在中途没执行完。
      // 主进程没带回来（老版本/异常）才退回 store 快照。
      const execLogs: LogEntry[] = (Array.isArray(result?.execLogs) && result.execLogs.length)
        ? result.execLogs
        : (get().convLogs[convId!] || [])
      const assistantMsg: Message = {
        id: `msg-${Date.now()}-assistant`,
        sender: 'assistant',
        content: replyContent,
        timestamp: new Date().toLocaleTimeString(),
        ...(result?.traceId ? { traceId: result.traceId } : {}),
        ...(Array.isArray(result?.sources) && result.sources.length ? { sources: result.sources } : {}),
        ...(Array.isArray(result?.webSources) && result.webSources.length ? { webSources: result.webSources } : {}),
        ...(Array.isArray(result?.files) && result.files.length ? { files: result.files } : {}),
        ...(typeof result?.ontology === 'string' && result.ontology ? { ontology: result.ontology } : {}),
        ...(result?.loginRequest ? { loginRequest: result.loginRequest } : {}),
        ...(execLogs.length ? { execLogs: [...execLogs] } : {}),   // 快照本次执行流，供该消息「执行详情」追溯
        // 新内核的过程快照（任务清单+工具行）随消息走：切会话/重启后回放与实时视图一致。
        // 轮数以**主进程随结果返回的那份**为准（同 execLogs 的理由：事件与回执是两条 IPC 通道，
        // 到达顺序无保证；只认事件的话结果先到就拿不到轮数）。
        ...(() => {
          const t = toSnapshot(get().turnRuns[convId!])
          if (!t) return {}
          return { turn: typeof result?.iterations === 'number' ? { ...t, iterations: result.iterations } : t }
        })()
      }

      // 切档重跑的「已切到…重跑」是过渡态，已合并进权限卡原地显示 → 不单独落库/上屏一条气泡（避免两气泡）。
      const isPermSwitch = !!result?.permSwitch
      // Save assistant message to DB(附带溯源/traceId/产出文件/执行流 元数据,切会话重载不丢)
      if (!isPermSwitch) try {
        const meta = (assistantMsg.sources?.length || assistantMsg.webSources?.length || assistantMsg.traceId || assistantMsg.files?.length || assistantMsg.execLogs?.length || assistantMsg.ontology || assistantMsg.loginRequest || assistantMsg.turn)
          ? JSON.stringify({ sources: assistantMsg.sources, webSources: assistantMsg.webSources, traceId: assistantMsg.traceId, files: assistantMsg.files, execLogs: assistantMsg.execLogs, ontology: assistantMsg.ontology, loginRequest: assistantMsg.loginRequest, turn: assistantMsg.turn })
          : null
        await window.api.invoke('db:msg-add', convId, 'assistant', replyContent, meta)
      } catch (err) {
        console.error('Failed to save assistant message to DB:', err)
      }

      // 定时任务运行记录回填：状态 + 摘要 + 产物数（详情页 Runs 列表的数据源）
      if (opts?.taskRun?.runId) {
        window.api.invoke('task-run:finish', {
          runId: opts.taskRun.runId,
          status: result?.content ? 'ok' : 'error',
          summary: (result?.content || '').replace(/\s+/g, ' ').slice(0, 200),
          fileCount: Array.isArray(result?.files) ? result.files.length : 0,
        }).catch(() => {})
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
          ...(viewing && !isPermSwitch ? { messages: [...s.messages, assistantMsg] } : {})
        }
      })

      // 先决权限闸：用户选了「切到允许操作重跑」→ 本次已结束，以 full 权限自动重发原任务（锚定原会话）
      if (result?.permSwitch) {
        const c = content
        setTimeout(() => { get().sendMessage(c, { permMode: 'full', forcedSkillId: opts?.forcedSkillId, skillName: opts?.skillName, convId: convId! }) }, 0)
      }
    } catch (err: any) {
      if (stale()) return
      // 定时任务的运行记录：失败也要回填状态，别让详情页永远显示 running
      if (opts?.taskRun?.runId) {
        window.api.invoke('task-run:finish', { runId: opts.taskRun.runId, status: 'error', summary: String(err?.message || err).slice(0, 200) }).catch(() => {})
      }
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

  // 行动方案批准：标记卡片已批准，并以「先问再做」档带方案上下文继续执行
  approvePlan: async (messageId: string) => {
    set((state) => ({ messages: state.messages.map(m => m.id === messageId ? { ...m, planApproved: true } : m) }))
    await get().sendMessage('同意，按你刚才提出的行动方案执行。', { permMode: 'full' })
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
    set((state) => ({ messages: state.messages.map(m => m.id === messageId ? { ...m, permGateResolved: true, permGateChoice: choice } : m) }))
    try { await window.api.invoke('agent:perm-choice', choice, get().viewConvId) } catch (e) { console.error(e) }
  },

  // 登录卡落定：已登录并重跑 → 卡片原地转落定态（按钮禁用），并回写 meta 使切会话/重启后不回退。
  resolveLoginCard: (messageId: string) => {
    const msg = get().messages.find(m => m.id === messageId)
    if (!msg || msg.loginResolved) return
    set((state) => ({ messages: state.messages.map(m => m.id === messageId ? { ...m, loginResolved: true } : m) }))
    try {
      const meta = JSON.stringify({ sources: msg.sources, webSources: msg.webSources, traceId: msg.traceId, files: msg.files, execLogs: msg.execLogs, ontology: msg.ontology, loginRequest: msg.loginRequest, loginResolved: true })
      window.api.invoke('db:msg-update-meta', messageId, meta)
    } catch (e) { console.error(e) }
  },

  // 终止当前视图会话的任务：标记丢弃结果 + 清生成态。per-run 隔离后 abort 带 runId 只作用于本会话，
  // 任何生成中的会话都可独立停止（不再受「只有队头」限制，因为其他会话是真并发在跑而非排队）。
  cancelTask: async () => {
    const convId = get().viewConvId
    if (!convId || !get().generatingConvs[convId]) return
    set((s) => {
      const gen = { ...s.generatingConvs }; delete gen[convId]
      // 收尾清理归停止方做（迟到的结果只负责闭嘴），否则停止后 runQueue/convCache 会留残留
      const cache = { ...s.convCache }; delete cache[convId]
      const idx = s.runQueue.indexOf(convId)
      const runQueue = idx >= 0 ? [...s.runQueue.slice(0, idx), ...s.runQueue.slice(idx + 1)] : s.runQueue
      return {
        convEpoch: { ...s.convEpoch, [convId]: (s.convEpoch[convId] ?? 0) + 1 },
        generatingConvs: gen,
        convCache: cache,
        runQueue,
        messages: s.messages.map(msg => (msg.formRequest && !msg.formSubmitted)
          ? { ...msg, formSubmitted: true, formCancelled: true } : msg),
        activeCliForm: null
      }
    })
    try { window.api.invoke('agent:abort', convId) } catch (_) { /* 主进程不可达时静默 */ }
    try { window.api.invoke('agent:form-cancel', convId) } catch (_) { /* 同上 */ }

    // 对话里留下明确标识：停止之后屏幕上原先什么都不会变——转圈没了、也没有任何一句话说明
    // 发生过什么，事后回看这条会话完全不知道当时是被停掉的还是自己跑完的（实测反馈）。
    const stopMsg: Message = {
      id: `msg-${Date.now()}-stopped`,
      sender: 'system',
      content: '🚫 已停止本次任务。已经做完的步骤不会回滚；需要的话可以重新发一次。',
      timestamp: new Date().toLocaleTimeString(),
    }
    try { await window.api.invoke('db:msg-add', convId, 'system', stopMsg.content) } catch (_) { /* 落库失败仅内存展示 */ }
    appendToConv(convId, stopMsg)
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
    // 开关的真值在主进程 config；这里先同步一次，之后每次发消息再校准。
    window.api.invoke('turn:enabled').then((v: any) => set({ turnEngineOn: !!v })).catch(() => {})

    // 主进程 per-run 隔离 + 真并发：事件带 runId(≡convId) 精确路由到对应会话；
    // 缺 runId 时（兼容旧后端）退回队头会话。
    const routeConv = (runId?: string) => (runId && get().generatingConvs[runId] ? runId : get().runQueue[0])

    const unsubLog = window.api.on('agent:log-stream', (log: LogEntry & { runId?: string }) => {
      const h = routeConv(log.runId)
      if (!h) return
      set((s) => ({ convLogs: { ...s.convLogs, [h]: [...(s.convLogs[h] || []), log] } }))
    })

    // 新执行内核的结构化事件流：驱动对话框里的任务清单与工具调用行。
    // 与 agent:log-stream 的区别——那是给「执行详情」抽屉看的散装文本，这是**结构化**过程展示，
    // 结束后原样存进消息快照，刷新回放和实时视图长得一模一样。
    const unsubTurn = window.api.on('turn:event', (ev: CoreEvent) => {
      const h = routeConv(ev.runId)
      if (!h) return
      set((s) => {
        const cur: CoreRunState = s.turnRuns[h] || EMPTY_TURN_RUN
        const next = applyTurnEvent(cur, ev)
        return next === cur ? {} : { turnRuns: { ...s.turnRuns, [h]: next } }
      })
    })


    // 行动方案卡（讨论档 Plan 流转）：模型侦查完提交方案 → 卡片 → 用户点「按此执行」自动切档继续
    const unsubPlan = window.api.on('agent:plan-proposal', (data: { runId?: string; summary: string; steps: string[] }) => {
      const h = routeConv(data.runId)
      if (!h) return
      appendToConv(h, {
        id: `msg-${Date.now()}-plan`,
        sender: 'assistant',
        content: '📋 只读侦查完成，我整理了一份行动方案——确认后我会切到「先问再做」档开始执行（写入前仍会逐项跟你确认）。',
        timestamp: new Date().toLocaleTimeString(),
        planProposal: { summary: data.summary, steps: data.steps || [] },
        planApproved: false,
      } as Message)
    })
    const unsubForm = window.api.on('agent:form-request', (data: FormRequest & { runId?: string }) => {
      const h = routeConv(data.runId)
      if (!h) return
      const msgId = `msg-${Date.now()}-form`
      // 卡片带上模型自己那句说明，而不是一句通用样板话。
      //
      // 模型在调 ask_user 之前会先叙述一句（"找到了两个候选仓库，来源不同…"），那句才是
      // 用户判断所需的信息。它此前只出现在「执行中」的临时气泡里——于是屏幕上出现两个气泡：
      // 卡片说着没信息量的样板话，真正的说明在下面那个转圈气泡里，**而且任务一结束就消失**。
      // 叙述在工具执行前就已发事件（agent-core），所以这里读得到。
      const narration = (get().turnRuns[h]?.narration || '').trim()
      const fallback = data.kind === 'ask'
        ? '💬 执行中有一个问题需要你回答，回答后我会接着继续做。'
        : data.kind === 'clarify'
          ? '💬 开始执行前需要补充一点任务信息——请在下方选择或输入后继续。'
          : '⚙️ 机器人执行中，需要您确认表单信息。您可以在下方表单直接确认，或在顶部的调试终端中通过命令行参数输入确认。'
      const newMsg: Message = {
        id: msgId,
        sender: 'assistant',
        // **只**对提问/澄清两类生效（白名单，不是排除法）：写操作签字卡的 kind 是 undefined，
        // 用排除法会把旁白混进签字卡——而那张卡讲的是"将要改动什么"，得由卡片字段自己说清楚，
        // 掺进模型的旁白只会稀释掉用户真正该核对的东西。
        content: narration && (data.kind === 'ask' || data.kind === 'clarify') ? `💬 ${narration}` : fallback,
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
      unsubTurn()
      unsubForm(); unsubPlan()
      unsubPerm()
    }
  }
  }
})
