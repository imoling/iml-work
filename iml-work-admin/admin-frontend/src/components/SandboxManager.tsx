import Switch from './Switch'
import { useState, useEffect } from 'react'
import { ShieldCheck, HardDrive, RefreshCw, Boxes, Plug, Save, Trash2, Container, Play, Activity, FileScan, Server } from 'lucide-react'
import DoclingManager from './DoclingManager'
import { useAuth } from '../auth'
import { Permissions as P } from '../permissions'

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
  role?: string     // 基础服务的人话角色：文档引擎 / 向量模型（虾池容器没有）
}

// 沙箱执行审计：一次性容器"创建→执行→销毁"留痕（后端 /exec/history）
interface ExecAudit {
  id: number; createdAt: string; source?: string; containerId: string; image: string
  packages: string; durationMs: number; success: boolean; networkIsolated: boolean
  status: string; fileCount: number; fileNames: string
  codePreview?: string; stdoutPreview?: string; stderrPreview?: string
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

// 常驻基础服务的说明。运维只关心两件事：**它是干什么的**、**挂了会怎样**。
const BASE_SERVICE_META = [
  {
    container: 'iml-docling-serve',
    title: '文档引擎 · 文档解析',
    desc: 'PDF / Word / Excel / PPT / 图片 → 结构化文本。知识入库的第一道，服务端解析，员工终端不吃算力。',
    port: ':5001',
    downImpact: '离线时二进制文档无法入库（txt/md 仍可直入）',
  },
  {
    container: 'iml-embedding',
    title: '向量模型 · 语义检索',
    desc: 'bge-m3（1024 维，中文检索强，完全离线）。把文档切块与用户提问都转成语义向量，pgvector 据此召回。',
    port: ':11434',
    downImpact: '检索直接失效——知识库形同虚设',
  },
  {
    container: 'iml-searxng',
    title: '聚合检索 · SearXNG',
    desc: '企业自托管聚合搜索（免密钥，baidu/bing 多引擎）。分身联网备料/问答检索经后端 /api/v1/search 代理走它，检索词与结果都不出企业侧。',
    port: ':8890',
    downImpact: '联网检索退化为客户端浏览器兜底（易被搜索引擎反爬限流）',
  },
]

export default function SandboxManager() {
  // 安全沙箱 = 企业隔离执行平面：动态虾池（代码执行）＋ 文档引擎（文档解析）。页签按权限显示。
  const { has } = useAuth()
  const canPool = has(P.SANDBOX_MANAGE)
  const canDoc = has(P.DOCLING_MANAGE)
  const [pane, setPane] = useState<'pool' | 'docengine'>(canPool ? 'pool' : 'docengine')
  // 检索通道配置（聚合检索服务卡用）：容器在跑 ≠ 通道启用，两个状态都要报
  const [searchProv, setSearchProv] = useState<{ provider?: string; endpoint?: string } | null>(null)
  const fetchSearchCfg = async () => { try { const r = await fetch('/api/v1/search-config'); if (r.ok) setSearchProv(await r.json()) } catch { /* 不可达时卡片如实显示 — */ } }
  // 向量模型真探测：真发一次向量请求（容器活着 ≠ 模型在——模型没拉时后端拒答，检索直接失效）。
  // 探测是真实推理、可能秒级耗时，只在进页时探一次 + 手动重测，不进 30s 轮询。
  const [embStatus, setEmbStatus] = useState<any>(null)
  const [embProbing, setEmbProbing] = useState(false)
  const probeEmbedding = async () => {
    setEmbProbing(true)
    try { const r = await fetch('/api/v1/knowledge/embedding/health'); setEmbStatus(r.ok ? await r.json() : null) }
    catch { setEmbStatus(null) }
    setEmbProbing(false)
  }
  // ⚠️ dockerEndpoint 初始留空、等后端配置回填：绝不在前端写死默认地址。
  // 曾写死 'unix:///var/run/docker.sock'，页面一挂载就拿它去拉容器（此时真配置还没取回来），
  // 而本机 docker 走 colima、那个路径压根不存在 → 每次进页面都先闪一次「无法连接 Docker 守护进程」。
  const [config, setConfig] = useState<SandboxConfig>({
    mode: 'docker', dockerEndpoint: '', baseImage: 'python:3.12-slim',
    cpuQuota: 1, memoryQuotaMb: 512, timeoutSeconds: 120, networkIsolation: true
  })
  const [containers, setContainers] = useState<DockerContainer[]>([])
  const [services, setServices] = useState<DockerContainer[]>([])   // 常驻基础服务（文档引擎 / 向量模型），与一次性虾池容器分开
  const [dockerReachable, setDockerReachable] = useState<boolean | null>(null)
  const [dockerMsg, setDockerMsg] = useState('')
  const [clientNodes, setClientNodes] = useState<ClientNode[]>([])
  const [execStatus, setExecStatus] = useState<ExecStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string>('')
  const [history, setHistory] = useState<ExecAudit[]>([])

  // 沙箱执行历史：一次性容器跑完即毁、在线监控看不到，从审计表回溯
  const fetchHistory = async () => {
    try { const res = await fetch('/api/v1/sandbox/exec/history?limit=50'); if (res.ok) setHistory(await res.json()) } catch (err) { console.error(err) }
  }

  // 聚合检索真查验证：走后端 /api/v1/search 代理——与客户端联网备料同一条链路，不是 mock
  const [searxTesting, setSearxTesting] = useState(false)
  const [searxResult, setSearxResult] = useState('')
  const testSearxng = async () => {
    setSearxTesting(true); setSearxResult('')
    try {
      const t0 = Date.now()
      const r = await fetch('/api/v1/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '上证指数 今日行情', maxResults: 3 })
      })
      const d = await r.json()
      const n = (d.results || []).length
      if (d.provider === 'NONE') setSearxResult('⚠️ 检索配置未指向任何服务商——到「检索配置」选 SearXNG 并填服务地址')
      else if (n) setSearxResult(`✅ ${d.provider} · ${n} 条 · ${Date.now() - t0}ms · 首条「${String(d.results[0].title || '').slice(0, 22)}…」`)
      else setSearxResult(`⚠️ ${d.provider} 返回 0 条——检查容器状态与 settings.yml 引擎启用`)
    } catch (e: any) { setSearxResult('❌ 检索失败：' + (e?.message || e)) }
    setSearxTesting(false)
  }

  const fetchClientNodes = async () => {
    try {
      const res = await fetch('/api/v1/clients')
      if (res.ok) setClientNodes(await res.json())
    } catch (err) { console.error(err) }
  }

  // 清理离线节点：删除已离线的陈旧节点（在线的不动；被删节点重连会重新注册）
  const pruneOfflineNodes = async () => {
    const offline = clientNodes.filter(n => !n.online).length
    if (!offline) return alert('当前没有离线节点可清理。')
    if (!confirm(`清理 ${offline} 个离线节点？在线节点不受影响，被清节点若客户端重连会重新注册。`)) return
    try {
      const res = await fetch('/api/v1/clients/offline', { method: 'DELETE' })
      const d = await res.json()
      alert(`已清理 ${d.removed ?? 0} 个离线节点。`)
      fetchClientNodes()
    } catch (err: any) { alert('清理失败：' + (err?.message || err)) }
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
    setTesting(true); setTestResult('正在虾池内执行自检脚本…')
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
      fetchHistory()
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

  // 不传 endpoint：地址的单一来源在后端（库里的沙箱配置）。前端再传一份 = 多一份会漂移的真值。
  const fetchContainers = async () => {
    const res = await fetch('/api/v1/sandbox/containers')
    if (res.ok) {
      const data = await res.json()
      setDockerReachable(!!data.reachable)
      setContainers(data.containers || [])       // 虾池容器（一次性，跑完即焚）
      setServices(data.services || [])           // 常驻基础服务（文档引擎 / 向量模型）
      if (!data.reachable) setDockerMsg(data.message || '')
    }
  }

  const killContainer = async (id: string) => {
    if (!confirm('确认强制终止该容器？')) return
    const res = await fetch(`/api/v1/sandbox/containers/${id}`, { method: 'DELETE' })
    const data = await res.json()
    alert(data.message)
    fetchContainers()
  }

  useEffect(() => {
    fetchConfig()
    fetchExecStatus()
    fetchClientNodes()
    fetchHistory()
    fetchSearchCfg()
    probeEmbedding()
    const t = setInterval(() => { fetchClientNodes(); fetchExecStatus(); fetchHistory(); fetchSearchCfg() }, 30000)
    return () => clearInterval(t)
  }, [])

  // 容器列表：首屏就拉、并随配置里的 Docker 端点变化重拉。
  // 以前只有手动点「刷新容器」才拉 —— 进页面永远是空的，用户以为"没容器"。
  // 虾池是一次性容器（跑完即焚），10s 一刷才追得上；基础服务常驻，顺带刷新。
  useEffect(() => {
    fetchContainers()
    const t = setInterval(fetchContainers, 10000)
    return () => clearInterval(t)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* 顶部统计条已移除（信息与下方区块重复，用户拍板）：虾池就绪度在配置面板、
          文档引擎详情在其页签、检索通道并入下方聚合检索服务卡、节点数看消费节点区块。 */}

      {/* 页签：动态虾池（代码执行沙箱）｜文档引擎（文档解析） */}
      <div style={{ display: 'flex', gap: 8 }}>
        {canPool && <button className={pane === 'pool' ? 'btn-primary' : 'btn-secondary'} onClick={() => setPane('pool')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ShieldCheck size={14} />动态虾池 · 代码执行</button>}
        {canDoc && <button className={pane === 'docengine' ? 'btn-primary' : 'btn-secondary'} onClick={() => setPane('docengine')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FileScan size={14} />文档引擎 · 文档解析</button>}
      </div>

      {pane === 'docengine' && canDoc && <DoclingManager />}

      {pane === 'pool' && canPool && <>

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
          <Switch checked={config.networkIsolation} onChange={v => setConfig({ ...config, networkIsolation: v })} onText="网络隔离已启用" offText="网络隔离已关闭" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {dockerReachable !== null && (
              <span style={{ fontSize: 11, color: dockerReachable ? 'var(--accent-green)' : 'var(--accent-red, #f87171)' }}>{dockerMsg}</span>
            )}
            <button className="btn-primary" onClick={saveConfig}><Save size={14} />保存配置</button>
          </div>
        </div>

      </div>

      {/* ② 执行自检（独立卡，对应文档引擎「解析自检」）：镜像就绪状态 + 一键测试整条执行链路 */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={16} color="var(--accent-green)" />
            <span>执行自检</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>在代码沙箱中运行一段最小脚本，验证「装包 → 执行 → 产物回传」链路是否健康</span>
          </h3>
          <button className="btn-secondary" onClick={testExec} disabled={testing} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Play size={14} />{testing ? '执行中…' : '测试执行'}</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldCheck size={14} color={execStatus?.reachable ? 'var(--accent-green)' : 'var(--text-muted)'} />
          {execStatus
            ? (execStatus.reachable
                ? <span>虾池可达 · 基础镜像 <b>{execStatus.image}</b> {execStatus.imageReady ? '已就绪' : '未就绪（首次执行将自动拉取）'}</span>
                : <span style={{ color: 'var(--accent-red, #f87171)' }}>虾池不可达：{execStatus.error || '检查 Docker 端点'}</span>)
            : <span>正在探测虾池状态…</span>}
        </div>
        {testResult && (
          <pre style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, whiteSpace: 'pre-wrap', background: 'var(--bg-subtle)', border: '1px solid var(--border-color)', padding: 10, borderRadius: 6, margin: 0 }}>{testResult}</pre>
        )}
      </div>

      {/* 常驻基础服务：文档引擎 + 向量模型。
          它们**不是虾池**（虾池是一次性容器，跑完即焚），此前却混在「虾池容器监控」里，
          还配着「强杀」按钮 —— 一点就把知识库检索/文档入库整体干掉。现在单独成卡，且不给强杀。 */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Server size={16} color="var(--accent-purple)" />
            <span>常驻基础服务</span>
            <span style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--text-muted)' }}>
              知识库依赖它们；起停走 <code style={{ fontSize: 11 }}>scripts/docker-services.sh up|down</code>
            </span>
          </h3>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
          {BASE_SERVICE_META.map(m => {
            const c = services.find(x => (x.names || []).some(n => n.replace(/^\//, '') === m.container))
            const up = c?.state === 'running'
            return (
              <div key={m.container} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '12px 14px', background: 'var(--bg-subtle)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: up ? 'var(--accent-green)' : 'var(--accent-red)' }} />
                  <b style={{ fontSize: 13.5 }}>{m.title}</b>
                  <span className={`badge ${up ? 'badge-green' : 'badge-red'}`} style={{ marginLeft: 'auto' }}>
                    {up ? c?.status : '未运行'}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{m.desc}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <span>{m.port}</span>
                  {!up && <span style={{ color: 'var(--accent-red)' }}>⚠️ {m.downImpact}</span>}
                </div>
                {m.container === 'iml-searxng' && (
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {/* 容器在跑 ≠ 通道启用：检索配置没指过来时分身仍走浏览器兜底，必须黄牌点破 */}
                    <span style={{ fontSize: 11, color: searchProv?.provider === 'SEARXNG' ? 'var(--accent-green)' : 'var(--accent-yellow, #f59e0b)' }}>
                      {searchProv?.provider === 'SEARXNG' ? '✅ 检索通道已启用' : `⚠ 检索通道当前为 ${searchProv?.provider || '—'}，未指向 SearXNG`}
                    </span>
                    <button className="btn-secondary" style={{ fontSize: 11, padding: '3px 10px' }} disabled={searxTesting} onClick={testSearxng}>
                      {searxTesting ? '检索中…' : '真查一次'}
                    </button>
                    {searxResult && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{searxResult}</span>}
                  </div>
                )}
                {m.container === 'iml-embedding' && (
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {/* 最阴险的故障态：容器在跑但模型没拉——端口通、页面绿，检索却已失效。真发一次向量请求才算数 */}
                    {embStatus == null
                      ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>模型探测未返回</span>
                      : embStatus.ok
                        ? <span style={{ fontSize: 11, color: 'var(--accent-green)' }}>✅ 模型就绪 · {embStatus.model} · {embStatus.actualDimension || embStatus.dimension} 维</span>
                        : <span style={{ fontSize: 11, color: 'var(--accent-red, #f87171)' }}>⚠ {embStatus.error || embStatus.mode || '模型不可用'}——容器在跑 ≠ 可用，检索已受影响</span>}
                    <button className="btn-secondary" style={{ fontSize: 11, padding: '3px 10px' }} disabled={embProbing} onClick={probeEmbedding}>
                      {embProbing ? '探测中…' : '重测'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Live Container Monitor */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: '15px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Container size={16} color="var(--brand-secondary)" />
            <span>虾池容器监控</span>
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
              ? '当前无运行中的容器。动态虾池采用一次性容器（跑完即销毁，不留残留），仅在任务执行的那几秒内可见；此处为空即代表虾池空闲。'
              : '点击“检测联通”或“刷新容器”拉取虾池在跑容器列表。'}
          </div>
        ) : (
          <table className="admin-table">
            {/* 镜像列去掉：虾池容器全是同一个基础镜像（iml-sandbox:py312，配置里已写明），
                每行重复一遍纯属噪声，还挤掉了真正要看的东西。 */}
            <thead><tr><th style={{ width: 130 }}>容器 ID</th><th>名称</th><th>状态</th><th style={{ width: 56 }}></th></tr></thead>
            <tbody>
              {containers.map(c => (
                <tr key={c.id}>
                  <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{c.shortId}</td>
                  <td style={{ fontSize: 12 }}>{(c.names || []).map(n => n.replace(/^\//, '')).join(', ')}</td>
                  <td><span className={`badge ${c.state === 'running' ? 'badge-green' : 'badge-yellow'}`}>{c.status}</span></td>
                  {/* 操作：纯图标、不换行。原来「🗑 强杀」带文字，在窄列里被挤到第二行。 */}
                  <td>
                    <div className="kb-row-actions">
                      <button className="icon-btn danger" title="强制终止该虾池容器" onClick={() => killContainer(c.id)}><Trash2 size={13} /></button>
                    </div>
                  </td>
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
            <span>在线消费节点</span>
          </h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" onClick={pruneOfflineNodes} style={{ padding: '6px 12px' }} title="删除已离线的陈旧节点（在线的不动，重连会重新注册）"><Trash2 size={12} />清理离线</button>
            <button className="btn-secondary" onClick={fetchClientNodes} style={{ padding: '6px 12px' }}><RefreshCw size={12} />刷新节点</button>
          </div>
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
      </div>      {/* 沙箱执行历史：一次性容器"创建→执行→销毁"留痕（在线监控看不到历史，从审计表回溯） */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: '15px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Activity size={16} color="var(--brand-primary)" />
            <span>虾池执行历史</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>一次性容器跑完即毁，此处留痕回溯（最近 50 条）</span>
          </h3>
          <button className="btn-secondary" onClick={fetchHistory} style={{ padding: '6px 12px' }}><RefreshCw size={12} />刷新历史</button>
        </div>
        {history.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>
            暂无执行记录。每次代码执行型任务（或上方「测试执行」）跑完，虾池都会留一条「创建→执行→销毁」审计。
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="admin-table">
              <thead><tr>
                <th>时间</th><th>结果</th><th>耗时</th><th>镜像</th><th>网络</th><th>产物</th><th>容器</th>
              </tr></thead>
              <tbody>
                {history.map(h => (
                  <tr key={h.id} title={[h.codePreview && `代码：${h.codePreview}`, h.stdoutPreview && `输出：${h.stdoutPreview}`, h.stderrPreview && `错误：${h.stderrPreview}`].filter(Boolean).join('\n\n')}>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{(h.createdAt || '').replace('T', ' ').slice(0, 19)}</td>
                    <td><span className={`badge ${h.success ? 'badge-green' : 'badge-red'}`}>{h.success ? '成功' : (h.status || '失败')}</span></td>
                    <td style={{ fontSize: 12 }}>{h.durationMs >= 1000 ? (h.durationMs / 1000).toFixed(1) + 's' : h.durationMs + 'ms'}</td>
                    <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{h.image}</td>
                    <td><span className={`badge ${h.networkIsolated ? 'badge-purple' : 'badge-yellow'}`}>{h.networkIsolated ? '隔离' : '联网'}</span></td>
                    <td style={{ fontSize: 11 }} title={h.fileNames}>{h.fileCount > 0 ? `${h.fileCount} 个` : '—'}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)' }}>{h.containerId || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>


      </>}

    </div>
  )
}
