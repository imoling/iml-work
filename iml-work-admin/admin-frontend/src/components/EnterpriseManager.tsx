import { useState, useEffect } from 'react'
import { Building2, Save, RefreshCw } from 'lucide-react'

interface Enterprise {
  companyName: string
  info: string
}

const BLANK: Enterprise = { companyName: '', info: '' }

export default function EnterpriseManager() {
  const [form, setForm] = useState<Enterprise>(BLANK)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/v1/enterprise')
      if (res.ok) {
        const d = await res.json()
        setForm({ companyName: d.companyName || '', info: d.info || '' })
      }
    } catch (err) { console.error(err) }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const save = async () => {
    setSaving(true)
    const res = await fetch('/api/v1/enterprise', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form)
    })
    setSaving(false)
    if (res.ok) { alert('企业信息已保存，将随分身系统指令下发给客户端。') } else { alert('保存失败') }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 640 }}>
          统一维护企业基础信息与通用规则。客户端在构建工作分身的系统指令时会拉取这里的内容，无需在客户端写死公司名称、税号或报销规定等。
        </div>
        <button className="btn-secondary" onClick={load}><RefreshCw size={14} /><span>刷新</span></button>
      </div>

      <div className="glass-panel" style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Building2 size={16} color="var(--brand-primary)" />企业基础信息
        </h3>

        {loading ? (
          <div style={{ color: 'var(--text-secondary)', padding: 20, textAlign: 'center' }}>正在加载企业信息...</div>
        ) : (
          <>
            <div className="form-group">
              <label className="form-label">企业名称</label>
              <input className="form-input" value={form.companyName} onChange={e => setForm({ ...form, companyName: e.target.value })} placeholder="例如：科大讯飞股份有限公司" />
            </div>

            <div className="form-group">
              <label className="form-label">其他基本信息</label>
              <textarea className="form-textarea" style={{ minHeight: 160, resize: 'vertical' }}
                value={form.info} onChange={e => setForm({ ...form, info: e.target.value })}
                placeholder="自由填写：统一社会信用代码、公司地址、差旅报销规定等企业通用信息与规则。" />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>这些信息会随系统指令下发给分身，作为其判断与回答的依据。</span>
            </div>

            <div>
              <button className="btn-primary" onClick={save} disabled={saving}><Save size={14} /><span>{saving ? '保存中…' : '保存企业信息'}</span></button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
