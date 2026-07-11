import { useState, useEffect, useMemo } from 'react'
import { Search, Eye, CloudUpload, CheckCircle2, RefreshCw, FolderOpen, FolderCog, Database, ToggleLeft, ToggleRight, Building2, Ban, BookText, ListTodo, FolderSearch, MapPin, FileText, Trash2 } from 'lucide-react'
import { useSpaceStore } from '../stores/spaceStore'
import { useUserStore } from '../stores/userStore'

// 归档分类来自数据字典（管理端「字典管理」维护，dict:list 实时拉取）；此常量仅作后端不可达时的兜底
const FALLBACK_CATEGORIES = ['公司基本信息', '行政财务制度', '企业合规制度', '人事审批规范']

interface KbFile { name: string; excluded: boolean; docId: string; isArtifact?: boolean; doc: { id: string; chunksCount: number; promotionStatus?: string } | null }
interface KbOverview { ok: boolean; ownerId: string; autoIngest: boolean; files: KbFile[]; personalDocs: any[] }
// 产物索引（任务成果视图）：主进程 artifacts:groups 返回，按任务(会话)分组
interface ArtEntry { name: string; absPath: string; sizeBytes: number; source: string; convId: string; createdAt: number; exists: boolean }
interface ArtGroup { convId: string; title: string; latestAt: number; files: ArtEntry[] }

const fmtSize = (n: number) => (n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B')
const fmtTime = (sec: number) => {
  const d = new Date(sec * 1000)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

export default function PersonalSpace() {
  const { files, searchQuery, setSearchQuery, syncFile } = useSpaceStore()
  const [wsDir, setWsDir] = useState('')
  // 双视图：任务成果（产物按任务分组，出处可溯）｜资料库（用户放入的输入文件 + 知识库管理）
  const [view, setView] = useState<'artifacts' | 'library'>('artifacts')
  const [groups, setGroups] = useState<ArtGroup[]>([])

  // 个人知识库概览
  const [kb, setKb] = useState<KbOverview>({ ok: false, ownerId: '', autoIngest: true, files: [], personalDocs: [] })
  const [promoCat, setPromoCat] = useState<Record<string, string>>({})
  const [kbBusy, setKbBusy] = useState<string>('')
  const loadKb = () => window.api.invoke('kb:overview').then((r: any) => { if (r?.ok) setKb(r) }).catch(() => {})
  const loadGroups = () => window.api.invoke('artifacts:groups').then((r: any) => { if (r?.ok) setGroups(r.groups || []) }).catch(() => {})

  // 归档分类：实时读数据字典（管理端可维护），失败回退内置四类
  const [categories, setCategories] = useState<string[]>(FALLBACK_CATEGORIES)
  useEffect(() => {
    window.api.invoke('dict:list', 'knowledge_category')
      .then((r: any) => { if (r?.ok && Array.isArray(r.labels) && r.labels.length) setCategories(r.labels) })
      .catch(() => {})
  }, [])

  // 企业知识库（本岗位授权范围 + 文档，只读）——资料库视图一并呈现，问答时按需 RAG 召回
  const claimedExpertId = useUserStore(s => s.claimedExpertId)
  const [ent, setEnt] = useState<{ categories: string[]; docs: { name: string; category: string }[]; total: number }>({ categories: [], docs: [], total: 0 })
  useEffect(() => {
    if (!claimedExpertId) { setEnt({ categories: [], docs: [], total: 0 }); return }
    window.api.invoke('memory:enterprise', claimedExpertId)
      .then((r: any) => { if (r?.ok) setEnt({ categories: r.categories || [], docs: r.docs || [], total: r.total || 0 }) })
      .catch(() => {})
  }, [claimedExpertId])
  useEffect(() => {
    window.api.invoke('workspace:files').then((r: any) => { if (r) setWsDir(r.dir || '') }).catch(() => {})
    loadKb(); loadGroups()
    const un = window.api.on('kb:changed', () => { loadKb(); loadGroups() })
    return () => { un && un() }
  }, [])
  const toggleAuto = async () => { await window.api.invoke('kb:set-autoingest', !kb.autoIngest); loadKb() }
  // 入库结果必须给反馈：失败静默曾让「加入个人库」看起来"点了没反应"（如 docling 离线时 PDF 解析失败）
  const ingestFile = async (name: string) => {
    setKbBusy(name)
    const r: any = await window.api.invoke('kb:ingest', name).catch((e: any) => ({ ok: false, reason: String(e?.message || e) }))
    setKbBusy('')
    loadKb()
    if (!r?.ok) alert(`「${name}」加入个人库失败：${r?.reason || '未知错误'}`)
  }
  const removeFromKb = async (name: string) => { setKbBusy(name); await window.api.invoke('kb:remove', name); setKbBusy(''); loadKb() }
  const promoteFile = async (name: string) => {
    const category = promoCat[name] || categories[0]
    setKbBusy(name)
    const r: any = await window.api.invoke('kb:promote', { name, category })
    setKbBusy('')
    loadKb()
    if (r?.ok) alert(`已提名「${name}」归档到企业库（类目：${category}），等待管理端审批。`)
    else alert(`提名失败：${r?.reason || '未知错误'}`)
  }

  // 切换目录后必须重拉知识库清单(kb:overview 按新目录扫描),否则列表停留在旧目录
  const pickDir = async () => {
    const r = await window.api.invoke('workspace:pick-dir')
    if (r && !r.canceled) { setWsDir(r.dir || ''); loadKb(); loadGroups() }
  }
  const openDir = () => window.api.invoke('workspace:open')

  // ── 分类：产物名集合（来自索引）→ 资料库 = 目录里未登记为产物的文件 ──
  const artifactNames = useMemo(() => new Set(groups.flatMap(g => g.files.map(f => f.name))), [groups])
  const q = searchQuery.toLowerCase()
  const libraryKbFiles = kb.files.filter(f => !f.isArtifact && !artifactNames.has(f.name)).filter(f => !q || f.name.toLowerCase().includes(q))
  const filteredGroups = groups
    .map(g => ({ ...g, files: g.files.filter(f => !q || f.name.toLowerCase().includes(q) || g.title.toLowerCase().includes(q)) }))
    .filter(g => g.files.length > 0)
  const filteredFiles = files.filter(file => !artifactNames.has(file.name)).filter(file =>
    file.name.toLowerCase().includes(q) || (file.summary && file.summary.toLowerCase().includes(q)))

  return (
    <div className="space-view">
      <div className="space-toolbar">
        <div>
          <div className="wb-hero-title" style={{ fontSize: 22 }}>文件</div>
          <div className="wb-hero-sub" style={{ fontSize: 12 }}>任务成果按任务归组、出处可溯；资料库是你放入的参考文件，自动收录进个人知识库。</div>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <input
              type="text"
              className="space-search"
              placeholder={view === 'artifacts' ? '搜索成果文件或任务...' : '搜索本地文件或知识概要...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ paddingLeft: '32px' }}
            />
            <Search size={14} style={{ position: 'absolute', left: '10px', top: '10px', color: 'var(--text-muted)' }} />
          </div>
        </div>
      </div>

      {/* 当前工作空间目录（分身在此目录读取 / 操作文件） */}
      <div className="glass-card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>
          <FolderOpen size={14} color="var(--brand-primary)" />工作目录
        </span>
        <code style={{ flex: 1, minWidth: 200, fontSize: 12, color: 'var(--text-primary)', background: 'var(--bg-subtle)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '5px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={wsDir}>
          {wsDir || '默认 documents 目录'}
        </code>
        <button className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={pickDir} title="指定一个本地文件夹作为工作空间"><FolderCog size={13} />选择目录</button>
        <button className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={openDir}><FolderOpen size={13} />打开</button>
      </div>

      {/* 双视图切换：任务成果 ｜ 资料库 */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className={view === 'artifacts' ? 'btn-primary' : 'btn-secondary'} onClick={() => { setView('artifacts'); loadGroups() }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ListTodo size={13} />任务成果{groups.length > 0 && <span style={{ fontSize: 10, opacity: .8 }}>（{groups.reduce((n, g) => n + g.files.length, 0)}）</span>}
        </button>
        <button className={view === 'library' ? 'btn-primary' : 'btn-secondary'} onClick={() => { setView('library'); loadKb() }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FolderSearch size={13} />资料库{libraryKbFiles.length > 0 && <span style={{ fontSize: 10, opacity: .8 }}>（{libraryKbFiles.length}）</span>}
        </button>
      </div>

      {/* ── 任务成果视图：按任务(会话)分组的产物，出处/时间/来源技能齐全 ── */}
      {view === 'artifacts' && (
        filteredGroups.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {filteredGroups.map(g => (
              <div key={g.convId || 'orphan'} className="glass-card" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ListTodo size={14} color="var(--brand-primary)" style={{ flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, marginLeft: 'auto' }}>{fmtTime(g.latestAt)}</span>
                </div>
                {g.files.map((f, i) => (
                  <div key={f.name + i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-subtle)', opacity: f.exists ? 1 : .55 }}>
                    <FileText size={13} color={f.exists ? 'var(--brand-primary)' : 'var(--text-muted)'} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: f.exists ? 'zoom-in' : 'default' }}
                      title={f.exists ? '点击快速查看（系统原生预览）' : '文件已被删除或移动'}
                      onClick={() => f.exists && window.api.invoke('files:preview', f.name)}>{f.name}</span>
                    {f.source && <span className="kb-tag none" title="产出来源技能">{f.source}</span>}
                    {!f.exists && <span className="kb-tag off" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Trash2 size={10} />已删除</span>}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{fmtSize(f.sizeBytes)} · {fmtTime(f.createdAt)}</span>
                    {f.exists && (
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button className="robot-btn" onClick={() => window.api.invoke('files:preview', f.name)}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }} title="快速查看"><Eye size={12} />查看</button>
                        <button className="robot-btn" onClick={() => window.api.invoke('files:reveal', f.name)}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }} title="在访达中显示"><MapPin size={12} />位置</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '30px 0' }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--mint-50, rgba(16,185,129,0.08))' }}>
              <ListTodo size={26} color="var(--brand-primary)" />
            </div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{q ? '没有匹配的成果' : '还没有任务成果'}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', lineHeight: 1.7, maxWidth: 420 }}>
              让分身执行生成类任务（如写报告、出表格）后，产物会自动登记在这里——按任务归组、可溯源，重名也不会互相覆盖。
            </div>
          </div>
        )
      )}

      {/* ── 资料库视图：用户放入的输入文件 + 个人知识库管理（产物不在此列，不自动入库） ── */}
      {view === 'library' && (
        <div className="glass-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14 }}>
              <Database size={15} color="var(--brand-primary)" />个人知识库
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>
                已收录 {kb.personalDocs?.length || 0} 个文档
              </span>
            </span>
            <button className="btn-secondary" onClick={toggleAuto} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="放入工作空间的资料是否自动进个人库（任务产物与截图不会自动入库）">
              {kb.autoIngest ? <ToggleRight size={16} color="var(--brand-primary)" /> : <ToggleLeft size={16} />}
              自动入库 · {kb.autoIngest ? '开' : '关'}
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            放入工作空间/上传的<b>资料文档</b>会自动经服务端解析后进你的<b>个人库</b>（仅你可检索，分身答题时会用到）。任务产物与截图<b>不自动入库</b>（可在成果里手动加入）。可按文件排除，或<b>归档到企业库</b>（管理端审批后全员可用）。
          </p>

          {libraryKbFiles.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {libraryKbFiles.map(f => {
                const inKb = !!f.docId && !f.excluded
                const pending = f.doc?.promotionStatus === 'PENDING'
                const busy = kbBusy === f.name
                return (
                  <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-subtle)' }}>
                    <BookText size={13} color={inKb ? 'var(--brand-primary)' : 'var(--text-muted)'} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'zoom-in' }}
                      title="点击快速查看（系统原生预览）"
                      onClick={() => window.api.invoke('files:preview', f.name)}>{f.name}</span>
                    {inKb ? (
                      <span className="kb-tag on">个人库已收录</span>
                    ) : f.excluded ? (
                      <span className="kb-tag off">已排除</span>
                    ) : (
                      <span className="kb-tag none">未收录</span>
                    )}
                    {pending && <span className="kb-tag pending">待审批</span>}
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button className="robot-btn" onClick={() => window.api.invoke('files:preview', f.name)}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }} title="快速查看（系统原生预览）">
                        <Eye size={12} />查看
                      </button>
                      {inKb ? (
                        <>
                          {!pending && (
                            <>
                              <select value={promoCat[f.name] || categories[0]} onChange={e => setPromoCat(p => ({ ...p, [f.name]: e.target.value }))}
                                style={{ fontSize: 11, padding: '2px 4px', borderRadius: 5, border: '1px solid var(--border-color)', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
                                {categories.map(c => <option key={c} value={c}>{c}</option>)}
                              </select>
                              <button className="robot-btn" disabled={busy} onClick={() => promoteFile(f.name)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }} title="提名归档到企业库（管理端审批）">
                                <Building2 size={12} />归档到企业库
                              </button>
                            </>
                          )}
                          <button className="robot-btn" disabled={busy} onClick={() => removeFromKb(f.name)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }} title="移出个人库并不再自动入库">
                            <Ban size={12} />移出
                          </button>
                        </>
                      ) : (
                        <button className="robot-btn" disabled={busy} onClick={() => ingestFile(f.name)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                          <CloudUpload size={12} />{busy ? '入库中…' : '加入个人库'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '26px 0' }}>
              <div style={{ width: 52, height: 52, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--mint-50, rgba(16,185,129,0.08))' }}>
                <FolderOpen size={26} color="var(--brand-primary)" />
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{q ? '没有匹配的资料' : '资料库暂无文件'}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', lineHeight: 1.7, maxWidth: 420 }}>
                把参考资料放入上方工作目录，系统会<b>自动监听 → 差量同步 → 收录进个人知识库</b>，分身即可检索使用。
              </div>
              <button className="btn-secondary" style={{ marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={openDir}>
                <FolderOpen size={13} />打开工作目录
              </button>
            </div>
          )}
        </div>
      )}

      {/* 企业知识库（只读）：本岗位授权范围 + 文档清单，回答问题时按需 RAG 召回 */}
      {view === 'library' && (
        <div className="glass-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Database size={15} color="var(--brand-primary)" />
            <span style={{ fontWeight: 600, fontSize: 14 }}>企业知识库</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· 可检索 {ent.total} 篇</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>由管理端授权 · 问答时按需检索引用</span>
          </div>
          {ent.categories.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>授权范围：</span>
              {ent.categories.map((c, i) => (
                <span key={i} style={{ fontSize: 10.5, padding: '2px 8px', borderRadius: 999, background: 'rgba(59,130,246,0.08)', color: 'var(--brand-primary)', border: '1px solid rgba(59,130,246,0.2)' }}>{c}</span>
              ))}
            </div>
          )}
          {ent.docs.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ent.docs.filter(d => !q || d.name.toLowerCase().includes(q)).map((d, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, background: 'rgba(59,130,246,0.03)', border: '1px solid rgba(59,130,246,0.08)', padding: '7px 10px', borderRadius: 6 }}>
                  <FileText size={13} style={{ color: 'var(--brand-primary)', flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{d.category}</span>
                </div>
              ))}
              {ent.total > ent.docs.length && (
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', paddingLeft: 4 }}>…等共 {ent.total} 篇，按提问语义实时召回相关内容</div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontStyle: 'italic' }}>暂无可检索的企业文档（由管理端「知识中心」维护与授权）。</div>
          )}
        </div>
      )}

      {/* Files Grid（云同步卡片，仅资料库视图；产物不掺入） */}
      {view === 'library' && files.length > 0 && filteredFiles.length > 0 && (
        <div className="files-grid">
          {filteredFiles.map((file) => (
            <div key={file.name} className="file-card glass-card" style={{ cursor: 'zoom-in' }}
              title="点击快速查看（macOS 原生预览）"
              onClick={() => window.api.invoke('files:preview', file.name)}>
              <div className="file-icon">
                {file.name.endsWith('.pdf') ? '📄' : file.name.endsWith('.xlsx') ? '📊' : '📝'}
              </div>
              <div className="file-name">{file.name}</div>
              <div className="file-summary">{file.summary || '提取文本块并建立语义向量索引中...'}</div>

              <div className="file-footer">
                <span className="file-path" title={file.path}>{file.path}</span>

                {file.synced ? (
                  <span className="file-sync-status synced">
                    <CheckCircle2 size={10} style={{ marginRight: '3px', verticalAlign: 'middle', display: 'inline-block' }} />
                    已同步
                  </span>
                ) : (
                  <span className="file-sync-status pending" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {file.syncProgress && file.syncProgress > 0 && file.syncProgress < 100 ? (
                      <>
                        <RefreshCw size={10} className="spin" style={{ animation: 'spin 2s linear infinite' }} />
                        <span>同步中 {file.syncProgress}%</span>
                      </>
                    ) : (
                      <button
                        className="robot-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          syncFile(file.name)
                        }}
                        style={{ padding: '2px 6px', fontSize: '9px' }}
                      >
                        <CloudUpload size={10} style={{ marginRight: '3px', verticalAlign: 'middle', display: 'inline-block' }} />
                        同步云端
                      </button>
                    )}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* CSS Animation injection for spin */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
