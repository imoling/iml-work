// 设置 · 语音输入（对齐 语音输入管理页）：隐私说明 → 设备兼容性 → 模型选择 → 麦克风测试。
// 模型目录来自企业平台（tiny/base/small），按本机配置自动标「推荐」；文件平台优先、镜像回退（见 lib/stt.ts）。
// 麦克风测试为准实时：边说边刷中间转写（LiveRecorder），结束后整段定稿。
import { useEffect, useRef, useState } from 'react'
import { Mic, MonitorSmartphone, Loader2, Check, AudioLines } from 'lucide-react'
import { fetchCatalog, isModelCached, downloadModel, getModelSource, getSelectedModelId, setSelectedModel, type SttModel } from '../../lib/stt'
import { VoiceRecorder } from '../../lib/stt-recorder'
import { swallowUi } from '../../lib/ui-util'

interface DeviceInfo { platform: string; arch: string; osRelease: string; memGb: number; cores: number }

export default function VoiceTab() {
  const [dev, setDev] = useState<DeviceInfo | null>(null)
  const [models, setModels] = useState<SttModel[]>([])
  const [selId, setSelId] = useState('')
  const [cached, setCached] = useState<Record<string, boolean>>({})
  const [downState, setDownState] = useState<'idle' | 'downloading' | 'ready'>('idle')
  const [progress, setProgress] = useState('')
  const [downErr, setDownErr] = useState('')
  const [source, setSource] = useState<'platform' | 'mirror' | ''>('')
  const [micState, setMicState] = useState<'idle' | 'rec' | 'busy'>('idle')
  const [micResult, setMicResult] = useState('')
  const [level, setLevel] = useState(0)
  const recRef = useRef<VoiceRecorder | null>(null)

  // 推荐 = 本机满足门槛的最高档；全不满足取门槛最低的
  const recommend = (list: SttModel[], d: DeviceInfo | null): string => {
    if (!d || !list.length) return list[0]?.id || ''
    const ok = list.filter(m => d.memGb >= m.minMemGb && d.cores >= m.minCores)
    const pick = ok.length ? ok.reduce((a, b) => (b.minMemGb > a.minMemGb ? b : a)) : list.reduce((a, b) => (b.minMemGb < a.minMemGb ? b : a))
    return pick.id
  }
  const recId = recommend(models, dev)

  useEffect(() => {
    Promise.all([
      window.api.invoke('app:device-info').catch(e => { swallowUi(e, 'voice-dev'); return null }),
      fetchCatalog(),
    ]).then(async ([d, list]) => {
      setDev(d)
      setModels(list)
      const flags: Record<string, boolean> = {}
      for (const m of list) flags[m.id] = await isModelCached(m.repo)
      setCached(flags)
      // 首次进入未选过模型 → 默认选中推荐档
      const saved = getSelectedModelId()
      const initial = saved && list.some(m => m.id === saved) ? saved : recommend(list, d)
      const im = list.find(m => m.id === initial)
      if (im) { setSelId(initial); if (!saved) setSelectedModel(im.id, im.repo) }
      if (im && flags[initial]) setDownState('ready')
    })
    return () => { recRef.current?.abort() }
  }, [])

  const osName = dev?.platform === 'darwin' ? `macOS ${dev.osRelease.split('.').slice(0, 2).join('.')}`
    : dev?.platform === 'win32' ? 'Windows' : dev?.platform || ''
  const archName = dev?.arch === 'arm64' ? 'Apple Silicon' : dev?.arch || ''
  const compatible = !!dev && dev.memGb >= 8 && dev.cores >= 4

  const pick = (m: SttModel) => {
    setSelectedModel(m.id, m.repo)
    setSelId(m.id)
    setDownErr('')
    setDownState(cached[m.id] ? 'ready' : 'idle')
  }

  const doDownload = async () => {
    setDownState('downloading')
    setDownErr('')
    try {
      await downloadModel(setProgress)
      setSource(getModelSource())
      setCached(c => ({ ...c, [selId]: true }))
      setDownState('ready')
    } catch (e: any) {
      console.error('[voice-tab] 模型下载失败:', e)
      const msg = String(e?.message || e)
      // 区分错误类别，别一律怪网络：session 创建失败是模型与推理引擎不兼容，重试没用
      setDownErr(msg.includes('create a session') || msg.includes('ERROR_CODE')
        ? `该模型在本机推理引擎上加载失败（${msg.slice(0, 60)}）——请改用 Base 模型，并把此问题反馈给管理员`
        : msg.includes('Could not locate file')
          ? '模型文件在下载源上缺失——请稍后重试；若持续出现，请联系管理员在资源中心重新拉取该模型'
          : `下载失败：${msg.slice(0, 80)}——请检查网络后重试`)
      setDownState('idle')
    }
    setProgress('')
  }

  // 麦克风测试：点「开始录音」（电平跳动）→ 点「结束」→ 转写出文字（推理在 Worker）
  const micTest = async () => {
    if (micState === 'busy') return
    if (micState === 'rec') {
      setMicState('busy')
      setLevel(0)
      try {
        const finalText = await recRef.current!.stop(setProgress)
        setMicResult(finalText || '（没有识别到内容，请靠近麦克风重试）')
        setSource(getModelSource())
        setCached(c => ({ ...c, [selId]: true }))
        setDownState('ready')
      } catch (e: any) {
        console.error('[voice-tab] 测试失败:', e)
        setMicResult(`测试失败：${String(e?.message || e).slice(0, 80)}——若持续出现请换用 Base 模型`)
      }
      recRef.current = null
      setMicState('idle')
      setProgress('')
      return
    }
    try {
      const rec = new VoiceRecorder()
      setMicResult('')
      await rec.start(setLevel)
      recRef.current = rec
      setMicState('rec')
    } catch (e) {
      console.error('[voice-tab] 无法访问麦克风:', e)
      setMicResult('无法访问麦克风——请在系统设置中授予麦克风权限')
    }
  }

  return (
    <div className="settings-tab-content">
      <h2 className="tab-title">语音输入</h2>
      <p className="voice-sub">在输入框自然说话，本机转写成文字。录音与转写全程只在这台设备上完成。</p>

      <div className="voice-privacy">隐私设计：音频只在录音期间驻留内存，转写由本机模型完成，绝不上传。</div>

      {/* 设备兼容性 */}
      <div className="voice-card">
        <div className="voice-card-head">
          <MonitorSmartphone size={16} />
          <div style={{ flex: 1 }}>
            <div className="voice-card-title">本机设备</div>
            <div className="voice-card-desc">{osName}{archName ? ` · ${archName}` : ''}{dev ? ` · ${dev.memGb}GB 内存 · ${dev.cores} 核` : ''}</div>
          </div>
          {dev && (
            <span className={`voice-badge ${compatible ? 'ok' : 'warn'}`}>
              {compatible ? '满足要求' : '配置偏低'}
            </span>
          )}
        </div>
      </div>

      {/* 模型选择：平台目录全量展示，按本机配置标推荐 */}
      <div className="voice-card">
        <div className="voice-card-title" style={{ marginBottom: 10 }}>语音模型（按本机配置推荐）</div>
        {models.map(m => {
          const isSel = m.id === selId
          return (
            <div key={m.id} className={`voice-model-row ${isSel ? 'sel' : ''}`} onClick={() => pick(m)}>
              <span className={`voice-radio ${isSel ? 'on' : ''}`} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <b style={{ fontSize: 13 }}>{m.name}</b>
                  {m.id === recId && <span className="voice-badge ok">推荐</span>}
                  {cached[m.id] && <span className="voice-badge ok"><Check size={11} /> 已下载</span>}
                  {!cached[m.id] && !m.hosted && <span className="voice-badge warn">公网镜像</span>}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                  {m.desc} · {m.approxSize} · 建议 {m.requirements}
                </div>
              </div>
              {isSel && !cached[m.id] && downState !== 'downloading' && (
                <button type="button" className="robot-btn" onClick={e => { e.stopPropagation(); doDownload() }}>下载</button>
              )}
              {isSel && downState === 'downloading' && (
                <span className="voice-progress"><Loader2 size={13} className="drawer-spin" /> {progress || '准备中…'}</span>
              )}
              {isSel && cached[m.id] && (
                <span className="voice-badge ok"><Check size={12} /> 就绪{source === 'platform' ? ' · 企业平台' : source === 'mirror' ? ' · 公网镜像' : ''}</span>
              )}
            </div>
          )
        })}
        {downErr && <div className="voice-card-foot" style={{ color: '#B45309' }}>{downErr}</div>}
        <div className="voice-card-foot">优先从企业平台下载（内网可用）；平台未托管的版本自动走公网镜像。每个版本仅需下载一次。</div>
      </div>

      {/* 麦克风测试（准实时：边说边出中间结果） */}
      <div className="voice-card">
        <div className="voice-card-head">
          <Mic size={16} />
          <div style={{ flex: 1 }}>
            <div className="voice-card-title">麦克风测试</div>
            <div className="voice-card-desc">点「开始录音」说一句话，点「结束」后稍等片刻出文字（首次会触发模型加载）。</div>
          </div>
          {micState === 'rec' && (
            <span className="voice-meter" aria-hidden>
              {[0.5, 0.75, 1, 0.75, 0.5].map((k, i) => (
                <i key={i} style={{ height: `${Math.max(12, Math.min(100, level * 100 * k * 1.6))}%` }} />
              ))}
            </span>
          )}
          <button type="button" className={`robot-btn ${micState === 'rec' ? 'voice-rec-on' : ''}`} onClick={micTest} disabled={micState === 'busy'}>
            {micState === 'rec' ? '结束录音' : micState === 'busy' ? (progress || '转写中…') : '开始录音'}
          </button>
        </div>
        {micResult && (
          <div className="voice-test-result"><AudioLines size={13} /> {micResult}</div>
        )}
      </div>
    </div>
  )
}
