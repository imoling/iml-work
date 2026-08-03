// 多提供商管理：列表（各家连接状态）+ 详情（密钥 → 测试 → 拉取 → 勾选 → 分配档位）。
//
// 为什么不是"选一个提供商"：企业中转站已经承担了统一调度多家的角色；员工自配如果只能连一家，
// 它就只是个降级备胎。真正会自配的人恰恰想混着用不同厂商的长处（这家推理强、那家长上下文便宜）。
//
// 勾选语义与档位是两件事，别混：
//   · 勾选 = 这个模型出现在 composer 选择器里（用户随时可切）
//   · 档位 = 深度调研这类**按用途**取模型的链路走哪个（用户不用管，链路自己挑）
import { useState } from 'react'
import { Check, ChevronRight, RefreshCw, Trash2, Plus } from 'lucide-react'
import { vendorLogo } from './vendors'
import {
  modelRef, enabledModels, type LlmProvider, type TierModels, type TierKey, autoAssignTiers,
} from '../../../../shared/llm-service'

type Types = Record<string, { type?: string; tierName?: string; chatCapable?: boolean }>

interface Props {
  providers: LlmProvider[]
  onChange: (list: LlmProvider[]) => void
  tiers: TierModels
  onTiers: (t: TierModels) => void
  defaultRef: string
  onDefaultRef: (r: string) => void
  /** 厂商预设（名称 / 预填地址 / 协议），与既有 NETWORK_VENDORS 同源 */
  vendors: { key: string; name: string; baseUrl: string; apiMode: string; doc?: string }[]
  /** 拉取模型 + 档位判定，由父组件提供（它持有 IPC 与后端地址） */
  fetchModels: (baseUrl: string, apiKey: string, apiMode: string) => Promise<{ models: string[]; types: Types }>
}

const TIER_DEFS: { key: TierKey; name: string }[] = [
  { key: 'standard', name: '标准档' },
  { key: 'reasoning', name: '推理档' },
  { key: 'vision', name: '视觉档' },
]

export default function ProviderList(p: Props) {
  const [openId, setOpenId] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [types, setTypes] = useState<Record<string, Types>>({})

  const upd = (id: string, patch: Partial<LlmProvider>) =>
    p.onChange(p.providers.map(x => (x.id === id ? { ...x, ...patch } : x)))

  const addVendor = (v: Props['vendors'][number]) => {
    // 同一厂商允许配两份（比如两个不同额度的 key），id 加序号区分
    const n = p.providers.filter(x => x.vendorKey === v.key).length
    const id = n ? `${v.key}-${n + 1}` : v.key
    p.onChange([...p.providers, {
      id, vendorKey: v.key, name: n ? `${v.name} ${n + 1}` : v.name,
      baseUrl: v.baseUrl, apiKey: '', apiMode: v.apiMode, models: [], enabled: [],
    }])
    setOpenId(id)
  }

  const removeProvider = (id: string) => {
    p.onChange(p.providers.filter(x => x.id !== id))
    // 连带清掉指向它的档位与默认模型，否则会留下指向不存在提供商的悬空引用
    const t: TierModels = { ...p.tiers }
    for (const k of Object.keys(t) as TierKey[]) if ((t[k] || '').startsWith(id + '::')) delete t[k]
    p.onTiers(t)
    if (p.defaultRef.startsWith(id + '::')) p.onDefaultRef('')
    if (openId === id) setOpenId('')
  }

  const pull = async (pr: LlmProvider) => {
    setBusy(pr.id); setMsg(m => ({ ...m, [pr.id]: '' }))
    try {
      const { models, types: t } = await p.fetchModels(pr.baseUrl, pr.apiKey, pr.apiMode)
      setTypes(x => ({ ...x, [pr.id]: t }))
      // 首次拉取默认勾选可对话的模型；已经勾过就保留用户的选择
      const chat = models.filter(m => t[m]?.chatCapable !== false)
      const enabled = pr.enabled.length ? pr.enabled.filter(m => models.includes(m)) : chat
      upd(pr.id, { models, enabled })
      setMsg(m => ({ ...m, [pr.id]: `已拉取 ${models.length} 个模型` }))
      // 档位还空着就顺手配好——「导入一个模型服务」的意思就是一次配齐，不用用户自己琢磨
      if (!Object.keys(p.tiers).length) {
        const auto = autoAssignTiers(models, t)
        const mapped: TierModels = {}
        for (const k of Object.keys(auto) as TierKey[]) mapped[k] = modelRef(pr.id, auto[k]!)
        p.onTiers(mapped)
      }
      if (!p.defaultRef && chat[0]) p.onDefaultRef(modelRef(pr.id, chat[0]))
    } catch (e: any) {
      setMsg(m => ({ ...m, [pr.id]: `❌ ${e?.message || '拉取失败'}` }))
    }
    setBusy('')
  }

  const toggleModel = (pr: LlmProvider, m: string) => {
    const has = pr.enabled.includes(m)
    upd(pr.id, { enabled: has ? pr.enabled.filter(x => x !== m) : [...pr.enabled, m] })
  }

  const total = enabledModels(p.providers).length

  return (
    <div className="model-field">
      <label className="model-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>模型服务</span>
        <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11.5 }}>
          已连接 {p.providers.filter(x => x.apiKey).length} 家 · 可选模型 {total} 个
        </span>
      </label>

      {p.providers.map(pr => {
        const open = openId === pr.id
        const t = types[pr.id] || {}
        return (
          <div key={pr.id} style={{ border: '1px solid var(--border-color)', borderRadius: 10, marginBottom: 8, overflow: 'hidden' }}>
            <button type="button" onClick={() => setOpenId(open ? '' : pr.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', background: 'transparent', border: 0, cursor: 'pointer', textAlign: 'left' }}>
              {vendorLogo(pr.vendorKey)}
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>{pr.name}</span>
              <span style={{ fontSize: 11.5, color: pr.apiKey ? 'var(--brand-primary)' : 'var(--text-muted)' }}>
                {pr.apiKey ? `✓ 已连接 · ${pr.enabled.length} 个模型可选` : '未配置密钥'}
              </span>
              {/* 删除放在标题行：它是"这条服务"的操作，跟标题在一起才对得上；
                  原来埋在展开区最底部，要先展开、再滚到底才找得到。
                  用 span 而不是 button——外层整行已经是 button，HTML 不允许按钮套按钮。 */}
              <span role="button" tabIndex={0} title="移除此服务"
                onClick={e => { e.stopPropagation(); removeProvider(pr.id) }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); removeProvider(pr.id) } }}
                style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', padding: 4, borderRadius: 6, color: 'var(--text-muted)', cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.color = '#b45309' }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)' }}>
                <Trash2 size={13} />
              </span>
              <ChevronRight size={14} style={{ transform: open ? 'rotate(90deg)' : '', color: 'var(--text-muted)' }} />
            </button>

            {open && (
              <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border-color)' }}>
                <div className="model-field" style={{ marginTop: 10 }}>
                  <label className="model-label">接口地址</label>
                  <input className="settings-input" value={pr.baseUrl} onChange={e => upd(pr.id, { baseUrl: e.target.value })} />
                </div>
                <div className="model-field">
                  <label className="model-label">API 密钥</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input type="password" className="settings-input" style={{ flex: 1 }} value={pr.apiKey}
                      onChange={e => upd(pr.id, { apiKey: e.target.value })} placeholder="粘贴该服务的 API Key" />
                    <button type="button" className="settings-btn" disabled={busy === pr.id || !pr.apiKey}
                      onClick={() => pull(pr)} style={{ whiteSpace: 'nowrap' }}>
                      <RefreshCw size={12} style={{ verticalAlign: '-1px', marginRight: 4 }} />
                      {busy === pr.id ? '拉取中…' : '测试并拉取'}
                    </button>
                  </div>
                  {msg[pr.id] && <span className="model-hint">{msg[pr.id]}</span>}
                  <span className="model-hint">密钥保存后在本地加密存储，不上传。</span>
                </div>

                {pr.models.length > 0 && (
                  <div className="model-field">
                    <label className="model-label">
                      模型
                      <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11.5, marginLeft: 8 }}>
                        勾选的会出现在对话框的模型选择器里
                      </span>
                    </label>
                    <div className="model-pick-list">
                      {pr.models.map(m => {
                        const nonChat = t[m]?.chatCapable === false
                        const on = pr.enabled.includes(m)
                        return (
                          <button type="button" key={m} disabled={nonChat}
                            className={`model-pick${on ? ' on' : ''}`}
                            style={nonChat ? { opacity: .45, cursor: 'not-allowed' } : undefined}
                            onClick={() => toggleModel(pr, m)}>
                            <span className="model-pick-name">{m}</span>
                            {on && <Check size={12} className="model-pick-on" />}
                            {nonChat
                              ? <span className="model-pick-tag muted">非对话模型</span>
                              : t[m]?.tierName && <span className={`model-pick-tag${t[m]?.type === 'reasoning' ? ' strong' : ''}`}>{t[m]!.tierName}</span>}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

              </div>
            )}
          </div>
        )
      })}

      {/* 添加：同一厂商可加多份（不同额度的 key） */}
      <div className="model-field" style={{ marginTop: 4 }}>
        <label className="model-label"><Plus size={12} style={{ verticalAlign: '-1px', marginRight: 4 }} />添加模型服务</label>
        <div className="vendor-grid">
          {p.vendors.map(v => (
            <button type="button" key={v.key} className="vendor-card" onClick={() => addVendor(v)}>
              {vendorLogo(v.key)}<span className="vendor-name">{v.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 档位：跨提供商指定，供深度调研等"按用途取模型"的链路使用 */}
      {total > 0 && (
        <div className="model-field">
          <label className="model-label">
            档位
            <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11.5, marginLeft: 8 }}>
              可跨服务指定：深度调研这类任务会自动用推理档，不用你每次手切
            </span>
          </label>
          {TIER_DEFS.map(td => (
            <div key={td.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12.5, width: 52, flexShrink: 0 }}>{td.name}</span>
              <select className="settings-input" style={{ flex: 1 }}
                value={p.tiers[td.key] || ''}
                onChange={e => p.onTiers({ ...p.tiers, [td.key]: e.target.value || undefined })}>
                <option value="">（未配置，回落标准档）</option>
                {enabledModels(p.providers).map(x => (
                  <option key={x.ref} value={x.ref}>{x.provider} · {x.model}</option>
                ))}
              </select>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <span style={{ fontSize: 12.5, width: 52, flexShrink: 0 }}>默认</span>
            <select className="settings-input" style={{ flex: 1 }} value={p.defaultRef}
              onChange={e => p.onDefaultRef(e.target.value)}>
              <option value="">（未选）</option>
              {enabledModels(p.providers).map(x => (
                <option key={x.ref} value={x.ref}>{x.provider} · {x.model}</option>
              ))}
            </select>
          </div>
          <span className="model-hint">新会话默认用它；对话里可随时在输入框上方切换。</span>
        </div>
      )}
    </div>
  )
}
