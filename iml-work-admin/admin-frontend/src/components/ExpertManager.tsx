import Switch from './Switch'
import { useState, useEffect } from 'react'
import { Plus, Check, RefreshCw, Trash2, Database, Boxes, Pencil, X, Search, Globe, Sparkles, ShieldCheck } from 'lucide-react'

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
  ontologyDomains?: string[]
}

// 分类来自数据字典（管理端「字典管理」维护）；此常量仅作字典接口不可用时的兜底
const FALLBACK_CATEGORIES = ['公司基本信息', '行政财务制度', '企业合规制度', '人事审批规范']

const ENGINE_LABEL: Record<string, string> = {
  'playwright': '浏览器自动化',
  'python-sandbox': 'Python 数据处理',
  'nut-js': '桌面自动化',
  'onnx-bge': '本地向量模型'
}

const BLANK = { title: '', spec: '', description: '', skillIds: [] as string[], knowledgeCategories: [] as string[], webSearchEnabled: false, principles: '', workStyle: '', ontologyDomains: [] as string[], ontologyActionIds: [] as string[] }

interface OntoCap { id: string; label: string; actionKey: string; objectType: string; capability: string; typeLabel: string }

export default function ExpertManager() {
  const [experts, setExperts] = useState<Expert[]>([])
  // 企业知识分类（实时读字典，失败回退内置四类）
  const [categories, setCategories] = useState<string[]>(FALLBACK_CATEGORIES)
  useEffect(() => {
    fetch('/api/v1/dicts/knowledge_category').then(r => r.ok ? r.json() : null)
      .then((items: any) => { if (Array.isArray(items) && items.length) setCategories(items.map((i: any) => i.label)) })
      .catch(() => {})
  }, [])
  const [catalog, setCatalog] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<typeof BLANK>(BLANK)
  const [skillQuery, setSkillQuery] = useState('')
  const [ontoDomains, setOntoDomains] = useState<string[]>([])   // 本体现有业务域（数据驱动，非写死）
  // 岗位 → 授权给它的本体动作（岗位的能力 = 技能 + 本体动作；只显示技能会让审批型岗位看着像"什么都不会"）
  const [ontoByExpert, setOntoByExpert] = useState<Record<string, OntoCap[]>>({})
  const [allActions, setAllActions] = useState<(OntoCap & { domain: string })[]>([])
  const reloadOnto = () => {
    Promise.all([
      fetch('/api/v1/ontology/actions').then(r => r.ok ? r.json() : []),
      fetch('/api/v1/ontology/types').then(r => r.ok ? r.json() : []),
    ]).then(([acts, types]: [any[], any[]]) => {
      const typeLabel = new Map<string, string>()
      for (const t of types || []) typeLabel.set(`${t.domain}.${t.typeKey}`, t.label || t.typeKey)
      const map: Record<string, OntoCap[]> = {}
      for (const a of acts || []) {
        for (const eid of (a.allowedExperts || [])) {
          (map[eid] ||= []).push({
            id: a.id, label: a.label, actionKey: a.actionKey, objectType: a.objectType,
            capability: a.capability, typeLabel: typeLabel.get(`${a.domain}.${a.objectType}`) || a.objectType,
          })
        }
      }
      setOntoByExpert(map)
      setAllActions((acts || []).map((a: any) => ({
        id: a.id, label: a.label, actionKey: a.actionKey, objectType: a.objectType, capability: a.capability,
        domain: a.domain, typeLabel: typeLabel.get(`${a.domain}.${a.objectType}`) || a.objectType,
      })))
    }).catch(() => {})
  }
  useEffect(() => { reloadOnto() }, [])
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
        const cats: string[] = Array.isArray(d.knowledgeCategories) ? d.knowledgeCategories.filter((c: string) => categories.includes(c)) : []
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
      const [ex, sk, ot] = await Promise.all([fetch('/api/v1/experts'), fetch('/api/v1/skills'), fetch('/api/v1/ontology/types').catch(() => null)])
      if (ex.ok) setExperts(await ex.json())
      if (sk.ok) setCatalog(await sk.json())
      if (ot && ot.ok) { const ts: any[] = await ot.json(); setOntoDomains([...new Set(ts.map(t => t.domain).filter(Boolean))] as string[]) }
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
      workStyle: (exp.workStyle || []).join('\n'),
      ontologyDomains: exp.ontologyDomains || [],
      ontologyActionIds: (ontoByExpert[exp.id] || []).map(a => a.id)
    })
    setSkillQuery('')
    setShowForm(true)
  }

  const toggleSkill = (id: string) =>
    setForm(f => ({ ...f, skillIds: f.skillIds.includes(id) ? f.skillIds.filter(x => x !== id) : [...f.skillIds, id] }))
  const toggleCategory = (cat: string) =>
    setForm(f => ({ ...f, knowledgeCategories: f.knowledgeCategories.includes(cat) ? f.knowledgeCategories.filter(c => c !== cat) : [...f.knowledgeCategories, cat] }))
  const toggleDomain = (d: string) =>
    setForm(f => ({ ...f, ontologyDomains: f.ontologyDomains.includes(d) ? f.ontologyDomains.filter(x => x !== d) : [...f.ontologyDomains, d] }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.title.trim() || !form.spec.trim()) { alert('请填写岗位名称与功能描述'); return }
    const payload = {
      title: form.title, spec: form.spec, description: form.description,
      skills: form.skillIds.map(id => ({ id })),
      knowledgeCategories: form.knowledgeCategories,
      webSearchEnabled: form.webSearchEnabled,
      principles: form.principles.split('\n').map(s => s.trim()).filter(Boolean),
      workStyle: form.workStyle.split('\n').map(s => s.trim()).filter(Boolean),
      ontologyDomains: form.ontologyDomains
    }
    const res = await fetch(editingId ? `/api/v1/experts/${editingId}` : '/api/v1/experts', {
      method: editingId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    if (!res.ok) { alert('保存失败'); return }
    // 本体授权存在动作上，但入口在岗位这边——保存岗位后把授权同步回各动作（后端一次事务双向同步）。
    try {
      const saved = await res.json()
      const eid = editingId || saved?.id
      if (eid) {
        await fetch(`/api/v1/ontology/expert-actions/${eid}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actionIds: form.ontologyActionIds }),
        })
      }
    } catch (err) { console.error('本体授权同步失败', err) }
    setShowForm(false); setEditingId(null); setForm(BLANK); fetchAll(); reloadOnto()
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
      <div className="page-header">
        <div className="page-intro">
          定义岗位工作分身的职责，并从企业技能中心挑选要装配的技能。员工领用该岗位时，会自动把选定的技能与知识库范围同步至本地。
        </div>
        <div className="page-actions">
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
                <textarea className="form-textarea" style={{ minHeight: 96, resize: 'vertical' }} placeholder="留空则客户端展示以下企业默认治理原则：&#10;只依据真实抓取 / 检索到的内容作答，绝不编造任何业务数据&#10;登录态与凭证只保存在你本地受管环境，平台绝不上传&#10;增删改 / 批量 / 删除等写操作，执行前必须经你人工确认&#10;高风险操作触发一次性签名授权锁，未授权不执行" value={form.principles} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, principles: v })) }} />
              </div>
              <div className="form-group">
                <label className="form-label">我的工作方式<span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · 每行一条</span></label>
                <textarea className="form-textarea" style={{ minHeight: 96, resize: 'vertical' }} placeholder="留空则客户端展示以下默认工作方式：&#10;查询 / 读取类：自动直达目标页取数，按标准流程 SOP 整理后回你&#10;写入 / 操作类：先从你的话里提炼参数 → 弹表单确认 → 再执行&#10;只调用企业按本岗位装配的技能，越权不调用" value={form.workStyle} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, workStyle: v })) }} />
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
                {categories.map(cat => (
                  <button type="button" key={cat} onClick={() => toggleCategory(cat)}
                    className={`filter-chip ${form.knowledgeCategories.includes(cat) ? 'active' : ''}`}>
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* 业务域侧重：本体解析优先在侧重域内匹配（生产岗侧重 ERM、销售岗侧重 CRM）——领域语料随岗位配置 */}
            {ontoDomains.length > 0 && (
              <div className="form-group">
                <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Boxes size={14} />业务域侧重<span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· 分身理解口语指令时优先在侧重域内匹配对象/动作；不选=全域</span>
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {ontoDomains.map(d => (
                    <button type="button" key={d} onClick={() => toggleDomain(d)}
                      className={`filter-chip ${form.ontologyDomains.includes(d) ? 'active' : ''}`}>
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 本体能力（岗位授权）：岗位的能力 = 技能 + 本体动作。
                「批准生产指令」这种高危动作必须限定岗位——本体动作曾经完全没有权限概念，
                只要业务域命中，一线操作工的分身就能批准生产指令。授权写在动作上（allowedExperts），
                但**配置入口放在岗位这边**才符合直觉："这个岗位能干什么"，而不是反过来逐个动作去找岗位。 */}
            {allActions.length > 0 && (
              <div className="form-group">
                <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <ShieldCheck size={14} />本体能力（授权）
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· 勾选后该岗位分身才有权执行；写操作不授权=任何业务域命中的岗位都能做</span>
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(230px,1fr))', gap: 6 }}>
                  {allActions
                    .filter(a => !form.ontologyDomains.length || form.ontologyDomains.includes(a.domain))
                    .map(a => {
                      const on = form.ontologyActionIds.includes(a.id)
                      const write = a.capability !== 'read'
                      return (
                        <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', padding: '4px 6px', border: '1px solid var(--border-color)', borderRadius: 4, background: on ? 'var(--mint-50, rgba(22,163,113,.06))' : 'transparent' }}>
                          <input type="checkbox" checked={on} style={{ width: 'auto' }}
                            onChange={e => setForm(f => ({ ...f, ontologyActionIds: e.target.checked
                              ? [...f.ontologyActionIds, a.id]
                              : f.ontologyActionIds.filter(x => x !== a.id) }))} />
                          <span className={`badge ${write ? 'badge-red' : 'badge-green'}`} style={{ fontSize: 9, padding: '0 4px' }}>{write ? '写' : '读'}</span>
                          <span>{a.label} · {a.typeLabel}</span>
                        </label>
                      )
                    })}
                </div>
                {!form.ontologyDomains.length && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>未选业务域侧重 → 列出全部动作。选了域会自动收窄。</div>}
              </div>
            )}

            {/* 能力开关 */}
            <div className="form-group">
              <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Globe size={14} />联网检索能力
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <Switch checked={form.webSearchEnabled} onChange={v => setForm(f => ({ ...f, webSearchEnabled: v }))} onText="允许该岗位分身联网检索" offText="允许该岗位分身联网检索" />
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>开启后，分身会根据问题自主判断是否上网查找最新/外部信息，无需用户输入"联网/搜索"等触发词。</span>
              </div>
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
                    {exp.skills && exp.skills.length > 0 && exp.skills.map(sk => (
                      <span key={sk.id} className="expert-skill-tag">
                        <span className={`badge ${sk.type === 'playwright' ? 'badge-blue' : 'badge-green'}`} style={{ padding: '1px 5px', fontSize: 9, marginRight: 4 }}>
                          {ENGINE_LABEL[sk.type] || sk.type}
                        </span>{sk.name}
                      </span>
                    ))}
                    {/* 本体能力：授权给该岗位的本体动作（如「批准生产指令」）。
                        岗位的能力 = 技能 + 本体动作。只显示技能会让审批型岗位（领导）看着像「什么都不会」，
                        而它恰恰握着最高危的权限。 */}
                    {ontoByExpert[exp.id]?.map(a => (
                      <span key={a.id} className="expert-skill-tag" title={`本体动作 ${a.objectType}.${a.actionKey}（${a.capability}）`}>
                        <span className="badge badge-purple" style={{ padding: '1px 5px', fontSize: 9, marginRight: 4 }}>本体</span>
                        {a.label}·{a.typeLabel}
                      </span>
                    ))}
                    {!(exp.skills?.length) && !(ontoByExpert[exp.id]?.length) &&
                      <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>未装配技能 / 未授权本体动作</span>}
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
