import { useEffect, useState } from 'react'
import type { TierDef } from './model-vendors'

// 「从上游拉取列表」后的批量登记面板：勾选要登记的模型，逐条确认通道类型，一次建多个通道。
//
// 类型是**服务端按模型名猜的**（ModelTypeGuess，启发式——OpenAI 兼容协议不返回类型元数据），
// 所以每行都保留下拉让管理员改：猜错时误判成推理档会把日常对话按推理档计费。
// 路由名不给填：推理档必须与快档分开，否则 corp-default 的候选池会把推理通道也算进去
// （见 ModelRouterService.candidates），日常对话会被负载均衡打到贵模型上。

export interface UpstreamModel {
  id: string
  guessedType: string
  suggestedRouteKey: string
  /** 能否当对话通道用；嵌入/重排/语音模型为 false，不可勾选。 */
  chatCapable?: boolean
}

export interface ProbeResult { type: string; probed: boolean }

interface Props {
  items: UpstreamModel[]
  busy: boolean
  onCancel: () => void
  onSubmit: (picks: { model: string; modelType: string; routeKey: string }[]) => void
  /** 实测类型：对每个模型发探针请求，读回执里的 reasoning_tokens。见后端 probeModelTypes。 */
  onProbe: (models: string[]) => Promise<Record<string, ProbeResult>>
  /** 档位定义（后端下发，唯一来源 ModelTiers）：决定下拉选项与各档的逻辑路由名。 */
  tiers: TierDef[]
}

const PROBE_LIMIT = 20      // 与后端 probeModelTypes 的上限一致

const canUse = (i: UpstreamModel) => i.chatCapable !== false

export default function BatchModelPicker({ items, busy, onCancel, onSubmit, onProbe, tiers }: Props) {
  // 档位 → 逻辑路由名。推理档必须与快档分开，否则 corp-default 的候选池会把推理通道
  // 也算进去（见 ModelRouterService.candidates），日常对话会被打到贵模型上。
  const routeKeyOf = (modelType: string) =>
    tiers.find(t => t.modelType.toLowerCase() === modelType.toLowerCase())?.alias || tiers[0]?.alias || ''

  // 默认只勾选推理档：快档通常已经登记过一条了，全选会造出一堆重复通道
  const [sel, setSel] = useState<Record<string, boolean>>(
    () => Object.fromEntries(items.map(i => [i.id, canUse(i) && i.guessedType === 'reasoning'])))
  const [types, setTypes] = useState<Record<string, string>>(
    () => Object.fromEntries(items.map(i => [i.id, i.guessedType])))
  const [probing, setProbing] = useState(true)
  const [probed, setProbed] = useState<Record<string, boolean>>({})

  // 挂载即自动实测：命名推断认不出 deepseek-v4-pro 这类"名字里看不出推理属性"的模型，
  // 只有真发一次请求看 reasoning_tokens 才知道。探测期间禁用交互，免得结果回来覆盖用户的手改。
  useEffect(() => {
    let alive = true
    onProbe(items.slice(0, PROBE_LIMIT).map(i => i.id))
      .then(res => {
        if (!alive) return
        const nextTypes: Record<string, string> = {}
        const nextProbed: Record<string, boolean> = {}
        for (const i of items) {
          const r = res[i.id]
          nextTypes[i.id] = r?.type || i.guessedType
          nextProbed[i.id] = !!r?.probed
        }
        setTypes(nextTypes)
        setProbed(nextProbed)
        setSel(Object.fromEntries(items.map(i => [i.id, canUse(i) && nextTypes[i.id] === 'reasoning'])))
      })
      .catch(() => { /* 探测失败 → 保留命名推断，不打断登记流程 */ })
      .finally(() => { if (alive) setProbing(false) })
    return () => { alive = false }
  }, [items])

  const chosen = items.filter(i => sel[i.id])

  return (
    <div style={{ gridColumn: 'span 3', border: '1px solid var(--border-color)', borderRadius: 8, padding: 12, background: 'var(--bg-subtle)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>
          拉取到 {items.length} 个模型 · {probing ? '正在实测类型…' : '勾选后可一次登记多个通道'}
        </strong>
        <button type="button" className="btn-ghost" style={{ fontSize: 12 }} onClick={onCancel}>重选上游</button>
      </div>
      {items.length > PROBE_LIMIT && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
          仅前 {PROBE_LIMIT} 个做了实测，其余按模型名推断，请自行核对。
        </div>
      )}
      <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {items.map(i => (
          <label key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 6px', borderRadius: 6, background: sel[i.id] ? 'var(--bg-surface)' : 'transparent' }}>
            <input type="checkbox" checked={!!sel[i.id]} disabled={probing || !canUse(i)}
              onChange={e => setSel({ ...sel, [i.id]: e.target.checked })} />
            <span style={{ flex: 1, fontSize: 13, fontFamily: 'monospace', opacity: canUse(i) ? 1 : 0.5 }}>{i.id}</span>
            {canUse(i) ? (
              <>
                <span style={{ fontSize: 11, color: probed[i.id] ? 'var(--brand-primary)' : 'var(--text-muted)', width: 52 }}>
                  {probing ? '检测中' : probed[i.id] ? '实测' : '按名'}
                </span>
                <select className="form-input" style={{ width: 150, height: 30, fontSize: 12 }} disabled={probing}
                  value={types[i.id]} onChange={e => setTypes({ ...types, [i.id]: e.target.value })}>
                  {tiers.map(t => <option key={t.key} value={t.modelType}>{t.name}</option>)}
                </select>
                <code style={{ fontSize: 11, color: 'var(--text-muted)', width: 110 }}>{routeKeyOf(types[i.id])}</code>
              </>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 314 }}>非对话模型（嵌入/重排/语音），不能作对话通道</span>
            )}
          </label>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.6 }}>
        <strong>实测</strong> = 按上游回执里的 reasoning_tokens 判定；
        <strong>按名</strong> = 探不出时按模型名推断（同厂商全系都产生思维链时就属于这种），请核对后再登记。
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <button type="button" className="btn-primary" style={{ height: 34 }}
          disabled={busy || probing || chosen.length === 0}
          onClick={() => onSubmit(chosen.map(i => ({ model: i.id, modelType: types[i.id], routeKey: routeKeyOf(types[i.id]) })))}>
          {busy ? '登记中…' : probing ? '正在实测…' : `批量登记 ${chosen.length} 个通道`}
        </button>
      </div>
    </div>
  )
}
