import { useState, useEffect, useRef } from 'react'
import { FileScan, RefreshCw, Save, Activity, CheckCircle2, XCircle, MinusCircle, Upload, Play, Square, RotateCw, Container } from 'lucide-react'

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

  const m = status?.metrics

  return (
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FileScan size={16} color="var(--brand-primary)" />
          <span>文档解析引擎 (docling) · 监控与管理</span>
          {stateBadge()}
        </h3>
        <button className="btn-secondary" onClick={doCheck} disabled={checking} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={13} className={checking ? 'spin' : ''} />{checking ? '检测中…' : '检测'}
        </button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
        PDF/DOCX/XLSX/PPTX/图片的解析放在服务端（docling-serve）跑，终端不吃算力。此处监控其健康与解析指标，并可在线调整配置（无需重启后端）。
        {status && status.probeError && <span style={{ color: 'var(--accent-red, #dc2626)' }}> · 探测异常：{status.probeError}</span>}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {[
          ['引擎状态', status ? (!status.configured ? '未配置' : status.online ? '在线' : '离线') : '—', status?.online ? 'var(--accent-green)' : 'var(--text-muted)'],
          ['探测时延', status && status.probeLatencyMs >= 0 ? `${status.probeLatencyMs} ms` : '—', 'var(--brand-primary)'],
          ['累计解析', m ? `${m.success}/${m.total}` : '—', 'var(--brand-secondary)'],
          ['平均解析时延', m ? `${m.avgLatencyMs} ms` : '—', 'var(--accent-yellow)']
        ].map(([label, val, color], i) => (
          <div key={i} style={{ border: '1px solid var(--border-color)', borderRadius: 6, padding: 10, textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 'bold', color: color as string }}>{val}</div>
          </div>
        ))}
      </div>

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
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', height: 34 }}>
            <input type="checkbox" checked={doOcr} onChange={e => setDoOcr(e.target.checked)} />
            {doOcr ? '开' : '关'}
          </label>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={save} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Save size={13} />{saving ? '保存中…' : '保存配置'}
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          OCR 默认关（电子文档不需要）。开 OCR 需在 docling 主机装 ocrmac/easyocr 引擎，否则解析扫描件会失败。
        </span>
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
          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Container size={14} color="var(--brand-secondary)" />容器托管 (Docker · 可选){badge}
              </span>
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
                  ? <>说明：Docker 只是「托管 docling」的一种可选方式。当前引擎已在本机原生运行（见上方「在线」），解析功能不受影响，本面板无需处理。若日后想改用容器托管，安装并启动容器运行时（如 <code>colima start</code> 或 Docker Desktop）后即可在此启动。</>
                  : <>引擎离线且未连到 Docker 守护进程。两种恢复方式任选：① 在主机原生启动 <code>docling-serve run --port 5001</code>；② 安装并启动容器运行时（如 <code>colima start</code> 或 Docker Desktop）后在此点「启动」，如需改 Docker 地址，请到「沙箱管理」统一配置（本面板与其共用）。</>}
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
                <label className="form-label">Docker 地址（与「沙箱管理」共用）</label>
                <div className="form-input" style={{ background: 'var(--bg-subtle, #f8fafc)', color: 'var(--text-secondary)', cursor: 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={status?.dockerEndpoint || 'unix:///var/run/docker.sock'}>
                  {status?.dockerEndpoint || 'unix:///var/run/docker.sock'}
                </div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              启动会按需拉取镜像并以 <code>{`-p ${hostPort}:5001`}</code> + <code>LOAD_MODELS_AT_BOOT=false</code> 运行；首次启动若「服务地址」为空会自动指向 <code>http://localhost:{hostPort}</code>。改镜像/端口后先「保存配置」再启动。
            </div>
          </div>
        )
      })()}

      {/* Test parse */}
      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Activity size={14} color="var(--accent-green)" />
          <span style={{ fontSize: 13, fontWeight: 600 }}>解析自检</span>
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
            <div style={{ fontSize: 12, color: 'var(--accent-red, #dc2626)' }}>✗ 解析失败：{testResult.error}（docling 未在线时会回退基础解析）</div>
          )
        )}
      </div>
    </div>
  )
}
