import { useState, useEffect } from 'react'
import { ShieldCheck, HardDrive, RefreshCw, Boxes, Plug, Save, Trash2, Container, Play, Activity } from 'lucide-react'

interface SandboxConfig {
  mode: string
  dockerEndpoint: string
  baseImage: string
  cpuQuota: number
  memoryQuotaMb: number
  timeoutSeconds: number
  networkIsolation: boolean
}

// 公司级代码执行沙箱的实时状态（后端 /exec/status）：Docker 可达性 + 基础镜像就绪。
interface ExecStatus {
  mode: string
  dockerEndpoint: string
  reachable: boolean
  imageReady?: boolean
  image?: string
  error?: string
}

interface DockerContainer {
  shortId: string
  id: string
  names: string[]
  image: string
  state: string
  status: string
}

interface ClientNode {
  clientId: string
  hostname: string
  expertName: string
  sandboxMode: string
  pyodideHealthy: boolean
  imCommandCount: number
  appVersion: string
  lastSeen: string
  online: boolean
}

export default function SandboxManager() {
  const [config, setConfig] = useState<SandboxConfig>({
    mode: 'docker', dockerEndpoint: 'unix:///var/run/docker.sock', baseImage: 'python:3.12-slim',
    cpuQuota: 1, memoryQuotaMb: 512, timeoutSeconds: 120, networkIsolation: true
  })
  const [containers, setContainers] = useState<DockerContainer[]>([])
  const [dockerReachable, setDockerReachable] = useState<boolean | null>(null)
  const [dockerMsg, setDockerMsg] = useState('')
  const [clientNodes, setClientNodes] = useState<ClientNode[]>([])
  const [execStatus, setExecStatus] = useState<ExecStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string>('')

  const fetchClientNodes = async () => {
    try {
      const res = await fetch('/api/v1/clients')
      if (res.ok) setClientNodes(await res.json())
    } catch (err) { console.error(err) }
  }

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/v1/sandbox/config')
      if (res.ok) setConfig(await res.json())
    } catch (err) { console.error(err) }
  }

  // 拉取公司级沙箱实时状态：Docker 可达 + 基础镜像就绪（代码执行型技能的执行前提）。
  const fetchExecStatus = async () => {
    try {
      const res = await fetch('/api/v1/sandbox/exec/status')
      if (res.ok) setExecStatus(await res.json())
    } catch (err) { console.error(err) }
  }

  // 管理员一键自检：在沙箱里跑一段最小 Python，验证「装包 → 执行 → 产物回传」整条链路。
  const testExec = async () => {
    setTesting(true); setTestResult('正在沙箱内执行自检脚本…')
    try {
      const res = await fetch('/api/v1/sandbox/exec', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'import sys, platform\nprint("python", platform.python_version(), "on", sys.platform)\nopen("/out/selfcheck.txt","w").write("ok")\nprint("selfcheck file written")',
          packages: []
        })
      })
      const d = await res.json()
      if (d.ok) {
        const files = (d.files || []).map((f: any) => f.name).join('、') || '无'
        setTestResult(`✅ 自检通过\n输出：${d.stdout || '(无)'}\n产物回传：${files}\n网络隔离：${d.networkIsolated ? '是' : '否'}`)
      } else {
        setTestResult(`❌ 自检失败：${d.error || d.stderr || '未知错误'}`)
      }
      fetchExecStatus()
    } catch (err: any) {
      setTestResult(`❌ 请求失败：${err?.message || err}`)
    }
    setTesting(false)
  }

  const saveConfig = async () => {
    const res = await fetch('/api/v1/sandbox/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config)
    })
    if (res.ok) { setConfig(await res.json()); alert('沙箱配置已保存') }
  }

  const pingDocker = async () => {
    setDockerMsg('正在探测 Docker 守护进程...')
    const res = await fetch('/api/v1/sandbox/docker/ping', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: config.dockerEndpoint })
    })
    const data = await res.json()
    setDockerReachable(!!data.reachable)
    setDockerMsg(data.reachable ? `连接成功 · Docker ${data.version}` : data.message)
    if (data.reachable) fetchContainers()
  }

  const fetchContainers = async () => {
    const res = await fetch(`/api/v1/sandbox/containers?endpoint=${encodeURIComponent(config.dockerEndpoint)}`)
    if (res.ok) {
      const data = await res.json()
      setDockerReachable(!!data.reachable)
      setContainers(data.containers || [])
      if (!data.reachable) setDockerMsg(data.message || '')
    }
  }

  const killContainer = async (id: string) => {
    if (!confirm('确认强制终止该沙箱容器?')) return
    const res = await fetch(`/api/v1/sandbox/containers/${id}?endpoint=${encodeURIComponent(config.dockerEndpoint)}`, { method: 'DELETE' })
    const data = await res.json()
    alert(data.message)
    fetchContainers()
  }

  useEffect(() => {
    fetchConfig()
    fetchExecStatus()
    fetchClientNodes()
    const t = setInterval(() => { fetchClientNodes(); fetchExecStatus() }, 30000)
    return () => clearInterval(t)
  }, [])

  // 在线节点：正在使用该沙箱执行技能的客户端（心跳上报的真实数据）
  const onlineNodes = clientNodes.filter(n => n.online).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* 沙箱平面实时态（沙箱可达/镜像就绪 + 在跑容器 + 在线消费节点） */}
      <div className="dashboard-grid">
        <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <ShieldCheck size={36} color={execStatus?.reachable ? 'var(--accent-green)' : 'var(--accent-red, #f87171)'} />
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>企业安全沙箱</div>
            <div style={{ fontSize: '20px', fontWeight: 'bold' }}>
              {execStatus?.mode === 'disabled'
                ? <span style={{ color: 'var(--text-muted)' }}>已停用</span>
                : execStatus?.reachable
                  ? (execStatus.imageReady
                      ? <>就绪 <span style={{ fontSize: '11px', color: 'var(--accent-green)' }}>Docker</span></>
                      : <>镜像未就绪 <span style={{ fontSize: '11px', color: 'var(--accent-yellow)' }}>拉取中</span></>)
                  : <>不可达 <span style={{ fontSize: '11px', color: 'var(--accent-red, #f87171)' }}>检查配置</span></>}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>全公司共用一套集中 Docker 沙箱 · {execStatus?.image || '—'}</div>
          </div>
        </div>

        <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Container size={36} color="var(--brand-secondary)" />
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>在跑沙箱容器</div>
            <div style={{ fontSize: '20px', fontWeight: 'bold' }}>
              {containers.length} <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>个</span>
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{dockerReachable === false ? '未连接 Docker · 见下方监控' : '一次性执行容器，跑完即毁'}</div>
          </div>
        </div>

        <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <HardDrive size={36} color="var(--brand-primary)" />
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>在线消费节点</div>
            <div style={{ fontSize: '20px', fontWeight: 'bold' }}>
              {onlineNodes} <span style={{ fontSize: '11px', color: 'var(--brand-primary)' }}>在线</span>
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>正在使用该沙箱执行技能的客户端</div>
          </div>
        </div>
      </div>

      {/* Sandbox Runtime Config */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Boxes size={16} color="var(--brand-primary)" />
          <span>沙箱运行配置</span>
        </h3>
        <div className="dashboard-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' }}>
          <div className="form-group">
            <label className="form-label">运行模式</label>
            <select className="form-select" value={config.mode} onChange={e => setConfig({ ...config, mode: e.target.value })}>
              <option value="docker">启用 · 公司级 Docker 沙箱</option>
              <option value="disabled">停用 · 拒绝代码执行技能</option>
            </select>
          </div>
          <div className="form-group" style={{ gridColumn: 'span 2' }}>
            <label className="form-label">Docker 接口端点（公司统一）</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="form-input" value={config.dockerEndpoint} onChange={e => setConfig({ ...config, dockerEndpoint: e.target.value })} placeholder="本机 colima：unix:///Users/xx/.colima/default/docker.sock ｜ 远程：tcp://host:2376" />
              <button className="btn-secondary" type="button" onClick={pingDocker} style={{ whiteSpace: 'nowrap' }}><Plug size={14} />检测联通</button>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">CPU 配额（核）</label>
            <input type="number" step="0.5" min={0.5} className="form-input" value={config.cpuQuota} onChange={e => setConfig({ ...config, cpuQuota: Number(e.target.value) })} />
          </div>
          <div className="form-group">
            <label className="form-label">内存配额（MB）</label>
            <input type="number" min={128} step={128} className="form-input" value={config.memoryQuotaMb} onChange={e => setConfig({ ...config, memoryQuotaMb: Number(e.target.value) })} />
          </div>
          <div className="form-group">
            <label className="form-label">最大超时（秒）</label>
            <input type="number" min={10} className="form-input" value={config.timeoutSeconds} onChange={e => setConfig({ ...config, timeoutSeconds: Number(e.target.value) })} />
          </div>
          <div className="form-group" style={{ gridColumn: 'span 3' }}>
            <label className="form-label">基础镜像（预装常用包可免每次 pip 联网）</label>
            <input className="form-input" value={config.baseImage} onChange={e => setConfig({ ...config, baseImage: e.target.value })} placeholder="python:3.12-slim ｜ 预装镜像：iml-sandbox:py312" />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <input type="checkbox" checked={config.networkIsolation} onChange={e => setConfig({ ...config, networkIsolation: e.target.checked })} />
            启用网络隔离
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {dockerReachable !== null && (
              <span style={{ fontSize: 11, color: dockerReachable ? 'var(--accent-green)' : 'var(--accent-red, #f87171)' }}>{dockerMsg}</span>
            )}
            <button className="btn-primary" onClick={saveConfig}><Save size={14} />保存配置</button>
          </div>
        </div>

        {/* 运行自检：镜像就绪状态 + 一键测试执行（管理员自检整条链路，无需等员工触发） */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: 12, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={14} color={execStatus?.reachable ? 'var(--accent-green)' : 'var(--text-muted)'} />
            {execStatus
              ? (execStatus.reachable
                  ? <span>沙箱可达 · 基础镜像 <b>{execStatus.image}</b> {execStatus.imageReady ? '已就绪' : '未就绪（首次执行将自动拉取）'}</span>
                  : <span style={{ color: 'var(--accent-red, #f87171)' }}>沙箱不可达：{execStatus.error || '检查 Docker 端点'}</span>)
              : <span>正在探测沙箱状态…</span>}
          </div>
          <button className="btn-secondary" onClick={testExec} disabled={testing}><Play size={14} />{testing ? '执行中…' : '测试执行'}</button>
        </div>
        {testResult && (
          <pre style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, whiteSpace: 'pre-wrap', background: 'var(--bg-subtle)', border: '1px solid var(--border-color)', padding: 10, borderRadius: 6, margin: 0 }}>{testResult}</pre>
        )}
      </div>

      {/* Live Container Monitor */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: '15px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Container size={16} color="var(--brand-secondary)" />
            <span>在线沙箱容器监控</span>
          </h3>
          <button className="btn-secondary" onClick={fetchContainers} style={{ padding: '6px 12px' }}><RefreshCw size={12} />刷新容器</button>
        </div>
        {dockerReachable === false ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>
            未连接 Docker 守护进程（{dockerMsg || '点击上方“检测联通”'}）。配置 Docker 接口端点后即可实时监控并强杀容器。
          </div>
        ) : containers.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>
            {dockerReachable
              ? '当前无运行中的沙箱容器。沙箱采用一次性容器（跑完即销毁，不留残留），仅在技能执行的那几秒内可见；此处为空即代表沙箱空闲。'
              : '点击“检测联通”或“刷新容器”拉取在线沙箱容器列表。'}
          </div>
        ) : (
          <table className="admin-table">
            <thead><tr><th>容器 ID</th><th>名称</th><th>镜像</th><th>状态</th><th style={{ width: 80 }}>操作</th></tr></thead>
            <tbody>
              {containers.map(c => (
                <tr key={c.id}>
                  <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{c.shortId}</td>
                  <td style={{ fontSize: 12 }}>{(c.names || []).join(', ')}</td>
                  <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{c.image}</td>
                  <td><span className={`badge ${c.state === 'running' ? 'badge-green' : 'badge-yellow'}`}>{c.status}</span></td>
                  <td><button className="btn-danger" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => killContainer(c.id)}><Trash2 size={12} />强杀</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Online Client Nodes (heartbeat telemetry) */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: '15px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <HardDrive size={16} color="var(--accent-green)" />
            <span>在线客户端节点与沙箱状态</span>
          </h3>
          <button className="btn-secondary" onClick={fetchClientNodes} style={{ padding: '6px 12px' }}><RefreshCw size={12} />刷新节点</button>
        </div>
        {clientNodes.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>
            暂无客户端上报。启动 Electron 客户端后，它会每 30 秒上报一次沙箱运行状态心跳。
          </div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>客户端节点</th>
                <th>主机名</th>
                <th>当前岗位</th>
                <th>执行平面</th>
                <th>指令数</th>
                <th style={{ width: 90 }}>状态</th>
              </tr>
            </thead>
            <tbody>
              {clientNodes.map(n => (
                <tr key={n.clientId}>
                  <td><div style={{ fontWeight: 600, fontSize: 12 }}>{n.clientId}</div><div style={{ fontSize: 9, color: 'var(--text-muted)' }}>v{n.appVersion}</div></td>
                  <td style={{ fontSize: 12 }}>{n.hostname}</td>
                  <td style={{ fontSize: 12 }}>{n.expertName || '-'}</td>
                  <td><span className="badge badge-purple">{n.sandboxMode}</span></td>
                  <td style={{ fontSize: 12 }}>{n.imCommandCount}</td>
                  <td><span className={`badge ${n.online ? 'badge-green' : 'badge-yellow'}`}>{n.online ? '● 在线' : '○ 离线'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </div>
  )
}
