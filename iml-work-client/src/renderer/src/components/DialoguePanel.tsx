import React, { useState, useRef, useEffect } from 'react'
import { ShieldAlert, CheckCircle2, FileText, Ban, Paperclip, Layers, FolderOpen, KeyRound, ArrowUp, ChevronUp, ChevronDown, Loader2, X, Check } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { useUserStore } from '../stores/userStore'


interface Segment {
  type: 'text' | 'bold' | 'code' | 'link' | 'image'
  text: string
  url?: string
}

function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split('\n')
  const elements: React.ReactNode[] = []
  
  let currentTable: { headers: string[]; rows: string[][] } | null = null
  let currentList: { type: 'ul' | 'ol'; items: React.ReactNode[] } | null = null

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
    if (lst.type === 'ul') {
      return (
        <ul key={key}>
          {lst.items.map((it, idx) => <li key={idx}>{it}</li>)}
        </ul>
      )
    } else {
      return (
        <ol key={key}>
          {lst.items.map((it, idx) => <li key={idx}>{it}</li>)}
        </ol>
      )
    }
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
        try { label = new URL(m[1]).hostname.replace(/^www\./, '') } catch (_) {}
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
                    onClick={() => {
                      if (seg.url) {
                        (window as any).api.invoke('window:open-url', seg.url)
                      }
                    }}
                  />
                </span>
              )
            default:
              return <span key={i}>{seg.text}</span>
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
        const isSeparator = cells.every(c => c.startsWith('-'))
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
      const itemContent = line.substring(line.indexOf(' ') + 1)
      if (!currentList || currentList.type !== 'ul') {
        if (currentList) elements.push(flushList(`list-${i}`))
        currentList = { type: 'ul', items: [renderInline(itemContent)] }
      } else {
        currentList.items.push(renderInline(itemContent))
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
        currentList = { type: 'ol', items: [renderInline(itemContent)] }
      } else {
        currentList.items.push(renderInline(itemContent))
      }
      continue
    }

    if (currentList) {
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

export default function DialoguePanel() {
  const {
    messages,
    logs,
    isDrawerOpen,
    isGenerating,
    activeCliForm,
    cliFormData,
    cliCurrentFieldIndex,
    sendMessage,
    submitBubbleForm,
    submitDeleteConfirm,
    toggleDrawer,
    clearLogs,
    submitCliField
  } = useChatStore()

  const { getCurrentExpertName, claimedExpertId, expertList } = useUserStore()
  const currentSkills = expertList.find(e => e.id === claimedExpertId)?.skills || []

  const [input, setInput] = useState('')
  const [bubbleFormsData, setBubbleFormsData] = useState<Record<string, Record<string, string>>>({})
  const [deletePassphrases, setDeletePassphrases] = useState<Record<string, string>>({})

  // Composer tools state
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([])
  const [openMenu, setOpenMenu] = useState<null | 'skills' | 'perm'>(null)
  const [perm, setPerm] = useState({ read: true, write: true, system: true, danger: false })
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const pickAttachment = async () => {
    const r = await window.api.invoke('attach:pick')
    if (r?.success && Array.isArray(r.files)) setAttachments(a => [...a, ...r.files])
  }
  const removeAttachment = (name: string) => setAttachments(a => a.filter(x => x.name !== name))
  const openWorkspace = () => window.api.invoke('workspace:open')
  const insertSkill = (name: string) => {
    setInput(prev => (prev.trim() ? prev.trimEnd() + ' ' : '') + name)
    setOpenMenu(null)
    inputRef.current?.focus()
  }
  const togglePerm = (k: 'read' | 'write' | 'system' | 'danger') => setPerm(p => ({ ...p, [k]: !p[k] }))

  // Build the message with attachment / permission context attached.
  const composeContent = () => {
    const parts: string[] = []
    if (attachments.length) parts.push(`【附件】${attachments.map(a => a.name).join('、')}（已加入工作空间）`)
    // 仅当权限被收窄或开启高危时才声明，默认权限不展示。
    const isDefaultPerm = perm.read && perm.write && perm.system && !perm.danger
    if (!isDefaultPerm) {
      const scopes: string[] = []
      if (perm.read) scopes.push('读取文件')
      if (perm.write) scopes.push('写入文件')
      if (perm.system) scopes.push('访问企业系统')
      if (perm.danger) scopes.push('允许高危删除')
      parts.push(`【权限范围】${scopes.length ? scopes.join('、') : '仅对话'}`)
    }
    parts.push(input.trim())
    return parts.join('\n')
  }

  const chatEndRef = useRef<HTMLDivElement>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-scroll logs in drawer
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, activeCliForm])

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isGenerating) return
    sendMessage(composeContent())
    setInput('')
    setAttachments([])
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
      
      {/* Messages Window */}
      <div className="chat-window">
        {messages.map((msg) => (
          <div key={msg.id} className={`message-bubble ${msg.sender}`}>
            <div className={`msg-header ${msg.sender}`}>
              {msg.sender === 'assistant' && <span className="msg-dot" />}
              <span>{msg.sender === 'assistant' ? getCurrentExpertName() : '您'}</span>
              <span className="msg-time">{msg.timestamp}</span>
            </div>
            
            <div className="msg-body">
              <div className="msg-body-text">
                <MarkdownRenderer content={msg.content} />
              </div>

              {/* Dynamic Bubble Form Card */}
              {msg.formRequest && !msg.formSubmitted && (
                <div className="bubble-form-card">
                  <div className="bubble-form-title">
                    <FileText size={14} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                    业务系统表单参数确认
                  </div>
                  <div className="form-grid">
                    {msg.formRequest.fields.map((field) => (
                      <div key={field.name} className="form-field">
                        <label className="form-label">{field.label}</label>
                        <input
                          type={field.type}
                          className="form-input"
                          value={bubbleFormsData[msg.id]?.[field.name] !== undefined ? bubbleFormsData[msg.id][field.name] : field.value}
                          onChange={(e) => handleBubbleFormChange(msg.id, field.name, e.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                  <button 
                    className="form-submit-btn"
                    onClick={() => handleBubbleFormSubmit(msg.id, msg.formRequest)}
                  >
                    <CheckCircle2 size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                    确认并提交至企业系统
                  </button>
                </div>
              )}

              {/* Form Submitted Success State */}
              {msg.formRequest && msg.formSubmitted && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--accent-green)', marginTop: '8px', background: 'rgba(16, 185, 129, 0.05)', padding: '8px', borderRadius: '4px', border: '1px solid rgba(16,185,129,0.1)' }}>
                  <CheckCircle2 size={14} />
                  <span>已完成表单数据确认与系统同步提交</span>
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
              <button type="button" className="composer-status" onClick={() => toggleDrawer()}>
                <div className="drawer-title">
                  {isGenerating
                    ? <Loader2 size={13} className="drawer-spin" />
                    : <span className="drawer-status-dot done" />}
                  <span>执行流 · 调试审计</span>
                  {isGenerating
                    ? <span className="drawer-status-text running">执行中…</span>
                    : <span className="drawer-status-text">已完成 · {logs.length} 步</span>}
                </div>
                <div className="drawer-actions">
                  <span className="drawer-btn" onClick={(e) => { e.stopPropagation(); clearLogs() }}>清除</span>
                  {isDrawerOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                </div>
              </button>

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

          {/* Attachment chips */}
          {attachments.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {attachments.map(a => (
                <span key={a.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, background: 'var(--bg-subtle)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-full)', padding: '4px 10px' }}>
                  <FileText size={12} />{a.name}
                  <X size={12} style={{ cursor: 'pointer' }} onClick={() => removeAttachment(a.name)} />
                </span>
              ))}
            </div>
          )}

          {/* Input + tools — part of the composer card */}
          <textarea
            ref={inputRef}
            className="composer-input"
            rows={1}
            placeholder={`输入任务，让${getCurrentExpertName()}处理…`}
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
            <button type="button" className="wb-tool" onClick={pickAttachment}>
              <Paperclip size={13} />附件{attachments.length > 0 ? ` · ${attachments.length}` : ''}
            </button>

            {/* 业务技能 */}
            <div style={{ position: 'relative', zIndex: 50 }}>
              <button type="button" className="wb-tool" onClick={() => setOpenMenu(openMenu === 'skills' ? null : 'skills')}>
                <Layers size={13} />业务技能
              </button>
              {openMenu === 'skills' && (
                <div className="composer-popover">
                  <div className="composer-popover-title">点击插入技能，发起对应任务</div>
                  {currentSkills.length === 0 && <div className="composer-popover-empty">当前分身暂未装配业务技能</div>}
                  {currentSkills.map(sk => (
                    <button type="button" key={sk.id} className="composer-popover-item" onClick={() => insertSkill(sk.name)}>
                      <Layers size={13} />
                      <span style={{ flex: 1 }}>{sk.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 工作空间 */}
            <button type="button" className="wb-tool" onClick={openWorkspace}>
              <FolderOpen size={13} />工作空间
            </button>

            {/* 权限范围 */}
            <div style={{ position: 'relative', zIndex: 50 }}>
              <button type="button" className="wb-tool" onClick={() => setOpenMenu(openMenu === 'perm' ? null : 'perm')}>
                <KeyRound size={13} />权限范围{perm.danger ? ' · 高危' : ''}
              </button>
              {openMenu === 'perm' && (
                <div className="composer-popover">
                  <div className="composer-popover-title">本次任务授权范围</div>
                  {([
                    { k: 'read', label: '读取文件', danger: false },
                    { k: 'write', label: '写入文件', danger: false },
                    { k: 'system', label: '访问企业系统', danger: false },
                    { k: 'danger', label: '允许高危删除', danger: true }
                  ] as const).map(item => (
                    <button type="button" key={item.k} className="composer-popover-item" onClick={() => togglePerm(item.k)}>
                      <span className={`perm-check ${perm[item.k] ? 'on' : ''} ${item.danger ? 'danger' : ''}`}>
                        {perm[item.k] && <Check size={11} />}
                      </span>
                      <span style={{ flex: 1, color: item.danger && perm[item.k] ? 'var(--accent-red)' : undefined }}>{item.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button type="button" className="wb-send" onClick={(e) => handleSend(e as any)} disabled={isGenerating} title="发送">
              <ArrowUp size={16} />
            </button>
          </div>
        </div>

        <div className="input-hints-bar">
          <span>提示：输入「新建审批」等新增/修改指令会触发动态表单卡片，「删除数据」等敏感操作会触发高危授权锁。</span>
        </div>
      </div>
    </div>
  )
}
