import { useState, useEffect } from 'react'
import { Plus, Check, RefreshCw, Trash2, Database, Boxes, Pencil, X, Search, Globe, Sparkles } from 'lucide-react'

interface Skill {
  id: string
  name: string
  type: string
  category?: string
  status?: string
}

interface Expert {
  id: string
  title: string
  spec: string
  description: string
  skills?: Skill[]
  knowledgeCategories?: string[]
  webSearchEnabled?: boolean
  principles?: string[]
  workStyle?: string[]
}

const KNOWLEDGE_CATEGORIES = ['公司基本信息', '行政财务制度', '企业合规制度', '人事审批规范']

const ENGINE_LABEL: Record<string, string> = {
  'playwright': '浏览器自动化',
  'python-sandbox': 'Python 数据处理',
  'nut-js': '桌面自动化',
  'onnx-bge': '本地向量模型'
}

const BLANK = { title: '', spec: '', description: '', skillIds: [] as string[], knowledgeCategories: [] as string[], webSearchEnabled: false, principles: '', workStyle: '' }

export default function ExpertManager() {
  const [experts, setExperts] = useState<Expert[]>([])
  const [catalog, setCatalog] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<typeof BLANK>(BLANK)
  const [skillQuery, setSkillQuery] = useState('')
  const [generating, setGenerating] = useState(false)

  const generateFields = async () => {
    if (!form.title.trim()) { alert('请先填写岗位名称，再让 AI 生成'); return }
    setGenerating(true)
    try {
      const res = await fetch('/api/v1/experts/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: form.title })
      })
      const d = await res.json()
      if (res.ok && d.success) {
        const cats: string[] = Array.isArray(d.knowledgeCategories) ? d.knowledgeCategories.filter((c: string) => KNOWLEDGE_CATEGORIES.includes(c)) : []
        setForm(f => ({
          ...f,
          spec: d.spec || f.spec,
          description: d.description || f.description,
          knowledgeCategories: cats.length > 0 ? cats : f.knowledgeCategories
        }))
        if (d.source === 'fallback') alert('企业模型中转站暂不可用，已使用模板生成，请按需修改。')
      } else { alert(d.error || 'AI 生成失败') }
    } catch (err) { console.error(err); alert('AI 生成失败，请稍后重试') }
    setGenerating(false)
  }

  const fetchAll = async () => {
    setLoading(true)
    try {
      const [ex, sk] = await Promise.all([fetch('/api/v1/experts'), fetch('/api/v1/skills')])
      if (ex.ok) setExperts(await ex.json())
      if (sk.ok) setCatalog(await sk.json())
    } catch (err) { console.error(err) }
    setLoading(false)
  }

  useEffect(() => { fetchAll() }, [])

  const openCreate = () => { setEditingId(null); setForm(BLANK); setSkillQuery(''); setShowForm(true) }
  const openEdit = (exp: Expert) => {
    setEditingId(exp.id)
    setForm({
      title: exp.title, spec: exp.spec, description: exp.description || '',
      skillIds: (exp.skills || []).map(s => s.id),
      knowledgeCategories: exp.knowledgeCategories || [],
      webSearchEnabled: !!exp.webSearchEnabled,
      principles: (exp.principles || []).join('\n'),
      workStyle: (exp.workStyle || []).join('\n')
    })
    setSkillQuery('')
    setShowForm(true)
  }

  const toggleSkill = (id: string) =>
    setForm(f => ({ ...f, skillIds: f.skillIds.includes(id) ? f.skillIds.filter(x => x !== id) : [...f.skillIds, id] }))
  const toggleCategory = (cat: string) =>
    setForm(f => ({ ...f, knowledgeCategories: f.knowledgeCategories.includes(cat) ? f.knowledgeCategories.filter(c => c !== cat) : [...f.knowledgeCategories, cat] }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.title.trim() || !form.spec.trim()) { alert('请填写岗位名称与功能描述'); return }
    const payload = {
      title: form.title, spec: form.spec, description: form.description,
      skills: form.skillIds.map(id => ({ id })),
      knowledgeCategories: form.knowledgeCategories,
      webSearchEnabled: form.webSearchEnabled,
      principles: form.principles.split('\n').map(s => s.trim()).filter(Boolean),
      workStyle: form.workStyle.split('\n').map(s => s.trim()).filter(Boolean)
    }
    const res = await fetch(editingId ? `/api/v1/experts/${editingId}` : '/api/v1/experts', {
      method: editingId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (res.ok) { setShowForm(false); setEditingId(null); setForm(BLANK); fetchAll() } else { alert('保存失败') }
  }

  const deleteExpert = async (id: string) => {
    if (!confirm('确认删除该岗位专家?')) return
    const res = await fetch(`/api/v1/experts/${id}`, { method: 'DELETE' })
    if (res.ok) fetchAll()
  }

  const visibleCatalog = catalog.filter(s => {
    if (s.status === 'DISABLED') return false
    if (!skillQuery.trim()) return true
    const q = skillQuery.toLowerCase()
    return `${s.name} ${s.category || ''}`.toLowerCase().includes(q)
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: 640 }}>
          定义岗位工作分身的职责，并从企业技能中心挑选要装配的技能。员工领用该岗位时，会自动把选定的技能与知识库范围同步至本地。
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn-secondary" onClick={fetchAll}><RefreshCw size={14} /><span>刷新</span></button>
          <button className="btn-primary" onClick={openCreate}><Plus size={14} /><span>新增岗位专家</span></button>
        </div>
      </div>

      {/* 新建 / 编辑表单 */}
      {showForm && (
        <div className="skill-drawer-overlay" onClick={() => { setShowForm(false); setEditingId(null) }}>
          <div className="skill-drawer" onClick={e => e.stopPropagation()}>
          <div className="drawer-head">
            <h3 style={{ fontSize: 16, fontWeight: 700 }}>{editingId ? '编辑岗位专家' : '新增岗位专家'}</h3>
            <button className="icon-btn" onClick={() => { setShowForm(false); setEditingId(null) }}><X size={16} /></button>
          </div>

          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', borderRadius: 10, background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.25)' }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Sparkles size={14} style={{ color: '#10b981' }} />填写岗位名称后，可由企业模型中转站自动生成功能描述、职责背景与建议知识库范围。
              </div>
              <button type="button" className="btn-secondary" onClick={generateFields} disabled={generating}
                style={{ whiteSpace: 'nowrap' }}>
                <Sparkles size={14} /><span>{generating ? '生成中...' : 'AI 生成'}</span>
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div className="form-group">
                <label className="form-label">岗位名称</label>
                <input className="form-input" placeholder="例如：行政审批分身" value={form.title} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, title: v })) }} />
              </div>
              <div className="form-group">
                <label className="form-label">一句话功能描述</label>
                <input className="form-input" placeholder="自动处理OA审批与公章会签" value={form.spec} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, spec: v })) }} />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">详细职责背景<span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · 岗位 SOUL「我是谁」</span></label>
              <textarea className="form-textarea" style={{ minHeight: 70, resize: 'vertical' }} placeholder="说明该岗位分身的背景职责..." value={form.description} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, description: v })) }} />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">我的原则<span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · 每行一条，客户端只读展示</span></label>
                <textarea className="form-textarea" style={{ minHeight: 96, resize: 'vertical' }} placeholder="留空则用企业默认治理原则，例如：&#10;只依据真实数据作答，绝不编造&#10;增删改操作执行前必须人工确认" value={form.principles} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, principles: v })) }} />
              </div>
              <div className="form-group">
                <label className="form-label">我的工作方式<span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · 每行一条</span></label>
                <textarea className="form-textarea" style={{ minHeight: 96, resize: 'vertical' }} placeholder="留空则用默认，例如：&#10;读取类自动取数按 SOP 整理&#10;写入类先确认参数再执行" value={form.workStyle} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, workStyle: v })) }} />
              </div>
            </div>

            {/* 从技能中心挑选技能 */}
            <div className="form-group">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Boxes size={14} />装配技能（从企业技能中心选择） · 已选 {form.skillIds.length}
                </label>
                <div style={{ position: 'relative', width: 220 }}>
                  <input className="form-input" placeholder="搜索技能" value={skillQuery} onChange={e => setSkillQuery(e.target.value)} style={{ paddingLeft: 30, height: 32, fontSize: 12 }} />
                  <Search size={13} style={{ position: 'absolute', left: 9, top: 10, color: 'var(--text-muted)' }} />
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 200, overflowY: 'auto', padding: 4 }}>
                {visibleCatalog.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>没有可选技能，请先到企业技能中心创建。</span>}
                {visibleCatalog.map(s => {
                  const on = form.skillIds.includes(s.id)
                  return (
                    <button type="button" key={s.id} onClick={() => toggleSkill(s.id)}
                      className={`filter-chip ${on ? 'active' : ''}`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 12px' }}>
                      {on ? <Check size={13} /> : <Plus size={13} />}
                      <span style={{ fontWeight: 600 }}>{s.name}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{ENGINE_LABEL[s.type] || s.type}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 知识库范围 */}
            <div className="form-group">
              <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Database size={14} />绑定知识库检索范围
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {KNOWLEDGE_CATEGORIES.map(cat => (
                  <button type="button" key={cat} onClick={() => toggleCategory(cat)}
                    className={`filter-chip ${form.knowledgeCategories.includes(cat) ? 'active' : ''}`}>
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* 能力开关 */}
            <div className="form-group">
              <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Globe size={14} />联网检索能力
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={form.webSearchEnabled} onChange={e => { const v = e.target.checked; setForm(f => ({ ...f, webSearchEnabled: v })) }} />
                <span>允许该岗位分身联网检索</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>开启后，分身会根据问题自主判断是否上网查找最新/外部信息，无需用户输入"联网/搜索"等触发词。</span>
              </label>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" className="btn-primary"><Check size={14} /><span>{editingId ? '保存修改' : '保存并发布'}</span></button>
              <button type="button" className="btn-secondary" onClick={() => { setShowForm(false); setEditingId(null) }}>取消</button>
            </div>
          </form>
          </div>
        </div>
      )}

      {/* 岗位专家列表 */}
      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 40 }}>正在拉取岗位专家配置...</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th style={{ width: 160 }}>岗位专家</th>
                <th style={{ width: 280 }}>功能简述</th>
                <th>装配技能</th>
                <th style={{ width: 170 }}>知识库范围</th>
                <th style={{ width: 110 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {experts.map(exp => (
                <tr key={exp.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{exp.title}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{exp.id}</div>
                  </td>
                  <td>
                    <div style={{ fontSize: 12, lineHeight: 1.4 }}>{exp.spec}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{exp.description}</div>
                  </td>
                  <td>
                    {exp.skills && exp.skills.length > 0 ? exp.skills.map(sk => (
                      <span key={sk.id} className="expert-skill-tag">
                        <span className={`badge ${sk.type === 'playwright' ? 'badge-blue' : 'badge-green'}`} style={{ padding: '1px 5px', fontSize: 9, marginRight: 4 }}>
                          {ENGINE_LABEL[sk.type] || sk.type}
                        </span>{sk.name}
                      </span>
                    )) : <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>未装配技能</span>}
                  </td>
                  <td>
                    {exp.knowledgeCategories && exp.knowledgeCategories.length > 0
                      ? exp.knowledgeCategories.map(cat => (
                        <span key={cat} className="badge badge-yellow" style={{ fontSize: 9, marginRight: 4, marginBottom: 4, display: 'inline-block' }}>{cat}</span>))
                      : <span style={{ fontStyle: 'italic', color: 'var(--text-muted)', fontSize: 11 }}>未绑定</span>}
                    {exp.webSearchEnabled && (
                      <span className="badge badge-green" style={{ fontSize: 9, marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 3 }}><Globe size={9} />联网</span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="icon-btn" title="编辑" onClick={() => openEdit(exp)}><Pencil size={14} /></button>
                      <button className="icon-btn danger" title="删除" onClick={() => deleteExpert(exp.id)}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {experts.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>暂无岗位专家</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
