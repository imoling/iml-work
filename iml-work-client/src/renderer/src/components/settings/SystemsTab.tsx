import React, { useState } from 'react'
import { Building2, Server, Github, MessageCircle, Users, Boxes } from 'lucide-react'
import { useUserStore } from '../../stores/userStore'

// 企业业务系统连接页：从管理端拉取系统清单，在本地完成个人登录（登录态按系统隔离
// 保存在本地分区）；含登录保活心跳状态与企业安全沙箱只读状态条。
// 样式沿用 SettingsPanel 的全局 <style>（svc-card / pill / setting-row 等）。

interface BizSystem { id: string; type: string; name: string; baseUrl: string; status: string; linked: boolean }

export default function SystemsTab() {
  const { keepBusinessSession, updateBusinessSession } = useUserStore()

  const [bizSystems, setBizSystems] = useState<BizSystem[]>([])
  const [bizAdminUrl, setBizAdminUrl] = useState('')
  const [bizLoading, setBizLoading] = useState(false)
  const [bizStatus, setBizStatus] = useState<Record<string, 'unknown' | 'checking' | 'verifying' | 'logged-in' | 'logged-out'>>({})
  // 登录保活心跳状态（主进程常驻运行）+ 保活记录（每次心跳的各系统在线/掉线明细）
  type HbLog = { at: string; items: { name: string; online: boolean }[] }
  const [hb, setHb] = useState<{ enabled: boolean; busy: boolean; lastAt: string; online: number; total: number; log?: HbLog[] }>({ enabled: true, busy: false, lastAt: '', online: 0, total: 0, log: [] })
  const [showHbLog, setShowHbLog] = useState(false)
  const [bizError, setBizError] = useState('')

  // 公司级代码执行沙箱状态（主进程代理后端 /sandbox/exec/status；配置入口在管理端「沙箱监控」）

  const loadBizSystems = async () => {
    setBizLoading(true)
    setBizError('')
    try {
      const r = await window.api.invoke('systems:list')
      if (r?.ok) {
        setBizSystems(r.systems || [])
        setBizAdminUrl(r.adminBaseUrl || '')
        const m: Record<string, any> = {}
        ;(r.systems || []).forEach((s: BizSystem) => { m[s.id] = s.linked ? 'logged-in' : 'unknown' })
        setBizStatus(m)
      } else {
        // 把真因显示出来：以前这里只 setBizSystems([])，主进程返回的 error（HTTP 403 / 连接失败…）
        // 被整个丢掉，界面只剩一句"未获取到"，排查时无从下手。
        setBizSystems([])
        setBizError(String(r?.error || '未知错误（主进程未返回原因）'))
      }
    } catch (e: any) {
      setBizSystems([])
      setBizError(`调用失败：${e?.message || e}`)
    }
    setBizLoading(false)
  }

  React.useEffect(() => {
    // 挂载即拉一次：此前只在收到心跳事件时才 loadBizSystems，而心跳是低频的常驻任务——
    // 进页面往往要等一个心跳周期才有内容，用户看到的是空列表 + "未获取到业务系统"，
    // 手点「刷新系统」却立刻有数据（实测反馈）。首屏内容不该依赖后台事件的到达时机。
    loadBizSystems()
    window.api.invoke('systems:heartbeat-get').then((s: any) => { if (s) setHb(s) }).catch(() => {})
    const un = window.api.on('systems:heartbeat', (s: any) => { setHb(s); if (s && !s.busy) loadBizSystems() })
    return un
  }, [])
  const toggleHb = async () => { const s = await window.api.invoke('systems:heartbeat-set', !hb.enabled); if (s) setHb(s) }
  const hbNow = async () => { await window.api.invoke('systems:heartbeat-now') }

  // 打开登录窗口（立即返回，窗口保持打开）→ 进入"验证中"，员工登录后点「我已登录，检测」
  const bizLogin = async (sys: BizSystem) => {
    await window.api.invoke('systems:login', { systemId: sys.id, baseUrl: sys.baseUrl })
    setBizStatus(s => ({ ...s, [sys.id]: 'verifying' }))
  }
  const bizCheck = async (sys: BizSystem) => {
    setBizStatus(s => ({ ...s, [sys.id]: 'checking' }))
    const c = await window.api.invoke('systems:check', { systemId: sys.id, baseUrl: sys.baseUrl })
    setBizStatus(s => ({ ...s, [sys.id]: c?.loggedIn ? 'logged-in' : 'logged-out' }))
  }
  const bizCancel = async (sys: BizSystem) => {
    await window.api.invoke('systems:login-close', { systemId: sys.id })
    setBizStatus(s => ({ ...s, [sys.id]: 'unknown' }))
  }
  const bizLogout = async (sys: BizSystem) => {
    await window.api.invoke('systems:logout', { systemId: sys.id })
    setBizStatus(s => ({ ...s, [sys.id]: 'logged-out' }))
  }

  return (
    <div className="settings-tab-content wide" style={{ maxWidth: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h2 className="tab-title">企业系统连接</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }} title="开启后每 4 分钟在本地登录态分区静默访问一次，刷新会话有效期、检测掉线">
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: !hb.enabled ? '#9ca3af' : hb.busy ? '#d97706' : '#16a34a' }} />
            登录保活：<a style={{ cursor: 'pointer', color: 'var(--accent, #16a34a)' }} onClick={toggleHb}>{hb.enabled ? '开' : '关'}</a>
            {hb.enabled ? (hb.busy ? ' · 保活中' : hb.lastAt ? ` · 在线 ${hb.online}/${hb.total} · ${hb.lastAt}` : ' · 待心跳') : ''}
            {(hb.log && hb.log.length > 0) ? <> · <a style={{ cursor: 'pointer', color: 'var(--accent, #16a34a)' }} onClick={() => setShowHbLog(v => !v)}>{showHbLog ? '收起记录' : '保活记录'}</a></> : null}
          </span>
          <button className="btn-secondary" onClick={hbNow} disabled={hb.busy}>立即保活</button>
          <button className="btn-secondary" onClick={loadBizSystems} disabled={bizLoading}>
            {bizLoading ? '加载中…' : '刷新系统'}
          </button>
        </div>
      </div>
      {showHbLog && hb.log && hb.log.length > 0 && (
        <div style={{ margin: '4px 0 12px', padding: '10px 12px', background: 'var(--surface-2, rgba(0,0,0,.03))', borderRadius: 8, fontSize: 12, color: 'var(--text-secondary)', maxHeight: 220, overflowY: 'auto' }}>
          <div style={{ marginBottom: 6, opacity: .8 }}>保活记录（每 4 分钟一次，各系统在线/掉线 · 掉线=会话已失效需重登）</div>
          {hb.log.map((row, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '3px 0', flexWrap: 'wrap' }}>
              <span style={{ fontVariantNumeric: 'tabular-nums', opacity: .75, minWidth: 62 }}>{row.at}</span>
              {row.items.length === 0
                ? <span style={{ opacity: .6 }}>无已登录系统</span>
                : row.items.map((it, j) => (
                    <span key={j} style={{ color: it.online ? '#16a34a' : '#dc2626' }}>{it.name}：{it.online ? '在线' : '掉线'}</span>
                  ))}
            </div>
          ))}
        </div>
      )}
      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
        下列业务系统由企业管理端统一定义（来源：{bizAdminUrl || '管理端'}）。请在此完成你的个人登录——登录态会按系统隔离保存在本地，供工作分身执行技能时直接复用，无需重复登录。
      </p>
      {/* 沙箱状态已拆到 设置 → 安全沙箱（可切换云端/本地执行位置） */}

      <div className="wb-section-title" style={{ margin: '0 0 10px' }}>业务系统（{bizSystems.length}）</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {!bizLoading && bizSystems.length === 0 && (
          <div className="svc-card" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            未从管理端获取到业务系统。请确认管理端「业务系统连接」已定义系统，且服务地址（设置 → 模型服务 → 高级设置 → 企业网关地址）可访问。
            {bizError && (
              <div style={{ marginTop: 8, color: '#b45309', fontSize: 12.5, wordBreak: 'break-all' }}>
                实际错误：{bizError}
              </div>
            )}
          </div>
        )}

        <div className="svc-grid">
          {bizSystems.map(sys => {
            const Icon = sys.type === 'OA' ? Building2 : sys.type === 'ERP' ? Server
              : sys.type === 'GITHUB' ? Github : sys.type === 'EMAIL' ? MessageCircle
              : sys.type === 'CRM' ? Users : Boxes
            const st = bizStatus[sys.id] || 'unknown'
            const pill = st === 'logged-in' ? { cls: 'pill-mint', txt: '已登录' }
              : st === 'logged-out' ? { cls: 'pill-amber', txt: '未登录' }
              : st === 'checking' ? { cls: 'pill-gray', txt: '检测中…' }
              : st === 'verifying' ? { cls: 'pill-amber', txt: '验证中' }
              : { cls: 'pill-gray', txt: '未检测' }
            return (
              <div key={sys.id} className="svc-card">
                <div className="svc-head">
                  <div className="svc-ic"><Icon size={18} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="svc-name">{sys.name}</div>
                    <div className="svc-type">{sys.type} · 管理端定义</div>
                  </div>
                  <span className={`pill ${pill.cls}`}><span className="pill-dot" />{pill.txt}</span>
                </div>
                <div className="svc-meta" style={{ wordBreak: 'break-all' }}>系统地址：{sys.baseUrl}</div>
                <div className="svc-actions">
                  {st === 'verifying' ? (
                    <>
                      <button className="settings-btn" style={{ flex: 1 }} onClick={() => bizCheck(sys)}>我已登录，检测</button>
                      <button className="btn-secondary" onClick={() => bizCancel(sys)}>取消</button>
                    </>
                  ) : (
                    <>
                      <button className="settings-btn" style={{ flex: 1 }} onClick={() => bizLogin(sys)} disabled={st === 'checking'}>
                        {st === 'logged-in' ? '重新登录' : '登录'}
                      </button>
                      <button className="btn-secondary" onClick={() => bizCheck(sys)} disabled={st === 'checking'}>检测</button>
                      {st === 'logged-in' && (
                        <button className="btn-secondary" onClick={() => bizLogout(sys)}>退出</button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <div className="setting-row" style={{ marginTop: 4 }}>
          <div className="setting-info">
            <div className="setting-label">保留登录会话</div>
            <div className="setting-desc">开启后，登录态在本地按系统隔离持久保存，技能执行时直接复用，无需每次重新登录。</div>
          </div>
          <div className="setting-control">
            <label className="toggle-switch">
              <input type="checkbox" checked={keepBusinessSession} onChange={(e) => updateBusinessSession(e.target.checked)} />
              <span className="slider" />
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}
