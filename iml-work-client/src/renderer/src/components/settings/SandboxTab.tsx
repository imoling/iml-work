// 设置 · 安全沙箱管理（从「企业系统连接」拆出，2026-08-01 用户拍板）：
// 代码执行位置切换（云端/本地）+ 云端沙箱状态 + 本地沙箱（Docker 检测、镜像从资源中心一键下载安装）。
// 本地与云端跑同一镜像，执行语义同构；本地不可用时执行自动回落云端。
import { useEffect, useRef, useState } from 'react'
import { Cloud, Laptop, ShieldCheck, Loader2, Check, Download, RefreshCw } from 'lucide-react'
import { swallowUi } from '../../lib/ui-util'

interface LocalStatus {
  mode: 'cloud' | 'local'
  dockerOk: boolean
  dockerVersion: string
  brewOk: boolean
  imageReady: boolean
  imageTag: string
  platformImage: { ready: boolean; sizeBytes: number; fileName: string } | null
}

const fmtSize = (b: number) => b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : `${(b / (1 << 20)).toFixed(0)} MB`

export default function SandboxTab() {
  const [st, setSt] = useState<LocalStatus | null>(null)
  const [cloud, setCloud] = useState<any>(null)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState('')
  const [instErr, setInstErr] = useState('')
  const offRef = useRef<(() => void) | null>(null)

  const load = () => {
    window.api.invoke('sandbox-local:status').then(setSt).catch(e => swallowUi(e, 'sbx-local'))
    window.api.invoke('sandbox:status').then(setCloud).catch(e => swallowUi(e, 'sbx-cloud'))
  }
  useEffect(() => {
    load()
    offRef.current = window.api.on('sandbox-local:install-progress', (p: any) => {
      const m = String(p?.msg || '')
      setProgress(m.length > 48 ? m.slice(0, 48) + '…' : m)   // 主进程只发阶段说明；长度防线兜底
    })
    return () => { try { offRef.current?.() } catch { /* 已卸载 */ } }
  }, [])

  const setMode = async (mode: 'cloud' | 'local') => {
    await window.api.invoke('sandbox-local:set-mode', mode)
    setSt(s => (s ? { ...s, mode } : s))
  }

  // Docker 环境一键安装（brew + colima；首次要下载虚拟机镜像，几分钟）
  const installDocker = async () => {
    setInstalling(true)
    setInstErr('')
    setProgress('准备安装 Docker 环境…')
    const r: any = await window.api.invoke('sandbox-local:install-docker').catch((e: any) => ({ ok: false, error: String(e?.message || e) }))
    setInstalling(false)
    setProgress('')
    if (!r?.ok) setInstErr(r?.error || '安装失败，请重试')
    load()
  }

  const install = async () => {
    setInstalling(true)
    setInstErr('')
    setProgress('准备中…')
    const r: any = await window.api.invoke('sandbox-local:install').catch((e: any) => ({ ok: false, error: String(e?.message || e) }))
    setInstalling(false)
    setProgress('')
    if (!r?.ok) setInstErr(r?.error || '安装失败，请重试')
    load()
  }

  const localUsable = !!st?.dockerOk && !!st?.imageReady
  const cloudOk = cloud != null && cloud.healthy

  return (
    <div className="settings-tab-content">
      <h2 className="tab-title">安全沙箱</h2>
      <p className="voice-sub">技能代码一律在隔离容器中执行、跑完即毁，绝不在你的桌面环境直接运行。执行位置可选云端或本机。</p>

      {/* 执行位置切换 */}
      <div className="voice-card">
        <div className="voice-card-title" style={{ marginBottom: 10 }}>代码执行位置</div>
        <div className={`voice-model-row ${st?.mode === 'cloud' ? 'sel' : ''}`} onClick={() => setMode('cloud')}>
          <span className={`voice-radio ${st?.mode === 'cloud' ? 'on' : ''}`} />
          <Cloud size={17} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <b style={{ fontSize: 13 }}>云端沙箱（推荐）</b>
              {cloudOk ? <span className="voice-badge ok">就绪</span> : <span className="voice-badge warn">{cloud == null ? '探测中' : '不可达'}</span>}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
              在公司服务器的隔离容器中执行，本机零占用；由管理端统一运维与审计。
            </div>
          </div>
        </div>
        <div className={`voice-model-row ${st?.mode === 'local' ? 'sel' : ''}`} onClick={() => setMode('local')}>
          <span className={`voice-radio ${st?.mode === 'local' ? 'on' : ''}`} />
          <Laptop size={17} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <b style={{ fontSize: 13 }}>本地沙箱</b>
              {localUsable ? <span className="voice-badge ok">就绪</span> : <span className="voice-badge warn">未就绪</span>}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
              在本机 Docker 的隔离容器中执行（与云端同一镜像）：数据不出机、断网也能跑。未就绪时自动回落云端。
            </div>
          </div>
        </div>
      </div>

      {/* 云端状态（从企业系统连接页拆来） */}
      <div className="voice-card">
        <div className="voice-card-head">
          <ShieldCheck size={16} style={{ color: cloudOk ? 'var(--brand-primary)' : '#F59E0B' }} />
          <div style={{ flex: 1 }}>
            <div className="voice-card-title">云端沙箱</div>
            <div className="voice-card-desc">
              {cloud == null ? '正在探测…'
                : cloud.mode === 'disabled' ? '已停用（管理员在「沙箱监控」中关闭）'
                : cloudOk ? `就绪 · 基础镜像 ${cloud.image || '—'} · 配置与运维在管理端「沙箱监控」`
                : `不可达${cloud.error ? '：' + String(cloud.error).slice(0, 50) : ''} · 请联系管理员`}
            </div>
          </div>
          <button type="button" className="robot-btn" onClick={load}><RefreshCw size={13} /> 刷新</button>
        </div>
      </div>

      {/* 本地沙箱 */}
      <div className="voice-card">
        <div className="voice-card-head">
          <Laptop size={16} />
          <div style={{ flex: 1 }}>
            <div className="voice-card-title">本地沙箱环境</div>
            <div className="voice-card-desc">
              {st == null ? '正在检测…'
                : !st.dockerOk ? '未检测到本机 Docker 运行时'
                : `Docker ${st.dockerVersion} · ${st.imageReady ? `镜像 ${st.imageTag} 已安装` : `镜像 ${st.imageTag} 未安装`}`}
            </div>
          </div>
          {st != null && !st.dockerOk && st.brewOk && !installing && (
            <button type="button" className="robot-btn" onClick={installDocker}>
              <Download size={13} /> 一键安装 Docker 环境
            </button>
          )}
          {st?.dockerOk && !st.imageReady && !installing && (
            <button type="button" className="robot-btn" onClick={install} disabled={!st.platformImage?.ready}>
              <Download size={13} /> 下载并安装镜像{st.platformImage?.ready ? `（${fmtSize(st.platformImage.sizeBytes)}）` : ''}
            </button>
          )}
          {installing && <span className="voice-progress"><Loader2 size={13} className="drawer-spin" /> {progress || '安装中…'}</span>}
          {st?.dockerOk && st.imageReady && <span className="voice-badge ok"><Check size={12} /> 已就绪</span>}
        </div>
        {!st?.dockerOk && st != null && (
          <div className="voice-card-foot">
            {st.brewOk
              ? '点「一键安装 Docker 环境」自动完成（需可访问外网或企业内网 Homebrew 镜像，首次几分钟）；也可手动安装 OrbStack / Docker Desktop 后点刷新。'
              : '需要先安装 Docker 运行时（OrbStack 或 Docker Desktop），安装后回到本页点「刷新」。'}
            {' '}无外网环境：请从企业客户端下载页获取 Docker 离线安装包（管理员在资源中心发布），或由 IT 统一预装。
          </div>
        )}
        {st?.dockerOk && !st.imageReady && !st.platformImage?.ready && (
          <div className="voice-card-foot" style={{ color: '#B45309' }}>
            企业平台尚未托管沙箱镜像——请联系管理员在管理端「资源中心 → 沙箱镜像」点击导出。
          </div>
        )}
        {instErr && <div className="voice-card-foot" style={{ color: '#B45309' }}>{instErr}</div>}
        <div className="voice-card-foot">
          镜像从企业平台下载（与云端完全同一镜像），仅需安装一次；执行时容器用完即毁，产物只落你的工作空间。
        </div>
      </div>
    </div>
  )
}
