import { useState, useRef, useEffect } from 'react'
import { LogOut, Cpu, User, ShieldCheck, Plug } from 'lucide-react'
import { useUserStore } from '../stores/userStore'
import { useAuthStore } from '../stores/authStore'

// 本地安全环境真实状态：企业沙箱可达性 + 业务系统登录会话（不再是写死的装饰绿点）
interface EnvState {
  sandbox: 'ok' | 'down' | 'checking'
  imageReady: boolean
  online: number
  total: number
  lastAt: string
}


function maskPhone(p?: string): string {
  if (!p || p.length < 7) return p || ''
  return p.slice(0, 3) + '****' + p.slice(-4)
}

export default function UserCard() {
  const {
    claimedExpertId,
    getCurrentExpertName,
    llmConnectionMode,
    llmApiMode,
    userNickname
  } = useUserStore()
  const { user, logout } = useAuthStore()
  const displayName = user?.displayName || user?.username || userNickname
  const phoneText = maskPhone(user?.phone) || '—'

  const [isOpen, setIsOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  // 真实环境状态：挂载时拉取 + 每 60s 轮询 + 心跳实时推送。
  // 「业务系统登录」以 systems:list 的 bizsys-linked 真值为准（与设置页「已登录」同源，登录后即时一致）；
  // 心跳只用来补充「在线/心跳时间」，不作为已登录总数的唯一来源（避免心跳未跑时误显未绑定）。
  const [env, setEnv] = useState<EnvState>({ sandbox: 'checking', imageReady: false, online: 0, total: 0, lastAt: '' })
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const [sb, sysRes, hb]: any[] = await Promise.all([
          window.api.invoke('sandbox:status'),
          window.api.invoke('systems:list'),
          window.api.invoke('systems:heartbeat-get'),
        ])
        if (!alive) return
        const linked = Array.isArray(sysRes?.systems) ? sysRes.systems.filter((s: any) => s.linked).length : 0
        setEnv({ sandbox: sb?.healthy ? 'ok' : 'down', imageReady: !!sb?.imageReady, online: Math.max(linked, hb?.online || 0), total: linked, lastAt: hb?.lastAt || '' })
      } catch { if (alive) setEnv(e => ({ ...e, sandbox: 'down' })) }
    }
    refresh()
    const t = setInterval(refresh, 60000)
    const off = window.api.on('systems:heartbeat', () => { if (alive) refresh() })
    return () => { alive = false; clearInterval(t); try { off && off() } catch (_) { /* 已卸载 */ } }
  }, [])
  const dotColor = env.sandbox === 'ok' ? 'var(--brand-primary)' : env.sandbox === 'checking' ? 'var(--text-muted)' : '#F59E0B'
  const envText = env.sandbox === 'ok' ? '本地安全环境 · 正常' : env.sandbox === 'checking' ? '环境检测中…' : '企业沙箱不可达'

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleLogout = async () => {
    if (confirm('确认退出登录？将返回登录页。')) {
      await logout()
    }
  }

  return (
    <div className="user-card-container" ref={popoverRef}>
      {/* Popover Menu */}
      {isOpen && (
        <div className="user-card-popover glass-card">
          {/* 「分身设置」入口已并入侧边栏「设置」，此处不重复（避免同屏双入口且弹层遮挡导航） */}
          <div className="popover-section-header">运行状态</div>
          
          <div className="popover-info-row">
            <User size={13} className="info-icon" />
            <div className="info-content">
              <span className="info-label">当前分身</span>
              <span className="info-val">{claimedExpertId ? getCurrentExpertName() : '未激活'}</span>
            </div>
          </div>

          <div className="popover-info-row">
            <Cpu size={13} className="info-icon" />
            <div className="info-content">
              <span className="info-label">安全连接</span>
              <span className="info-val">
                {llmConnectionMode === 'proxy'
                  ? '安全中转'
                  : `直连 API (${llmApiMode === 'anthropic' ? 'Anthropic' : 'Chat'})`}
              </span>
            </div>
          </div>

          <div className="popover-info-row">
            <ShieldCheck size={13} className="info-icon" />
            <div className="info-content">
              <span className="info-label">企业沙箱</span>
              <span className="info-val">
                {env.sandbox === 'ok' ? `正常${env.imageReady ? ' · 镜像就绪' : ''}` : env.sandbox === 'checking' ? '检测中…' : '不可达（检查管理端「安全沙箱」）'}
              </span>
            </div>
          </div>

          <div className="popover-info-row">
            <Plug size={13} className="info-icon" />
            <div className="info-content">
              <span className="info-label">业务系统登录</span>
              <span className="info-val">
                {env.total === 0 ? '未登录任何业务系统' : `${env.total} 个已登录${env.lastAt ? ` · 心跳 ${env.lastAt}` : ''}`}
              </span>
            </div>
          </div>

          <div className="popover-divider" />

          <button className="popover-item logout-item" onClick={handleLogout}>
            <LogOut size={14} />
            <span>退出登录</span>
          </button>
        </div>
      )}

      {/* User Card Trigger */}
      <div className="user-card-trigger" onClick={() => setIsOpen(!isOpen)}>
        <div className="user-avatar">{displayName.charAt(0) || '用'}</div>
        <div className="user-info">
          <div className="user-name" title={displayName}>{displayName}</div>
          <div className="user-phone">{phoneText}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: env.sandbox === 'down' ? '#B45309' : 'var(--mint-700)', marginTop: 1, minWidth: 0 }}
            title="点击查看运行状态明细（企业沙箱 / 业务系统登录）">
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{envText}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
