import { useEffect, useState } from 'react'
import { Building2, Boxes, Database, Github, ShieldCheck, RefreshCw, Server } from 'lucide-react'
import BrandMark from '../BrandMark'
import BackendConfig from '../BackendConfig'

// 「关于」页：品牌、版本、产品四要点 + 检查更新。

type UpdateStatus =
  | { state: 'disabled'; reason: string }
  | { state: 'checking' }
  | { state: 'available'; version: string; page?: string }   // page：下载落地页（清单通道，用户自取安装包）
  | { state: 'none'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

export default function AboutTab() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [version, setVersion] = useState('')   // 单一来源 package.json（app.getVersion），不再硬编码
  useEffect(() => {
    window.api.invoke('app:version').then((v: any) => setVersion(String(v || ''))).catch(() => {})
    window.api.invoke('app:update-get').then((s: any) => setStatus(s)).catch(() => {})
    const un = window.api.on('app:update-status', (s: any) => { setStatus(s); if (s?.state !== 'checking') setChecking(false) })
    return un
  }, [])
  const check = async () => {
    setChecking(true)
    try { const s = await window.api.invoke('app:update-check'); setStatus(s) } catch { /* ignore */ }
    setChecking(false)
  }
  const statusText = (s: UpdateStatus | null): string => {
    if (!s) return ''
    switch (s.state) {
      case 'disabled': return s.reason
      case 'checking': return '正在检查更新…'
      case 'available': return `发现新版本 ${s.version}`
      case 'none': return '当前已是最新版本'
      case 'downloading': return `下载中 ${s.percent}%`
      case 'downloaded': return `新版本 ${s.version} 已下载，重启即可安装`
      case 'error': return `检查失败：${s.message}`
    }
  }
  return (
    <div className="settings-tab-content">
      <h2 className="tab-title">关于</h2>

      <div className="glass-card" style={{ padding: '32px 28px', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', textAlign: 'center', width: '100%', maxWidth: 480, alignSelf: 'center', marginTop: 8 }}>
        <BrandMark height={64} />
        <div>
          <h3 style={{ fontSize: '20px', fontWeight: 800, letterSpacing: '-0.5px' }}>
            <span style={{ color: 'var(--text-primary)' }}>iML</span> <span style={{ color: 'var(--brand-primary)' }}>Work</span>
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '6px' }}>你的工作分身，安全连接企业流程。</p>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-full)', padding: '3px 12px' }}>Version {version || '—'}</span>

        <div style={{ borderTop: '1px solid var(--border-color)', width: '100%', paddingTop: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[
            { icon: <ShieldCheck size={15} />, t: '本地安全环境' },
            { icon: <Building2 size={15} />, t: '企业系统连接' },
            { icon: <Boxes size={15} />, t: '业务技能执行' },
            { icon: <Database size={15} />, t: '执行记录沉淀' },
          ].map(f => (
            <div key={f.t} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 10, padding: '10px 12px', background: 'rgba(255,255,255,0.02)' }}>
              <span style={{ color: 'var(--brand-primary)', display: 'inline-flex', flexShrink: 0 }}>{f.icon}</span>{f.t}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            className="btn-secondary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={check}
            disabled={checking || status?.state === 'checking'}
          >
            <RefreshCw size={14} className={checking || status?.state === 'checking' ? 'spin' : ''} />检查更新
          </button>
          {status?.state === 'available' && (
            status.page
              // 清单通道：不静默下载，跳管理端下载落地页由用户自取安装包
              ? <button className="settings-btn" onClick={() => window.api.invoke('window:open-url', status.page)}>前往下载页</button>
              : <button className="settings-btn" onClick={() => window.api.invoke('app:update-download')}>下载新版本</button>
          )}
          {status?.state === 'downloaded' && (
            <button className="settings-btn" onClick={() => window.api.invoke('app:update-install')}>重启安装</button>
          )}
        </div>
        {status && <p style={{ margin: 0, fontSize: 11, color: status.state === 'error' ? 'var(--accent-red)' : 'var(--text-muted)' }}>{statusText(status)}</p>}

        <button
          className="btn-secondary"
          style={{ marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => window.api.invoke('window:open-url', 'https://github.com/imoling/iml-work')}
        >
          <Github size={14} />github.com/imoling/iml-work
        </button>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>iML Studio · 由个人开发者 imoling 打造 · © 2026</p>
      </div>

      {/* 后端服务地址：岗位/技能/本体/模型网关/知识检索均经此后端 */}
      <div className="glass-card" style={{ padding: '18px 20px', width: '100%', maxWidth: 480, alignSelf: 'center', marginTop: 14 }}>
        <div className="setting-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Server size={14} /> 后端服务地址</div>
        <div className="setting-desc" style={{ marginBottom: 10 }}>岗位、技能、本体、模型网关与知识检索均经此地址访问。改动后需重新登录。</div>
        <BackendConfig />
      </div>
    </div>
  )
}
