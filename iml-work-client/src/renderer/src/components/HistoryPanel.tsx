import React, { useState } from 'react'
import { Trash2, MessageSquare, Edit2, Plus, PanelLeftClose, Loader2 } from 'lucide-react'
import { useHistoryStore } from '../stores/historyStore'
import { useChatStore } from '../stores/chatStore'

export default function HistoryPanel({ onClose }: { onClose?: () => void }) {
  const {
    conversations,
    activeConversationId,
    deleteConversation,
    setActiveConversationId,
    updateConversationTitle
  } = useHistoryStore()

  // 多会话并行：执行中转圈、完成未读小圆点（切进会话即读）
  const generatingConvs = useChatStore(s => s.generatingConvs)
  const unreadConvs = useChatStore(s => s.unreadConvs)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  // 会话列表加载 & 切换会话载入消息，统一由 App 层驱动（历史栏收起时也生效）

  const handleStartRename = (id: string, currentTitle: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingId(id)
    setEditTitle(currentTitle)
  }

  const handleSaveRename = async (id: string, e: React.FormEvent | React.FocusEvent) => {
    e.preventDefault()
    if (editTitle.trim()) await updateConversationTitle(id, editTitle.trim())
    setEditingId(null)
  }

  // 新对话：清空当前会话，回到欢迎态；发第一条消息时自动落库建会话。
  // 其他会话在执行中也可以随时新建/切换——在途任务后台继续，完成后标未读。
  const newConversation = () => {
    setActiveConversationId(null)
  }

  return (
    <div className="conv-rail">
      <div className="conv-rail-head">
        <div className="conv-rail-head-left">
          {onClose && (
            <button className="conv-rail-collapse" onClick={onClose} title="收起历史会话">
              <PanelLeftClose size={15} />
            </button>
          )}
          <span className="conv-rail-title">历史会话</span>
        </div>
        <button className="conv-rail-new" onClick={newConversation} title="新对话">
          <Plus size={14} />
          <span>新对话</span>
        </button>
      </div>

      <div className="conv-rail-list">
        {conversations.map((conv) => {
          const isActive = conv.id === activeConversationId
          const isEditing = conv.id === editingId
          const isRunning = !!generatingConvs[conv.id]
          const unreadKind = !isActive ? unreadConvs[conv.id] : undefined
          const needsAttention = unreadKind === 'attention'
          return (
            <div
              key={conv.id}
              onClick={() => !isEditing && setActiveConversationId(conv.id)}
              className={`conv-item ${isActive ? 'active' : ''}`}
            >
              {isRunning
                ? <Loader2 size={13} className="conv-item-ic conv-item-spin" />
                : <MessageSquare size={13} className="conv-item-ic" />}

              {isEditing ? (
                <form
                  onSubmit={(e) => handleSaveRename(conv.id, e)}
                  className="conv-item-editform"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={(e) => handleSaveRename(conv.id, e)}
                    autoFocus
                    className="conv-item-editinput"
                  />
                </form>
              ) : (
                <div className="conv-item-main">
                  <span className="conv-item-title">{conv.title}</span>
                  {isRunning ? (
                    needsAttention
                      ? <span className="conv-item-time" style={{ color: '#D97706' }}>待确认</span>
                      : <span className="conv-item-time" style={{ color: 'var(--brand-primary)' }}>执行中…</span>
                  ) : !isActive && (
                    <span className="conv-item-time">{formatRelativeTime(conv.updated_at)}</span>
                  )}
                  {unreadKind && (
                    <span className={`conv-item-unread ${unreadKind}`}
                      title={unreadKind === 'attention' ? '需要你确认（表单/权限）' : unreadKind === 'error' ? '执行异常' : '有新回复'} />
                  )}
                </div>
              )}

              {!isEditing && (
                <div className="conv-item-actions">
                  <button onClick={(e) => handleStartRename(conv.id, conv.title, e)} title="重命名">
                    <Edit2 size={12} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirm('确定删除该对话历史吗？')) deleteConversation(conv.id)
                    }}
                    title="删除"
                  >
                    <Trash2 size={12} className="conv-item-del" />
                  </button>
                </div>
              )}
            </div>
          )
        })}

        {conversations.length === 0 && (
          <div className="conv-rail-empty">暂无历史会话</div>
        )}
      </div>
    </div>
  )
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return ''
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestamp
  if (diff < 60) return '刚刚'
  const diffMinutes = Math.floor(diff / 60)
  if (diffMinutes < 60) return `${diffMinutes}分钟前`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}小时前`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `${diffDays}天前`
  const date = new Date(timestamp * 1000)
  return `${date.getMonth() + 1}/${date.getDate()}`
}
