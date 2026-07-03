import { useState, useEffect, useRef } from 'react'
import { Database, Search, Upload, RefreshCw, FileText, Activity, Trash2, Inbox, Check, X, User, ChevronRight, Cog, FileUp, ClipboardType, BookOpen, Eye } from 'lucide-react'
import DoclingManager from './DoclingManager'

interface KnowledgeDocument {
  id: string
  filename: string
  sizeBytes: number
  chunksCount: number
  category: string
  uploadTime: string
  scope?: string
  ownerId?: string
  promotionStatus?: string
  proposedCategory?: string
}

const ENTERPRISE_CATEGORIES = ['公司基本信息', '行政财务制度', '企业合规制度', '人事审批规范']

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

type TabKey = 'library' | 'promotions' | 'retrieval' | 'engine'

/**
 * 知识中心 —— 按用户意图分四个页签，替代原单页大杂烩：
 *  库管理（上传→解析→切块→向量化 的真实管道 + 文档列表）/ 晋升审批 / 检索与审计 / 解析引擎运维。
 */
export default function KnowledgeManager() {
  const [tab, setTab] = useState<TabKey>('library')

  const [docs, setDocs] = useState<KnowledgeDocument[]>([])
  const [loading, setLoading] = useState(true)

  // 上传：真实文件（PDF/Word/Excel/PPT/图片经 docling 解析）或手工粘贴文本（纯文本直切块）
  const [uploadMode, setUploadMode] = useState<'file' | 'text'>('file')
  const fileRef = useRef<HTMLInputElement>(null)
  const [pickedFile, setPickedFile] = useState<File | null>(null)
  const [textName, setTextName] = useState('')
  const [textContent, setTextContent] = useState('')
  const [uploadCategory, setUploadCategory] = useState('行政财务制度')
  const [chunkSize, setChunkSize] = useState(280)
  const [chunkOverlap, setChunkOverlap] = useState(40)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // 检索测试
  const [queryText, setQueryText] = useState('')
  const [queryResults, setQueryResults] = useState<MatchChunk[]>([])
  const [searching, setSearching] = useState(false)

  // 检索审计
  const [audit, setAudit] = useState<AuditData | null>(null)

  // 个人 → 企业晋升审批
  const [promotions, setPromotions] = useState<KnowledgeDocument[]>([])
  const [promoCat, setPromoCat] = useState<Record<string, string>>({})

  // 查看已入库内容：选中文档的分块正文
  const [viewDoc, setViewDoc] = useState<{ id: string; filename: string; chunksCount: number; chunks: { seq: number; text: string }[] } | null>(null)
  const [viewLoading, setViewLoading] = useState(false)

  // 解析引擎在线状态（供管道流程条与页签圆点展示；详情在「解析引擎」页签）
  const [engineOnline, setEngineOnline] = useState<boolean | null>(null)

  const fetchEngine = async () => {
    try {
      const res = await fetch('/api/v1/parse/status')
      if (res.ok) { const d = await res.json(); setEngineOnline(!!d.online) }
    } catch (err) { console.error(err) }
  }

  const fetchPromotions = async () => {
    try {
      const res = await fetch('/api/v1/knowledge/promotions')
      if (res.ok) setPromotions(await res.json())
    } catch (err) { console.error(err) }
  }

  const approvePromotion = async (doc: KnowledgeDocument) => {
    const cat = promoCat[doc.id] || doc.proposedCategory || ENTERPRISE_CATEGORIES[0]
    const res = await fetch(`/api/v1/knowledge/docs/${doc.id}/approve?category=${encodeURIComponent(cat)}`, { method: 'POST' })
    if (res.ok) { fetchPromotions(); fetchDocs() }
  }

  const rejectPromotion = async (id: string) => {
    const res = await fetch(`/api/v1/knowledge/docs/${id}/reject`, { method: 'POST' })
    if (res.ok) fetchPromotions()
  }

  const fetchDocs = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/v1/knowledge/docs')
      if (res.ok) setDocs(await res.json())
    } catch (err) { console.error(err) }
    setLoading(false)
  }

  const fetchAudit = async () => {
    try {
      const res = await fetch('/api/v1/knowledge/audit')
      if (res.ok) setAudit(await res.json())
    } catch (err) { console.error(err) }
  }

  const deleteDoc = async (id: string) => {
    if (!confirm('删除该文档及其全部向量分块?')) return
    const res = await fetch(`/api/v1/knowledge/docs/${id}`, { method: 'DELETE' })
    if (res.ok) { fetchDocs(); fetchAudit(); if (viewDoc?.id === id) setViewDoc(null) }
  }

  // 查看已入库内容：拉取该文档的分块正文
  const openDocChunks = async (id: string) => {
    setViewLoading(true)
    try {
      const res = await fetch(`/api/v1/knowledge/docs/${id}/chunks?limit=200`)
      if (res.ok) setViewDoc(await res.json())
      else setViewDoc(null)
    } catch (err) { console.error(err) }
    setViewLoading(false)
  }

  useEffect(() => {
    fetchDocs()
    fetchAudit()
    fetchPromotions()
    fetchEngine()
  }, [])

  const doUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    setUploadMsg(null)
    let file: File | null = null
    if (uploadMode === 'file') {
      file = pickedFile
      if (!file) { setUploadMsg({ ok: false, text: '请先选择要上传的文档文件。' }); return }
    } else {
      if (!textName.trim() || !textContent.trim()) { setUploadMsg({ ok: false, text: '请填写文档名与文本内容。' }); return }
      const name = textName.trim().endsWith('.txt') ? textName.trim() : `${textName.trim()}.txt`
      file = new File([new Blob([textContent], { type: 'text/plain' })], name, { type: 'text/plain' })
    }
    setUploading(true)
    const formData = new FormData()
    formData.append('file', file)
    formData.append('category', uploadCategory)
    formData.append('chunkSize', String(chunkSize))
    formData.append('chunkOverlap', String(chunkOverlap))
    try {
      const res = await fetch('/api/v1/knowledge/upload', { method: 'POST', body: formData })
      const data: any = await res.json().catch(() => ({}))
      if (res.ok && data?.success !== false) {
        setUploadMsg({ ok: true, text: `「${file.name}」已入库：切为 ${data.chunksCreated} 个语义块（块 ${data.chunkSize} / 重叠 ${data.chunkOverlap}），已写入向量库。` })
        setPickedFile(null); if (fileRef.current) fileRef.current.value = ''
        fetchDocs(); fetchAudit()
      } else {
        setUploadMsg({ ok: false, text: data?.error || `上传失败 (HTTP ${res.status})` })
      }
    } catch (err: any) {
      setUploadMsg({ ok: false, text: `上传失败：${err?.message || err}` })
    }
    setUploading(false)
  }

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!queryText.trim()) return
    setSearching(true)
    try {
      const res = await fetch(`/api/v1/knowledge/query?text=${encodeURIComponent(queryText)}&topK=3`)
      if (res.ok) { setQueryResults(await res.json()); fetchAudit() }
    } catch (err) { console.error(err) }
    setSearching(false)
  }

  // —— 真实管道流程条：上传 → 解析 → 切块 → 向量化 → 领用/检索 ——
  const pipeline = [
    { t: '上传文档', s: 'PDF / Word / Excel / 图片 / 文本' },
    { t: 'docling 解析', s: engineOnline == null ? '状态获取中…' : engineOnline ? '引擎在线' : '引擎离线（纯文本仍可直入）', dot: engineOnline },
    { t: '语义切块', s: `块 ${chunkSize} 字 · 重叠 ${chunkOverlap}` },
    { t: '向量化入库', s: 'pgvector · HNSW 索引' },
    { t: '岗位领用 · 检索', s: '客户端 RAG 实时命中' },
  ]

  const engineDot = (on: boolean | null) => (
    <span style={{ width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
      background: on == null ? 'var(--text-muted)' : on ? 'var(--accent-green, #16a34a)' : 'var(--accent-red, #dc2626)' }} />
  )

  const TABS: { k: TabKey; label: React.ReactNode }[] = [
    { k: 'library', label: <><BookOpen size={13} />知识库管理</> },
    { k: 'promotions', label: <><Inbox size={13} />晋升审批{promotions.length > 0 && <span className="badge badge-yellow" style={{ marginLeft: 4 }}>{promotions.length}</span>}</> },
    { k: 'retrieval', label: <><Search size={13} />检索与审计</> },
    { k: 'engine', label: <><Cog size={13} />解析引擎{engineDot(engineOnline)}</> },
  ]

  return (
    <div>
      {/* 页签：按用户意图分区 —— 管内容 / 管审批 / 验检索 / 管引擎 */}
      <div className="settings-tabbar" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border-color)', marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.k} className={`filter-chip ${tab === t.k ? 'active' : ''}`}
            style={{ borderRadius: '8px 8px 0 0', display: 'inline-flex', alignItems: 'center', gap: 5 }}
            onClick={() => setTab(t.k)}>{t.label}</button>
        ))}
      </div>

      {/* ================= 页签 1：知识库管理（核心流程） ================= */}
      {tab === 'library' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* 管道流程条：让「整个流程」一眼可见，docling 状态内嵌在第 2 步 */}
          <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '12px 16px' }}>
            {pipeline.map((p, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 10px', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-subtle, #f8fafc)' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{i + 1}</span>{p.t}
                    {'dot' in p && engineDot(p.dot as boolean | null)}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{p.s}</span>
                </div>
                {i < pipeline.length - 1 && <ChevronRight size={14} color="var(--text-muted)" />}
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 16, alignItems: 'start' }}>
            {/* 上传（真实文件为主；手工文本为辅） */}
            <form onSubmit={doUpload} className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Upload size={16} color="var(--brand-primary)" /><span>发布企业知识文档</span>
              </h3>

              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className={`filter-chip ${uploadMode === 'file' ? 'active' : ''}`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => setUploadMode('file')}>
                  <FileUp size={12} />上传文件
                </button>
                <button type="button" className={`filter-chip ${uploadMode === 'text' ? 'active' : ''}`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => setUploadMode('text')}>
                  <ClipboardType size={12} />粘贴文本
                </button>
              </div>

              {uploadMode === 'file' ? (
                <div className="form-group">
                  <label className="form-label">文档文件（PDF/Word/Excel/PPT/图片经 docling 解析；txt/md 直入）</label>
                  <input ref={fileRef} type="file" style={{ display: 'none' }}
                    accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.md,.txt,.png,.jpg,.jpeg"
                    onChange={e => setPickedFile(e.target.files?.[0] || null)} />
                  <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <FileUp size={13} />{pickedFile ? pickedFile.name : '选择文件…'}
                  </button>
                  {pickedFile && <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 }}>{(pickedFile.size / 1024).toFixed(1)} KB</span>}
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label className="form-label">文档名</label>
                    <input className="form-input" value={textName} onChange={e => setTextName(e.target.value)} placeholder="如：差旅报销管理规定" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">文本内容（纯文本直切块，不经 docling）</label>
                    <textarea className="form-textarea" style={{ minHeight: 90, resize: 'vertical' }}
                      value={textContent} onChange={e => setTextContent(e.target.value)} placeholder="粘贴规章制度全文…" />
                  </div>
                </>
              )}

              <div className="form-group">
                <label className="form-label">知识类目</label>
                <select className="form-select" value={uploadCategory} onChange={e => setUploadCategory(e.target.value)}>
                  {ENTERPRISE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">分块大小（字符）</label>
                  <input type="number" className="form-input" min={50} max={2000} value={chunkSize} onChange={e => setChunkSize(Number(e.target.value))} />
                </div>
                <div className="form-group">
                  <label className="form-label">分块重叠（字符）</label>
                  <input type="number" className="form-input" min={0} max={500} value={chunkOverlap} onChange={e => setChunkOverlap(Number(e.target.value))} />
                </div>
              </div>

              <button type="submit" className="btn-primary" disabled={uploading}>
                {uploading ? '正在解析、切块并写入向量库…' : '发布并更新云端知识库'}
              </button>
              {uploadMsg && (
                <div style={{ fontSize: 11, color: uploadMsg.ok ? 'var(--accent-green, #16a34a)' : 'var(--accent-red, #dc2626)' }}>
                  {uploadMsg.text}
                </div>
              )}
            </form>

            {/* 文档列表 */}
            <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--border-color)' }}>
                <h3 style={{ fontSize: 15, fontWeight: 600 }}>知识库文档（企业 + 个人）</h3>
                <button className="btn-secondary" onClick={fetchDocs} style={{ padding: '4px 8px' }}><RefreshCw size={12} /></button>
              </div>
              {loading ? (
                <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 20 }}>正在加载云端知识文件…</div>
              ) : (
                <table className="admin-table">
                  <thead>
                    <tr><th>文件名</th><th>知识类目</th><th>分块数</th><th>大小</th><th style={{ width: 84 }}>操作</th></tr>
                  </thead>
                  <tbody>
                    {docs.map(doc => (
                      <tr key={doc.id}>
                        <td>
                          <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <FileText size={12} color="var(--brand-primary)" />{doc.filename}
                          </div>
                          <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>Doc ID: {doc.id}</div>
                        </td>
                        <td>
                          <span className={`badge ${doc.scope === 'PERSONAL' ? 'badge-yellow' : 'badge-green'}`} style={{ marginRight: 4 }}>
                            {doc.scope === 'PERSONAL' ? '个人' : '企业'}
                          </span>
                          <span className="badge badge-purple">{doc.category}</span>
                        </td>
                        <td>{doc.chunksCount} 块</td>
                        <td>{doc.sizeBytes} B</td>
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button className="btn-secondary" title="查看已入库分块" style={{ padding: '3px 6px' }} onClick={() => openDocChunks(doc.id)}><Eye size={12} /></button>
                            <button className="btn-danger" style={{ padding: '3px 6px' }} onClick={() => deleteDoc(doc.id)}><Trash2 size={12} /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {docs.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16 }}>知识库为空，从左侧上传第一份文档。</td></tr>}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* 已入库内容查看：选中文档的分块正文（验证解析/切块质量） */}
          {(viewLoading || viewDoc) && (
            <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Eye size={15} color="var(--brand-secondary)" />
                  <span>{viewLoading ? '正在加载分块…' : `已入库内容 · ${viewDoc!.filename}`}</span>
                  {viewDoc && <span className="badge badge-purple">{viewDoc.chunks.length}/{viewDoc.chunksCount} 块</span>}
                </h3>
                <button className="btn-secondary" style={{ padding: '3px 8px' }} onClick={() => setViewDoc(null)}><X size={12} /></button>
              </div>
              {viewDoc && (
                <div style={{ maxHeight: 380, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {viewDoc.chunks.map(c => (
                    <div key={c.seq} style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10 }}>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4 }}>块 #{c.seq}</div>
                      <div style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{c.text}</div>
                    </div>
                  ))}
                  {viewDoc.chunks.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>该文档没有分块记录。</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ================= 页签 2：个人知识晋升审批 ================= */}
      {tab === 'promotions' && (
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Inbox size={16} color="var(--accent-yellow)" /><span>个人知识汇聚 · 待审提名</span>
              {promotions.length > 0 && <span className="badge badge-yellow">{promotions.length}</span>}
            </h3>
            <button className="btn-secondary" onClick={fetchPromotions} style={{ padding: '4px 8px' }}><RefreshCw size={12} /></button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4, margin: 0 }}>
            员工把个人知识库中的文档提名归档到企业库。审核通过后，该文档转为企业级、全员可检索（结合 DLP 合规）。
          </p>
          {promotions.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>
              暂无待审提名。员工在客户端「文件」里点“归档到企业库”后会出现在此。
            </div>
          ) : (
            <table className="admin-table">
              <thead><tr><th>文档</th><th>提名人</th><th style={{ width: 150 }}>归入类目</th><th style={{ width: 110 }}>操作</th></tr></thead>
              <tbody>
                {promotions.map(doc => (
                  <tr key={doc.id}>
                    <td>
                      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <FileText size={12} color="var(--brand-primary)" />{doc.filename}
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{doc.chunksCount} 块 · {doc.id}</div>
                    </td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
                        <User size={11} />{doc.ownerId || '—'}
                      </span>
                    </td>
                    <td>
                      <select className="form-select" style={{ padding: '3px 6px', fontSize: 12 }}
                        value={promoCat[doc.id] || doc.proposedCategory || ENTERPRISE_CATEGORIES[0]}
                        onChange={e => setPromoCat(p => ({ ...p, [doc.id]: e.target.value }))}>
                        {ENTERPRISE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-primary" style={{ padding: '3px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => approvePromotion(doc)}><Check size={12} />通过</button>
                        <button className="btn-danger" style={{ padding: '3px 6px' }} onClick={() => rejectPromotion(doc.id)}><X size={12} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ================= 页签 3：检索验证与命中审计 ================= */}
      {tab === 'retrieval' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: 16, alignItems: 'start' }}>
          {/* 检索测试（做一次测试 → 右侧审计立即多一条记录，闭环可见） */}
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Database size={16} color="var(--brand-secondary)" /><span>向量相似度检索测试</span>
            </h3>
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4, margin: 0 }}>
              输入业务问题，模拟岗位分身执行任务时如何命中知识库文本块。每次测试都会记入右侧审计。
            </p>
            <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8 }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <input type="text" className="form-input" placeholder="例如: 财务公章去哪借？" value={queryText}
                  onChange={e => setQueryText(e.target.value)} style={{ paddingLeft: 32 }} />
                <Search size={14} style={{ position: 'absolute', left: 10, top: 12, color: 'var(--text-muted)' }} />
              </div>
              <button type="submit" className="btn-primary" disabled={searching}>{searching ? '检索中…' : '向量匹配'}</button>
            </form>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-color)', paddingBottom: 6 }}>
                语义检索结果（相似度排序）：
              </div>
              {queryResults.map((chunk, idx) => (
                <div key={idx} style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span className="badge badge-green" style={{ fontSize: 9, padding: '1px 6px' }}>相似度 {(chunk.score * 100).toFixed(1)}%</span>
                    <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>来源 {chunk.documentId}</span>
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)' }}>{chunk.text}</div>
                </div>
              ))}
              {queryResults.length === 0 && !searching && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center', padding: 20 }}>
                  暂无匹配结果，输入问题并点击向量匹配。
                </div>
              )}
            </div>
          </div>

          {/* 命中率与消耗审计 */}
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Activity size={16} color="var(--accent-green)" /><span>检索命中率与消耗审计</span>
              </h3>
              <button className="btn-secondary" onClick={fetchAudit} style={{ padding: '4px 8px' }}><RefreshCw size={12} /></button>
            </div>
            {audit && (
              <>
                <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
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
                    {audit.recent.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16 }}>暂无检索记录，在左侧做一次向量检索测试。</td></tr>}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}

      {/* ================= 页签 4：解析引擎运维（docling + 容器托管） ================= */}
      {tab === 'engine' && <DoclingManager />}
    </div>
  )
}
