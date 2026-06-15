import { useState, useEffect } from 'react'
import { Search, Upload, Play, Save, Plus, RefreshCw, Trash2, FileCode, Terminal } from 'lucide-react'

interface Skill {
  id: string
  name: string
  type: string
  description: string
  triggerKeywords: string[]
  allowedRoles: string[]
  sopContent: string
  code: string
  source: string
}

const BLANK: Skill = {
  id: '', name: '', type: 'playwright', description: '',
  triggerKeywords: [], allowedRoles: [], sopContent: '', code: '', source: 'preset'
}

const CODE_TEMPLATE = `// Playwright 网页驱动技能模板
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
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Skill | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [testInput, setTestInput] = useState('')
  const [loading, setLoading] = useState(true)

  const fetchSkills = async (q = '') => {
    setLoading(true)
    try {
      const res = await fetch(`/api/v1/skills${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      if (res.ok) setSkills(await res.json())
    } catch (err) { console.error(err) }
    setLoading(false)
  }

  useEffect(() => { fetchSkills() }, [])

  const edit = (s: Skill) => {
    setSelected({ ...s, code: s.code || CODE_TEMPLATE })
    setLogs([])
  }

  const newSkill = () => { setSelected({ ...BLANK, code: CODE_TEMPLATE }); setLogs([]) }

  const save = async () => {
    if (!selected) return
    if (!selected.name.trim()) { alert('请填写技能名称'); return }
    const isNew = !selected.id
    const url = isNew ? '/api/v1/skills' : `/api/v1/skills/${selected.id}`
    const res = await fetch(url, {
      method: isNew ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selected)
    })
    if (res.ok) { setSelected(null); fetchSkills(query) } else { alert('保存失败') }
  }

  const remove = async (id: string) => {
    if (!confirm('确认删除该技能包?')) return
    const res = await fetch(`/api/v1/skills/${id}`, { method: 'DELETE' })
    if (res.ok) { if (selected?.id === id) setSelected(null); fetchSkills(query) }
  }

  const runTest = async () => {
    if (!selected?.id) { alert('请先保存技能后再进行测试'); return }
    setLogs(['[console] 提交测试请求...'])
    const res = await fetch(`/api/v1/skills/${selected.id}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: testInput })
    })
    if (res.ok) {
      const data = await res.json()
      setLogs(data.logs || [])
    } else { setLogs(['[error] 测试执行失败']) }
  }

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/v1/skills/upload', { method: 'POST', body: fd })
    if (res.ok) {
      const data = await res.json()
      alert(`技能包解析归档成功: ${data.name}\n触发词: ${(data.triggerKeywords || []).join(', ')}`)
      fetchSkills(query)
    } else { alert('上传解析失败') }
    e.target.value = ''
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: '20px' }}>
      {/* Left: list + search + upload */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input className="form-input" placeholder="搜索技能名称 / 描述" value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && fetchSkills(query)}
              style={{ paddingLeft: '32px' }} />
            <Search size={14} style={{ position: 'absolute', left: '10px', top: '12px', color: 'var(--text-muted)' }} />
          </div>
          <button className="btn-secondary" onClick={() => fetchSkills(query)}><RefreshCw size={14} /></button>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn-primary" onClick={newSkill}><Plus size={14} /><span>新建技能</span></button>
          <label className="btn-secondary" style={{ cursor: 'pointer' }}>
            <Upload size={14} /><span>上传 .md / .zip</span>
            <input type="file" accept=".md,.zip" hidden onChange={onUpload} />
          </label>
        </div>

        <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-secondary)' }}>加载技能列表...</div>
          ) : (
            <table className="admin-table">
              <thead><tr><th>技能</th><th>沙箱类型</th><th>来源</th><th style={{ width: 70 }}>操作</th></tr></thead>
              <tbody>
                {skills.map(s => (
                  <tr key={s.id} style={{ cursor: 'pointer', background: selected?.id === s.id ? 'var(--bg-active)' : undefined }}>
                    <td onClick={() => edit(s)}>
                      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <FileCode size={12} color="var(--brand-secondary)" />{s.name}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.id}</div>
                    </td>
                    <td onClick={() => edit(s)}><span className="badge badge-purple">{s.type}</span></td>
                    <td onClick={() => edit(s)}><span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{s.source}</span></td>
                    <td><button className="btn-danger" style={{ padding: '3px 6px' }} onClick={() => remove(s.id)}><Trash2 size={12} /></button></td>
                  </tr>
                ))}
                {skills.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>暂无技能</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Right: editor + test console */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {!selected ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px', fontStyle: 'italic' }}>
            从左侧选择一个技能进行编辑，或新建 / 上传技能包。
          </div>
        ) : (
          <>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--brand-primary)' }}>
              {selected.id ? '编辑技能' : '新建技能'} {selected.id && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>({selected.id})</span>}
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="form-label">技能名称</label>
                <input className="form-input" value={selected.name} onChange={e => setSelected({ ...selected, name: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">执行沙箱类型</label>
                <select className="form-select" value={selected.type} onChange={e => setSelected({ ...selected, type: e.target.value })}>
                  <option value="playwright">浏览器自动化</option>
                  <option value="python-sandbox">Python 沙箱</option>
                  <option value="nut-js">桌面自动化</option>
                  <option value="onnx-bge">本地向量模型</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">技能描述 (供大模型语义匹配)</label>
              <input className="form-input" value={selected.description} onChange={e => setSelected({ ...selected, description: e.target.value })} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-group">
                <label className="form-label">触发关键词 (逗号分隔)</label>
                <input className="form-input" value={selected.triggerKeywords.join(', ')}
                  onChange={e => setSelected({ ...selected, triggerKeywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
              </div>
              <div className="form-group">
                <label className="form-label">允许角色（逗号分隔）</label>
                <input className="form-input" value={selected.allowedRoles.join(', ')}
                  onChange={e => setSelected({ ...selected, allowedRoles: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">技能代码（编辑器）</label>
              <textarea value={selected.code} onChange={e => setSelected({ ...selected, code: e.target.value })}
                spellCheck={false}
                style={{ minHeight: 160, fontFamily: 'JetBrains Mono, monospace', fontSize: 12, background: '#050a14', color: '#9fe6c0', border: '1px solid var(--border-color)', borderRadius: 6, padding: 12, resize: 'vertical', whiteSpace: 'pre' }} />
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn-primary" onClick={save}><Save size={14} /><span>保存技能</span></button>
              <div style={{ flex: 1 }} />
              <input className="form-input" placeholder="测试参数（如网址）" value={testInput}
                onChange={e => setTestInput(e.target.value)} style={{ maxWidth: 200 }} />
              <button className="btn-secondary" onClick={runTest}><Play size={14} /><span>单步测试</span></button>
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--brand-secondary)', marginBottom: 6 }}>
                <Terminal size={13} /><span>测试控制台</span>
              </div>
              <pre style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#10b981', background: '#050a14', padding: 12, borderRadius: 6, minHeight: 80, whiteSpace: 'pre-wrap' }}>
                {logs.length ? logs.join('\n') : '// 单步测试输出将在此实时打印（含浏览器画面帧日志）'}
              </pre>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
