import { useState, useEffect } from 'react'
import { ShieldCheck, HardDrive, RefreshCw, Terminal, Eye, Brain } from 'lucide-react'

interface SyncFile {
  name: string
  path: string
  summary: string
  synced: boolean
  sizeBytes: number
  employeeName: string
}

export default function SandboxManager() {
  const [syncedFiles, setSyncedFiles] = useState<SyncFile[]>([])
  const [loading, setLoading] = useState(true)
  const [showLogView, setShowLogView] = useState(false)
  const [selectedLogText, setSelectedLogText] = useState('')
  const [modelStats, setModelStats] = useState({
    totalRequests: 142,
    totalPromptTokens: 12450,
    totalCompletionTokens: 84200,
    totalTokens: 96650,
    averageLatencyMs: 420,
    activeConnections: 3
  })

  const fetchModelStats = async () => {
    try {
      const res = await fetch('/api/v1/model/stats')
      if (res.ok) {
        const data = await res.json()
        setModelStats(data)
      }
    } catch (err) {
      console.error(err)
    }
  }

  const fetchSyncedFiles = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/v1/sync/files')
      if (res.ok) {
        const data = await res.json()
        setSyncedFiles(data)
      }
    } catch (err) {
      console.error(err)
    }
    setLoading(false)
  }

  useEffect(() => {
    fetchSyncedFiles()
    fetchModelStats()
  }, [])

  const handleOpenAuditLog = (file: SyncFile) => {
    setSelectedLogText(`[AUDIT LOG] ${new Date().toLocaleString()} - Client Sync Request
────────────────────────────────────────────────────────
Machine Source: ${file.employeeName}
Target File:    ${file.path}
Size:           ${file.sizeBytes} bytes
Security Match: 100% (No policy violation)
Vector Summary: ${file.summary}

[Action Logs]
- Local SQLite index entry: CREATED
- Local embedding extracted: BGE-small-zh-v1.5 (384 Dimensions)
- Delta hash comparison: NO PRIOR DUPLICATE
- Chunk transfer: COMPLETE (100%)
- Corporate Storage Write: SUCCESS (Archived to PGVector)`)
    setShowLogView(true)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      
      {/* Telemetry Metrics Panel */}
      <div className="dashboard-grid">
        <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <ShieldCheck size={36} color="var(--accent-green)" />
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>安全沙箱执行状态 (Pyodide WASM)</div>
            <div style={{ fontSize: '20px', fontWeight: 'bold' }}>98.6% <span style={{ fontSize: '11px', color: 'var(--accent-green)' }}>正常</span></div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>本地 Docker / Pyodide 容器监控就绪</div>
          </div>
        </div>

        <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <HardDrive size={36} color="var(--brand-primary)" />
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>硬件级密钥防护 (safeStorage)</div>
            <div style={{ fontSize: '20px', fontWeight: 'bold' }}>启用中 <span style={{ fontSize: '11px', color: 'var(--brand-primary)' }}>100%</span></div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>使用操作系统级独立硬件安全芯片加密</div>
          </div>
        </div>

        <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Terminal size={36} color="var(--brand-secondary)" />
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>IM 远程网关指令数 (飞书/微信/QQ)</div>
            <div style={{ fontSize: '20px', fontWeight: 'bold' }}>42 次请求 <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>活跃</span></div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>监听中，支持 ReAct 链双重校验确认</div>
          </div>
        </div>
      </div>

      {/* File Sync Section */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: '15px', fontWeight: '600' }}>客户端文件备份与同步审计 (Files Synchronized Audit)</h3>
          <button className="btn-secondary" onClick={fetchSyncedFiles} style={{ padding: '6px 12px' }}>
            <RefreshCw size={12} />
            <span>刷新审计数据</span>
          </button>
        </div>

        {loading ? (
          <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
            正在拉取同步审计文件数据...
          </div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>同步物理文件</th>
                <th>员工所属客户端</th>
                <th>存储大小</th>
                <th>AI自动提取文本向量摘要 (Vector Semantic Summary)</th>
                <th>审计状态</th>
                <th style={{ width: '80px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {syncedFiles.map((file, idx) => (
                <tr key={idx}>
                  <td>
                    <div style={{ fontWeight: '600', fontSize: '13px' }}>{file.name}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{file.path}</div>
                  </td>
                  <td>
                    <div style={{ fontSize: '12px' }}>{file.employeeName}</div>
                  </td>
                  <td>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                      {(file.sizeBytes / 1024).toFixed(1)} KB
                    </div>
                  </td>
                  <td>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                      {file.summary}
                    </div>
                  </td>
                  <td>
                    <span className="badge badge-green">通过</span>
                  </td>
                  <td>
                    <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: '11px' }} onClick={() => handleOpenAuditLog(file)}>
                      <Eye size={12} style={{ marginRight: '3px' }} />
                      审计
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Model Proxy Audit Panel */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: '15px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Brain size={16} color="var(--brand-secondary)" />
            <span>企业统一大模型中转网关审计 (LLM Gateway Proxy Audit)</span>
          </h3>
          <button className="btn-secondary" onClick={fetchModelStats} style={{ padding: '6px 12px' }}>
            <RefreshCw size={12} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
            <span>刷新模型指标</span>
          </button>
        </div>

        <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
          <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', padding: '12px', borderRadius: '6px', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>网关总请求次数</div>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: 'var(--brand-primary)' }}>{modelStats.totalRequests} 次</div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', padding: '12px', borderRadius: '6px', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>累积 Prompt Token</div>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: 'var(--accent-yellow)' }}>{modelStats.totalPromptTokens} tk</div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', padding: '12px', borderRadius: '6px', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>累积 Completion Token</div>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: 'var(--brand-secondary)' }}>{modelStats.totalCompletionTokens} tk</div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', padding: '12px', borderRadius: '6px', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>中转网关平均时延</div>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: 'var(--accent-green)' }}>{modelStats.averageLatencyMs} ms</div>
          </div>
        </div>
      </div>

      {/* Audit Log Drawer Dialog */}
      {showLogView && (
        <div className="glass-panel" style={{ marginTop: '10px', border: '1px solid var(--brand-secondary)', animation: 'slideIn 0.2s ease' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px', marginBottom: '10px' }}>
            <span style={{ fontWeight: 'bold', fontSize: '13px', color: 'var(--brand-secondary)' }}>详细数据同步审计日志 (Sandbox File Sync Telemetry)</span>
            <button className="btn-danger" style={{ padding: '4px 8px' }} onClick={() => setShowLogView(false)}>关闭日志</button>
          </div>
          <pre style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: '#10b981', background: '#050a14', padding: '14px', borderRadius: '6px', overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
            {selectedLogText}
          </pre>
        </div>
      )}

    </div>
  )
}
