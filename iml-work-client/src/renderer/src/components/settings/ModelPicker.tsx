// 选模型：**列表优先、自动拉取**，手填降级为兜底。
//
// 原来的交互是「一个要手填的模型名输入框 + 右上角一个不起眼的『拉取可用模型』文字链」——
// 用户配完密钥后并不知道还该去点那个链接，于是永远在手抄模型名；拉取失败还弹 alert 打断操作。
// 改成：密钥就绪就自动去拉，模型以**列表**呈现（带档位标注），点一行即选用；
// 上游不提供 /models 的厂商才需要手填，所以把输入框折叠成兜底入口。
//
// 网络模型服务与本地模型两处共用本组件——此前两处各写一份拉取链接与输入框，改一处必漏另一处。
import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Pencil, Check } from 'lucide-react'

export interface ModelTierHint { type: string; tierName: string; chatCapable: boolean }

interface Props {
  value: string
  onChange: (v: string) => void
  /** 拉取实现由父组件给（它持有 mode/baseUrl/apiKey 的真值）；返回模型名数组，抛错即失败。 */
  fetchModels: () => Promise<string[]>
  /** 档位标注（按模型名，来自后端 ModelTypeGuess）。拿不到就不标，不影响选择。 */
  tiers: Record<string, ModelTierHint>
  /** 变化即触发自动拉取的凭据（密钥/地址）。为空表示条件还不具备，不去打接口。 */
  readyKey: string
  placeholder: string
  hint?: string
}

export default function ModelPicker({ value, onChange, fetchModels, tiers, readyKey, placeholder, hint }: Props) {
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [manual, setManual] = useState(false)
  // 已经拉过的凭据不重复拉：这个组件在每次输入都会重渲染，不记住就会把接口打爆
  const lastKey = useRef('')

  const load = async (why: 'auto' | 'manual') => {
    if (busy) return
    setBusy(true); setErr('')
    try {
      const list = await fetchModels()
      setModels(list)
      if (!list.length) setErr('该服务未返回模型列表，请在下方手动输入模型名')
    } catch (e: any) {
      // 不用 alert：自动拉取是后台行为，弹窗打断操作；失败就地说明并留手填出路
      setErr(why === 'auto' ? '' : (e?.message || '拉取失败'))
      if (why === 'auto') setManual(true)
    }
    setBusy(false)
  }

  // 密钥/地址就绪即自动拉取（防抖：用户还在粘贴密钥时不要连打接口）
  useEffect(() => {
    if (!readyKey || readyKey === lastKey.current) return
    const t = setTimeout(() => { lastKey.current = readyKey; load('auto') }, 600)
    return () => clearTimeout(t)
  }, [readyKey])

  return (
    <div className="model-field">
      <label className="model-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>模型</span>
        <a className="model-doc-link" onClick={busy ? undefined : () => load('manual')}>
          <RefreshCw size={11} style={{ verticalAlign: '-1px', marginRight: 4, ...(busy ? { animation: 'spin 1s linear infinite' } : {}) }} />
          {busy ? '拉取中…' : '重新拉取'}
        </a>
      </label>

      {models.length > 0 && (
        <div className="model-pick-list">
          {models.map(m => {
            const t = tiers[m]
            const on = value === m
            return (
              <button type="button" key={m} className={`model-pick${on ? ' on' : ''}`} onClick={() => onChange(m)}>
                <span className="model-pick-name">{m}</span>
                {on && <Check size={12} className="model-pick-on" />}
                {t && t.chatCapable === false
                  ? <span className="model-pick-tag muted">非对话模型</span>
                  : t && <span className={`model-pick-tag${t.type === 'reasoning' ? ' strong' : ''}`}>{t.tierName}</span>}
              </button>
            )
          })}
        </div>
      )}

      {/* 还没拉到时给的不是空白：说清楚在等什么、或者可以直接手填 */}
      {!models.length && !manual && (
        <div className="model-hint" style={{ padding: '10px 0' }}>
          {busy ? '正在拉取可用模型…' : readyKey ? '填好密钥后会自动列出可用模型。' : '请先填写上方的地址与密钥。'}
        </div>
      )}

      {err && <div className="model-hint" style={{ color: 'var(--danger, #b45309)' }}>{err}</div>}

      {manual || !models.length ? (
        <input className="settings-input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      ) : (
        <button type="button" className="settings-accordion-trigger" style={{ padding: '6px 0', fontSize: 12 }} onClick={() => setManual(true)}>
          <Pencil size={11} style={{ verticalAlign: '-1px', marginRight: 5 }} />
          列表里没有？手动输入模型名
        </button>
      )}

      {hint && <span className="model-hint">{hint}</span>}
    </div>
  )
}
