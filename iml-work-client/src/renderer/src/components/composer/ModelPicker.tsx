// composer 的模型选择器。两种形态，取决于**这套配置归谁所有**（见 shared/llm-service 的 exposesModelId）：
//
// · 企业中转站(gateway) —— 模型由管理端统一调度，员工看到 deepseek-chat 这类字符串没有决策价值，
//   反而把后端选型泄漏进终端界面，且管理员随时可换上游。只给**语义档位**（标准档/推理档），
//   档位定义由网关下发（唯一来源是后端 ModelTiers），客户端不硬编码。
// · 自配(network/local) —— baseUrl 与 model id 本来就是用户自己在设置页敲进去的，
//   composer 里藏起来反而和设置页不一致。**如实列出该端点的模型**，并标注数据已绕过企业闸。
//
// 两种形态都只写 modelName（turn:conv-model-set），端点与密钥仍是全局那一份——
// 每会话复制一份密钥快照是安全倒退，理由见 main/llm.ts 的会话级模型选择注释。
import { useEffect, useState } from 'react'
import { ChevronDown, ShieldAlert } from 'lucide-react'
import { useUserStore } from '../../stores/userStore'
import { deriveServiceType, bypassesCorpGateway, parseTierModels, TIER_MODELS_KEY, PROVIDERS_KEY, parseProviders, enabledModels } from '../../../../shared/llm-service'
import { swallowUi } from '../../lib/ui-util'

/** 网关下发的档位（/api/v1/model/models 的 tiers 字段）。 */
interface Tier { alias: string; name: string; use: string; available: boolean }

/** 统一成一份可渲染的选项，两种形态共用同一套渲染与写入逻辑。 */
interface Option { value: string; label: string; hint?: string }

interface Props {
  convId: string | null
  disabled: boolean
  /** 会话尚未创建时（新对话首次发送前）把选择交给父级暂存，发送时随会话落库。 */
  onPickPending: (modelName: string) => void
}

export default function ModelPicker({ convId, disabled, onPickPending }: Props) {
  const { llmConnectionMode, llmBaseUrl, llmApiKey } = useUserStore()
  const service = deriveServiceType(llmConnectionMode, llmBaseUrl)
  const isGateway = service === 'gateway'
  const offGateway = bypassesCorpGateway(service)

  const [options, setOptions] = useState<Option[]>([])
  const [picked, setPicked] = useState('')
  const [open, setOpen] = useState(false)

  // 拉可选项。两种形态共用 llm:list-models：gateway 取它的 tiers（可用性由后端判定，
  // 客户端不重算"哪个档位真有通道"）；自配取 models（该端点真实存在的模型）。
  // 拉取失败就静默不渲染，不打扰正在打字的用户。
  // 自配侧的提供商与档位映射（设置页写入）。
  const [localTierModels, setLocalTierModels] = useState('')
  const [providersRaw, setProvidersRaw] = useState('')
  useEffect(() => {
    window.api.invoke('db:config-get', TIER_MODELS_KEY)
      .then((v: unknown) => setLocalTierModels(typeof v === 'string' ? v : ''))
      .catch(e => swallowUi(e, 'model-picker-tiers'))
    window.api.invoke('db:config-get', PROVIDERS_KEY)
      .then((v: unknown) => setProvidersRaw(typeof v === 'string' ? v : ''))
      .catch(e => swallowUi(e, 'model-picker-providers'))
  }, [])

  useEffect(() => {
    let alive = true
    window.api.invoke('llm:list-models', { mode: llmConnectionMode, baseUrl: llmBaseUrl, apiKey: llmApiKey })
      .then((r: any) => {
        if (!alive) return
        if (isGateway) {
          const tiers: Tier[] = Array.isArray(r?.tiers) ? r.tiers : []
          setOptions(tiers.filter(t => t?.available && t.alias).map(t => ({ value: t.alias, label: t.name, hint: t.use })))
        } else {
          // 自配模式：档位（跨服务）在前，各服务勾选的具体模型在后。
          // 员工日常要的是"这轮用快的还是用强的"；但既然多家并存，也得能点名某一家的某个模型。
          // 档位别名与 `providerId::model` 引用都由主进程 resolveSelection 翻译（自配没有网关代劳）。
          const provs = parseProviders(providersRaw)
          const tm = parseTierModels(localTierModels)
          const tierOpts = ([['standard', 'corp-default', '标准档'],
                             ['reasoning', 'corp-reasoning', '推理档'],
                             ['vision', 'corp-vision', '视觉档']] as const)
            .filter(([k]) => tm[k])
            .map(([k, alias, name]) => ({ value: alias, label: name, hint: tm[k] }))
          const each = enabledModels(provs).map(x => ({ value: x.ref, label: x.model, hint: x.provider }))
          // 都没配（老配置尚未迁移）→ 退回该端点直接列出来的模型名
          const models: string[] = Array.isArray(r?.models) ? r.models : []
          setOptions(tierOpts.length || each.length
            ? [...tierOpts, ...each]
            : models.filter(m => typeof m === 'string' && m).map(m => ({ value: m, label: m })))
        }
      })
      .catch(e => swallowUi(e, 'model-picker-list'))
    return () => { alive = false }
  }, [isGateway, llmConnectionMode, llmBaseUrl, llmApiKey, localTierModels, providersRaw])

  // 切会话回显该会话的选择（没选过 = 空 = 跟随全局默认）
  useEffect(() => {
    if (!convId) { setPicked(''); return }
    window.api.invoke('turn:conv-model-get', convId)
      .then((v: any) => setPicked(typeof v === 'string' ? v : ''))
      .catch(e => swallowUi(e, 'model-picker-get'))
  }, [convId])

  // 只有一个可选项时整个控件不渲染：一个选项的选择器没有意义，只是占位。
  if (options.length < 2) return null

  const current = options.find(o => o.value === picked) || options[0]

  const pick = async (v: string) => {
    setOpen(false)
    const next = v === options[0].value ? '' : v   // 首项即默认，存空串免得钉死一个名字
    setPicked(next)
    if (convId) {
      await window.api.invoke('turn:conv-model-set', { convId, modelName: next })
        .catch((e: unknown) => swallowUi(e, 'model-picker-set'))
    } else {
      onPickPending(next)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="token-pill" disabled={disabled}
        title={isGateway
          ? '本次会话的企业模型档位（模型由管理端统一调度）'
          : '本次会话使用的模型（你在设置里自配的直连端点）'}
        onClick={() => setOpen(o => !o)}>
        <span style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current.label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <>
          {/* 点击外部关闭：透明遮罩比全局 listener 更不容易和 composer 的焦点管理打架 */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 59 }} onClick={() => setOpen(false)} />
          <div className="composer-popover" style={{ left: 'auto', right: 0, minWidth: 240, maxHeight: 320, overflowY: 'auto' }}>
            <div className="composer-popover-title">
              {isGateway ? '企业模型档位 · 由管理端统一调度' : '我的模型 · 直连厂商'}
            </div>
            {options.map(o => (
              <button key={o.value} type="button"
                className={`composer-popover-item${o.value === current.value ? ' sel' : ''}`}
                style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
                onClick={() => pick(o.value)}>
                <span style={{ fontFamily: isGateway ? undefined : 'monospace', fontSize: isGateway ? undefined : 12.5 }}>{o.label}</span>
                {o.hint && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{o.hint}</span>}
              </button>
            ))}
            {/* 自配端点 = 业务数据绕过企业中转站，直接流向用户自填的厂商。这条必须可见：
                员工未必意识到"换个模型"同时也换掉了数据流向。 */}
            {offGateway && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', padding: '8px 8px 4px', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border-color)', marginTop: 4 }}>
                <ShieldAlert size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>该端点由你自己配置，对话内容不经企业中转站，平台侧无法审计。</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
