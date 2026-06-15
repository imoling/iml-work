import { useState, useEffect } from 'react'
import {
  Search, Upload, Play, Save, Plus, RefreshCw, Trash2, X, Terminal,
  Globe, Code2, MousePointer2, Brain, Boxes, CheckCircle2, FileEdit, PauseCircle, Send, Tag
} from 'lucide-react'

interface Skill {
  id: string
  name: string
  type: string
  category: string
  status: string
  version: string
  description: string
  triggerKeywords: string[]
  allowedRoles: string[]
  sopContent: string
  code: string
  source: string
}

interface ExpertRef { id: string; title: string }

const BLANK: Skill = {
  id: '', name: '', type: 'playwright', category: '办公自动化', status: 'DRAFT', version: '1.0.0',
  description: '', triggerKeywords: [], allowedRoles: [], sopContent: '', code: '', source: 'preset'
}

// 执行引擎：图标 / 名称 / 配色
const ENGINES: Record<string, { label: string; icon: React.ReactNode; color: string; bg: string }> = {
  'playwright': { label: '浏览器自动化', icon: <Globe size={20} />, color: '#3B82F6', bg: 'rgba(59,130,246,0.12)' },
  'python-sandbox': { label: 'Python 数据处理', icon: <Code2 size={20} />, color: '#1F9E69', bg: 'var(--mint-50)' },
  'nut-js': { label: '桌面自动化', icon: <MousePointer2 size={20} />, color: '#D97706', bg: 'rgba(245,158,11,0.14)' },
  'onnx-bge': { label: '本地向量模型', icon: <Brain size={20} />, color: '#7C3AED', bg: 'rgba(139,92,246,0.12)' }
}
const engineOf = (t: string) => ENGINES[t] || { label: t || '通用', icon: <Boxes size={20} />, color: '#6B7280', bg: 'var(--bg-subtle)' }

const PRESET_CATEGORIES = ['办公自动化', '财务税务', '知识管理', '数据处理', '通用工具']

const STATUS_META: Record<string, { label: string; cls: string }> = {
  PUBLISHED: { label: '已发布', cls: 'badge-green' },
  DRAFT: { label: '草稿', cls: 'badge-yellow' },
  DISABLED: { label: '已停用', cls: 'badge-red' }
}
const statusOf = (s: string) => STATUS_META[s] || STATUS_META.PUBLISHED

const CODE_TEMPLATE = `// 浏览器自动化技能模板
const { chromium } = require('playwright')
module.exports = async function run(ctx) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newContext({ storageState: ctx.storageState }).then(c => c.newPage())
  await page.goto(ctx.params.url)
  // TODO: 填写表单 / 点击审批 ...
  await browser.close()
  return { ok: true }
}`

export default function SkillsHub() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [experts, setExperts] = useState<ExpertRef[]>([])
  const [loading, setLoading] = useState(true)

  // 过滤
  const [query, setQuery] = useState('')
  const [fCategory, setFCategory] = useState('全部')
  const [fStatus, setFStatus] = useState('全部')

  // 编辑抽屉
  const [selected, setSelected] = useState<Skill | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [testInput, setTestInput] = useState('')

  const fetchAll = async () => {
    setLoading(true)
    try {
      const [sk, ex] = await Promise.all([fetch('/api/v1/skills'), fetch('/api/v1/experts')])
      if (sk.ok) setSkills(await sk.json())
      if (ex.ok) setExperts(await ex.json())
    } catch (err) { console.error(err) }
    setLoading(false)
  }

  useEffect(() => { fetchAll() }, [])

  const roleName = (id: string) => experts.find(e => e.id === id)?.title || id

  const categories = ['全部', ...Array.from(new Set([...PRESET_CATEGORIES, ...skills.map(s => s.category).filter(Boolean)]))]

  const visible = skills.filter(s => {
    if (fCategory !== '全部' && (s.category || '未分类') !== fCategory) return false
    if (fStatus !== '全部' && (s.status || 'PUBLISHED') !== fStatus) return false
    if (query.trim()) {
      const q = query.toLowerCase()
      const hay = `${s.name} ${s.description} ${(s.triggerKeywords || []).join(' ')}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  const counts = {
    total: skills.length,
    published: skills.filter(s => (s.status || 'PUBLISHED') === 'PUBLISHED').length,
    draft: skills.filter(s => s.status === 'DRAFT').length,
    engines: new Set(skills.map(s => s.type)).size
  }

  const openEdit = (s: Skill) => { setSelected({ ...s, code: s.code || CODE_TEMPLATE }); setLogs([]); setTestInput('') }
  const openNew = () => { setSelected({ ...BLANK, code: CODE_TEMPLATE }); setLogs([]); setTestInput('') }

  const save = async () => {
    if (!selected) return
    if (!selected.name.trim()) { alert('请填写技能名称'); return }
    const isNew = !selected.id
    const res = await fetch(isNew ? '/api/v1/skills' : `/api/v1/skills/${selected.id}`, {
      method: isNew ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selected)
    })
    if (res.ok) { setSelected(null); fetchAll() } else { alert('保存失败') }
  }

  const remove = async (id: string) => {
    if (!confirm('确认删除该技能?')) return
    const res = await fetch(`/api/v1/skills/${id}`, { method: 'DELETE' })
    if (res.ok) { if (selected?.id === id) setSelected(null); fetchAll() }
  }

  const changeStatus = async (id: string, status: string) => {
    const res = await fetch(`/api/v1/skills/${id}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
    })
    if (res.ok) fetchAll()
  }

  const runTest = async () => {
    if (!selected?.id) { alert('请先保存技能后再进行测试'); return }
    setLogs(['[控制台] 提交测试请求...'])
    const res = await fetch(`/api/v1/skills/${selected.id}/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: testInput })
    })
    if (res.ok) { const data = await res.json(); setLogs(data.logs || []) } else { setLogs(['[错误] 测试执行失败']) }
  }

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const fd = new FormData(); fd.append('file', file)
    const res = await fetch('/api/v1/skills/upload', { method: 'POST', body: fd })
    if (res.ok) {
      const data = await res.json()
      alert(`技能包解析归档成功：${data.name}（已置为草稿，待发布）`)
      fetchAll()
    } else { alert('上传解析失败') }
    e.target.value = ''
  }

  const stat = (label: string, value: React.ReactNode, icon: React.ReactNode, color: string) => (
    <div className="glass-panel" style={{ flex: 1, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ color }}>{icon}</div>
      <div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* 顶部说明 + 操作 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 640 }}>
          企业内部技能中心：集中沉淀、分类与发布可复用的自动化技能，供各岗位工作分身按权限调用。技能以 SKILL.md（说明 + 触发词 + 标准流程 + 代码）形式管理。
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" onClick={fetchAll}><RefreshCw size={14} /><span>刷新</span></button>
          <label className="btn-secondary" style={{ cursor: 'pointer' }}>
            <Upload size={14} /><span>上传技能包</span>
            <input type="file" accept=".md,.zip" hidden onChange={onUpload} />
          </label>
          <button className="btn-primary" onClick={openNew}><Plus size={14} /><span>新建技能</span></button>
        </div>
      </div>

      {/* 概览 */}
      <div style={{ display: 'flex', gap: 14 }}>
        {stat('技能总数', counts.total, <Boxes size={20} />, 'var(--brand-primary)')}
        {stat('已发布', counts.published, <CheckCircle2 size={20} />, 'var(--accent-green)')}
        {stat('草稿待审', counts.draft, <FileEdit size={20} />, 'var(--accent-yellow)')}
        {stat('执行引擎种类', counts.engines, <Tag size={20} />, 'var(--brand-secondary)')}
      </div>

      {/* 过滤条 */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
            <input className="form-input" placeholder="搜索技能名称 / 描述 / 触发词" value={query}
              onChange={e => setQuery(e.target.value)} style={{ paddingLeft: 32 }} />
            <Search size={14} style={{ position: 'absolute', left: 10, top: 12, color: 'var(--text-muted)' }} />
          </div>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            {['全部', 'PUBLISHED', 'DRAFT', 'DISABLED'].map(s => (
              <button key={s} className={`filter-chip ${fStatus === s ? 'active' : ''}`} onClick={() => setFStatus(s)}>
                {s === '全部' ? '全部状态' : statusOf(s).label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {categories.map(c => (
            <button key={c} className={`filter-chip ${fCategory === c ? 'active' : ''}`} onClick={() => setFCategory(c)}>{c}</button>
          ))}
        </div>
      </div>

      {/* 技能卡片网格 */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>正在加载技能目录...</div>
      ) : visible.length === 0 ? (
        <div className="glass-panel" style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
          没有符合条件的技能。点击「新建技能」或「上传技能包」开始。
        </div>
      ) : (
        <div className="skill-grid">
          {visible.map(s => {
            const eng = engineOf(s.type)
            const st = statusOf(s.status || 'PUBLISHED')
            return (
              <div key={s.id} className={`skill-card ${s.status === 'DISABLED' ? 'disabled' : ''}`} onClick={() => openEdit(s)}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div className="skill-ic" style={{ background: eng.bg, color: eng.color }}>{eng.icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="skill-name">{s.name}</span>
                      <span className={`badge ${st.cls}`}>{st.label}</span>
                    </div>
                    <div className="skill-id">v{s.version || '1.0.0'} · {s.id}</div>
                  </div>
                </div>

                <div className="skill-desc">{s.description || '（暂无描述）'}</div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="badge badge-blue">{eng.label}</span>
                  {s.category && <span className="badge badge-purple">{s.category}</span>}
                </div>

                {(s.triggerKeywords || []).length > 0 && (
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {s.triggerKeywords.slice(0, 4).map((k, i) => <span key={i} className="kw-chip">{k}</span>)}
                    {s.triggerKeywords.length > 4 && <span className="kw-chip">+{s.triggerKeywords.length - 4}</span>}
                  </div>
                )}

                <div className="skill-card-foot">
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    适用 {(s.allowedRoles || []).length} 个岗位
                  </span>
                  <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
                    {s.status === 'PUBLISHED'
                      ? <button className="icon-btn" title="停用" onClick={() => changeStatus(s.id, 'DISABLED')}><PauseCircle size={14} /></button>
                      : <button className="icon-btn" title="发布" onClick={() => changeStatus(s.id, 'PUBLISHED')}><Send size={14} /></button>}
                    <button className="icon-btn" title="编辑" onClick={() => openEdit(s)}><FileEdit size={14} /></button>
                    <button className="icon-btn danger" title="删除" onClick={() => remove(s.id)}><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 编辑抽屉 */}
      {selected && (
        <div className="skill-drawer-overlay" onClick={() => setSelected(null)}>
          <div className="skill-drawer" onClick={e => e.stopPropagation()}>
            <div className="drawer-head">
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>{selected.id ? '编辑技能' : '新建技能'}</h3>
              <button className="icon-btn" onClick={() => setSelected(null)}><X size={16} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">技能名称</label>
                <input className="form-input" value={selected.name} onChange={e => setSelected({ ...selected, name: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">执行引擎</label>
                <select className="form-select" value={selected.type} onChange={e => setSelected({ ...selected, type: e.target.value })}>
                  <option value="playwright">浏览器自动化</option>
                  <option value="python-sandbox">Python 数据处理</option>
                  <option value="nut-js">桌面自动化</option>
                  <option value="onnx-bge">本地向量模型</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">业务分类</label>
                <select className="form-select" value={selected.category} onChange={e => setSelected({ ...selected, category: e.target.value })}>
                  {PRESET_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">版本号</label>
                  <input className="form-input" value={selected.version} onChange={e => setSelected({ ...selected, version: e.target.value })} placeholder="1.0.0" />
                </div>
                <div className="form-group">
                  <label className="form-label">状态</label>
                  <select className="form-select" value={selected.status} onChange={e => setSelected({ ...selected, status: e.target.value })}>
                    <option value="PUBLISHED">已发布</option>
                    <option value="DRAFT">草稿</option>
                    <option value="DISABLED">已停用</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">技能描述（供大模型语义匹配）</label>
              <input className="form-input" value={selected.description} onChange={e => setSelected({ ...selected, description: e.target.value })} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">触发关键词（逗号分隔）</label>
                <input className="form-input" value={selected.triggerKeywords.join(', ')}
                  onChange={e => setSelected({ ...selected, triggerKeywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
              </div>
              <div className="form-group">
                <label className="form-label">适用岗位（逗号分隔岗位编号）</label>
                <input className="form-input" value={selected.allowedRoles.join(', ')}
                  onChange={e => setSelected({ ...selected, allowedRoles: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
              </div>
            </div>
            {selected.allowedRoles.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: -8 }}>
                {selected.allowedRoles.map(r => <span key={r} className="kw-chip">{roleName(r)}</span>)}
              </div>
            )}

            <div className="form-group">
              <label className="form-label">标准作业流程 SOP</label>
              <textarea className="form-textarea" value={selected.sopContent || ''} rows={4}
                onChange={e => setSelected({ ...selected, sopContent: e.target.value })}
                placeholder="描述该技能的执行步骤与规则，会注入到分身的上下文中..." style={{ resize: 'vertical' }} />
            </div>

            <div className="form-group">
              <label className="form-label">技能代码</label>
              <textarea className="code-editor" spellCheck={false} value={selected.code}
                onChange={e => setSelected({ ...selected, code: e.target.value })} />
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn-primary" onClick={save}><Save size={14} /><span>保存技能</span></button>
              <div style={{ flex: 1 }} />
              <input className="form-input" placeholder="测试参数（如网址）" value={testInput}
                onChange={e => setTestInput(e.target.value)} style={{ maxWidth: 200 }} />
              <button className="btn-secondary" onClick={runTest}><Play size={14} /><span>单步测试</span></button>
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                <Terminal size={13} /><span>测试控制台</span>
              </div>
              <pre className="test-console">{logs.length ? logs.join('\n') : '// 单步测试输出将在此打印'}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
