import { useState, useEffect } from 'react'
import { Search, CloudUpload, CheckCircle2, RefreshCw, FolderOpen, FolderCog, Database, ToggleLeft, ToggleRight, Building2, Ban, BookText } from 'lucide-react'
import { useSpaceStore } from '../stores/spaceStore'

const ENTERPRISE_CATEGORIES = ['公司基本信息', '行政财务制度', '企业合规制度', '人事审批规范']

interface KbFile { name: string; excluded: boolean; docId: string; doc: { id: string; chunksCount: number; promotionStatus?: string } | null }
interface KbOverview { ok: boolean; ownerId: string; autoIngest: boolean; files: KbFile[]; personalDocs: any[] }

export default function PersonalSpace() {
  const { files, searchQuery, setSearchQuery, syncFile } = useSpaceStore()
  const [wsDir, setWsDir] = useState('')

  // 个人知识库概览
  const [kb, setKb] = useState<KbOverview>({ ok: false, ownerId: '', autoIngest: true, files: [], personalDocs: [] })
  const [promoCat, setPromoCat] = useState<Record<string, string>>({})
  const [kbBusy, setKbBusy] = useState<string>('')
  const loadKb = () => window.api.invoke('kb:overview').then((r: any) => { if (r?.ok) setKb(r) }).catch(() => {})
  useEffect(() => {
    window.api.invoke('workspace:files').then((r: any) => { if (r) setWsDir(r.dir || '') }).catch(() => {})
    loadKb()
    const un = window.api.on('kb:changed', () => loadKb())
    return () => { un && un() }
  }, [])
  const toggleAuto = async () => { await window.api.invoke('kb:set-autoingest', !kb.autoIngest); loadKb() }
  const ingestFile = async (name: string) => { setKbBusy(name); await window.api.invoke('kb:ingest', name); setKbBusy(''); loadKb() }
  const removeFromKb = async (name: string) => { setKbBusy(name); await window.api.invoke('kb:remove', name); setKbBusy(''); loadKb() }
  const promoteFile = async (name: string) => {
    const category = promoCat[name] || ENTERPRISE_CATEGORIES[0]
    setKbBusy(name)
    const r: any = await window.api.invoke('kb:promote', { name, category })
    setKbBusy('')
    loadKb()
    if (r?.ok) alert(`已提名「${name}」归档到企业库（类目：${category}），等待管理端审批。`)
    else alert(`提名失败：${r?.reason || '未知错误'}`)
  }

  const pickDir = async () => { const r = await window.api.invoke('workspace:pick-dir'); if (r && !r.canceled) setWsDir(r.dir || '') }
  const openDir = () => window.api.invoke('workspace:open')

  // Filtered files list based on query
  const filteredFiles = files.filter(file => 
    file.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    (file.summary && file.summary.toLowerCase().includes(searchQuery.toLowerCase()))
  )

  return (
    <div className="space-view">
      <div className="space-toolbar">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 'bold' }}>个人文件空间 (Local Workspace)</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            监听本地物理目录，自动索引，提取向量信息并差量备份至云端归档知识库。
          </p>
        </div>
        
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <input
              type="text"
              className="space-search"
              placeholder="搜索本地文件或知识概要..."
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

      {/* 个人知识库（个人+企业分层）*/}
      <div className="glass-card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14 }}>
            <Database size={15} color="var(--brand-primary)" />个人知识库
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>
              已收录 {kb.personalDocs?.length || 0} 个文档
            </span>
          </span>
          <button className="btn-secondary" onClick={toggleAuto} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="放入工作空间的文档是否自动进个人库">
            {kb.autoIngest ? <ToggleRight size={16} color="var(--brand-primary)" /> : <ToggleLeft size={16} />}
            自动入库 · {kb.autoIngest ? '开' : '关'}
          </button>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
          放入工作空间/上传的文档会自动经服务端解析后进你的<b>个人库</b>（仅你可检索，分身答题时会用到）。可按文件排除，或<b>归档到企业库</b>（管理端审批后全员可用）。
        </p>

        {kb.files && kb.files.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {kb.files.map(f => {
              const inKb = !!f.docId && !f.excluded
              const pending = f.doc?.promotionStatus === 'PENDING'
              const busy = kbBusy === f.name
              return (
                <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-subtle)' }}>
                  <BookText size={13} color={inKb ? 'var(--brand-primary)' : 'var(--text-muted)'} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{f.name}</span>
                  {inKb ? (
                    <span className="kb-tag on">个人库已收录</span>
                  ) : f.excluded ? (
                    <span className="kb-tag off">已排除</span>
                  ) : (
                    <span className="kb-tag none">未收录</span>
                  )}
                  {pending && <span className="kb-tag pending">待审批</span>}
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {inKb ? (
                      <>
                        {!pending && (
                          <>
                            <select value={promoCat[f.name] || ENTERPRISE_CATEGORIES[0]} onChange={e => setPromoCat(p => ({ ...p, [f.name]: e.target.value }))}
                              style={{ fontSize: 11, padding: '2px 4px', borderRadius: 5, border: '1px solid var(--border-color)', background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
                              {ENTERPRISE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
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
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '10px 0' }}>
            工作空间还没有文档。放入或上传文件后会自动进个人库。
          </div>
        )}
      </div>

      {/* 真实空态引导：文件从真实工作目录进入,不提供任何模拟入口 */}
      {files.length === 0 && (
        <div className="glass-card" style={{ padding: '24px', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <p>本地工作目录为空。把文件放入上方「工作目录」（或用「打开」进入目录后拖入文件），系统会自动监听、差量同步并收录进个人知识库。</p>
        </div>
      )}

      {/* Files Grid */}
      {files.length > 0 && (
        <div className="files-grid">
          {filteredFiles.map((file) => (
            <div key={file.name} className="file-card glass-card">
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
      
      {/* Search results notice */}
      {files.length > 0 && filteredFiles.length === 0 && (
        <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '20px' }}>
          未找到匹配 &quot;{searchQuery}&quot; 的本地索引文档
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
