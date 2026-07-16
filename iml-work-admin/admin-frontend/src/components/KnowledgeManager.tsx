import { useState, useEffect, useRef } from 'react'
import { Database, Search, Upload, RefreshCw, FileText, Activity, Trash2, Inbox, Check, X, User, ChevronRight, FileUp, ClipboardType, BookOpen, Eye, Maximize2, Minimize2, Layers, Cpu } from 'lucide-react'

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

// 分类来自数据字典（管理端「字典管理」维护）；此常量仅作字典接口不可用时的兜底
const FALLBACK_CATEGORIES = ['公司基本信息', '行政财务制度', '企业合规制度', '人事审批规范']

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

type TabKey = 'library' | 'promotions' | 'retrieval'

/**
 * 知识中心 —— 按用户意图分四个页签，替代原单页大杂烩：
 *  库管理（上传→解析→切块→向量化 的真实管道 + 文档列表）/ 晋升审批 / 检索与审计。文档解析引擎运维已并入「安全沙箱 › 文档引擎」。
 */
export default function KnowledgeManager() {
  const [tab, setTab] = useState<TabKey>('library')
  // 企业知识分类（实时读字典，失败回退内置四类）
  const [categories, setCategories] = useState<string[]>(FALLBACK_CATEGORIES)
  useEffect(() => {
    fetch('/api/v1/dicts/knowledge_category').then(r => r.ok ? r.json() : null)
      .then((items: any) => { if (Array.isArray(items) && items.length) setCategories(items.map((i: any) => i.label)) })
      .catch(() => {})
  }, [])

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
  const [viewDoc, setViewDoc] = useState<{ id: string; filename: string; chunksCount: number; chunks: { seq: number; text: string; images?: { marker: string; dataUri: string }[] }[] } | null>(null)
  const [viewLoading, setViewLoading] = useState(false)
  const [viewFull, setViewFull] = useState(false)   // 抽屉全屏切换

  // 解析引擎在线状态（供管道流程条圆点展示；引擎运维在「安全沙箱 › 文档引擎」）
  const [showUpload, setShowUpload] = useState(false)   // 发布文档抽屉
  const [q, setQ] = useState('')                        // 文档搜索
  const [fScope, setFScope] = useState<'ALL' | 'ENTERPRISE' | 'PERSONAL'>('ALL')
  const [fCat, setFCat] = useState('全部')
  const [engineOnline, setEngineOnline] = useState<boolean | null>(null)
  // 向量服务健康。这是**准必需**服务：它挂了检索直接失效，但此前管理端完全看不出来——
  // 而且它挂掉时后端曾会静默退回哈希兜底向量（分数看着正常、实则荒谬），更需要明示。
  const [embed, setEmbed] = useState<{ ok?: boolean; mode?: string; model?: string; dimension?: number; error?: string } | null>(null)
  const fetchEmbed = async () => {
    try {
      const r = await fetch('/api/v1/knowledge/embedding/health')
      if (r.ok) setEmbed(await r.json())
    } catch { setEmbed({ ok: false, mode: '不可达' }) }
  }

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
    const cat = promoCat[doc.id] || doc.proposedCategory || categories[0]
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

  const recategorize = async (id: string, category: string) => {
    const res = await fetch(`/api/v1/knowledge/docs/${id}/category`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    })
    if (!res.ok) { alert('改分类失败'); return }
    const d = await res.json()
    alert(`已改分类：${d.from || '（无）'} → ${d.to}（同步更新 ${d.chunks} 个检索分块）`)
    fetchDocs(); fetchAudit()
  }

  const deleteDoc = async (id: string) => {
    if (!confirm('删除该文档及其全部向量分块?')) return
    const res = await fetch(`/api/v1/knowledge/docs/${id}`, { method: 'DELETE' })
    if (res.ok) { fetchDocs(); fetchAudit(); if (viewDoc?.id === id) { setViewDoc(null); setViewFull(false) } }
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
    fetchEmbed()
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
        // 成功即收抽屉，让用户看见新文档落到列表里（结果在表里，不该停在表单上）。
        // 失败**不关**——错误信息（如"只有图片、没有正文"）要留在原地让人看清、直接改。
        setTimeout(() => { setShowUpload(false); setUploadMsg(null) }, 1200)
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

  // 文件大小：3090213 B 这种裸字节数没人读得出来
  const fmtSize = (b?: number) => {
    if (b == null) return '—'
    if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)} MB`
    if (b >= 1 << 10) return `${Math.round(b / (1 << 10))} KB`
    return `${b} B`
  }
  // 入库质量：分块数 vs 文件大小明显不匹配 = 解析基本没出内容。
  // 真事：一份 1.5MB 的 PDF 只切出 1 块，内容是「【图1】…【图20】」——纯图片占位，检索不到任何东西，
  // 却在列表里静静躺着，运维以为"已入库"。已在后端加入库闸拒收，历史脏数据仍要能一眼看出来。
  const ingestWarn = (doc: KnowledgeDocument): string => {
    if (doc.chunksCount === 0) return '未切出任何分块 —— 解析失败，检索不到'
    if (doc.chunksCount <= 1 && doc.sizeBytes > 200 * 1024) return '文件很大却只有 1 块 —— 多半是扫描件/图片型 PDF，正文没解析出来'
    return ''
  }

  // 文档筛选：搜索（文件名）+ 归属（企业/个人）+ 知识类目。
  // 文档一多，翻页找一份文档就变成体力活——搜索/筛选不是锦上添花，是这张表能不能用的前提。
  const shownDocs = docs.filter(d => {
    if (fScope !== 'ALL' && (d.scope || 'ENTERPRISE') !== fScope) return false
    if (fCat !== '全部' && d.category !== fCat) return false
    if (q.trim() && !d.filename.toLowerCase().includes(q.trim().toLowerCase())) return false
    return true
  })

  // 统计卡（与技能中心 SkillsHub 同构 —— 各页面的统计条必须长一样，不能各自为政）
  const stat = (label: string, value: React.ReactNode, icon: React.ReactNode, color: string) => (
    <div className="glass-panel" style={{ flex: 1, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ color }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 20, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
      </div>
    </div>
  )

  // —— 真实管道流程条：上传 → 解析 → 切块 → 向量化 → 领用/检索 ——
  const pipeline = [
    { t: '上传文档', s: 'PDF / Word / Excel / 图片 / 文本' },
    { t: '文档解析', s: engineOnline == null ? '状态获取中…' : engineOnline ? '引擎在线' : '引擎离线（安全沙箱页可管理；纯文本仍可直入）', dot: engineOnline },
    { t: '语义切块', s: `块 ${chunkSize} 字 · 重叠 ${chunkOverlap}` },
    { t: '向量化入库',
      s: embed == null ? '状态获取中…'
        : embed.ok ? `${embed.model} · ${embed.dimension}维 · pgvector HNSW`
        : `⚠️ ${embed.mode || '不可达'}${embed.error ? '' : ''} —— 检索将失效`,
      dot: embed == null ? null : !!embed.ok },
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

          {/* 概览统计：先回答"这个库现在什么规模"，再谈流程。与技能中心的统计条同构。 */}
          <div style={{ display: 'flex', gap: 12 }}>
            {stat('企业文档', docs.filter(d => d.scope !== 'PERSONAL').length, <Database size={18} />, 'var(--accent-green)')}
            {stat('个人文档', docs.filter(d => d.scope === 'PERSONAL').length, <FileText size={18} />, 'var(--accent-orange)')}
            {stat('检索分块', docs.reduce((n, d) => n + (d.chunksCount || 0), 0), <Layers size={18} />, 'var(--accent-blue)')}
            {stat('向量模型', embed?.ok ? (embed.model || '在线') : '离线', <Cpu size={18} />, embed?.ok ? 'var(--accent-purple)' : 'var(--accent-red)')}
          </div>

          {/* 管道流程条：一体化的一条链（不是五个各自为政的方块）。
              解析引擎 / 向量模型的真实状态内嵌在对应环节 —— 这两个服务挂了，整条链就断了。 */}
          <div className="glass-panel kb-pipeline">
            {pipeline.map((p, i) => (
              <div key={i} className="kb-step">
                <div className="kb-step-idx">{i + 1}</div>
                <div className="kb-step-body">
                  <div className="kb-step-title">
                    {p.t}
                    {'dot' in p && engineDot(p.dot as boolean | null)}
                  </div>
                  <div className="kb-step-sub">{p.s}</div>
                </div>
                {i < pipeline.length - 1 && <div className="kb-step-arrow"><ChevronRight size={13} /></div>}
              </div>
            ))}
          </div>

          {/* 文档表是主体 —— 全宽。「发布文档」改成右侧抽屉：
              上传是低频动作，原来却和文档表左右并排、占着 40% 宽度还留一大片空白。 */}
          {/* 文档列表 */}
          <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--border-color)' }}>
              <h3 style={{ fontSize: 15, fontWeight: 600 }}>知识库文档 <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>企业 + 个人 · 共 {docs.length} 份</span></h3>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-secondary" title="刷新" onClick={fetchDocs} style={{ padding: '5px 9px' }}><RefreshCw size={13} /></button>
                <button className="btn-primary" onClick={() => { setShowUpload(true); setUploadMsg(null) }}>
                  <Upload size={13} /><span>发布文档</span>
                </button>
              </div>
            </div>

            {/* 工具条：搜索 + 归属/类目筛选 */}
            <div className="kb-toolbar">
              <div className="kb-search">
                <Search size={13} />
                <input placeholder="搜索文件名…" value={q} onChange={e => setQ(e.target.value)} />
              </div>
              {(['ALL', 'ENTERPRISE', 'PERSONAL'] as const).map(sc => (
                <button key={sc} className={`filter-chip ${fScope === sc ? 'active' : ''}`}
                  onClick={() => setFScope(sc)}>
                  {sc === 'ALL' ? '全部' : sc === 'ENTERPRISE' ? '企业' : '个人'}
                </button>
              ))}
              <select className="table-select" style={{ marginLeft: 4, padding: '5px 24px 5px 10px', fontSize: 12 }}
                value={fCat} onChange={e => setFCat(e.target.value)}>
                <option value="全部">全部类目</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              {(q || fScope !== 'ALL' || fCat !== '全部') && (
                <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-muted)' }}>
                  命中 {shownDocs.length} / {docs.length} 份
                </span>
              )}
            </div>
            {loading ? (
              <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 20 }}>正在加载云端知识文件…</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>文件名</th>
                    <th style={{ width: 150 }}>知识类目</th>
                    <th className="num" style={{ width: 80 }}>分块</th>
                    <th className="num" style={{ width: 80 }}>大小</th>
                    <th style={{ width: 76 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {shownDocs.map(doc => (
                    <tr key={doc.id}>
                      <td>
                        <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <FileText size={12} color="var(--brand-primary)" />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.filename}</span>
                        </div>
                        {/* 入库质量告警：解析没出内容的文档躺在列表里，看着"已入库"、实则检索不到任何东西 */}
                        {ingestWarn(doc)
                          ? <div style={{ fontSize: 10, color: 'var(--accent-red, #dc2626)', marginTop: 2 }}>⚠️ {ingestWarn(doc)}</div>
                          : <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{doc.id}</div>}
                      </td>
                      <td>
                        {/* 个人库文档原本挂两个徽标（「个人」+「个人知识」）——同一件事说两遍。
                            个人库没有分类的概念，只标"个人"即可；企业库才给可改的分类下拉。 */}
                        {doc.scope === 'PERSONAL'
                          ? <span className="badge badge-yellow">个人</span>
                          : <select
                              className="table-select"
                              value={doc.category || ''}
                              title="改分类（会同步更新检索用的分块分类）"
                              onChange={e => recategorize(doc.id, e.target.value)}>
                              {!categories.includes(doc.category) && doc.category &&
                                <option value={doc.category}>{doc.category}（当前）</option>}
                              {categories.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>}
                      </td>
                      <td className="num">{doc.chunksCount}</td>
                      <td className="num" style={{ color: 'var(--text-secondary)' }}>{fmtSize(doc.sizeBytes)}</td>
                      <td>
                        {/* 行内操作默认低调（图标按钮），hover 才显色 —— 删除是危险动作，
                            一直红着会持续抢注意力，而它并不是这张表的主角。 */}
                        <div className="kb-row-actions">
                          <button className="icon-btn" title="查看已入库分块" onClick={() => openDocChunks(doc.id)}><Eye size={13} /></button>
                          <button className="icon-btn danger" title="删除文档及其向量分块" onClick={() => deleteDoc(doc.id)}><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {shownDocs.length === 0 && (
                    <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20 }}>
                      {docs.length === 0 ? '知识库为空 —— 点右上角「发布文档」上传第一份。' : '没有匹配的文档，换个关键词或清掉筛选。'}
                    </td></tr>
                  )}
                </tbody>
              </table>
            )}
          </div>

          {/* 发布文档：右侧抽屉（复用 skill-drawer 模式，与本页「查看分块」同一套） */}
          {showUpload && (
            <div className="skill-drawer-overlay" onClick={() => setShowUpload(false)}>
              <div className="skill-drawer" style={{ width: 520 }} onClick={e => e.stopPropagation()}>
                <div className="drawer-head">
                  <h3 style={{ fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Upload size={16} color="var(--brand-primary)" />发布企业知识文档
                  </h3>
                  <button className="icon-btn" onClick={() => setShowUpload(false)}><X size={16} /></button>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: -8 }}>
                  文档经解析引擎解析 → 语义切块 → 向量化入库，随即可被岗位分身检索到。
                </div>
                <form onSubmit={doUpload} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

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
                <label className="form-label">文档文件（PDF/Word/Excel/PPT/图片经解析引擎解析；txt/md 直入）</label>
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
                <label className="form-label">文本内容（纯文本直切块，无需解析引擎）</label>
                <textarea className="form-textarea" style={{ minHeight: 90, resize: 'vertical' }}
                value={textContent} onChange={e => setTextContent(e.target.value)} placeholder="粘贴规章制度全文…" />
                </div>
                </>
                )}

                <div className="form-group">
                <label className="form-label">知识类目</label>
                <select className="form-select" value={uploadCategory} onChange={e => setUploadCategory(e.target.value)}>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
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
              </div>
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
                      value={promoCat[doc.id] || doc.proposedCategory || categories[0]}
                      onChange={e => setPromoCat(p => ({ ...p, [doc.id]: e.target.value }))}>
                      {categories.map(c => <option key={c} value={c}>{c}</option>)}
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


    {/* 已入库内容查看：右侧抽屉（复用 skill-drawer 模式），支持全屏 */}
    {(viewLoading || viewDoc) && (
      <div className="skill-drawer-overlay" onClick={() => { setViewDoc(null); setViewFull(false) }}>
        <div className="skill-drawer" onClick={e => e.stopPropagation()}
          style={viewFull ? { width: '100vw', maxWidth: '100vw' } : { width: 640 }}>
          <div className="drawer-head">
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Eye size={16} color="var(--brand-secondary)" />
                {viewLoading ? '正在加载分块…' : `已入库内容 · ${viewDoc!.filename}`}
                {viewDoc && <span className="badge badge-purple">{viewDoc.chunks.length}/{viewDoc.chunksCount} 块</span>}
              </h3>
              {viewDoc && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Doc ID: {viewDoc.id} · 向量库中的真实存储内容（检索命中即这些块）</div>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="icon-btn" title={viewFull ? '退出全屏' : '全屏查看'} onClick={() => setViewFull(f => !f)}>
                {viewFull ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
              <button className="icon-btn" onClick={() => { setViewDoc(null); setViewFull(false) }}><X size={16} /></button>
            </div>
          </div>
          {viewDoc && (
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 4 }}>
              {viewDoc.chunks.map(c => (
                <div key={c.seq} style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10 }}>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4 }}>块 #{c.seq}</div>
                  <div style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{c.text}</div>
                  {(c.images || []).map(im => (
                    <div key={im.marker} style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 2 }}>{im.marker}</div>
                      <img src={im.dataUri} alt={im.marker} style={{ maxWidth: '100%', borderRadius: 4, border: '1px solid var(--border-color)' }} />
                    </div>
                  ))}
                </div>
              ))}
              {viewDoc.chunks.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>该文档没有分块记录。</div>}
            </div>
          )}
        </div>
      </div>
    )}
  </div>
)
}
