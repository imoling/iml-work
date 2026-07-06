import React, { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { ShieldAlert, CheckCircle2, FileText, Ban, Paperclip, Layers, FolderOpen, KeyRound, ArrowUp, ChevronUp, ChevronDown, Loader2, X, Check, Trash2, Copy, ThumbsUp, ThumbsDown, RefreshCw, Puzzle } from 'lucide-react'
import { useChatStore, type LogEntry } from '../stores/chatStore'
import { useUserStore } from '../stores/userStore'
import { useHistoryStore } from '../stores/historyStore'
import { skillTypeLabel } from './skillTypeMeta'
import { swallow } from '../utils'


interface Segment {
  type: 'text' | 'bold' | 'code' | 'link' | 'image'
  text: string
  url?: string
}

function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split('\n')
  const elements: React.ReactNode[] = []
  
  let currentTable: { headers: string[]; rows: string[][] } | null = null
  // 列表项：node 是该项主体，sub 是其嵌套子条目（如有序项下挂的 * 明细 bullet）
  type ListItem = { node: React.ReactNode; sub: React.ReactNode[] }
  let currentList: { type: 'ul' | 'ol'; items: ListItem[] } | null = null

  const flushTable = (key: string) => {
    if (!currentTable) return null
    const tbl = currentTable
    currentTable = null
    return (
      <div key={key} className="markdown-table-wrapper">
        <table>
          <thead>
            <tr>
              {tbl.headers.map((h, i) => (
                <th key={i}>
                  {renderInline(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tbl.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci}>
                    {renderInline(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const flushList = (key: string) => {
    if (!currentList) return null
    const lst = currentList
    currentList = null
    const renderItem = (it: ListItem, idx: number) => (
      <li key={idx}>
        {it.node}
        {it.sub && it.sub.length > 0 && (
          <ul>{it.sub.map((s, si) => <li key={si}>{s}</li>)}</ul>
        )}
      </li>
    )
    return lst.type === 'ul'
      ? <ul key={key}>{lst.items.map(renderItem)}</ul>
      : <ol key={key}>{lst.items.map(renderItem)}</ol>
  }

  const renderInline = (text: string): React.ReactNode => {
    let segments: Segment[] = [{ type: 'text', text }]

    // 1. Parse Images: !\[(.*?)\]\((.*?)\)
    segments = segments.flatMap(seg => {
      if (seg.type !== 'text') return [seg]
      const parts: Segment[] = []
      let lastIndex = 0
      const imgRegex = /!\[(.*?)\]\((.*?)\)/g
      let match
      while ((match = imgRegex.exec(seg.text)) !== null) {
        if (match.index > lastIndex) {
          parts.push({ type: 'text', text: seg.text.substring(lastIndex, match.index) })
        }
        parts.push({ type: 'image', text: match[1], url: match[2] })
        lastIndex = imgRegex.lastIndex
      }
      if (lastIndex < seg.text.length) {
        parts.push({ type: 'text', text: seg.text.substring(lastIndex) })
      }
      return parts
    })

    // 2. Parse Links: \[(.*?)\]\((.*?)\)
    segments = segments.flatMap(seg => {
      if (seg.type !== 'text') return [seg]
      const parts: Segment[] = []
      let lastIndex = 0
      const linkRegex = /\[(.*?)\]\((.*?)\)/g
      let match
      while ((match = linkRegex.exec(seg.text)) !== null) {
        if (match.index > lastIndex) {
          parts.push({ type: 'text', text: seg.text.substring(lastIndex, match.index) })
        }
        parts.push({ type: 'link', text: match[1], url: match[2] })
        lastIndex = linkRegex.lastIndex
      }
      if (lastIndex < seg.text.length) {
        parts.push({ type: 'text', text: seg.text.substring(lastIndex) })
      }
      return parts
    })

    // 2b. Bare URLs -> compact clickable links (show hostname, hide long URL)
    segments = segments.flatMap(seg => {
      if (seg.type !== 'text') return [seg]
      const parts: Segment[] = []
      let last = 0
      const urlRegex = /(https?:\/\/[^\s)）]+)/g
      let m
      while ((m = urlRegex.exec(seg.text)) !== null) {
        if (m.index > last) parts.push({ type: 'text', text: seg.text.substring(last, m.index) })
        let label = m[1]
        try { label = new URL(m[1]).hostname.replace(/^www\./, '') } catch (e) { swallow(e, 'parse citation url') }
        parts.push({ type: 'link', text: label, url: m[1] })
        last = urlRegex.lastIndex
      }
      if (last < seg.text.length) parts.push({ type: 'text', text: seg.text.substring(last) })
      return parts
    })

    // 3. Parse Bold: \*\*(.*?)\*\*
    segments = segments.flatMap(seg => {
      if (seg.type !== 'text') return [seg]
      const parts: Segment[] = []
      let lastIndex = 0
      const boldRegex = /\*\*(.*?)\*\*/g
      let match
      while ((match = boldRegex.exec(seg.text)) !== null) {
        if (match.index > lastIndex) {
          parts.push({ type: 'text', text: seg.text.substring(lastIndex, match.index) })
        }
        parts.push({ type: 'bold', text: match[1] })
        lastIndex = boldRegex.lastIndex
      }
      if (lastIndex < seg.text.length) {
        parts.push({ type: 'text', text: seg.text.substring(lastIndex) })
      }
      return parts
    })

    // 4. Parse Inline Code: `(.*?)`
    segments = segments.flatMap(seg => {
      if (seg.type !== 'text') return [seg]
      const parts: Segment[] = []
      let lastIndex = 0
      const codeRegex = /`(.*?)`/g
      let match
      while ((match = codeRegex.exec(seg.text)) !== null) {
        if (match.index > lastIndex) {
          parts.push({ type: 'text', text: seg.text.substring(lastIndex, match.index) })
        }
        parts.push({ type: 'code', text: match[1] })
        lastIndex = codeRegex.lastIndex
      }
      if (lastIndex < seg.text.length) {
        parts.push({ type: 'text', text: seg.text.substring(lastIndex) })
      }
      return parts
    })

    return (
      <>
        {segments.map((seg, i) => {
          switch (seg.type) {
            case 'bold':
              return <strong key={i}>{seg.text}</strong>
            case 'code':
              return <code key={i}>{seg.text}</code>
            case 'link':
              return (
                <a 
                  key={i} 
                  href={seg.url}
                  onClick={(e) => {
                    e.preventDefault()
                    if (seg.url) {
                      if (seg.url.startsWith('file://')) {
                        (window as any).api.invoke('window:open-path', seg.url.replace('file://', ''))
                      } else {
                        (window as any).api.invoke('window:open-url', seg.url)
                      }
                    }
                  }}
                >
                  {seg.text}
                </a>
              )
            case 'image':
              return (
                <span key={i} className="chat-image-container" style={{ display: 'inline-block' }}>
                  <img
                    src={seg.url}
                    alt={seg.text}
                    title="点击查看大图"
                    onClick={() => {
                      if (seg.url) window.dispatchEvent(new CustomEvent('iml:lightbox', { detail: seg.url }))
                    }}
                  />
                </span>
              )
            default: {
              // 处理 <br> / <br/>：拆成多行（LLM 在表格单元格里常用 <br> 换行）
              const parts = seg.text.split(/<br\s*\/?>/i)
              if (parts.length === 1) return <span key={i}>{seg.text}</span>
              return <span key={i}>{parts.map((p, j) => <React.Fragment key={j}>{j > 0 && <br />}{p}</React.Fragment>)}</span>
            }
          }
        })}
      </>
    )
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // 1. Check Table
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (currentList) {
        elements.push(flushList(`list-${i}`))
      }
      
      const cells = trimmed.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1)
      
      if (!currentTable) {
        currentTable = { headers: cells, rows: [] }
      } else {
        const isSeparator = cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c))
        if (!isSeparator) {
          currentTable.rows.push(cells)
        }
      }
      continue
    }

    if (currentTable) {
      elements.push(flushTable(`table-${i}`))
    }

    // 2. Check Unordered Lists
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('▸ ')) {
      if (currentTable) {
        elements.push(flushTable(`table-${i}`))
      }
      const itemContent = trimmed.substring(2)
      // 若当前是有序列表，则这些 bullet 视为「当前有序项的嵌套子条目」，不打断父 <ol> 的编号
      if (currentList && currentList.type === 'ol' && currentList.items.length > 0) {
        currentList.items[currentList.items.length - 1].sub.push(renderInline(itemContent))
        continue
      }
      if (!currentList || currentList.type !== 'ul') {
        if (currentList) elements.push(flushList(`list-${i}`))
        currentList = { type: 'ul', items: [{ node: renderInline(itemContent), sub: [] }] }
      } else {
        currentList.items.push({ node: renderInline(itemContent), sub: [] })
      }
      continue
    }

    // 3. Check Ordered Lists
    const olMatch = /^\d+\.\s+(.*)/.exec(trimmed)
    if (olMatch) {
      if (currentTable) {
        elements.push(flushTable(`table-${i}`))
      }
      const itemContent = olMatch[1]
      if (!currentList || currentList.type !== 'ol') {
        if (currentList) elements.push(flushList(`list-${i}`))
        currentList = { type: 'ol', items: [{ node: renderInline(itemContent), sub: [] }] }
      } else {
        currentList.items.push({ node: renderInline(itemContent), sub: [] })
      }
      continue
    }

    // 到这里是「非列表行」。若列表仍开着，需判断它与列表的关系，避免把同一个列表拆成
    // 多个单项 <ol>（那样每个都从 1 开始，于是全显示成 “1.”）。
    if (currentList) {
      const isStructural = trimmed.startsWith('#') || trimmed.startsWith('> ') || (trimmed.startsWith('|') && trimmed.endsWith('|'))
      if (trimmed === '') {
        // 空行不立即结束列表：若附近（可能夹着明细行）仍有列表项，视为同一列表，吞掉空行
        let j = i + 1, seen = 0, near = false
        while (j < lines.length && seen < 3) {
          const t = lines[j].trim()
          if (t === '') { j++; continue }
          if (/^[-*▸]\s/.test(t) || /^\d+\.\s+/.test(t)) { near = true; break }
          seen++; j++
        }
        if (near) continue
        elements.push(flushList(`list-${i}`))
        elements.push(<div key={i} style={{ height: '8px' }} />)
        continue
      }
      // 仅把「明细行」并入当前项（如“（发布单位：…）”这类括注、或缩进续行），不另起 <ol>；
      // 普通成句的过渡段落（如“此外，还检索到…”）则结束列表、单独成段。
      const isDetailLine = !isStructural && (/^[（(]/.test(trimmed) || /^\s+\S/.test(line))
      if (isDetailLine) {
        const last = currentList.items.length - 1
        if (last >= 0) {
          currentList.items[last].node = (<>{currentList.items[last].node}<br />{renderInline(trimmed)}</>)
          continue
        }
      }
      // 结构性块或普通段落 → 结束列表
      elements.push(flushList(`list-${i}`))
    }

    // 4. Check Headers
    if (trimmed.startsWith('### ')) {
      elements.push(<h3 key={i}>{renderInline(trimmed.substring(4))}</h3>)
      continue
    }
    if (trimmed.startsWith('## ')) {
      elements.push(<h2 key={i}>{renderInline(trimmed.substring(3))}</h2>)
      continue
    }
    if (trimmed.startsWith('# ')) {
      elements.push(<h1 key={i}>{renderInline(trimmed.substring(2))}</h1>)
      continue
    }

    // 5. Check Blockquote
    if (trimmed.startsWith('> ')) {
      elements.push(
        <blockquote key={i}>
          {renderInline(trimmed.substring(2))}
        </blockquote>
      )
      continue
    }

    // 6. Normal Line
    if (trimmed === '') {
      elements.push(<div key={i} style={{ height: '8px' }} />)
    } else {
      elements.push(<p key={i}>{renderInline(line)}</p>)
    }
  }

  if (currentTable) {
    elements.push(flushTable('table-final'))
  }
  if (currentList) {
    elements.push(flushList('list-final'))
  }

  return <div className="markdown-body">{elements}</div>
}

// 从当前动作文案归纳出一个简短的阶段标题（执行状态头部用），匹配不到则按日志类型兜底。
// 人类可读的文件大小（文件卡展示）
function fmtSize(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function deriveActionTitle(rawText: string, type: string): string {
  const t = (rawText || '').replace(/^\[[^\]]+\]\s*/, '')
  if (/未登录|去.*登录/.test(t)) return '需要登录系统'
  if (/登录/.test(t)) return '正在登录系统'
  if (/打开|访问|跳转/.test(t)) return '正在打开页面'
  if (/页面已打开|加载|读取|提取|抓取|拿到.*内容|页面内容/.test(t)) return '正在读取页面'
  if (/联网|检索|搜索|细读/.test(t)) return '正在联网检索'
  if (/回忆|记忆|习惯|经验/.test(t)) return '正在回忆上下文'
  if (/制度|知识库|RAG/.test(t)) return '正在查阅知识库'
  if (/整理|生成回复|润色|整合|模型/.test(t)) return '正在整理回复'
  if (/技能/.test(t)) return '正在调用技能'
  if (/理解|任务/.test(t)) return '正在理解任务'
  if (/填|录入|表单|提交/.test(t)) return '正在填写表单'
  const map: Record<string, string> = { thinking: '正在思考', acting: '正在执行', observing: '正在读取', stdout: '执行中', completed: '已完成' }
  return map[type] || '执行中'
}

const EMPTY_LOGS: LogEntry[] = []

export default function DialoguePanel() {
  const {
    messages,
    convLogs,
    isDrawerOpen,
    generatingConvs,
    activeCliForm,
    cliFormData,
    cliCurrentFieldIndex,
    sendMessage,
    submitBubbleForm,
    resolvePermGate,
    cancelTask,
    submitDeleteConfirm,
    toggleDrawer,
    clearLogs,
    submitCliField
  } = useChatStore()

  const { getCurrentExpertName, claimedExpertId, expertList } = useUserStore()
  const currentSkills = expertList.find(e => e.id === claimedExpertId)?.skills || []

  // 多会话并行：生成态/执行流都按「当前视图会话」取——别的会话在跑不影响这里的输入与展示
  const activeConversationId = useHistoryStore(s => s.activeConversationId)
  const isGenerating = activeConversationId ? !!generatingConvs[activeConversationId] : false
  const logs = (activeConversationId && convLogs[activeConversationId]) || EMPTY_LOGS

  // 最新动作（用于折叠状态栏上的实时跑马灯，让用户无需展开即可看到任务进展）
  const latestLog = logs.length ? logs[logs.length - 1] : null
  // 跑马灯显示文案：去掉 [xxx] 技术前缀、只取首行，保持简洁人话
  const tickerText = latestLog ? (latestLog.text.split('\n')[0].replace(/^\[[^\]]+\]\s*/, '').trim() || latestLog.text.split('\n')[0]) : ''
  // 仅当文案放不下（溢出）时才横向滚动并复制两段；放得下就静态显示一段，避免出现重复文字
  const tickerRef = useRef<HTMLSpanElement>(null)
  const [tickerScroll, setTickerScroll] = useState(false)
  useLayoutEffect(() => {
    setTickerScroll(false)
    const raf = requestAnimationFrame(() => {
      const c = tickerRef.current
      if (c) setTickerScroll(c.scrollWidth > c.clientWidth + 2)
    })
    return () => cancelAnimationFrame(raf)
  }, [tickerText])

  // 执行计时（已用时 N 秒）：生成开始时归零并每秒递增，结束后保留最终值
  const [elapsed, setElapsed] = useState(0)
  const genStartRef = useRef<number | null>(null)
  useEffect(() => {
    if (isGenerating) {
      if (genStartRef.current == null) { genStartRef.current = Date.now(); setElapsed(0) }
      const t = setInterval(() => {
        if (genStartRef.current != null) setElapsed(Math.floor((Date.now() - genStartRef.current) / 1000))
      }, 1000)
      return () => clearInterval(t)
    }
    genStartRef.current = null
    return undefined
  }, [isGenerating])
  // 当前动作的简短阶段标题
  const execTitle = latestLog ? deriveActionTitle(latestLog.text, latestLog.type) : '正在准备…'

  // 生成中按 Esc 终止当前任务（与「点击停止」等效）
  useEffect(() => {
    if (!isGenerating) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cancelTask() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isGenerating])

  const [input, setInput] = useState('')
  const [bubbleFormsData, setBubbleFormsData] = useState<Record<string, Record<string, string>>>({})
  const [deletePassphrases, setDeletePassphrases] = useState<Record<string, string>>({})

  // 消息悬浮操作：复制 / 编辑 / 反馈(赞·踩) / 重新生成
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [msgFeedback, setMsgFeedback] = useState<Record<string, 'up' | 'down' | undefined>>({})
  const [openExecId, setOpenExecId] = useState<string | null>(null)   // 当前展开「执行详情」的消息 id
  const [openOntoId, setOpenOntoId] = useState<string | null>(null)   // 当前展开「本体执行」的消息 id
  const precedingUser = (m: any) => { const idx = messages.findIndex((x: any) => x.id === m.id); for (let i = idx - 1; i >= 0; i--) { if (messages[i].sender === 'user') return messages[i] } return null }
  const copyMsg = (m: any) => { navigator.clipboard.writeText(m.content || '').then(() => { setCopiedId(m.id); setTimeout(() => setCopiedId(null), 1200) }).catch(() => {}) }
  const regenerateMsg = (m: any) => {
    if (isGenerating) return
    const u = precedingUser(m)
    if (u) sendMessage(u.content, { forcedSkillId: u.skillTag?.id, skillName: u.skillTag?.name, permMode })
  }
  const toggleFb = (m: any, v: 'up' | 'down') => {
    setMsgFeedback(p => {
      const next = p[m.id] === v ? undefined : v
      const fb = next ? next.toUpperCase() : null
      try {
        if (m.traceId) window.api.invoke('trace:feedback', { traceId: m.traceId, feedback: fb })
        else { const u = precedingUser(m); if (u) window.api.invoke('trace:feedback', { userQuestion: u.content, feedback: fb }) }
      } catch (e) { swallow(e, 'trace:feedback') }
      return { ...p, [m.id]: next }
    })
  }

  // Composer tools state
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([])
  const [openMenu, setOpenMenu] = useState<null | 'skills' | 'perm' | 'workspace'>(null)
  const [permMode, setPermMode] = useState<'readonly' | 'full'>('readonly')   // 默认只读，安全优先
  const [selectedSkill, setSelectedSkill] = useState<{ id: string; name: string } | null>(null)
  const [wsDir, setWsDir] = useState('')
  const [wsFiles, setWsFiles] = useState<{ name: string; path: string }[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const loadWorkspace = async () => { const r = await window.api.invoke('workspace:files'); if (r) { setWsDir(r.dir || ''); setWsFiles(r.files || []) } }
  const pickWorkspaceDir = async () => { const r = await window.api.invoke('workspace:pick-dir'); if (r && !r.canceled) { setWsDir(r.dir || ''); setWsFiles(r.files || []) } }
  useEffect(() => { loadWorkspace() }, [])

  const pickAttachment = async () => {
    const r = await window.api.invoke('attach:pick')
    if (r?.success && Array.isArray(r.files)) setAttachments(a => [...a, ...r.files])
  }
  const removeAttachment = (name: string) => setAttachments(a => a.filter(x => x.name !== name))
  const openWorkspaceFolder = () => window.api.invoke('workspace:open')
  // 业务技能：显式锁定本次使用（执行时直接用该技能，不靠关键词猜测）
  const lockSkill = (sk: { id: string; name: string }) => {
    setSelectedSkill(sk)
    setOpenMenu(null)
    inputRef.current?.focus()
  }
  // 工作空间：把目录里的文件加入本次上下文（按文件名引用，发送时由分身抽取其正文）
  const addWorkspaceFile = (f: { name: string; path: string }) => {
    setAttachments(a => a.some(x => x.name === f.name) ? a : [...a, { name: f.name, path: f.path }])
  }

  // Build the message：把附件文件名写进正文（供分身定位并抽取其真实正文）。权限/锁定技能走 opts，不污染正文。
  const composeContent = () => {
    const parts: string[] = []
    if (attachments.length) parts.push(`【附件】${attachments.map(a => a.name).join('、')}（已加入工作空间）`)
    parts.push(input.trim())
    return parts.join('\n')
  }

  const chatEndRef = useRef<HTMLDivElement>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  // 切换/进入会话：标记一次，让下面的滚动用「瞬时」跳到底部（长历史别从顶部慢慢平滑滚）
  const justSwitchedRef = useRef(true)
  useEffect(() => { justSwitchedRef.current = true }, [activeConversationId])

  // Auto-scroll chat
  // 自动滚到最新：新消息 + 流式内容增长（依赖最后一条内容长度，确保长回答也滚到底）时都跟随；
  // 刚切会话时用瞬时滚动直接到底，之后的增量用平滑滚动。
  useEffect(() => {
    const instant = justSwitchedRef.current
    justSwitchedRef.current = false
    chatEndRef.current?.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'end' })
  }, [messages.length, messages[messages.length - 1]?.content, isGenerating])

  // Auto-scroll logs in drawer
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, activeCliForm])

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isGenerating) return
    sendMessage(composeContent(), { forcedSkillId: selectedSkill?.id, skillName: selectedSkill?.name, permMode })
    setInput('')
    setAttachments([])
    setSelectedSkill(null)
    setOpenMenu(null)
  }

  const handleBubbleFormChange = (msgId: string, fieldName: string, value: string) => {
    setBubbleFormsData(prev => ({
      ...prev,
      [msgId]: {
        ...(prev[msgId] || {}),
        [fieldName]: value
      }
    }))
  }

  const handleBubbleFormSubmit = (msgId: string, formRequest: any) => {
    // Fill with default values if not explicitly typed
    const defaultData: Record<string, string> = {}
    formRequest.fields.forEach((f: any) => {
      defaultData[f.name] = f.value
    })
    const submittedData = {
      ...defaultData,
      ...(bubbleFormsData[msgId] || {})
    }
    submitBubbleForm(msgId, submittedData)
  }

  const handleDeleteVerify = (msgId: string) => {
    const code = deletePassphrases[msgId] || ''
    if (code.trim().toUpperCase() === 'CONFIRM') {
      submitDeleteConfirm(msgId, true)
    } else {
      alert('安全口令输入错误！请重新输入 "CONFIRM" 以授权敏感删除。')
    }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <ImageLightbox />

      {/* Messages Window */}
      <div className="chat-window">
        {/* 欢迎语：固定开场白，始终作为第一条气泡显示（不入 messages/DB，发消息/切换会话都不丢）；
            结构与真实分身消息一致（msg-body），保证有气泡样式 */}
        <div className="message-bubble assistant">
          <div className="msg-header assistant">
            <span className="msg-dot" /><span>{getCurrentExpertName()}</span>
          </div>
          <div className="msg-body">
            <div className="msg-body-text">我是你的工作分身「{getCurrentExpertName()}」。可以帮你查资料、写文档、跑业务技能、联网检索、录入/审批等——直接说需求就行。</div>
          </div>
        </div>
        {messages.map((msg) => (
          <div key={msg.id} className={`message-bubble ${msg.sender}`}>
            <div className={`msg-header ${msg.sender}`}>
              {msg.sender === 'assistant' && <span className="msg-dot" />}
              <span>{msg.sender === 'assistant' ? getCurrentExpertName() : '我'}</span>
              <span className="msg-time">{msg.timestamp}</span>
            </div>
            
            <div className="msg-body">
              {msg.skillTag && (
                <div className="msg-skill-tag" title={`本次锁定技能：${msg.skillTag.name}（${msg.skillTag.id}）`}>
                  <Layers size={11} />
                  <span>已锁定技能 · {msg.skillTag.name}</span>
                  <span className="msg-skill-tag-id">{msg.skillTag.id}</span>
                </div>
              )}
              <div className="msg-body-text">
                <MarkdownRenderer content={msg.content} />
              </div>

              {/* 技能产出文件卡（放在溯源之上）：查看(Quick Look) / 打开所在位置(访达) —— 类似 IM 的文件消息 */}
              {msg.sender === 'assistant' && msg.files && msg.files.length > 0 && (
                <div className="msg-files">
                  {msg.files.map((f, i) => (
                    <div key={i} className="file-card" onDoubleClick={() => window.api.invoke('files:preview', f.name)}>
                      <div className={`file-card-icon ext-${(f.name.split('.').pop() || '').toLowerCase()}`}>
                        {(f.name.split('.').pop() || 'F').slice(0, 4).toUpperCase()}
                      </div>
                      <div className="file-card-info">
                        <div className="file-card-name" title={f.name}>{f.name}</div>
                        <div className="file-card-size">{fmtSize(f.sizeBytes)}</div>
                      </div>
                      <div className="file-card-actions">
                        <button className="file-card-btn" title="快速查看" onClick={() => window.api.invoke('files:preview', f.name)}>查看</button>
                        <button className="file-card-btn" title="在访达中显示" onClick={() => window.api.invoke('files:reveal', f.name)}>打开位置</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 知识溯源角标：悬浮显示来源卡(文件名/相似度/命中段落) */}
              {msg.sender === 'assistant' && msg.sources && msg.sources.length > 0 && (
                <div className="msg-sources">
                  <span className="msg-sources-label">知识来源</span>
                  {msg.sources.map(s => (
                    <span key={s.seq} className="src-badge">
                      {s.seq}
                      <span className="src-pop">
                        <span className="src-pop-name">《{s.name}》{s.scope === 'PERSONAL' ? '（个人知识）' : ''}</span>
                        <span className="src-pop-score">相似度 {(s.score * 100).toFixed(0)}%</span>
                        {s.excerpt && <span className="src-pop-excerpt">“{s.excerpt}…”</span>}
                      </span>
                    </span>
                  ))}
                </div>
              )}

              {/* Dynamic Bubble Form Card */}
              {msg.formRequest && !msg.formSubmitted && (
                <div className="bubble-form-card">
                  <div className="bubble-form-title">
                    <FileText size={14} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                    业务系统表单参数确认
                  </div>
                  <div className="form-grid">
                    {msg.formRequest.fields.map((field) => {
                      const val = bubbleFormsData[msg.id]?.[field.name] !== undefined ? bubbleFormsData[msg.id][field.name] : field.value
                      const isTextarea = field.type === 'textarea'
                      const hasOptions = Array.isArray(field.options) && field.options.length > 0
                      return (
                        <div key={field.name} className="form-field" style={isTextarea ? { gridColumn: '1 / -1' } : undefined}>
                          <label className="form-label">{field.label}</label>
                          {hasOptions ? (
                            <select
                              className="form-input"
                              value={val}
                              onChange={(e) => handleBubbleFormChange(msg.id, field.name, e.target.value)}
                            >
                              <option value="">（请选择）</option>
                              {field.options!.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                            </select>
                          ) : isTextarea ? (
                            <textarea
                              className="form-input"
                              style={{ minHeight: 56, resize: 'vertical' }}
                              value={val}
                              onChange={(e) => handleBubbleFormChange(msg.id, field.name, e.target.value)}
                            />
                          ) : (
                            <input
                              type={field.type}
                              className="form-input"
                              value={val}
                              onChange={(e) => handleBubbleFormChange(msg.id, field.name, e.target.value)}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
                    <button className="form-cancel-btn" onClick={() => cancelTask()}>
                      <X size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />取消
                    </button>
                    <button
                      className="form-submit-btn"
                      onClick={() => handleBubbleFormSubmit(msg.id, msg.formRequest)}
                    >
                      <CheckCircle2 size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                      确认并提交至企业系统
                    </button>
                  </div>
                </div>
              )}

              {/* Form Submitted Success State */}
              {msg.formRequest && msg.formSubmitted && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--accent-green)', marginTop: '8px', background: 'rgba(16, 185, 129, 0.05)', padding: '8px', borderRadius: '4px', border: '1px solid rgba(16,185,129,0.1)' }}>
                  <CheckCircle2 size={14} />
                  <span>已完成表单数据确认与系统同步提交</span>
                </div>
              )}

              {/* 先决权限闸：只读含写操作 → 开跑前两选一（继续 / 切档重跑） */}
              {msg.permGate && (
                <div className="bubble-form-card">
                  <div className="bubble-form-title">
                    <KeyRound size={14} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                    本次包含写操作，当前为「只读」
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
                    写操作：<strong>{msg.permGate.writeLabels.join('、') || '业务写入'}</strong>。只读模式不会对业务系统做任何改动，请选择：
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <button className="form-cancel-btn" disabled={msg.permGateResolved}
                      onClick={() => resolvePermGate(msg.id, 'continue')}>
                      继续（跳过写操作）
                    </button>
                    <button className="form-submit-btn" disabled={msg.permGateResolved}
                      onClick={() => {
                        // 切档 UI + 回传 'switch'；重发由主进程 permSwitch 标记驱动，在本次任务结束后自动进行（避免撞 isGenerating 守卫）
                        setPermMode('full')
                        resolvePermGate(msg.id, 'switch')
                      }}>
                      <KeyRound size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                      切到「允许操作」并重跑
                    </button>
                  </div>
                  {msg.permGateResolved && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>已选择。</div>}
                </div>
              )}

              {/* High Risk Deletion Warning Card */}
              {msg.deleteRequest && msg.deleteApproved === null && (
                <div className="delete-warning-card">
                  <div className="delete-warning-header">
                    <ShieldAlert size={16} />
                    <span>高危删除操作物理授权验证</span>
                  </div>
                  <div className="delete-warning-body">
                    {msg.deleteRequest.message}
                    <div style={{ marginTop: '8px', color: 'var(--text-muted)' }}>
                      提示：请在下方输入授权口令 <strong style={{ color: 'var(--accent-red)' }}>CONFIRM</strong> 以解除安全锁定。
                    </div>
                  </div>
                  <input
                    type="text"
                    className="delete-auth-input"
                    placeholder="请输入 CONFIRM 授权"
                    value={deletePassphrases[msg.id] || ''}
                    onChange={(e) => setDeletePassphrases({ ...deletePassphrases, [msg.id]: e.target.value })}
                  />
                  <div className="delete-actions">
                    <button 
                      className="delete-cancel-btn"
                      onClick={() => submitDeleteConfirm(msg.id, false)}
                    >
                      <Ban size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                      中止取消
                    </button>
                    <button 
                      className="delete-confirm-btn"
                      onClick={() => handleDeleteVerify(msg.id)}
                    >
                      <ShieldAlert size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                      验证并执行物理删除
                    </button>
                  </div>
                </div>
              )}

              {/* Deletion Card Status */}
              {msg.deleteRequest && msg.deleteApproved !== null && (
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '8px', 
                  fontSize: '11px', 
                  color: msg.deleteApproved ? 'var(--accent-red)' : 'var(--text-muted)', 
                  marginTop: '8px', 
                  background: msg.deleteApproved ? 'rgba(239, 68, 68, 0.05)' : 'rgba(255,255,255,0.02)', 
                  padding: '8px', 
                  borderRadius: '4px', 
                  border: msg.deleteApproved ? '1px solid rgba(239, 68, 68, 0.15)' : '1px solid var(--border-color)' 
                }}>
                  {msg.deleteApproved ? <ShieldAlert size={14} /> : <Ban size={14} />}
                  <span>{msg.deleteApproved ? '敏感物理删除授权通过，数据已擦除' : '已中止高危删除操作'}</span>
                </div>
              )}
            </div>

            {/* 用户消息：仅悬浮展示「复制」 */}
            {msg.content && msg.sender === 'user' && (
              <div className="msg-actions user">
                <button className="msg-act" title={copiedId === msg.id ? '已复制' : '复制'} onClick={() => copyMsg(msg)}>
                  {copiedId === msg.id ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
            )}

            {/* 分身回复：操作按钮常驻展示在回复下方，含「执行详情」追溯 */}
            {msg.content && msg.sender === 'assistant' && (
              <div className="msg-actions assistant">
                <button className="msg-act" title={copiedId === msg.id ? '已复制' : '复制'} onClick={() => copyMsg(msg)}>
                  {copiedId === msg.id ? <Check size={13} /> : <Copy size={13} />}
                </button>
                <button className={`msg-act ${msgFeedback[msg.id] === 'up' ? 'on' : ''}`} title="有帮助" onClick={() => toggleFb(msg, 'up')}><ThumbsUp size={13} /></button>
                <button className={`msg-act ${msgFeedback[msg.id] === 'down' ? 'on down' : ''}`} title="待改进" onClick={() => toggleFb(msg, 'down')}><ThumbsDown size={13} /></button>
                <button className="msg-act" title="重新生成" onClick={() => regenerateMsg(msg)} disabled={isGenerating}><RefreshCw size={13} /></button>
                {msg.execLogs && msg.execLogs.length > 0 && (
                  <button className={`msg-act exec ${openExecId === msg.id ? 'on' : ''}`} title="查看这条回复的执行过程" onClick={() => setOpenExecId(openExecId === msg.id ? null : msg.id)}>
                    <Layers size={13} /><span className="msg-act-label">执行详情</span>
                    {openExecId === msg.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                )}
                {msg.ontology && (
                  <button className={`msg-act exec ${openOntoId === msg.id ? 'on' : ''}`} title="查看本体语义执行细节（对象/消解/动作/状态迁移/事件）" onClick={() => setOpenOntoId(openOntoId === msg.id ? null : msg.id)}>
                    <Puzzle size={13} /><span className="msg-act-label">本体执行</span>
                    {openOntoId === msg.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                )}
              </div>
            )}

            {/* 本体执行细节（点击「本体执行」展开）——技术信息与业务回复分离 */}
            {msg.sender === 'assistant' && openOntoId === msg.id && msg.ontology && (
              <div className="msg-exec-detail onto-detail">
                <MarkdownRenderer content={msg.ontology} />
              </div>
            )}

            {/* 该回复的执行流时间线（点击「执行详情」展开） */}
            {msg.sender === 'assistant' && openExecId === msg.id && msg.execLogs && (
              <div className="msg-exec-detail">
                <div className="exec-timeline">
                  {msg.execLogs.map((log, i) => {
                    const label = ({ thinking: '思考', acting: '执行', observing: '观察', stdout: '输出', completed: '完成' } as Record<string, string>)[log.type] || log.type
                    const mono = log.type === 'stdout' || log.type === 'observing'
                    return (
                      <div key={i} className={`exec-step ${log.type}`}>
                        <span className="exec-dot" />
                        <div className="exec-step-body">
                          <div className="exec-step-head"><span className="exec-chip">{label}</span><span className="exec-time">{log.timestamp}</span></div>
                          <div className={`exec-step-text ${mono ? 'mono' : ''}`}>{log.text}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

      {/* Composer — unified execution status + input card */}
      <div className="input-area-wrap">
        <div className="composer">

          {/* Execution status row (only when there is activity) — expands the flow */}
          {(isGenerating || logs.length > 0) && (
            <>
              <div className="exec-header">
                <div className="exec-header-row">
                  <span className={`exec-header-icon ${isGenerating ? 'running' : 'done'}`}>
                    {isGenerating ? <Loader2 size={15} className="drawer-spin" /> : <Check size={15} />}
                  </span>
                  <div className="exec-header-main">
                    <div className="exec-header-titlerow">
                      <span className="exec-title">{isGenerating ? execTitle : '执行完成'}</span>
                      <span className="exec-meta">
                        {isGenerating
                          ? `第 ${logs.length} 步 · 已用时 ${elapsed} 秒`
                          : `共 ${logs.length} 步 · 用时 ${elapsed} 秒`}
                      </span>
                    </div>
                    {latestLog && (
                      <span className={`exec-ticker exec-detail ${tickerScroll ? 'scrolling' : ''}`} ref={tickerRef} title={latestLog.text}>
                        <span key={latestLog.timestamp + '|' + latestLog.text} className={`exec-ticker-track ${tickerScroll ? 'scroll' : ''}`}>
                          <span className="exec-ticker-seg">{tickerText}</span>
                          {tickerScroll && <span className="exec-ticker-seg" aria-hidden="true">{tickerText}</span>}
                        </span>
                      </span>
                    )}
                  </div>
                  <div className="exec-header-actions">
                    <button type="button" className="exec-detail-btn" onClick={() => toggleDrawer()}>
                      执行详情{isDrawerOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </button>
                    <button type="button" className="exec-more-btn" title="清除执行流" onClick={(e) => { e.stopPropagation(); clearLogs() }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <div className={`exec-progress ${isGenerating ? 'running' : 'done'}`}><span className="bar" /></div>
              </div>

              <div className={`exec-body ${isDrawerOpen ? 'open' : ''}`}>
                <div className="exec-timeline">
            {logs.map((log, index) => {
              const label = ({ thinking: '思考', acting: '执行', observing: '观察', stdout: '输出', completed: '完成' } as Record<string, string>)[log.type] || log.type
              const mono = log.type === 'stdout' || log.type === 'observing'
              return (
                <div key={index} className={`exec-step ${log.type}`}>
                  <span className="exec-dot" />
                  <div className="exec-step-body">
                    <div className="exec-step-head">
                      <span className="exec-chip">{label}</span>
                      <span className="exec-time">{log.timestamp}</span>
                    </div>
                    <div className={`exec-step-text ${mono ? 'mono' : ''}`}>{log.text}</div>
                  </div>
                </div>
              )
            })}

            {/* ASCII CLI Terminal Form */}
            {activeCliForm && (
              <div className="term-cli-form">
                <div style={{ fontWeight: 700, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '6px', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="exec-chip" style={{ background: 'var(--mint-50)', color: 'var(--mint-700)' }}>待确认</span>
                  需要补充参数后继续执行
                </div>

                {activeCliForm.fields.map((f, idx) => {
                  if (idx < cliCurrentFieldIndex) {
                    return (
                      <div key={f.name} className="term-cli-line">
                        <span style={{ color: 'var(--mint-700)' }}>✓ {f.label}：</span>
                        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{cliFormData[f.name]}</span>
                      </div>
                    )
                  } else if (idx === cliCurrentFieldIndex) {
                    return (
                      <form
                        key={f.name}
                        onSubmit={(e) => {
                          e.preventDefault()
                          const val = (e.currentTarget.elements.namedItem('cliInput') as HTMLInputElement).value
                          submitCliField(val || f.value)
                          e.currentTarget.reset()
                        }}
                        className="term-cli-line"
                      >
                        <span style={{ color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          {f.label}（默认 {f.value}）：
                        </span>
                        <input 
                          name="cliInput" 
                          autoFocus 
                          className="term-cli-input"
                          placeholder="按回车确认" 
                        />
                      </form>
                    )
                  }
                  return null
                })}
              </div>
            )}
            
            {logs.length === 0 && !activeCliForm && (
              <div className="exec-empty">
                暂无执行流。发起任务后，工作分身的思考、技能执行与沙箱底层输出会在此以时间线形式实时展开。
              </div>
            )}
                  <div ref={logEndRef} />
                </div>
              </div>
              <div className="composer-divider" />
            </>
          )}


          {/* 已锁定技能 + 附件 chips */}
          {(attachments.length > 0 || selectedSkill) && (
            <div className="composer-chips">
              {selectedSkill && (
                <span className="composer-chip skill" title={`本次锁定技能：${selectedSkill.name}`}>
                  <Layers size={12} className="cc-ico" /><span className="cc-name">{selectedSkill.name}</span>
                  <span className="composer-chip-x" onClick={() => setSelectedSkill(null)} title="取消锁定"><X size={11} /></span>
                </span>
              )}
              {attachments.map(a => (
                <span key={a.name} className="composer-chip" title={a.name}>
                  <FileText size={12} className="cc-ico" /><span className="cc-name">{a.name}</span>
                  <span className="composer-chip-x" onClick={() => removeAttachment(a.name)} title="移除"><X size={11} /></span>
                </span>
              ))}
            </div>
          )}

          {/* Input + tools — part of the composer card */}
          <textarea
            ref={inputRef}
            className="composer-input"
            rows={1}
            placeholder={`告诉${getCurrentExpertName()}你想完成什么…`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend(e)
              }
            }}
          />
          <div className="composer-tools" style={{ position: 'relative' }}>
            {openMenu && <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setOpenMenu(null)} />}

            {/* 附件 */}
            <button type="button" className="wb-tool" onClick={pickAttachment} title="从本地选文件，复制进工作空间并在发送时抽取其正文">
              <Paperclip size={13} />附件{attachments.length > 0 ? ` · ${attachments.length}` : ''}
            </button>

            {/* 业务技能：锁定本次直接执行 */}
            <div style={{ position: 'relative', zIndex: 50 }}>
              <button type="button" className={`wb-tool ${selectedSkill ? 'on' : ''}`} onClick={() => setOpenMenu(openMenu === 'skills' ? null : 'skills')}>
                <Layers size={13} />技能{selectedSkill ? ' · 已锁定' : ''}
              </button>
              {openMenu === 'skills' && (
                <div className="composer-popover">
                  <div className="composer-popover-title">锁定一个技能，本次直接用它执行</div>
                  {currentSkills.length === 0 && <div className="composer-popover-empty">当前分身暂未装载技能</div>}
                  {currentSkills.map(sk => (
                    <button type="button" key={sk.id} className={`composer-popover-item ${selectedSkill?.id === sk.id ? 'sel' : ''}`} onClick={() => lockSkill({ id: sk.id, name: sk.name })}>
                      <Layers size={13} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sk.name}</span>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{skillTypeLabel((sk as any).type)}</span>
                      </span>
                      {selectedSkill?.id === sk.id && <Check size={13} />}
                    </button>
                  ))}
                  {selectedSkill && <button type="button" className="composer-popover-item" onClick={() => { setSelectedSkill(null); setOpenMenu(null) }} style={{ color: 'var(--text-muted)' }}><X size={13} /><span>清除锁定</span></button>}
                </div>
              )}
            </div>

            {/* 工作空间：可指定本地目录，分身直接在该目录操作 */}
            <div style={{ position: 'relative', zIndex: 50 }}>
              <button type="button" className={`wb-tool ${openMenu === 'workspace' ? 'on' : ''}`} title={wsDir || '默认 documents 目录'} onClick={() => { const n = openMenu === 'workspace' ? null : 'workspace'; setOpenMenu(n); if (n) loadWorkspace() }}>
                <FolderOpen size={13} /><span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>工作空间 · {wsDir ? (wsDir.split('/').filter(Boolean).pop() || wsDir) : 'documents'}</span>
              </button>
              {openMenu === 'workspace' && (
                <div className="composer-popover" style={{ width: 320 }}>
                  <div className="composer-popover-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={wsDir}>{wsDir || '默认 documents 目录'}</span>
                    <a style={{ cursor: 'pointer', color: 'var(--brand-primary)', fontSize: 11, whiteSpace: 'nowrap' }} onClick={() => { openWorkspaceFolder(); setOpenMenu(null) }}>打开</a>
                  </div>
                  <div style={{ display: 'flex', gap: 8, padding: '0 8px 6px' }}>
                    <button type="button" className="wb-tool" style={{ flex: 1, justifyContent: 'center' }} onClick={pickWorkspaceDir}><FolderOpen size={12} />选择目录</button>
                  </div>
                  {wsFiles.length === 0 && <div className="composer-popover-empty">该目录暂无文件。点「选择目录」指定工作目录，或用「附件」添加。</div>}
                  {wsFiles.slice(0, 50).map(f => {
                    const added = attachments.some(x => x.name === f.name)
                    return (
                      <button type="button" key={f.path} className="composer-popover-item" onClick={() => addWorkspaceFile(f)} disabled={added}>
                        <FileText size={13} />
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                        <span style={{ fontSize: 10, color: added ? 'var(--brand-primary)' : 'var(--text-muted)' }}>{added ? '已加入' : '加入上下文'}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* 权限范围：只读 / 允许操作（真约束） */}
            <div style={{ position: 'relative', zIndex: 50 }}>
              <button type="button" className={`wb-tool ${permMode === 'full' ? 'on' : ''}`} onClick={() => setOpenMenu(openMenu === 'perm' ? null : 'perm')}>
                <KeyRound size={13} />权限范围 · {permMode === 'readonly' ? '只读' : '允许操作'}
              </button>
              {openMenu === 'perm' && (
                <div className="composer-popover" style={{ width: 280 }}>
                  <div className="composer-popover-title">本次任务的执行权限</div>
                  {([
                    { k: 'readonly', label: '只读', desc: '只查询/读取，绝不对业务系统做任何改动' },
                    { k: 'full', label: '允许操作', desc: '可执行写入/操作；写操作仍会请你人工确认，高危需签名授权' }
                  ] as const).map(item => (
                    <button type="button" key={item.k} className={`composer-popover-item ${permMode === item.k ? 'sel' : ''}`} onClick={() => { setPermMode(item.k); setOpenMenu(null) }}>
                      <span className={`perm-check ${permMode === item.k ? 'on' : ''}`}>{permMode === item.k && <Check size={11} />}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontWeight: 600 }}>{item.label}</span>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4, display: 'block', whiteSpace: 'normal' }}>{item.desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="composer-tools-spacer" />
            <span className="composer-send-hint">{isGenerating ? '点击停止' : 'Enter 发送'}</span>
            {isGenerating ? (
              <button type="button" className="wb-send wb-stop" onClick={() => cancelTask()} title="终止当前任务">
                <span className="wb-stop-sq" />
              </button>
            ) : (
              <button type="button" className="wb-send" onClick={(e) => handleSend(e as any)} title="发送">
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>

        <div className="input-hints-bar">
          <span>提示：输入「新建审批」等新增/修改指令会触发动态表单卡片，「删除数据」等敏感操作会触发高危授权锁。</span>
        </div>
      </div>
    </div>
  )
}


// 对话内图片的大图查看层：缩略图点击 → 全屏遮罩查看，点遮罩/X/Esc 关闭。
function ImageLightbox() {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    const onOpen = (e: Event) => setSrc((e as CustomEvent).detail || null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSrc(null) }
    window.addEventListener('iml:lightbox', onOpen)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('iml:lightbox', onOpen); window.removeEventListener('keydown', onKey) }
  }, [])
  if (!src) return null
  return (
    <div className="img-lightbox-overlay" onClick={() => setSrc(null)}>
      <button className="img-lightbox-close" onClick={() => setSrc(null)}><X size={18} /></button>
      <img src={src} alt="预览大图" onClick={e => e.stopPropagation()} />
    </div>
  )
}
