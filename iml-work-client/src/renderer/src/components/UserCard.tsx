import { useState, useRef, useEffect } from 'react'
import { Settings, LogOut, Cpu, User } from 'lucide-react'
import { useUserStore } from '../stores/userStore'

interface UserCardProps {
  onNavigateToSettings: () => void
}

export default function UserCard({ onNavigateToSettings }: UserCardProps) {
  const { 
    claimedExpertId, 
    getCurrentExpertName, 
    llmConnectionMode,
    llmApiMode,
    userNickname
  } = useUserStore()

  const [isOpen, setIsOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

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

  const handleLogout = () => {
    if (confirm('确认注销并清空本地岗位专家缓存容器吗？')) {
      window.location.reload()
    }
  }

  return (
    <div className="user-card-container" ref={popoverRef}>
      {/* Popover Menu */}
      {isOpen && (
        <div className="user-card-popover glass-card">
          <div className="popover-section-header">系统控制</div>
          
          <button 
            className="popover-item"
            onClick={() => {
              setIsOpen(false)
              onNavigateToSettings()
            }}
          >
            <Settings size={14} />
            <span>分身设置</span>
          </button>

          <div className="popover-divider" />
          
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

          <div className="popover-divider" />

          <button className="popover-item logout-item" onClick={handleLogout}>
            <LogOut size={14} />
            <span>退出登录</span>
          </button>
        </div>
      )}

      {/* User Card Trigger */}
      <div className="user-card-trigger" onClick={() => setIsOpen(!isOpen)}>
        <div className="user-avatar">{userNickname.charAt(0) || '张'}</div>
        <div className="user-info">
          <div className="user-name" title={userNickname}>{userNickname}</div>
          <div className="user-phone">185****6788</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--mint-700)', marginTop: 1 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--brand-primary)', flexShrink: 0 }} />
            本地安全环境已启用
          </div>
        </div>
      </div>
    </div>
  )
}
