import { useEffect, useState } from 'react'
import { Monitor, Apple, Download, RefreshCw, Server, Laptop, ShieldCheck, Network, Database, Plug, Box, MessageSquareText, Landmark, Sparkles, Mic, Trash2, Globe } from 'lucide-react'
import heroArt from '../assets/brand/dl-workbench.png'   // 下载页专属主图（AI 工作台+全息分身），与登录页插画区分
import logoMarkDark from '../assets/brand/logo-mark-dark.png'

// 客户端下载：安装包由 nginx 静态伺服（服务器 /opt/iml/frontend/downloads/ → 站点根 /downloads/），
// manifest.json 随安装包在发布时生成，前端只读清单渲染。
// 两种形态：
//   variant="public" —— 员工从登录页进来的**整页暗色 landing**（与登录页同一视觉体系，不鉴权）
//   variant="admin"  —— 管理端「平台设置」里的轻量列表（管理员不需要 marketing，只要版本与文件）
interface DlFile { platform: string; arch: string; file: string; sizeBytes: number }
interface DlProduct { key: string; name: string; version: string; files: DlFile[] }
interface Manifest { updatedAt: string; products: DlProduct[] }
// 旧版清单（单产品扁平结构）归一成 products，老包不重发也能渲染
function normalizeManifest(raw: any): Manifest | null {
  if (!raw) return null
  if (Array.isArray(raw.products)) return raw as Manifest
  if (Array.isArray(raw.files)) {
    return { updatedAt: raw.updatedAt, products: [{ key: 'client', name: 'iML Work 客户端', version: raw.version, files: raw.files }] }
  }
  return null
}

const fmtSize = (b: number) => b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : `${(b / (1 << 20)).toFixed(1)} MB`

// 七大核心能力：与《iML Work 产品介绍》能力①-⑦一一对应，金句原样保留
const FEATURES = [
  { icon: <Network size={18} />, title: '企业本体 · 业务关系一张网', desc: '"数据别给我，照样干活"——平台只存定义，业务实例现查现用、不落库不出网' },
  { icon: <Plug size={18} />, title: '技能三形态 · 有没有接口都能接', desc: '录制回放 / API 直连 / SOP 智能体随时切换，老系统零接口改造先跑起来' },
  { icon: <ShieldCheck size={18} />, title: '安全六红线 · 程序强制不靠自觉', desc: '凭证不出本机、对象绝不虚构、写操作人工确认＋一次性令牌——想闯祸也闯不了' },
  { icon: <Box size={18} />, title: '动态虾池 + 全链路审计', desc: '代码进一次性容器，跑完即毁不碰你电脑；每一步有账，管理端逐条可下钻' },
  { icon: <Landmark size={18} />, title: '私有化交付 · 出网可控', desc: '全内网能跑、无网 Linux 也能部；确需出网只走统一网关，任务先脱敏' },
  { icon: <MessageSquareText size={18} />, title: '授权说人话', desc: '对话只有结论，确认卡写明系统/单据/动作/字段——批的每一笔你都看得懂' },
  { icon: <Database size={18} />, title: '知识活水 · 用出来的知识库', desc: '聊天里说句"记住"就沉淀；个人记忆·岗位 SOP·企业知识库三层，越用越准' },
]

function useManifest() {
  const [mf, setMf] = useState<Manifest | null>(null)
  const [loaded, setLoaded] = useState(false)
  const load = async () => {
    try {
      const r = await fetch('/downloads/manifest.json', { cache: 'no-store' })
      setMf(r.ok ? normalizeManifest(await r.json()) : null)
    } catch { setMf(null) }
    setLoaded(true)
  }
  useEffect(() => { load() }, [])
  return { mf, loaded, load }
}

const platName = (f: DlFile) => `${f.platform === 'mac' ? 'macOS' : 'Windows'}${f.arch ? ` · ${f.arch}` : ''}`

function DownloadCards({ product, updatedAt, dark, urlOf }: { product: DlProduct; updatedAt: string; dark?: boolean; urlOf?: (file: string) => string }) {
  const href = urlOf || ((f: string) => `/downloads/${encodeURIComponent(f)}`)
  return (
    <div className={`dlp-cards ${dark ? 'dark' : ''}`}>
      {product.files.map(f => (
        <div key={f.file} className="dlp-card">
          <div className="dlp-card-ic">{f.platform === 'mac' ? <Apple size={30} /> : <Monitor size={30} />}</div>
          <div className="dlp-card-name">{platName(f)}</div>
          <div className="dlp-card-meta">{fmtSize(f.sizeBytes)} · v{product.version}</div>
          <div className="dlp-card-meta">发布于 {updatedAt}</div>
          <a className="dlp-card-btn" href={href(f.file)} download>
            <Download size={15} /> 下载
          </a>
        </div>
      ))}
    </div>
  )
}

// ── 平台托管安装包 → 下载页产品卡的组装（每产品取最新版本；版本号按数字段比较） ──
interface CliPkg { file: string; product: string; version: string; platform: string; arch: string; sizeBytes: number; updatedAt: number }
const cmpVer = (a: string, b: string) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}
function pkgsToProducts(pkgs: CliPkg[]): { products: DlProduct[]; updatedAt: string } {
  // 托管记录的 product 期望存键（client/fde），但管理端上传是手填文本，历史记录存过显示名——
  // 不归一会让 find(key) 落空、下载卡整块消失（2026-08-14 实锤），显示名一并映射兜底。
  const KEY: Record<string, string> = { 'iML Work 客户端': 'client', 'iML FDE 工作台': 'fde', 'FDE 工作台': 'fde' }
  const byProduct = new Map<string, CliPkg[]>()
  for (const p of pkgs) {
    const k = KEY[p.product] || p.product
    if (!byProduct.has(k)) byProduct.set(k, [])
    byProduct.get(k)!.push(p)
  }
  const NAME: Record<string, string> = { client: 'iML Work 客户端', fde: 'FDE 工作台' }
  const products: DlProduct[] = []
  let latest = 0
  for (const [key, list] of byProduct) {
    const top = list.map(x => x.version).sort(cmpVer).pop()!
    const files = list.filter(x => x.version === top)
    latest = Math.max(latest, ...files.map(f => f.updatedAt))
    products.push({ key, name: NAME[key] || key, version: top, files: files.map(f => ({ platform: f.platform, arch: f.arch, file: f.file, sizeBytes: f.sizeBytes })) })
  }
  return { products, updatedAt: latest ? new Date(latest).toLocaleDateString('zh-CN') : '' }
}

function InstallNote({ dark }: { dark?: boolean }) {
  return (
    <div className={`dlp-note ${dark ? 'dark' : ''}`}>
      <Server size={15} />
      <span>
        安装后在登录页展开「服务器连接设置」，后端地址填
        <code>{window.location.protocol}//{window.location.hostname}:8081</code>。
        <b>macOS 首次启动会被系统拦截</b>（企业内网分发，未公证）：打开
        <b>系统设置 → 隐私与安全</b>，在"已阻止 iML Work"处点<b>「仍要打开」</b>；
        若提示"已损坏"，终端执行 <code>xattr -cr "/Applications/iML Work.app"</code> 后再试。
      </span>
    </div>
  )
}

/** 公开 landing（#downloads，未登录可达） */
export function PublicDownloads() {
  const { mf, loaded } = useManifest()
  // 平台托管安装包优先（资源中心版本管理）；平台无数据回落旧 nginx manifest（兼容既有部署）
  const [cliPkgs, setCliPkgs] = useState<CliPkg[]>([])
  useEffect(() => {
    fetch('/api/v1/resources/client-packages').then(r => r.ok ? r.json() : []).then(setCliPkgs).catch(() => { /* 回落 manifest */ })
  }, [])
  const hosted = cliPkgs.length ? pkgsToProducts(cliPkgs) : null
  const products = hosted?.products || mf?.products || []
  const updatedAt = hosted?.updatedAt || mf?.updatedAt || ''
  const urlOf = hosted ? (f: string) => `/api/v1/resources/client-packages/download?name=${encodeURIComponent(f)}` : undefined
  const client = products.find(p => p.key === 'client')
  const fde = products.find(p => p.key === 'fde')
  // 运行时安装包（本地沙箱前置组件）：资源中心有托管就展示
  const [rtPkgs, setRtPkgs] = useState<RtPkg[]>([])
  useEffect(() => {
    fetch('/api/v1/resources/runtime-packages').then(r => r.ok ? r.json() : []).then(setRtPkgs).catch(() => { /* 无则不显示 */ })
  }, [])
  return (
    <div className="dlp-hero">
      <span className="login-aurora a" /><span className="login-aurora b" />
      <header className="dlp-top">
        <div className="dlp-brand">
          <img src={logoMarkDark} alt="iML" />
          <span>iML Work <em>桌面客户端</em></span>
        </div>
        <a className="dlp-back" href="#" onClick={() => { window.location.hash = '' }}>登录管理台 →</a>
      </header>

      <main className="dlp-main">
        {/* 图在左：全息人形指向右侧的标题与下载区，视线动线顺 */}
        <img className="dlp-art" src={heroArt} alt="" aria-hidden />
        <div className="dlp-pitch">
          <h1>给每个岗位一个<em>真会干活、管得住</em>的数字分身</h1>
          <div className="dlp-chips"><span>读直达</span><span>写确认</span><span>全留痕</span></div>
          <p>它用你本机的登录态替你操作业务系统、记住你在跟进的客户与单据、按你的岗位技能自动办事——凭证与业务数据永远只留在你的电脑上。</p>
          {/* 网页端体验入口：指向本机同名主机的 B/S 宿主（:8046），免安装先试后装 */}
          <a className="dlp-web-try" href={`http://${window.location.hostname}:8046/`} target="_blank" rel="noreferrer">
            <Globe size={16} /> 网页端直接体验<span>免安装 · 浏览器打开即用</span>
          </a>
          {(loaded || hosted) && client && <DownloadCards product={client} updatedAt={updatedAt} dark urlOf={urlOf} />}
          {loaded && !hosted && !client && <div className="dlp-empty"><Laptop size={22} /> 安装包尚未发布，请联系管理员。</div>}
          {client && <InstallNote dark />}
        </div>
      </main>

      {rtPkgs.length > 0 && (
        <section className="dlp-caps">
          <div className="dlp-caps-head">
            <h2>本地沙箱组件 · Docker 运行时</h2>
            <span>可选：在自己电脑上跑安全沙箱（数据不出机、断网可用）需要的运行时；有外网的电脑可在客户端里一键安装，无需下载</span>
          </div>
          <div className="dlp-cards dark">
            {rtPkgs.map(p => (
              <div key={p.path} className="dlp-card">
                <div className="dlp-card-ic"><Box size={30} /></div>
                <div className="dlp-card-name">{p.path}</div>
                <div className="dlp-card-meta">{fmtSize(p.sizeBytes)}</div>
                <a className="dlp-card-btn" href={`/api/v1/resources/runtime-packages/download?name=${encodeURIComponent(p.path)}`} download>
                  <Download size={15} /> 下载
                </a>
              </div>
            ))}
          </div>
        </section>
      )}

      {fde && (
        <section className="dlp-caps">
          <div className="dlp-caps-head">
            <h2>FDE 工作台</h2>
            <span>给实施工程师：接系统 · 本体建模 · 录制技能 · 一段话真跑验证 · 上架到平台</span>
          </div>
          <DownloadCards product={fde} updatedAt={updatedAt} dark urlOf={urlOf} />
        </section>
      )}

      <section className="dlp-caps">
        <div className="dlp-caps-head">
          <h2>七大核心能力</h2>
          <span>"真会干活"说给员工 · "管得住"说给管理者</span>
        </div>
        <div className="dlp-features">
          {FEATURES.map(f => (
            <div key={f.title} className="dlp-feature">
              <span className="dlp-feature-ic">{f.icon}</span>
              <div>
                <b>{f.title}</b>
                <span>{f.desc}</span>
              </div>
            </div>
          ))}
          {/* 期待感收尾：产品在持续生长（画像沉淀、目标一致性闸……都是最近一周长出来的） */}
          <div className="dlp-feature dlp-feature-more">
            <span className="dlp-feature-ic"><Sparkles size={18} /></span>
            <div>
              <b>更多核心能力 · 持续解锁中</b>
              <span>岗位画像自动沉淀、跟进对象越用越懂你……随版本更新陆续上线</span>
            </div>
          </div>
        </div>
      </section>
      <div className="login-footnote">凭证与业务实例数据只留员工本机 · 平台只存 Schema 与审计事件</div>
    </div>
  )
}

// ── 模型资源（按资源版本为单位，不暴露文件明细）──────────────────────────────
// 每个模型版本一张卡：状态 / 大小 / 设备配置要求 / 一键拉取到平台（服务端从公网镜像下载）。
// 无外网的服务器：把模型文件按 HF 目录结构放入 models/stt/ 即可，状态会自动变为已就绪。
interface FetchState { running: boolean; done: number; total: number; currentFile: string; error: string | null }
interface ModelStatus {
  id: string; name: string; desc: string; approxSize: string; requirements: string
  status: 'ready' | 'partial' | 'absent'; hostedBytes: number; fetch: FetchState | null
}

function ModelResources() {
  const [models, setModels] = useState<ModelStatus[]>([])
  const load = async () => {
    try { const r = await fetch('/api/v1/resources/stt-models/catalog'); if (r.ok) setModels(await r.json()) } catch { /* 如实留空 */ }
  }
  useEffect(() => { load() }, [])
  // 有拉取任务在跑时 2s 轮询进度
  const fetching = models.some(m => m.fetch?.running)
  useEffect(() => {
    if (!fetching) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [fetching])

  const pull = async (id: string) => {
    await fetch(`/api/v1/resources/stt-models/fetch?model=${encodeURIComponent(id)}`, { method: 'POST' })
    load()
  }
  const del = async (m: ModelStatus) => {
    if (!confirm(`删除「${m.name}」？客户端将无法再从平台下载该模型。`)) return
    await fetch(`/api/v1/resources/stt-models/model?model=${encodeURIComponent(m.id)}`, { method: 'DELETE' })
    load()
  }

  const badge = (m: ModelStatus) => {
    if (m.fetch?.running) return <span className="res-badge fetching"><RefreshCw size={11} className="spin" /> 拉取中 {m.fetch.done}/{m.fetch.total}</span>
    if (m.status === 'ready') return <span className="res-badge ready">已托管 · {fmtSize(m.hostedBytes)}</span>
    if (m.status === 'partial') return <span className="res-badge partial">不完整</span>
    return <span className="res-badge absent">未托管</span>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="page-header">
        <div className="page-intro">
          客户端「语音输入」的本地模型从这里下发（内网可用）；平台未托管时客户端自动回退公网镜像。
          点「拉取到平台」由服务器直接下载整套文件，无需手动处理文件。
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={load}><RefreshCw size={14} /><span>刷新</span></button>
        </div>
      </div>

      {models.map(m => (
        <div key={m.id} className="glass-panel" style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
          <span className="res-mark">W</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <b style={{ fontSize: 13.5 }}>{m.name}</b>
              {badge(m)}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>{m.desc}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
              {m.approxSize} · 客户端建议配置：{m.requirements}
            </div>
            {m.fetch?.running && m.fetch.currentFile && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'monospace' }}>{m.fetch.currentFile}</div>
            )}
            {m.fetch?.error && (
              <div style={{ fontSize: 11.5, color: '#B45309', marginTop: 4 }}>{m.fetch.error}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {!m.fetch?.running && m.status !== 'ready' && (
              <button className="btn-primary" onClick={() => pull(m.id)}><Download size={14} /><span>拉取到平台</span></button>
            )}
            {!m.fetch?.running && m.status === 'ready' && (
              <button className="btn-secondary res-del" onClick={() => del(m)}><Trash2 size={13} /><span>删除</span></button>
            )}
          </div>
        </div>
      ))}

      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', padding: '0 4px' }}>
        无外网的服务器：把模型文件按 HF 目录结构放入 <code>models/stt/</code>（如
        <code> onnx-community/whisper-base/…</code>），状态会自动变为已托管。
      </div>
    </div>
  )
}

// ── 沙箱镜像（本地沙箱的镜像托管）───────────────────────────────────────────────
// 客户端「安全沙箱 → 本地沙箱」从这里下载镜像 tar 后 docker load；导出=服务端 docker save 当前基础镜像。
interface SbxImageInfo { ready: boolean; fileName: string; sizeBytes: number; updatedAt: number; imageTag: string; exporting: boolean; exportError: string | null }

function SandboxImageCard() {
  const [info, setInfo] = useState<SbxImageInfo | null>(null)
  const load = async () => {
    try { const r = await fetch('/api/v1/resources/sandbox-image/info'); if (r.ok) setInfo(await r.json()) } catch { /* 如实留空 */ }
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!info?.exporting) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [info?.exporting])

  const doExport = async () => {
    await fetch('/api/v1/resources/sandbox-image/export', { method: 'POST' })
    load()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="page-header">
        <div className="page-intro">
          员工客户端的「本地沙箱」从这里下载镜像（与云端执行**完全同一镜像**，行为同构）。
          「导出镜像」会把服务器 Docker 里的沙箱基础镜像打包托管，重建镜像后需重新导出。
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={load}><RefreshCw size={14} /><span>刷新</span></button>
        </div>
      </div>
      <div className="glass-panel" style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <span className="res-mark" style={{ background: '#334155' }}>S</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <b style={{ fontSize: 13.5 }}>{info?.imageTag || '沙箱基础镜像'}</b>
            {info?.exporting ? <span className="res-badge fetching"><RefreshCw size={11} className="spin" /> 导出中</span>
              : info?.ready ? <span className="res-badge ready">已托管 · {fmtSize(info.sizeBytes)}</span>
              : <span className="res-badge absent">未托管</span>}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
            {info?.ready ? `${info.fileName} · 更新于 ${new Date(info.updatedAt).toLocaleString('zh-CN')}` : '导出后员工才能一键安装本地沙箱'}
          </div>
          {info?.exportError && <div style={{ fontSize: 11.5, color: '#B45309', marginTop: 4 }}>{info.exportError}</div>}
        </div>
        {!info?.exporting && (
          <button className="btn-primary" onClick={doExport}><Download size={14} /><span>{info?.ready ? '重新导出' : '导出镜像'}</span></button>
        )}
      </div>
    </div>
  )
}

/** 管理端「资源中心」：客户端安装包 + 模型资源 + 沙箱镜像。 */
export default function ClientDownloads() {
  const [tab, setTab] = useState<'client' | 'models' | 'sandbox'>('client')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className={tab === 'client' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('client')}>
          <Laptop size={14} /><span>客户端资源</span>
        </button>
        <button className={tab === 'models' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('models')}>
          <Mic size={14} /><span>模型资源</span>
        </button>
        <button className={tab === 'sandbox' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('sandbox')}>
          <ShieldCheck size={14} /><span>沙箱镜像</span>
        </button>
      </div>
      {tab === 'client' ? <ClientPackages /> : tab === 'models' ? <ModelResources /> : <SandboxImageCard />}
    </div>
  )
}

// ── 运行时安装包（Docker 运行时 dmg 等）：无外网员工的本地沙箱前置组件，公开下载页同步展示 ──
interface RtPkg { path: string; sizeBytes: number; updatedAt: number }

function RuntimePackages() {
  const [pkgs, setPkgs] = useState<RtPkg[]>([])
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try { const r = await fetch('/api/v1/resources/runtime-packages'); if (r.ok) setPkgs(await r.json()) } catch { /* 如实留空 */ }
  }
  useEffect(() => { load() }, [])
  const upload = async (fl: FileList | null) => {
    if (!fl?.length) return
    setBusy(true)
    const fd = new FormData()
    fd.append('file', fl[0])
    const r = await fetch('/api/v1/resources/runtime-packages', { method: 'POST', body: fd }).catch(() => null)
    setBusy(false)
    if (!r?.ok) alert('上传失败')
    load()
  }
  const del = async (name: string) => {
    if (!confirm(`删除 ${name}？公开下载页将不再提供该安装包。`)) return
    await fetch(`/api/v1/resources/runtime-packages?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
    load()
  }
  return (
    <div className="glass-panel" style={{ padding: '14px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, fontSize: 12.5, color: 'var(--text-secondary)' }}>
          <b style={{ color: 'var(--text-primary)', fontSize: 13.5 }}>运行时安装包</b>
          <span style={{ marginLeft: 8 }}>本地沙箱前置组件（OrbStack / Docker Desktop），无外网员工从公开下载页获取</span>
        </div>
        <label className="btn-secondary" style={{ cursor: 'pointer', flexShrink: 0 }}>
          <Download size={14} /><span>{busy ? '上传中…' : '上传安装包'}</span>
          <input type="file" style={{ display: 'none' }} disabled={busy}
            onChange={e => { upload(e.target.files); e.target.value = '' }} />
        </label>
      </div>
      {pkgs.length > 0 && <div className="rc-divider" />}
      {pkgs.map(p => (
        <div key={p.path} className="rc-row">
          <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.path}</span>
          <span className="rc-muted">{fmtSize(p.sizeBytes)}</span>
          <span className="rc-muted">{new Date(p.updatedAt).toLocaleDateString('zh-CN')}</span>
          <button className="btn-secondary res-del" onClick={() => del(p.path)}><Trash2 size={13} /><span>删除</span></button>
        </div>
      ))}
    </div>
  )
}

/** 客户端安装包：平台托管 + 版本管理（上传打包产物→登记版本；公开下载页从平台 API 读取）。 */
function ClientPackages() {
  const [pkgs, setPkgs] = useState<CliPkg[]>([])
  const [busy, setBusy] = useState(false)
  const [product, setProduct] = useState('client')
  const [version, setVersion] = useState('')
  const [plat, setPlat] = useState('mac-arm64')
  const load = async () => {
    try { const r = await fetch('/api/v1/resources/client-packages'); if (r.ok) setPkgs(await r.json()) } catch { /* 如实留空 */ }
  }
  useEffect(() => { load() }, [])

  const upload = async (fl: FileList | null) => {
    if (!fl?.length) return
    if (!version.trim()) { alert('请先填写版本号（如 1.2.0）'); return }
    setBusy(true)
    const [pf, arch] = plat.split('-')
    const fd = new FormData()
    fd.append('file', fl[0])
    fd.append('product', product)
    fd.append('version', version.trim())
    fd.append('platform', pf)
    fd.append('arch', arch)
    const r = await fetch('/api/v1/resources/client-packages', { method: 'POST', body: fd }).catch(() => null)
    setBusy(false)
    if (!r?.ok) alert('上传失败')
    load()
  }
  const del = async (name: string) => {
    if (!confirm(`删除 ${name}？下载页将不再提供该文件。`)) return
    await fetch(`/api/v1/resources/client-packages?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
    load()
  }

  // 按产品分组、版本倒序；每产品的最高版本标「当前版本」
  const groups = new Map<string, CliPkg[]>()
  for (const p of pkgs) { if (!groups.has(p.product)) groups.set(p.product, []); groups.get(p.product)!.push(p) }
  const PRODUCT_NAME: Record<string, string> = { client: 'iML Work 客户端', fde: 'FDE 工作台' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="glass-panel" style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, fontSize: 12.5, color: 'var(--text-secondary)' }}>
            <b style={{ color: 'var(--text-primary)', fontSize: 13.5 }}>客户端安装包</b>
            <span style={{ marginLeft: 8 }}>
              托管与版本管理；员工从<a href="#downloads" target="_blank" rel="noreferrer" style={{ margin: '0 3px' }}>公开下载页</a>获取最新版本
            </span>
          </div>
          <button className="btn-secondary" style={{ flexShrink: 0 }} onClick={load}><RefreshCw size={14} /><span>刷新</span></button>
        </div>

        {/* 上传行：产品 / 版本 / 平台 + 文件（内嵌浅底区，不再独立成卡） */}
        <div className="rc-upload">
          <select className="form-input" style={{ width: 150 }} value={product} onChange={e => setProduct(e.target.value)}>
            <option value="client">iML Work 客户端</option>
            <option value="fde">FDE 工作台</option>
          </select>
          <input className="form-input" style={{ width: 120 }} placeholder="版本号 1.2.0" value={version} onChange={e => setVersion(e.target.value)} />
          <select className="form-input" style={{ width: 140 }} value={plat} onChange={e => setPlat(e.target.value)}>
            <option value="mac-arm64">macOS · arm64</option>
            <option value="mac-x64">macOS · x64</option>
            <option value="win-x64">Windows · x64</option>
          </select>
          <label className="btn-primary" style={{ cursor: 'pointer' }}>
            <Download size={14} /><span>{busy ? '上传中…' : '上传安装包'}</span>
            <input type="file" style={{ display: 'none' }} disabled={busy}
              onChange={e => { upload(e.target.files); e.target.value = '' }} />
          </label>
        </div>

        {pkgs.length === 0 && (
          <div style={{ padding: '18px 0 6px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 12.5 }}>
            <Laptop size={24} style={{ opacity: 0.4, marginBottom: 4 }} />
            <div>还没有托管安装包——上传打包产物后，下载页会自动展示最新版本。</div>
          </div>
        )}

        {[...groups.entries()].map(([key, list]) => {
          const versions = [...new Set(list.map(x => x.version))].sort(cmpVer).reverse()
          return (
            <div key={key}>
              <div className="rc-divider" />
              <div style={{ fontSize: 13, padding: '2px 0 6px' }}>
                <b>{PRODUCT_NAME[key] || key}</b>
                <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 10 }}>共 {versions.length} 个版本</span>
              </div>
              {versions.map(v => (
                <div key={v} style={{ padding: '4px 0 4px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginBottom: 4 }}>
                    <b>v{v}</b>
                    {v === versions[0] && <span className="res-badge ready">当前版本</span>}
                  </div>
                  {list.filter(x => x.version === v).map(x => (
                    <div key={x.file} className="rc-row" style={{ paddingLeft: 12 }}>
                      <span className="res-badge absent" style={{ flexShrink: 0 }}>{x.platform}{x.arch ? ` · ${x.arch}` : ''}</span>
                      <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.file}</span>
                      <span className="rc-muted">{fmtSize(x.sizeBytes)}</span>
                      <span className="rc-muted">{new Date(x.updatedAt).toLocaleDateString('zh-CN')}</span>
                      <button className="btn-secondary res-del" onClick={() => del(x.file)}><Trash2 size={13} /><span>删除</span></button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )
        })}
      </div>

      <RuntimePackages />
    </div>
  )
}
