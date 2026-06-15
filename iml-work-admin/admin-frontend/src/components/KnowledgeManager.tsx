import { useState, useEffect } from 'react'
import { Database, Search, Upload, RefreshCw, FileText, Activity, Trash2 } from 'lucide-react'

interface KnowledgeDocument {
  id: string
  filename: string
  sizeBytes: number
  chunksCount: number
  category: string
  uploadTime: string
}

interface MatchChunk {
  documentId: string
  text: string
  score: number
}

interface AuditData {
  totalRetrievals: number
  hits: number
  misses: number
  hitRate: number
  avgLatencyMs: number
  totalChunks: number
  recent: { query: string; hit: boolean; topScore: number; latencyMs: number; clientId: string }[]
}

export default function KnowledgeManager() {
  const [docs, setDocs] = useState<KnowledgeDocument[]>([])
  const [loading, setLoading] = useState(true)
  
  // Upload states
  const [uploadCategory, setUploadCategory] = useState('行政财务制度')
  const [presetDocName, setPresetDocName] = useState('企业基本资质与社会信用代码.txt')
  const [presetDocContent, setPresetDocContent] = useState('公司名称：北京艾姆尔人工智能科技有限公司。信用代码：91110108MA01XXXXXX。公司地址：北京市海淀区中关村南大街1号。主营业务为智能硬件设备制造及算法软件外包。')
  const [uploading, setUploading] = useState(false)

  // Chunking config
  const [chunkSize, setChunkSize] = useState(280)
  const [chunkOverlap, setChunkOverlap] = useState(40)

  // Query states
  const [queryText, setQueryText] = useState('')
  const [queryResults, setQueryResults] = useState<MatchChunk[]>([])
  const [searching, setSearching] = useState(false)

  // Retrieval audit
  const [audit, setAudit] = useState<AuditData | null>(null)

  const fetchDocs = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/v1/knowledge/docs')
      if (res.ok) {
        const data = await res.json()
        setDocs(data)
      }
    } catch (err) {
      console.error(err)
    }
    setLoading(false)
  }

  const fetchAudit = async () => {
    try {
      const res = await fetch('/api/v1/knowledge/audit')
      if (res.ok) setAudit(await res.json())
    } catch (err) {
      console.error(err)
    }
  }

  const deleteDoc = async (id: string) => {
    if (!confirm('删除该文档及其全部向量分块?')) return
    const res = await fetch(`/api/v1/knowledge/docs/${id}`, { method: 'DELETE' })
    if (res.ok) { fetchDocs(); fetchAudit() }
  }

  useEffect(() => {
    fetchDocs()
    fetchAudit()
  }, [])

  const handleUploadPreset = async (e: React.FormEvent) => {
    e.preventDefault()
    setUploading(true)

    // Form data file upload simulation
    const blob = new Blob([presetDocContent], { type: 'text/plain' })
    const file = new File([blob], presetDocName, { type: 'text/plain' })

    const formData = new FormData()
    formData.append('file', file)
    formData.append('category', uploadCategory)
    formData.append('chunkSize', String(chunkSize))
    formData.append('chunkOverlap', String(chunkOverlap))

    try {
      const res = await fetch('/api/v1/knowledge/upload', {
        method: 'POST',
        body: formData
      })
      if (res.ok) {
        const data = await res.json()
        alert(`公司规章文档已切片为 ${data.chunksCreated} 个语义块（块大小 ${data.chunkSize} / 重叠 ${data.chunkOverlap}）并写入 PGVector 数据库！`)
        fetchDocs()
      } else {
        alert('同步失败')
      }
    } catch (err) {
      console.error(err)
    }
    setUploading(false)
  }

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!queryText.trim()) return
    setSearching(true)
    try {
      const res = await fetch(`/api/v1/knowledge/query?text=${encodeURIComponent(queryText)}&topK=3`)
      if (res.ok) {
        const data = await res.json()
        setQueryResults(data)
        fetchAudit()
      }
    } catch (err) {
      console.error(err)
    }
    setSearching(false)
  }

  // Helper for preset changes
  const handlePresetSelectChange = (name: string) => {
    setPresetDocName(name)
    if (name === '企业基本资质与社会信用代码.txt') {
      setPresetDocContent('公司名称：北京艾姆尔人工智能科技有限公司。信用代码：91110108MA01XXXXXX。公司地址：北京市海淀区中关村南大街1号。主营业务为智能硬件设备制造及算法软件外包。')
      setUploadCategory('公司基本信息')
    } else if (name === '公章保管及前台领用守则.txt') {
      setPresetDocContent('公章借用必须提前在系统申请，法务及VP审核后方可带出。公章日常存放在行政前台的二层密码抽屉中，密码由前台小王保管。借用期限最长为2个工作日。')
      setUploadCategory('企业合规制度')
    } else if (name === '高级技术合伙人股权分期协议.txt') {
      setPresetDocContent('技术合伙人股权分期成熟规则：首年成熟25%，剩余部分按月均分在36个月内成熟。离职时未成熟股权由创始团队按初始价格回购。')
      setUploadCategory('人事审批规范')
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '20px' }}>
      
      {/* Left side: Upload and List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        
        {/* Upload box */}
        <form onSubmit={handleUploadPreset} className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Upload size={16} color="var(--brand-primary)" />
            <span>发布同步公司规章制度</span>
          </h3>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div className="form-group">
              <label className="form-label">制度文档预设模板</label>
              <select className="form-select" value={presetDocName} onChange={(e) => handlePresetSelectChange(e.target.value)}>
                <option value="企业基本资质与社会信用代码.txt">企业基本资质与社会信用代码.txt</option>
                <option value="公章保管及前台领用守则.txt">公章保管及前台领用守则.txt</option>
                <option value="高级技术合伙人股权分期协议.txt">高级技术合伙人股权分期协议.txt</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">规章分类</label>
              <select className="form-select" value={uploadCategory} onChange={(e) => setUploadCategory(e.target.value)}>
                <option value="公司基本信息">公司基本信息</option>
                <option value="行政财务制度">行政财务制度</option>
                <option value="企业合规制度">企业合规制度</option>
                <option value="人事审批规范">人事审批规范</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div className="form-group">
              <label className="form-label">分块大小（字符）</label>
              <input type="number" className="form-input" min={50} max={2000} value={chunkSize}
                onChange={(e) => setChunkSize(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label className="form-label">分块重叠（字符）</label>
              <input type="number" className="form-input" min={0} max={500} value={chunkOverlap}
                onChange={(e) => setChunkOverlap(Number(e.target.value))} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">制度文本内容（上传后自动完成向量化与切片）</label>
            <textarea
              className="form-textarea"
              style={{ minHeight: '80px', resize: 'vertical' }}
              value={presetDocContent}
              onChange={(e) => setPresetDocContent(e.target.value)}
            />
          </div>

          <button type="submit" className="btn-primary" disabled={uploading}>
            {uploading ? '正在生成语义切片并写入向量库...' : '发布并更新云端知识库'}
          </button>
        </form>

        {/* Documents list table */}
        <div className="glass-panel" style={{ padding: '0px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: '15px', fontWeight: '600' }}>企业核心知识库列表</h3>
            <button className="btn-secondary" onClick={fetchDocs} style={{ padding: '4px 8px' }}>
              <RefreshCw size={12} />
            </button>
          </div>

          {loading ? (
            <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
              正在加载云端知识文件...
            </div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>文件名</th>
                  <th>知识类目</th>
                  <th>分块数</th>
                  <th>大小</th>
                  <th style={{ width: 50 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((doc) => (
                  <tr key={doc.id}>
                    <td>
                      <div style={{ fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <FileText size={12} color="var(--brand-primary)" />
                        {doc.filename}
                      </div>
                      <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Doc ID: {doc.id}</div>
                    </td>
                    <td>
                      <span className="badge badge-purple">{doc.category}</span>
                    </td>
                    <td>{doc.chunksCount} 块</td>
                    <td>{doc.sizeBytes} B</td>
                    <td><button className="btn-danger" style={{ padding: '3px 6px' }} onClick={() => deleteDoc(doc.id)}><Trash2 size={12} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Retrieval audit panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: '15px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Activity size={16} color="var(--accent-green)" />
              <span>客户端检索命中率与消耗审计</span>
            </h3>
            <button className="btn-secondary" onClick={fetchAudit} style={{ padding: '4px 8px' }}><RefreshCw size={12} /></button>
          </div>
          {audit && (
            <>
              <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
                {[
                  ['检索命中率', `${(audit.hitRate * 100).toFixed(1)}%`, 'var(--accent-green)'],
                  ['总检索次数', String(audit.totalRetrievals), 'var(--brand-primary)'],
                  ['平均时延', `${audit.avgLatencyMs} ms`, 'var(--accent-yellow)'],
                  ['向量分块总数', String(audit.totalChunks), 'var(--brand-secondary)']
                ].map(([label, val, color], i) => (
                  <div key={i} style={{ border: '1px solid var(--border-color)', borderRadius: 6, padding: 10, textAlign: 'center' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{label}</div>
                    <div style={{ fontSize: 17, fontWeight: 'bold', color: color as string }}>{val}</div>
                  </div>
                ))}
              </div>
              <table className="admin-table">
                <thead><tr><th>检索语句</th><th style={{ width: 70 }}>命中</th><th style={{ width: 80 }}>相似度</th><th style={{ width: 70 }}>时延</th></tr></thead>
                <tbody>
                  {audit.recent.map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontSize: 12 }}>{r.query}</td>
                      <td><span className={`badge ${r.hit ? 'badge-green' : 'badge-red'}`}>{r.hit ? '命中' : '未命中'}</span></td>
                      <td style={{ fontSize: 12 }}>{(r.topScore * 100).toFixed(1)}%</td>
                      <td style={{ fontSize: 12 }}>{r.latencyMs} ms</td>
                    </tr>
                  ))}
                  {audit.recent.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16 }}>暂无检索记录，去右侧做一次向量检索测试</td></tr>}
                </tbody>
              </table>
            </>
          )}
        </div>

      </div>

      {/* Right side: Semantic RAG Query Tester */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: 'fit-content' }}>
        <h3 style={{ fontSize: '15px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Database size={16} color="var(--brand-secondary)" />
          <span>内网向量相似度检索测试</span>
        </h3>
        <p style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
          在此输入业务问题，模拟测试岗位助手在执行任务时，如何检索匹配公司云端制度库中的文本块。
        </p>

        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '8px' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input 
              type="text" 
              className="form-input" 
              placeholder="例如: 财务公章去哪借？" 
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              style={{ paddingLeft: '32px' }}
            />
            <Search size={14} style={{ position: 'absolute', left: '10px', top: '12px', color: 'var(--text-muted)' }} />
          </div>
          <button type="submit" className="btn-primary" disabled={searching}>
            {searching ? '检索中...' : '向量匹配'}
          </button>
        </form>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', paddingBottom: '6px' }}>
            语义检索结果 (相似度排序):
          </div>
          {queryResults.map((chunk, idx) => (
            <div key={idx} style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span className="badge badge-green" style={{ fontSize: '9px', padding: '1px 6px' }}>
                  相似度： {(chunk.score * 100).toFixed(1)}%
                </span>
                <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>来源： {chunk.documentId}</span>
              </div>
              <div style={{ fontSize: '12px', lineHeight: '1.5', color: 'var(--text-primary)' }}>
                {chunk.text}
              </div>
            </div>
          ))}
          {queryResults.length === 0 && !searching && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center', padding: '20px' }}>
              暂无匹配结果，输入问题并点击向量匹配。
            </div>
          )}
        </div>
      </div>

    </div>
  )
}
