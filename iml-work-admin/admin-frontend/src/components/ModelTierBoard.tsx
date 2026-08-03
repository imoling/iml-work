import { AlertTriangle, Zap, Brain, Eye, Image, Film } from 'lucide-react'
import type { TierDef } from './model-vendors'

// 档位总览：把「客户端请求什么 → 实际落到哪个通道」放在页面最上方。
//
// 这是整个中转站最该被看见的信息，原来页面上完全没有——管理员只能看到一张通道表，
// 得自己在脑子里跑一遍路由规则才知道深度调研会打到哪。
//
// 档位定义（名称/用途/别名）由后端下发，这里不硬编码；成员判据按 fallback 分两种，
// 与 ModelRouterService.candidates 的两条分支一一对应：
//   · 兜底档（corp-default）—— 按 routeKey 字面匹配
//   · 类型档（corp-reasoning）—— 按 modelType 过滤，与 routeKey 无关
// 正因为判据不同，一个通道可能同时落进两个档位，那意味着日常对话会被负载均衡打到
// 贵的推理模型上——这种配置必须显式告警，不能藏着。

interface Provider {
  id: string
  name: string
  model: string
  routeKey: string
  modelType?: string
  weight: number
  enabled: boolean
  status: string
}

const live = (p: Provider) => p.enabled && p.status !== 'DOWN'

/** 该通道是否属于这一档（判据随 fallback 切换，见文件头注释）。 */
function membersOf(items: Provider[], t: TierDef): Provider[] {
  return items.filter(p => live(p) && (t.fallback
    ? (p.routeKey || '') === t.alias
    : (p.modelType || '').toLowerCase() === t.modelType.toLowerCase()))
}

const ICONS: Record<string, React.ReactNode> = {
  standard: <Zap size={15} />,
  reasoning: <Brain size={15} />,
  vision: <Eye size={15} />,
  image: <Image size={15} />,
  video: <Film size={15} />,
}

export default function ModelTierBoard({ items, tiers }: { items: Provider[]; tiers: TierDef[] }) {
  // 卡片区只画**对话档位**：这块讲的是"同一次对话该用哪个模型"，
  // 文生图/文生视频不是对话的可选项（客户端选择器里也没有它们），混进来既挤又误导。
  // 它们改用下方一条紧凑的能力行呈现——管理员照样能一眼看到落点。
  const convTiers = tiers.filter(t => t.kind !== 'capability')
  const capTiers = tiers.filter(t => t.kind === 'capability')
  const groups = convTiers.map(t => ({ tier: t, members: membersOf(items, t) }))
  const capGroups = capTiers.map(t => ({ tier: t, members: membersOf(items, t) }))
  // 同时落进两档的通道：日常请求会被打到推理模型上，按推理档计费
  const overlap = items.filter(p => groups.filter(g => g.members.some(m => m.id === p.id)).length > 1)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        客户端只按<strong>档位</strong>请求，由中转站决定实际通道。下面是此刻的真实落点：
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        {groups.map(({ tier, members }) => {
          const total = members.reduce((s, p) => s + Math.max(1, p.weight), 0)
          return (
            <div key={tier.key} className="glass-panel" style={{ flex: 1, padding: 16, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <span style={{ color: 'var(--brand-primary)', display: 'flex' }}>{ICONS[tier.key] || <Zap size={15} />}</span>
                <strong style={{ fontSize: 14 }}>{tier.name}</strong>
                <code style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-subtle)', padding: '1px 6px', borderRadius: 4 }}>
                  {tier.alias}
                </code>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10 }}>{tier.use}</div>
              {members.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-subtle)', padding: '8px 10px', borderRadius: 6 }}>
                  {tier.fallback
                    ? `没有通道用 ${tier.alias} 路由名 —— 普通请求会回退到全部启用通道里挑一个。`
                    : `未配置${tier.name} —— 该用途的请求会 fail-open 回退到标准档，能跑但质量打折。`}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {members.map(p => {
                    const share = total > 0 ? Math.round(Math.max(1, p.weight) / total * 100) : 0
                    return (
                      <div key={p.id}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {p.name}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{share}%</span>
                        </div>
                        <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{p.model}</code>
                        <div style={{ height: 4, background: 'var(--bg-subtle)', borderRadius: 2, marginTop: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${share}%`, height: '100%', background: 'var(--brand-primary)' }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {capGroups.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>生成能力：</span>
          {capGroups.map(({ tier, members }) => (
            <div key={tier.key} style={{
              display: 'flex', alignItems: 'center', gap: 7, fontSize: 12,
              background: 'var(--bg-subtle)', border: '1px solid var(--border-color)',
              borderRadius: 8, padding: '5px 10px',
            }}>
              <span style={{ color: 'var(--brand-primary)', display: 'flex' }}>{ICONS[tier.key]}</span>
              <strong style={{ fontWeight: 600 }}>{tier.name}</strong>
              {members.length === 0
                // 生成类不 fail-open 到对话通道（对话模型不认 /images/generations），没配就是不可用——照实说
                ? <span style={{ color: '#b45309' }}>未配置通道，该能力不可用</span>
                : <span style={{ color: 'var(--text-muted)' }}>→ {members.map(p => p.name).join('、')}</span>}
            </div>
          ))}
        </div>
      )}
      {overlap.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '9px 12px' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            <strong>{overlap.map(p => p.name).join('、')}</strong> 同时落在多个档位（路由名是兜底档的，类型又是别的档）。
            日常对话会被负载均衡打到它上面、按该档计费。建议把它的路由名改成对应档位的别名。
          </span>
        </div>
      )}
    </div>
  )
}
