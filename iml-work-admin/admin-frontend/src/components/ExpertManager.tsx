import { useState, useEffect } from 'react'
import { Plus, Check, RefreshCw, FileCode, Play, Trash2, Database } from 'lucide-react'

interface Skill {
  id: string
  name: string
  type: string
}

interface Expert {
  id: string
  title: string
  spec: string
  description: string
  skills?: Skill[]
  knowledgeCategories?: string[]
}

const KNOWLEDGE_CATEGORIES = ['公司基本信息', '行政财务制度', '企业合规制度', '人事审批规范']

export default function ExpertManager() {
  const [experts, setExperts] = useState<Expert[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)

  // New Expert Form States
  const [title, setTitle] = useState('')
  const [spec, setSpec] = useState('')
  const [description, setDescription] = useState('')
  const [skills, setSkills] = useState<Skill[]>([])

  // Temporary Skill input states
  const [skillName, setSkillName] = useState('')
  const [skillType, setSkillType] = useState('playwright')

  // Bound corporate knowledge-base categories
  const [knowledgeCategories, setKnowledgeCategories] = useState<string[]>([])

  const toggleCategory = (cat: string) => {
    setKnowledgeCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat])
  }

  const deleteExpert = async (id: string) => {
    if (!confirm('确认删除该岗位专家?')) return
    try {
      const res = await fetch(`/api/v1/experts/${id}`, { method: 'DELETE' })
      if (res.ok) fetchExperts()
    } catch (err) { console.error(err) }
  }

  const fetchExperts = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/v1/experts')
      if (res.ok) {
        const data = await res.json()
        setExperts(data)
      }
    } catch (err) {
      console.error('Failed to fetch experts', err)
    }
    setLoading(false)
  }

  useEffect(() => {
    fetchExperts()
  }, [])

  const handleAddSkill = (e: React.FormEvent) => {
    e.preventDefault()
    if (!skillName.trim()) return
    const newSkill: Skill = {
      id: `skill-sync-expert-temp-${Date.now()}`,
      name: skillName.trim(),
      type: skillType
    }
    setSkills([...skills, newSkill])
    setSkillName('')
  }

  const handleRemoveSkill = (index: number) => {
    setSkills(skills.filter((_, idx) => idx !== index))
  }

  const handleSubmitExpert = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !spec.trim()) {
      alert('请填写岗位专家名称与功能描述')
      return
    }

    const payload = {
      title,
      spec,
      description,
      skills,
      knowledgeCategories
    }

    try {
      const res = await fetch('/api/v1/experts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      if (res.ok) {
        setShowAddForm(false)
        setTitle('')
        setSpec('')
        setDescription('')
        setSkills([])
        setKnowledgeCategories([])
        fetchExperts()
      } else {
        alert('配置专家失败')
      }
    } catch (err) {
      console.error(err)
      alert('无法连接后端服务')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      
      {/* Action Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
          企业员工领用专家时，容器会自动将配置的自动化技能包拉取同步至本地沙箱并配置关联。
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn-secondary" onClick={fetchExperts}>
            <RefreshCw size={14} />
            <span>刷新列表</span>
          </button>
          <button className="btn-primary" onClick={() => setShowAddForm(!showAddForm)}>
            <Plus size={14} />
            <span>新增岗位专家配置</span>
          </button>
        </div>
      </div>

      {/* Add New Expert Dialog Form */}
      {showAddForm && (
        <div className="glass-panel" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', animation: 'slideIn 0.2s ease' }}>
          <form onSubmit={handleSubmitExpert} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: '600', color: 'var(--brand-primary)' }}>1. 岗位专家基础属性定义</h3>
            
            <div className="form-group">
              <label className="form-label">专家名称</label>
              <input type="text" className="form-input" placeholder="例如: 公章会签助手" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            <div className="form-group">
              <label className="form-label">一句话功能描述</label>
              <input type="text" className="form-input" placeholder="自动对比合同合规度并自动执行公章审批流填写" value={spec} onChange={(e) => setSpec(e.target.value)} />
            </div>

            <div className="form-group">
              <label className="form-label">详细技能背景描述</label>
              <textarea className="form-input" style={{ minHeight: '80px', resize: 'vertical' }} placeholder="说明此岗位助手的背景职责..." value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
              <button type="submit" className="btn-primary">
                <Check size={14} />
                <span>保存并发布专家</span>
              </button>
              <button type="button" className="btn-secondary" onClick={() => setShowAddForm(false)}>取消</button>
            </div>
          </form>

          {/* Skill Attachments */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', borderLeft: '1px solid var(--border-color)', paddingLeft: '20px' }}>
            <h3 style={{ fontSize: '15px', fontWeight: '600', color: 'var(--brand-secondary)' }}>2. 关联自动化机器人技能包</h3>
            
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
              <div className="form-group" style={{ flex: 2 }}>
                <label className="form-label">技能包名称</label>
                <input type="text" className="form-input" placeholder="例如: 智能发票OCR抽取" value={skillName} onChange={(e) => setSkillName(e.target.value)} />
              </div>

              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">执行沙箱类型</label>
                <select className="form-select" value={skillType} onChange={(e) => setSkillType(e.target.value)}>
                  <option value="playwright">Playwright 浏览器</option>
                  <option value="python-sandbox">WASM Python 沙箱</option>
                  <option value="onnx-bge">本地向量模型</option>
                </select>
              </div>

              <button className="btn-secondary" type="button" onClick={handleAddSkill} style={{ height: '38px', padding: '0 12px' }}>添加</button>
            </div>

            <div style={{ flex: 1, background: 'rgba(255,255,255,0.01)', border: '1px dashed var(--border-color)', borderRadius: '6px', padding: '12px', overflowY: 'auto' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>已添加的技能动作:</div>
              {skills.map((sk, index) => (
                <div key={index} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.02)', padding: '6px 10px', borderRadius: '4px', marginBottom: '6px', fontSize: '12px' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {sk.type === 'playwright' ? <Play size={12} color="var(--accent-green)" /> : <FileCode size={12} color="var(--brand-secondary)" />}
                    <strong>{sk.name}</strong> 
                    <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>({sk.type})</span>
                  </span>
                  <button className="btn-danger" style={{ padding: '2px 6px', fontSize: '10px' }} onClick={() => handleRemoveSkill(index)}>删除</button>
                </div>
              ))}
              {skills.length === 0 && (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center', marginTop: '20px' }}>
                  暂未关联任何 RPA 或沙箱技能包
                </div>
              )}
            </div>

            <h3 style={{ fontSize: '14px', fontWeight: '600', color: 'var(--brand-primary)', display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
              <Database size={14} />3. 绑定公司级知识库检索范围
            </h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {KNOWLEDGE_CATEGORIES.map(cat => (
                <label key={cat} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '6px 10px', borderRadius: '6px', cursor: 'pointer', border: '1px solid var(--border-color)', background: knowledgeCategories.includes(cat) ? 'rgba(59,130,246,0.12)' : 'transparent' }}>
                  <input type="checkbox" checked={knowledgeCategories.includes(cat)} onChange={() => toggleCategory(cat)} />
                  {cat}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Experts List Table */}
      <div className="glass-panel" style={{ padding: '0px', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '40px' }}>
            正在拉取内网岗位专家配置表...
          </div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th style={{ width: '150px' }}>岗位专家助手</th>
                <th style={{ width: '280px' }}>功能简述</th>
                <th>关联自动化核心技能 (Skills Synchronized)</th>
                <th style={{ width: '160px' }}>知识库检索范围</th>
                <th style={{ width: '90px' }}>预设状态</th>
                <th style={{ width: '70px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {experts.map((exp) => (
                <tr key={exp.id}>
                  <td>
                    <div style={{ fontWeight: '600', color: 'var(--brand-primary)' }}>{exp.title}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>ID: {exp.id}</div>
                  </td>
                  <td>
                    <div style={{ fontSize: '12px', lineHeight: '1.4' }}>{exp.spec}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                      {exp.description}
                    </div>
                  </td>
                  <td>
                    {exp.skills && exp.skills.map((sk) => (
                      <span key={sk.id} className="expert-skill-tag">
                        <span className={`badge ${sk.type === 'playwright' ? 'badge-green' : 'badge-purple'}`} style={{ padding: '1px 4px', fontSize: '9px', marginRight: '4px' }}>
                          {sk.type}
                        </span>
                        {sk.name}
                      </span>
                    ))}
                    {(!exp.skills || exp.skills.length === 0) && (
                      <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>无内置技能</span>
                    )}
                  </td>
                  <td>
                    {exp.knowledgeCategories && exp.knowledgeCategories.length > 0 ? (
                      exp.knowledgeCategories.map(cat => (
                        <span key={cat} className="badge badge-yellow" style={{ fontSize: '9px', marginRight: '4px', marginBottom: '4px', display: 'inline-block' }}>{cat}</span>
                      ))
                    ) : (
                      <span style={{ fontStyle: 'italic', color: 'var(--text-muted)', fontSize: '11px' }}>未绑定</span>
                    )}
                  </td>
                  <td>
                    <span className="badge badge-blue">已发布</span>
                  </td>
                  <td>
                    <button className="btn-danger" style={{ padding: '4px 8px' }} onClick={() => deleteExpert(exp.id)}><Trash2 size={12} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  )
}
