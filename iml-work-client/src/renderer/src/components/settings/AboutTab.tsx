import { Building2, Boxes, Database, Github, ShieldCheck } from 'lucide-react'
import BrandMark from '../BrandMark'

// 「关于」页：品牌、版本与产品四要点（纯静态展示）。

export default function AboutTab() {
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
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-full)', padding: '3px 12px' }}>Version 1.0.0 Alpha</span>

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

        <button
          className="btn-secondary"
          style={{ marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => window.api.invoke('window:open-url', 'https://github.com/imoling/iml-work')}
        >
          <Github size={14} />github.com/imoling/iml-work
        </button>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>iML Studio · 由个人开发者 imoling 打造 · © 2026</p>
      </div>
    </div>
  )
}
