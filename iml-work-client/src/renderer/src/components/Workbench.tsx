import { useState, useRef } from 'react'
import {
  ShieldCheck, Link2, Boxes, FilePlus2, ReceiptText, Plane, Stamp, Search, FileBarChart,
  Paperclip, Layers, FolderOpen, KeyRound, ArrowUp, X, Check, FileText
} from 'lucide-react'
import { useUserStore } from '../stores/userStore'

interface WorkbenchProps {
  onStartTask: (text: string) => void
  onNavigate: (tab: string) => void
}

const FLOWS = [
  { icon: <FilePlus2 size={18} />, title: '新建审批', desc: '发起各类审批流程', prompt: '帮我新建一个审批流程' },
  { icon: <ReceiptText size={18} />, title: '报销单检查', desc: '检查报销合规性', prompt: '检查这张报销单是否合规' },
  { icon: <Plane size={18} />, title: '出差申请', desc: '发起出差申请流程', prompt: '帮我发起一个出差申请' },
  { icon: <Stamp size={18} />, title: '合同用印预审', desc: '合同用印前合规检查', prompt: '帮我做合同用印预审' },
  { icon: <Search size={18} />, title: '查询审批状态', desc: '查询审批进度与结果', prompt: '查询我的审批状态' },
  { icon: <FileBarChart size={18} />, title: '生成日报', desc: '生成今日工作日报', prompt: '帮我生成今天的工作日报' },
]

export default function Workbench({ onStartTask, onNavigate }: WorkbenchProps) {
  const { userNickname, claimedExpertId, expertList } = useUserStore()
  const currentSkills = expertList.find(e => e.id === claimedExpertId)?.skills || []
  const [text, setText] = useState('')

  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([])
  const [openMenu, setOpenMenu] = useState<null | 'skills' | 'perm'>(null)
  const [perm, setPerm] = useState({ read: true, write: true, system: true, danger: false })
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const pickAttachment = async () => {
    const r = await window.api.invoke('attach:pick')
    if (r?.success && Array.isArray(r.files)) setAttachments(a => [...a, ...r.files])
  }
  const removeAttachment = (name: string) => setAttachments(a => a.filter(x => x.name !== name))
  const insertSkill = (name: string) => {
    setText(prev => (prev.trim() ? prev.trimEnd() + ' ' : '') + name)
    setOpenMenu(null)
    inputRef.current?.focus()
  }
  const togglePerm = (k: 'read' | 'write' | 'system' | 'danger') => setPerm(p => ({ ...p, [k]: !p[k] }))

  const composeContent = (body: string) => {
    const parts: string[] = []
    if (attachments.length) parts.push(`【附件】${attachments.map(a => a.name).join('、')}（已加入工作空间）`)
    const scopes: string[] = []
    if (perm.read) scopes.push('读取文件')
    if (perm.write) scopes.push('写入文件')
    if (perm.system) scopes.push('访问企业系统')
    if (perm.danger) scopes.push('允许高危删除')
    parts.push(`【权限范围】${scopes.length ? scopes.join('、') : '仅对话'}`)
    parts.push(body)
    return parts.join('\n')
  }

  const submit = () => {
    const t = text.trim()
    if (!t) return
    onStartTask(composeContent(t))
    setText('')
    setAttachments([])
    setOpenMenu(null)
  }

  return (
    <div className="wb">
      <div className="wb-inner">
        <div className="wb-hero-title">{userNickname}，今天让工作分身处理什么？</div>
        <div className="wb-hero-sub">本地安全环境已启用，已连接企业系统与常用业务技能。</div>

        <div className="wb-status-row">
          <div className="wb-stat">
            <div className="wb-stat-ic"><ShieldCheck size={18} /></div>
            <div><div className="wb-stat-t">本地沙箱已启用</div><div className="wb-stat-s">数据不出本地</div></div>
          </div>
          <div className="wb-stat">
            <div className="wb-stat-ic"><Link2 size={18} /></div>
            <div><div className="wb-stat-t">OA 已连接</div><div className="wb-stat-s">会话保持中</div></div>
          </div>
          <div className="wb-stat">
            <div className="wb-stat-ic"><Boxes size={18} /></div>
            <div><div className="wb-stat-t">{currentSkills.length} 个业务技能可用</div><div className="wb-stat-s">随时调用</div></div>
          </div>
        </div>

        <div className="wb-section-title">常用流程</div>
        <div className="wb-flow-grid">
          {FLOWS.map((f) => (
            <div key={f.title} className="wb-flow-card" onClick={() => onStartTask(f.prompt)}>
              <div className="wb-flow-ic">{f.icon}</div>
              <div className="wb-flow-t">{f.title}</div>
              <div className="wb-flow-d">{f.desc}</div>
            </div>
          ))}
        </div>

        <div className="wb-cmd" style={{ overflow: 'visible' }}>
          {attachments.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '12px 14px 0' }}>
              {attachments.map(a => (
                <span key={a.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, background: 'var(--bg-subtle)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-full)', padding: '4px 10px' }}>
                  <FileText size={12} />{a.name}
                  <X size={12} style={{ cursor: 'pointer' }} onClick={() => removeAttachment(a.name)} />
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="wb-cmd-input"
            rows={2}
            placeholder="输入任务，让工作分身开始处理…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
          />
          <div className="wb-cmd-tools" style={{ position: 'relative' }}>
            {openMenu && <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setOpenMenu(null)} />}

            <button className="wb-tool" onClick={pickAttachment}>
              <Paperclip size={13} />附件{attachments.length > 0 ? ` · ${attachments.length}` : ''}
            </button>

            <div style={{ position: 'relative', zIndex: 50 }}>
              <button className="wb-tool" onClick={() => setOpenMenu(openMenu === 'skills' ? null : 'skills')}>
                <Layers size={13} />业务技能
              </button>
              {openMenu === 'skills' && (
                <div className="composer-popover">
                  <div className="composer-popover-title">点击插入技能，发起对应任务</div>
                  {currentSkills.length === 0 && <div className="composer-popover-empty">当前分身暂未装配业务技能</div>}
                  {currentSkills.map(sk => (
                    <button type="button" key={sk.id} className="composer-popover-item" onClick={() => insertSkill(sk.name)}>
                      <Layers size={13} /><span style={{ flex: 1 }}>{sk.name}</span>
                    </button>
                  ))}
                  <button type="button" className="composer-popover-item" onClick={() => { setOpenMenu(null); onNavigate('skills') }}>
                    <Boxes size={13} /><span style={{ flex: 1, color: 'var(--brand-primary)' }}>查看全部业务技能</span>
                  </button>
                </div>
              )}
            </div>

            <button className="wb-tool" onClick={() => onNavigate('files')}><FolderOpen size={13} />工作空间</button>

            <div style={{ position: 'relative', zIndex: 50 }}>
              <button className="wb-tool" onClick={() => setOpenMenu(openMenu === 'perm' ? null : 'perm')}>
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

            <button className="wb-send" onClick={submit} title="发送"><ArrowUp size={16} /></button>
          </div>
        </div>
      </div>
    </div>
  )
}
