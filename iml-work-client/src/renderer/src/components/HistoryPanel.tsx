import React, { useEffect, useState } from 'react'
import { Trash2, MessageSquare, Edit2 } from 'lucide-react'
import { useHistoryStore } from '../stores/historyStore'
import { useChatStore } from '../stores/chatStore'
import { useUserStore } from '../stores/userStore'

export default function HistoryPanel() {
  const { claimedExpertId } = useUserStore()
  const {
    conversations,
    activeConversationId,
    loadConversations,
    deleteConversation,
    setActiveConversationId,
    updateConversationTitle
  } = useHistoryStore()

  const { loadMessages } = useChatStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  // Load conversations when expert changes
  useEffect(() => {
    if (claimedExpertId) {
      loadConversations(claimedExpertId)
    }
  }, [claimedExpertId])

  // Load messages when active conversation changes
  useEffect(() => {
    loadMessages(activeConversationId)
  }, [activeConversationId])

  const handleStartRename = (id: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(id)
    setEditTitle(currentTitle)
  }

  const handleSaveRename = async (id: string, e: React.FormEvent | React.FocusEvent) => {
    e.preventDefault()
    if (editTitle.trim()) {
      await updateConversationTitle(id, editTitle.trim())
    }
    setEditingId(null)
  }

  return (
    <div className="sidebar-history-nested" style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      paddingLeft: '8px',
      borderLeft: '1px solid var(--border-color)',
      marginLeft: '20px',
      marginTop: '2px',
      marginBottom: '6px',
      flexShrink: 0
    }}>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        maxHeight: '220px',
        overflowY: 'auto',
        paddingRight: '2px'
      }}>
        {conversations.map((conv) => {
          const isActive = conv.id === activeConversationId
          const isEditing = conv.id === editingId

          return (
            <div
              key={conv.id}
              onClick={() => !isEditing && setActiveConversationId(conv.id)}
              className={`history-item ${isActive ? 'active' : ''}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '6px 8px',
                borderRadius: '6px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                background: isActive ? 'rgba(59, 130, 246, 0.12)' : 'transparent',
                border: isActive ? '1px solid rgba(59, 130, 246, 0.2)' : '1px solid transparent',
                position: 'relative'
              }}
            >
              <MessageSquare size={12} style={{
                marginRight: '6px',
                color: isActive ? 'var(--brand-primary)' : 'var(--text-muted)',
                flexShrink: 0
              }} />

              {isEditing ? (
                <form
                  onSubmit={(e) => handleSaveRename(conv.id, e)}
                  style={{ flex: 1, display: 'flex', alignItems: 'center' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={(e) => handleSaveRename(conv.id, e)}
                    autoFocus
                    style={{
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid var(--brand-primary)',
                      borderRadius: '3px',
                      color: '#fff',
                      fontSize: '11px',
                      padding: '2px 4px',
                      width: '100%',
                      outline: 'none'
                    }}
                  />
                </form>
              ) : (
                <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'space-between', overflow: 'hidden' }}>
                  <span style={{
                    fontSize: '11px',
                    color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    paddingRight: '35px'
                  }}>
                    {conv.title}
                  </span>
                  {!isActive && (
                    <span className="history-time-badge" style={{
                      fontSize: '9px',
                      color: 'var(--text-muted)',
                      marginLeft: '6px',
                      flexShrink: 0
                    }}>
                      {formatRelativeTime(conv.updated_at)}
                    </span>
                  )}
                </div>
              )}

              {!isEditing && (
                <div className="history-actions" style={{
                  position: 'absolute',
                  right: '4px',
                  display: 'flex',
                  gap: '4px',
                  opacity: isActive ? 1 : 0,
                  transition: 'opacity 0.2s'
                }}>
                  <button
                    onClick={(e) => handleStartRename(conv.id, conv.title, e)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      padding: '2px'
                    }}
                    title="重命名"
                  >
                    <Edit2 size={10} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirm('确定删除该对话历史吗？')) {
                        deleteConversation(conv.id)
                      }
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      padding: '2px'
                    }}
                    title="删除"
                  >
                    <Trash2 size={10} style={{ color: 'var(--accent-red)' }} />
                  </button>
                </div>
              )}
            </div>
          )
        })}

        {conversations.length === 0 && (
          <div style={{
            fontSize: '10px',
            color: 'var(--text-muted)',
            textAlign: 'center',
            padding: '10px 5px',
            fontStyle: 'italic'
          }}>
            暂无历史
          </div>
        )}
      </div>
    </div>
  )
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return ''
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestamp
  
  if (diff < 60) {
    return '刚刚'
  }
  const diffMinutes = Math.floor(diff / 60)
  if (diffMinutes < 60) {
    return `${diffMinutes}分钟前`
  }
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours}小时前`
  }
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) {
    return '昨天'
  }
  if (diffDays < 7) {
    return `${diffDays}天前`
  }
  const date = new Date(timestamp * 1000)
  return `${date.getMonth() + 1}/${date.getDate()}`
}
