// 会话搜索弹窗（搜索弹窗形态）：标题匹配 + 消息全文匹配（db:msg-search 既有通道）。
// 会话页的历史列表移除后，「按内容找回旧会话」的能力收敛到这里；Cmd/Ctrl+K 唤起。
import { useEffect, useRef, useState } from 'react'
import { Search, MessageSquareText, X } from 'lucide-react'
import { useHistoryStore } from '../stores/historyStore'
import { useUserStore } from '../stores/userStore'

interface MsgHit { conversationId: string; conversationTitle: string; snippet: string; createdAt: number }

export function SearchModal({ onClose, onOpen }: { onClose: () => void; onOpen: (convId: string) => void }) {
  const conversations = useHistoryStore(s => s.conversations)
  const expertId = useUserStore(s => s.claimedExpertId)
  const [q, setQ] = useState('')
  const [msgHits, setMsgHits] = useState<MsgHit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 消息全文检索：300ms 防抖，避免每个按键打一次 IPC/SQL
  useEffect(() => {
    const kw = q.trim()
    if (kw.length < 2) { setMsgHits([]); return }
    const t = setTimeout(() => {
      window.api.invoke('db:msg-search', expertId || '', kw)
        .then((r: any) => setMsgHits(Array.isArray(r) ? r.slice(0, 12) : []))
        .catch(() => setMsgHits([]))
    }, 300)
    return () => clearTimeout(t)
  }, [q, expertId])

  const kw = q.trim().toLowerCase()
  const titleHits = kw ? conversations.filter(c => (c.title || '').toLowerCase().includes(kw)).slice(0, 10) : conversations.slice(0, 8)
  const titleIds = new Set(titleHits.map(c => c.id))
  // 消息命中但标题没命中的，作为第二组展示（带内容片段）；同一会话多条命中只留最新一条
  const contentHits: MsgHit[] = []
  const seenConv = new Set<string>()
  for (const h of msgHits) {
    if (titleIds.has(h.conversationId) || seenConv.has(h.conversationId)) continue
    seenConv.add(h.conversationId)
    contentHits.push(h)
  }

  const open = (id: string) => { onOpen(id); onClose() }

  return (
    <div className="mdp-mask" onClick={onClose}>
      <div className="search-modal" onClick={e => e.stopPropagation()}>
        <div className="search-head">
          <Search size={15} />
          <input ref={inputRef} className="search-input" placeholder="搜索会话标题或消息内容…"
            value={q} onChange={e => setQ(e.target.value)} />
          <button type="button" className="mdp-btn" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="search-body">
          {titleHits.length > 0 && (
            <>
              <div className="search-group">{kw ? '标题匹配' : '最近会话'}</div>
              {titleHits.map(c => (
                <button key={c.id} type="button" className="search-item" onClick={() => open(c.id)}>
                  <span className="search-item-title">{c.title || '新对话'}</span>
                </button>
              ))}
            </>
          )}
          {contentHits.length > 0 && (
            <>
              <div className="search-group">消息内容匹配</div>
              {contentHits.map(h => (
                <button key={h.conversationId} type="button" className="search-item" onClick={() => open(h.conversationId)}>
                  <span className="search-item-title"><MessageSquareText size={12} style={{ marginRight: 5, verticalAlign: '-2px' }} />{h.conversationTitle || '新对话'}</span>
                  <span className="search-item-snippet">{h.snippet}</span>
                </button>
              ))}
            </>
          )}
          {kw && titleHits.length === 0 && contentHits.length === 0 && (
            <div className="search-empty">没有找到与「{q.trim()}」相关的会话</div>
          )}
        </div>
      </div>
    </div>
  )
}
