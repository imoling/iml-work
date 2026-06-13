import { useState } from 'react'
import { Search, Plus, CloudUpload, CheckCircle2, RefreshCw } from 'lucide-react'
import { useSpaceStore } from '../stores/spaceStore'

export default function PersonalSpace() {
  const { files, searchQuery, setSearchQuery, addMockFile, syncFile } = useSpaceStore()
  const [newFileName, setNewFileName] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)

  // Filtered files list based on query
  const filteredFiles = files.filter(file => 
    file.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    (file.summary && file.summary.toLowerCase().includes(searchQuery.toLowerCase()))
  )

  const handleAddMockFile = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newFileName.trim()) return
    // Ensure file extension
    let name = newFileName.trim()
    if (!name.includes('.')) name += '.docx'
    await addMockFile(name)
    setNewFileName('')
    setShowAddForm(false)
  }

  const handleQuickAdd = async (name: string) => {
    await addMockFile(name)
  }

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

          <button className="settings-btn" onClick={() => setShowAddForm(!showAddForm)} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Plus size={14} />
            <span>模拟添加文档</span>
          </button>
        </div>
      </div>

      {/* Add Mock File Modal or Accordion Form */}
      {showAddForm && (
        <form onSubmit={handleAddMockFile} className="glass-card" style={{ padding: '16px', display: 'flex', gap: '12px', alignItems: 'flex-end', animation: 'slideIn 0.2s ease' }}>
          <div className="form-field" style={{ flex: 1 }}>
            <label className="form-label">模拟本地新增文件名 (系统会自动捕捉变化)</label>
            <input 
              type="text" 
              className="form-input" 
              placeholder="例如: customer_contracts_v2.pdf" 
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              autoFocus
            />
          </div>
          <button type="submit" className="settings-btn">创建本地物理文件</button>
          <button type="button" className="delete-cancel-btn" onClick={() => setShowAddForm(false)}>取消</button>
        </form>
      )}

      {/* Quick Add Suggestions when Empty */}
      {files.length === 0 && (
        <div className="glass-card" style={{ padding: '24px', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <p>本地工作目录为空，点击上方“模拟添加文档”或选择以下常见模板模拟添加：</p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '12px' }}>
            <button className="robot-btn" onClick={() => handleQuickAdd('china_telecom_tender.pdf')}>中电信招标文件模板.pdf</button>
            <button className="robot-btn" onClick={() => handleQuickAdd('employee_handbook.docx')}>员工手册汇编.docx</button>
          </div>
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
                <span>{file.path}</span>
                
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
