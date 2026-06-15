import { useState, useEffect } from 'react'
import { Building2, Save, RefreshCw } from 'lucide-react'

interface Enterprise {
  companyName: string
  taxId: string
  address: string
  rules: string
}

const BLANK: Enterprise = { companyName: '', taxId: '', address: '', rules: '' }

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
        setForm({ companyName: d.companyName || '', taxId: d.taxId || '', address: d.address || '', rules: d.rules || '' })
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div className="form-group">
                <label className="form-label">公司全称</label>
                <input className="form-input" value={form.companyName} onChange={e => setForm({ ...form, companyName: e.target.value })} placeholder="例如：科大讯飞股份有限公司" />
              </div>
              <div className="form-group">
                <label className="form-label">纳税人识别号 / 统一社会信用代码</label>
                <input className="form-input" value={form.taxId} onChange={e => setForm({ ...form, taxId: e.target.value })} placeholder="91XXXXXXXXXXXXXXXX" />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">公司地址</label>
              <input className="form-input" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="选填" />
            </div>

            <div className="form-group">
              <label className="form-label">企业通用规则 / 制度摘要</label>
              <textarea className="form-textarea" style={{ minHeight: 120, resize: 'vertical' }}
                value={form.rules} onChange={e => setForm({ ...form, rules: e.target.value })}
                placeholder="例如：差旅报销规定：华东/华北区酒店限额 500元/天，伙食补贴 100元/天，超出需 VP 审批。" />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>这些规则会随系统指令下发给分身，作为其判断与回答的依据。</span>
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
