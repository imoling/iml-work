import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Activity, Cpu, MemoryStick, Database, RefreshCw, Server,
  Zap, HardDrive, Timer, Boxes, ShieldCheck, FileText, MonitorSmartphone
} from 'lucide-react'

// ===== 运行监控：系统健康维度（JVM / HTTP / 连接池 / 依赖服务）=====
// 数据来自 /api/v1/monitor/overview（Micrometer 聚合）；与「运行总览」（业务任务维度）互补。
// QPS 无法由累计值直接得出：前端保留上一次采样，两次差分算出区间 QPS。

interface Jvm {
  uptimeMs: number; heapUsed: number; heapMax: number; nonHeapUsed: number
  threadCount: number; threadPeak: number; virtualThreads: boolean; processors: number
  processCpu: number; systemCpu: number; gcCount: number; gcTimeMs: number
  diskUsable: number; diskTotal: number
}
interface Http { totalRequests: number; errors5xx: number; avgLatencyMs: number; maxLatencyMs: number }
interface Db { ok: boolean; pingMs?: number; error?: string; poolActive: number; poolIdle: number; poolPending: number; poolMax: number }
interface Overview { jvm: Jvm; http: Http; db: Db; deps: Record<string, any> }

const fmtBytes = (n: number) => {
  if (!n || n < 0) return '—'
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + ' GB'
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(0) + ' MB'
  return (n / 1024).toFixed(0) + ' KB'
}
const fmtUptime = (ms: number) => {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}天${h}时` : h > 0 ? `${h}时${m}分` : `${m}分${s % 60}秒`
}
const pctOf = (v: number) => (v < 0 ? '采集中' : (v * 100).toFixed(0) + '%')

function Bar({ ratio, color }: { ratio: number; color: string }) {
  const w = Math.max(0, Math.min(100, ratio * 100))
  return (
    <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-tertiary, rgba(127,127,127,.15))', overflow: 'hidden', marginTop: 8 }}>
      <div style={{ width: `${w}%`, height: '100%', borderRadius: 3, background: color, transition: 'width .5s' }} />
    </div>
  )
}

function Stat({ icon, label, value, sub, bar }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: React.ReactNode; bar?: React.ReactNode }) {
  return (
    <div className="glass-panel" style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent-green, #16a34a)' }}>
        {icon}<span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>{value}</div>
      {bar}
      {sub && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function Dot({ ok }: { ok: boolean }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: ok ? 'var(--accent-green, #16a34a)' : 'var(--accent-red, #dc2626)', marginRight: 6 }} />
}

function DepRow({ icon, name, ok, detail }: { icon: React.ReactNode; name: string; ok: boolean; detail: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--border-color, rgba(127,127,127,.12))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>{icon}<span>{name}</span></div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}><Dot ok={ok} />{detail}</div>
    </div>
  )
}

export default function RuntimeMonitor() {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')
  const [qps, setQps] = useState<number | null>(null)
  const prev = useRef<{ t: number; total: number } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/monitor/overview')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const d: Overview = await res.json()
      const now = Date.now()
      if (prev.current && d.http.totalRequests >= prev.current.total) {
        const dt = (now - prev.current.t) / 1000
        if (dt > 0) setQps(Math.round((d.http.totalRequests - prev.current.total) / dt * 10) / 10)
      }
      prev.current = { t: now, total: d.http.totalRequests }
      setData(d); setError('')
    } catch (e: any) {
      setError(e.message || String(e))
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  if (error && !data) return <div className="glass-panel" style={{ color: 'var(--accent-red)' }}>运行监控加载失败：{error}　<button className="btn-secondary" onClick={load}>重试</button></div>
  if (!data) return <div className="glass-panel" style={{ color: 'var(--text-secondary)' }}>指标采集中…</div>

  const { jvm, http, db, deps } = data
  const heapRatio = jvm.heapMax > 0 ? jvm.heapUsed / jvm.heapMax : 0
  const diskRatio = jvm.diskTotal > 0 ? 1 - jvm.diskUsable / jvm.diskTotal : 0
  const poolRatio = db.poolMax > 0 ? Math.max(db.poolActive, 0) / db.poolMax : 0
  const docker = deps.sandboxDocker || {}
  const docling = deps.docling || {}
  const gateway = deps.modelGateway || {}
  const clients = deps.clients || {}
  const gwHealthy = (gateway.enabled ?? 0) === 0 || (gateway.healthy ?? 0) > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 顶部状态条 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
          <Dot ok={true} />后端服务在线 · 已运行 {fmtUptime(jvm.uptimeMs)}
          <span className="btn-secondary" style={{ padding: '2px 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Zap size={11} />虚拟线程 {jvm.virtualThreads ? '已开启' : '未开启'}
          </span>
          {error && <span style={{ color: 'var(--accent-red)' }}>本次刷新失败：{error}（显示上次数据）</span>}
        </div>
        <button className="btn-secondary" onClick={load} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><RefreshCw size={13} />刷新（每 5s 自动）</button>
      </div>

      {/* 核心指标卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        <Stat icon={<Cpu size={15} />} label={`进程 CPU（${jvm.processors} 核）`} value={pctOf(jvm.processCpu)} sub={`系统 ${pctOf(jvm.systemCpu)}`}
          bar={<Bar ratio={Math.max(jvm.processCpu, 0)} color={jvm.processCpu > 0.8 ? 'var(--accent-red, #dc2626)' : 'var(--accent-green, #16a34a)'} />} />
        <Stat icon={<MemoryStick size={15} />} label="JVM 堆内存" value={fmtBytes(jvm.heapUsed)} sub={`上限 ${fmtBytes(jvm.heapMax)} · 非堆 ${fmtBytes(jvm.nonHeapUsed)} · GC ${jvm.gcCount} 次`}
          bar={<Bar ratio={heapRatio} color={heapRatio > 0.85 ? 'var(--accent-red, #dc2626)' : 'var(--accent-green, #16a34a)'} />} />
        <Stat icon={<Activity size={15} />} label="QPS（5s 差分）" value={qps == null ? '…' : qps} sub={`累计请求 ${http.totalRequests} · 5xx ${http.errors5xx}`} />
        <Stat icon={<Timer size={15} />} label="平均延迟" value={`${http.avgLatencyMs} ms`} sub={`峰值 ${http.maxLatencyMs} ms（自启动累计）`} />
        <Stat icon={<Server size={15} />} label="线程" value={jvm.threadCount} sub={`峰值 ${jvm.threadPeak}`} />
        <Stat icon={<HardDrive size={15} />} label="磁盘（数据目录）" value={fmtBytes(jvm.diskUsable) + ' 可用'} sub={`共 ${fmtBytes(jvm.diskTotal)}`}
          bar={<Bar ratio={diskRatio} color={diskRatio > 0.85 ? 'var(--accent-red, #dc2626)' : 'var(--accent-green, #16a34a)'} />} />
      </div>

      {/* 数据库 + 依赖健康 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
        <div className="glass-panel" style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Database size={15} /><b style={{ fontSize: 13 }}>数据库 · 连接池</b>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 'auto' }}>
              <Dot ok={db.ok} />{db.ok ? `PostgreSQL 可达 · ${db.pingMs} ms` : `不可达：${db.error || ''}`}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
            活跃 {db.poolActive < 0 ? '—' : db.poolActive} / 上限 {db.poolMax < 0 ? '—' : db.poolMax}
            　空闲 {db.poolIdle < 0 ? '—' : db.poolIdle}
            　等待 <span style={{ color: db.poolPending > 0 ? 'var(--accent-red)' : 'inherit' }}>{db.poolPending < 0 ? '—' : db.poolPending}</span>
          </div>
          <Bar ratio={poolRatio} color={poolRatio > 0.8 ? 'var(--accent-red, #dc2626)' : 'var(--accent-green, #16a34a)'} />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>连接池持续打满或「等待」&gt;0 时，调大 DB_POOL_MAX（并同步 PG max_connections）。</div>
        </div>

        <div className="glass-panel" style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            <Activity size={15} /><b style={{ fontSize: 13 }}>依赖服务健康</b>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>每 10s 探测</span>
          </div>
          <DepRow icon={<ShieldCheck size={14} />} name="沙箱 Docker" ok={!!docker.reachable}
            detail={docker.reachable ? `daemon ${docker.version || ''} 可达` : (docker.message || docker.error || '不可达')} />
          <DepRow icon={<FileText size={14} />} name="文档解析 docling" ok={!!docling.healthy}
            detail={docling.healthy ? `在线 · ${docling.latencyMs} ms` : (docling.error || '离线（降级基础解析）')} />
          <DepRow icon={<Boxes size={14} />} name="模型网关" ok={gwHealthy}
            detail={`启用 ${gateway.enabled ?? '—'} · 健康 ${gateway.healthy ?? '—'} · 异常 ${gateway.down ?? '—'}`} />
          <DepRow icon={<MonitorSmartphone size={14} />} name="客户端节点" ok={true}
            detail={`在线 ${clients.online ?? 0} / 共 ${clients.total ?? 0}`} />
        </div>
      </div>
    </div>
  )
}
