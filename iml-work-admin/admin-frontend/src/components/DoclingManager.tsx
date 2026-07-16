import { useState, useEffect, useRef } from 'react'
import { FileScan, RefreshCw, Save, Activity, CheckCircle2, XCircle, MinusCircle, Upload, Play, Square, RotateCw, Container } from 'lucide-react'
import Switch from './Switch'

interface ContainerInfo {
  reachable: boolean
  exists: boolean
  running?: boolean
  state?: string
  status?: string
  phase?: string
  phaseMessage?: string
  message?: string
}
interface DoclingStatus {
  dockerEndpoint?: string   // 生效的 Docker 地址（与「沙箱管理」共用，后端计算）
  configured: boolean
  online: boolean
  endpoint: string
  convertPath: string
  doOcr: boolean
  timeoutMs: number
  probeLatencyMs: number
  probeError: string | null
  lastCheckAt: number
  metrics: { total: number; success: number; failed: number; avgLatencyMs: number }
  image: string
  hostPort: number
  containerName: string
  container: ContainerInfo
}

export default function DoclingManager() {
  const [status, setStatus] = useState<DoclingStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)

  // Editable config
  const [endpoint, setEndpoint] = useState('')
  const [convertPath, setConvertPath] = useState('/v1/convert/file')
  const [doOcr, setDoOcr] = useState(false)
  const [timeoutMs, setTimeoutMs] = useState(120000)
  const [image, setImage] = useState('ghcr.io/docling-project/docling-serve')
  const [hostPort, setHostPort] = useState(5001)
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const [lifecycleMsg, setLifecycleMsg] = useState<{ ok: boolean; text: string } | null>(null)   // 容器操作结果反馈（失败原因必须可见，不静默）

  // Test parse
  const fileRef = useRef<HTMLInputElement>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; name?: string; md?: string; error?: string } | null>(null)
  // 解析历史（审计表回溯，与虾池执行历史同构）
  const [hist, setHist] = useState<{ id: number; filename: string; sizeBytes: number; success: boolean; error?: string; latencyMs: number; source: string; createdAt: string }[]>([])
  const fetchHist = async () => { try { const r = await fetch('/api/v1/parse/history'); if (r.ok) setHist(await r.json()) } catch (e) { console.error(e) } }

  const applyStatus = (s: DoclingStatus) => {
    setStatus(s)
    setEndpoint(s.endpoint || '')
    setConvertPath(s.convertPath || '/v1/convert/file')
    setDoOcr(!!s.doOcr)
    setTimeoutMs(s.timeoutMs || 120000)
    setImage(s.image || 'ghcr.io/docling-project/docling-serve')
    setHostPort(s.hostPort || 5001)
  }

  const load = async () => {
    try {
      const res = await fetch('/api/v1/parse/status')
      if (res.ok) applyStatus(await res.json())
      fetchHist()
    } catch (e) { console.error(e) }
  }

  // 轮询:生命周期进行中(拉镜像/启动)时加快到 3s,否则 30s
  const phase = status?.container?.phase
  useEffect(() => {
    load()
    const fast = phase === 'pulling' || phase === 'starting'
    const t = setInterval(load, fast ? 3000 : 30000)
    return () => clearInterval(t)
  }, [phase])

  const lifecycle = async (action: 'start' | 'stop' | 'restart') => {
    setLifecycleBusy(true)
    setLifecycleMsg(null)
    try {
      const res = await fetch(`/api/v1/parse/container/${action}`, { method: 'POST' })
      const body: any = await res.json().catch(() => ({}))
      // 结果必须反馈给用户：后端返回 {success:false, error:"无法连接 Docker 守护进程…"} 时不能静默
      if (!res.ok || body?.success === false) {
        setLifecycleMsg({ ok: false, text: body?.error || body?.message || `操作失败 (HTTP ${res.status})` })
      } else if (body?.message) {
        setLifecycleMsg({ ok: true, text: body.message })
      }
      await load()
    } catch (e: any) {
      setLifecycleMsg({ ok: false, text: `请求失败：${e?.message || e}` })
    }
    setLifecycleBusy(false)
  }

  const doCheck = async () => {
    setChecking(true)
    try {
      const res = await fetch('/api/v1/parse/check', { method: 'POST' })
      if (res.ok) applyStatus(await res.json())
    } catch (e) { console.error(e) }
    setChecking(false)
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/v1/parse/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, convertPath, doOcr, timeoutMs, image, hostPort })
      })
      if (res.ok) { await load(); await doCheck() }
    } catch (e) { console.error(e) }
    setSaving(false)
  }

  const runTest = async (file: File) => {
    setTesting(true)
    setTestResult(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/v1/parse/document', { method: 'POST', body: form })
      const data = await res.json()
      setTestResult({ ok: !!data.ok, name: data.filename, md: data.markdown, error: data.error || data.reason })
      load()
    } catch (e: any) {
      setTestResult({ ok: false, error: e.message })
    }
    setTesting(false)
  }

  const stateBadge = () => {
    if (!status) return null
    if (!status.configured) return <span className="badge badge-yellow" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><MinusCircle size={12} />未配置</span>
    if (status.online) return <span className="badge badge-green" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={12} />在线</span>
    return <span className="badge badge-red" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><XCircle size={12} />离线</span>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* ① 解析服务配置（骨架与虾池「沙箱运行配置」同构：标题行右侧动作，底部行左提示右保存） */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileScan size={16} color="var(--brand-primary)" />
          <span>解析服务配置</span>
          {stateBadge()}
        </h3>
        <button className="btn-secondary" onClick={doCheck} disabled={checking} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={13} className={checking ? 'spin' : ''} />{checking ? '检测中…' : '检测联通'}
        </button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
        PDF/DOCX/XLSX/PPTX/图片的解析放在服务端文档引擎跑，终端不吃算力。配置在线生效（无需重启后端）。{status && status.probeLatencyMs >= 0 && <span> · 探测时延 {status.probeLatencyMs}ms</span>}
        {status && status.probeError && <span style={{ color: 'var(--accent-red, #dc2626)' }}> · 探测异常：{status.probeError}</span>}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 12, alignItems: 'end' }}>
        <div className="form-group">
          <label className="form-label">服务地址 (endpoint)</label>
          <input className="form-input" value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="http://localhost:5001" />
        </div>
        <div className="form-group">
          <label className="form-label">转换路径</label>
          <input className="form-input" value={convertPath} onChange={e => setConvertPath(e.target.value)} placeholder="/v1/convert/file" />
        </div>
        <div className="form-group">
          <label className="form-label">超时 (ms)</label>
          <input type="number" className="form-input" value={timeoutMs} min={5000} max={600000} onChange={e => setTimeoutMs(Number(e.target.value))} />
        </div>
        <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="form-label" style={{ whiteSpace: 'nowrap' }}>OCR（扫描件）</label>
          <div style={{ display: 'flex', alignItems: 'center', height: 34 }}>
            <Switch checked={doOcr} onChange={setDoOcr} />
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          OCR 默认关（电子文档不需要）。开启后扫描件/图片型文档才会提取文字；docling-serve 镜像已内置 OCR 引擎与中英文模型（RapidOcr），无需额外安装。
        </span>
        <button className="btn-primary" onClick={save} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Save size={13} />{saving ? '保存中…' : '保存配置'}
        </button>
      </div>
      </div>

      {/* ② 解析自检（独立卡，对应虾池「执行自检」） */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={16} color="var(--accent-green)" />
            <span>解析自检</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>选一个真实文档验证「上传 → 引擎解析 → Markdown 回传」整条链路</span>
          </h3>
          <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) runTest(f); e.target.value = '' }} />
          <button className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={testing} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Upload size={13} />{testing ? '解析中…' : '选文件测试解析'}
          </button>
        </div>
        {testResult && (
          testResult.ok ? (
            <div style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-color)', borderRadius: 6, padding: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--accent-green)', marginBottom: 6 }}>✓ {testResult.name} 解析成功（Markdown 预览，前 1500 字）</div>
              <pre style={{ margin: 0, maxHeight: 240, overflow: 'auto', fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--text-primary)' }}>
                {(testResult.md || '').slice(0, 1500)}{(testResult.md || '').length > 1500 ? '\n…' : ''}
              </pre>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--accent-red, #dc2626)' }}>✗ 解析失败：{testResult.error}（引擎未在线时会回退基础解析）</div>
          )
        )}
      </div>

      {/* 容器托管（可选）：Docker 只是「托管 docling-serve」的一种方式（拉镜像代跑）。
          引擎也可原生运行（直接 docling-serve run）——那时 Docker 不可达是正常状态，不该红色报警。 */}
      {(() => {
        const c = status?.container
        const running = !!c?.running
        const ph = c?.phase
        const engineOnline = !!status?.online   // 引擎本体是否在线（无论原生还是容器托管）
        let badge = <span className="badge badge-red">未创建</span>
        if (!c?.reachable) {
          badge = engineOnline
            ? <span className="badge badge-gray">未启用 · 引擎已原生运行</span>
            : <span className="badge badge-red">Docker 不可达</span>
        }
        else if (ph === 'pulling') badge = <span className="badge badge-yellow">拉取镜像中…</span>
        else if (ph === 'starting') badge = <span className="badge badge-yellow">启动中…</span>
        else if (ph === 'error') badge = <span className="badge badge-red">启动失败</span>
        else if (running) badge = <span className="badge badge-green">运行中</span>
        else if (c?.exists) badge = <span className="badge badge-yellow">已停止</span>
        const inProgress = ph === 'pulling' || ph === 'starting'
        const unreachable = !c?.reachable   // 守护进程不可达时任何容器操作都不可能成功 → 禁用而非静默失败
        return (
          <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Container size={16} color="var(--brand-secondary)" />容器托管 (Docker · 可选){badge}
              </h3>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px' }}
                  title={unreachable ? 'Docker 守护进程不可达，无法操作容器' : ''}
                  onClick={() => lifecycle('start')} disabled={unreachable || lifecycleBusy || inProgress || running}><Play size={12} />启动</button>
                <button className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px' }}
                  title={unreachable ? 'Docker 守护进程不可达，无法操作容器' : ''}
                  onClick={() => lifecycle('stop')} disabled={unreachable || lifecycleBusy || inProgress || !running}><Square size={12} />停止</button>
                <button className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px' }}
                  title={unreachable ? 'Docker 守护进程不可达，无法操作容器' : ''}
                  onClick={() => lifecycle('restart')} disabled={unreachable || lifecycleBusy || inProgress}><RotateCw size={12} />重启</button>
              </div>
            </div>
            {lifecycleMsg && (
              <div style={{ fontSize: 11, color: lifecycleMsg.ok ? 'var(--accent-green, #16a34a)' : 'var(--accent-red, #dc2626)' }}>
                {lifecycleMsg.text}
              </div>
            )}
            {c && (c.phaseMessage || c.message || c.status) && (
              <div style={{ fontSize: 11, color: inProgress ? 'var(--accent-yellow)' : 'var(--text-secondary)' }}>
                {c.phaseMessage || c.status || c.message}
              </div>
            )}
            {!c?.reachable && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {engineOnline
                  ? <>说明：Docker 只是「托管文档引擎」的一种可选方式。当前引擎已在本机原生运行（见上方「在线」），解析功能不受影响，本面板无需处理。若日后想改用容器托管，安装并启动容器运行时（如 <code>colima start</code> 或 Docker Desktop）后即可在此启动。</>
                  : <>引擎离线且未连到 Docker 守护进程。两种恢复方式任选：① 在主机原生运行文档解析服务（参见运维手册 RUNBOOK）；② 安装并启动容器运行时（如 <code>colima start</code> 或 Docker Desktop）后在此点「启动」，如需改 Docker 地址，请到本页「动态虾池」页签统一配置（两者共用）。</>}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.5fr', gap: 12, alignItems: 'end' }}>
              <div className="form-group">
                <label className="form-label">镜像</label>
                <input className="form-input" value={image} onChange={e => setImage(e.target.value)} placeholder="ghcr.io/docling-project/docling-serve" />
              </div>
              <div className="form-group">
                <label className="form-label">宿主端口</label>
                <input type="number" className="form-input" value={hostPort} onChange={e => setHostPort(Number(e.target.value))} />
              </div>
              <div className="form-group">
                <label className="form-label">Docker 地址（与「动态虾池」共用）</label>
                {/* 取不到就如实说"未获取"，绝不拿一个写死的地址当占位——那会让人以为系统在用它，实际不是。 */}
                <div className="form-input" style={{ background: 'var(--bg-subtle, #f8fafc)', color: 'var(--text-secondary)', cursor: 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={status?.dockerEndpoint || '未获取到（后端沙箱配置未就绪）'}>
                  {status?.dockerEndpoint || '未获取到（后端沙箱配置未就绪）'}
                </div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              启动会按需拉取镜像并以 <code>{`-p ${hostPort}:5001`}</code> + <code>LOAD_MODELS_AT_BOOT=false</code> 运行；首次启动若「服务地址」为空会自动指向 <code>http://localhost:{hostPort}</code>。改镜像/端口后先「保存配置」再启动。
            </div>
          </div>
        )
      })()}
      {/* ④ 解析历史（独立卡，与虾池执行历史同构——每次解析留痕，最近 50 条） */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={16} color="var(--brand-primary)" />
            <span>解析历史</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>每次解析（知识入库/文档解析）留痕回溯（最近 50 条）</span>
          </h3>
          <button className="btn-secondary" onClick={fetchHist} style={{ padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}><RefreshCw size={12} />刷新历史</button>
        </div>
        {hist.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>
            暂无解析记录。知识入库、附件解析或上方「解析自检」跑过后会在此留痕。
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="admin-table">
              <thead><tr><th>时间</th><th>结果</th><th>耗时</th><th>来源</th><th>文件</th><th>大小</th></tr></thead>
              <tbody>
                {hist.map(h => (
                  <tr key={h.id} title={h.error ? `失败原因：${h.error}` : ''}>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{(h.createdAt || '').replace('T', ' ').slice(0, 19)}</td>
                    <td><span className={`badge ${h.success ? 'badge-green' : 'badge-red'}`}>{h.success ? '成功' : '失败'}</span></td>
                    <td style={{ fontSize: 12 }}>{h.latencyMs >= 1000 ? (h.latencyMs / 1000).toFixed(1) + 's' : h.latencyMs + 'ms'}</td>
                    <td><span className="badge badge-purple">{h.source || '—'}</span></td>
                    <td style={{ fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.filename}>{h.filename}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{h.sizeBytes >= 1048576 ? (h.sizeBytes / 1048576).toFixed(1) + ' MB' : Math.round(h.sizeBytes / 1024) + ' KB'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>


    </div>
  )
}
