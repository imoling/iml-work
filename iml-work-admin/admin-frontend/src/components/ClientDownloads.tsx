import { useEffect, useState } from 'react'
import { Monitor, Apple, Download, RefreshCw, Server, Laptop, ShieldCheck, Network, Database, Plug, Box, MessageSquareText, Landmark, Sparkles } from 'lucide-react'
import heroArt from '../assets/brand/dl-workbench.png'   // 下载页专属主图（AI 工作台+全息分身），与登录页插画区分
import logoMarkDark from '../assets/brand/logo-mark-dark.png'

// 客户端下载：安装包由 nginx 静态伺服（服务器 /opt/iml/frontend/downloads/ → 站点根 /downloads/），
// manifest.json 随安装包在发布时生成，前端只读清单渲染。
// 两种形态：
//   variant="public" —— 员工从登录页进来的**整页暗色 landing**（与登录页同一视觉体系，不鉴权）
//   variant="admin"  —— 管理端「平台设置」里的轻量列表（管理员不需要 marketing，只要版本与文件）
interface DlFile { platform: string; arch: string; file: string; sizeBytes: number }
interface Manifest { version: string; updatedAt: string; files: DlFile[] }

const fmtSize = (b: number) => b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : `${(b / (1 << 20)).toFixed(1)} MB`

// 七大核心能力：与《iML Work 产品介绍》能力①-⑦一一对应，金句原样保留
const FEATURES = [
  { n: '01', icon: <Network size={18} />, title: '企业本体 · 业务关系一张网', desc: '"数据别给我，照样干活"——平台只存定义，业务实例现查现用、不落库不出网' },
  { n: '02', icon: <Plug size={18} />, title: '技能三形态 · 有没有接口都能接', desc: '录制回放 / API 直连 / SOP 智能体随时切换，老系统零接口改造先跑起来' },
  { n: '03', icon: <ShieldCheck size={18} />, title: '安全六红线 · 程序强制不靠自觉', desc: '凭证不出本机、对象绝不虚构、写操作人工确认＋一次性令牌——想闯祸也闯不了' },
  { n: '04', icon: <Box size={18} />, title: '动态虾池 + 全链路审计', desc: '代码进一次性容器，跑完即毁不碰你电脑；每一步有账，管理端逐条可下钻' },
  { n: '05', icon: <Landmark size={18} />, title: '私有化交付 · 出网可控', desc: '全内网能跑、无网 Linux 也能部；确需出网只走统一网关，任务先脱敏' },
  { n: '06', icon: <MessageSquareText size={18} />, title: '授权说人话', desc: '对话只有结论，确认卡写明系统/单据/动作/字段——批的每一笔你都看得懂' },
  { n: '07', icon: <Database size={18} />, title: '知识活水 · 用出来的知识库', desc: '聊天里说句"记住"就沉淀；个人记忆·岗位 SOP·企业知识库三层，越用越准' },
]

function useManifest() {
  const [mf, setMf] = useState<Manifest | null>(null)
  const [loaded, setLoaded] = useState(false)
  const load = async () => {
    try {
      const r = await fetch('/downloads/manifest.json', { cache: 'no-store' })
      setMf(r.ok ? await r.json() : null)
    } catch { setMf(null) }
    setLoaded(true)
  }
  useEffect(() => { load() }, [])
  return { mf, loaded, load }
}

const platName = (f: DlFile) => `${f.platform === 'mac' ? 'macOS' : 'Windows'}${f.arch ? ` · ${f.arch}` : ''}`

function DownloadCards({ mf, dark }: { mf: Manifest; dark?: boolean }) {
  return (
    <div className={`dlp-cards ${dark ? 'dark' : ''}`}>
      {mf.files.map(f => (
        <div key={f.file} className="dlp-card">
          <div className="dlp-card-ic">{f.platform === 'mac' ? <Apple size={30} /> : <Monitor size={30} />}</div>
          <div className="dlp-card-name">{platName(f)}</div>
          <div className="dlp-card-meta">{fmtSize(f.sizeBytes)} · v{mf.version}</div>
          <div className="dlp-card-meta">发布于 {mf.updatedAt}</div>
          <a className="dlp-card-btn" href={`/downloads/${encodeURIComponent(f.file)}`} download>
            <Download size={15} /> 下载
          </a>
        </div>
      ))}
    </div>
  )
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
          {loaded && mf && <DownloadCards mf={mf} dark />}
          {loaded && !mf && <div className="dlp-empty"><Laptop size={22} /> 安装包尚未发布，请联系管理员。</div>}
          {mf && <InstallNote dark />}
        </div>
      </main>

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
                <b><i className="dlp-feature-n">{f.n}</i>{f.title}</b>
                <span>{f.desc}</span>
              </div>
            </div>
          ))}
          {/* 期待感收尾：产品在持续生长（画像沉淀、目标一致性闸……都是最近一周长出来的） */}
          <div className="dlp-feature dlp-feature-more">
            <span className="dlp-feature-ic"><Sparkles size={18} /></span>
            <div>
              <b><i className="dlp-feature-n">08+</i>更多核心能力 · 持续解锁中</b>
              <span>岗位画像自动沉淀、跟进对象越用越懂你……随版本更新陆续上线</span>
            </div>
          </div>
        </div>
      </section>
      <div className="login-footnote">凭证与业务实例数据只留员工本机 · 平台只存 Schema 与审计事件</div>
    </div>
  )
}

/** 管理端 tab 内的轻量版 */
export default function ClientDownloads() {
  const { mf, loaded, load } = useManifest()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="page-header">
        <div className="page-intro">
          安装包由 nginx 静态伺服（<code>/opt/iml/frontend/downloads/</code>）；员工可不登录直接访问
          <a href="#downloads" target="_blank" rel="noreferrer" style={{ margin: '0 4px' }}>下载页</a>。
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={load}><RefreshCw size={14} /><span>刷新</span></button>
        </div>
      </div>
      {loaded && !mf && (
        <div className="glass-panel" style={{ padding: 26, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
          <Laptop size={28} style={{ opacity: 0.4, marginBottom: 6 }} />
          <div>尚未发布安装包。发布：把产物与 manifest.json 放到服务器 <code>/opt/iml/frontend/downloads/</code>。</div>
        </div>
      )}
      {mf && (
        <>
          <div className="glass-panel" style={{ padding: '10px 16px', fontSize: 13 }}>
            当前版本 <b>v{mf.version}</b><span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 10 }}>发布于 {mf.updatedAt}</span>
          </div>
          <DownloadCards mf={mf} />
          <InstallNote />
        </>
      )}
    </div>
  )
}
