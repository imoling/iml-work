import { BRAND_ICONS } from './brand-icons'

// 厂商预设与标识（模型网关页与登记向导共用；原先内联在 ModelGatewayManager 里，
// 拆出来是因为向导、通道表、档位总览三处都要画同一套厂商图标）。

// 与客户端模型配置一致。选择后自动带出上游地址(完整 chat/completions 端点)与默认模型。
export interface VendorPreset { key: string; name: string; provider: string; baseUrl: string; model: string }

export const VENDOR_PRESETS: VendorPreset[] = [
  { key: 'agnes', name: 'Agnes', provider: 'AGNES', baseUrl: 'https://apihub.agnes-ai.com/v1/chat/completions', model: 'agnes-2.0-flash' },
  { key: 'deepseek', name: 'DeepSeek', provider: 'DEEPSEEK', baseUrl: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
  { key: 'openai', name: 'OpenAI', provider: 'OPENAI', baseUrl: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o' },
  { key: 'anthropic', name: 'Anthropic', provider: 'ANTHROPIC', baseUrl: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-sonnet-latest' },
  { key: 'qwen', name: '通义千问', provider: 'QWEN', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
  { key: 'moonshot', name: 'Moonshot', provider: 'MOONSHOT', baseUrl: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
  { key: 'ollama', name: 'Ollama', provider: 'OLLAMA', baseUrl: 'http://localhost:11434/v1/chat/completions', model: 'qwen2.5' },
  { key: 'lmstudio', name: 'LM Studio', provider: 'LMSTUDIO', baseUrl: 'http://localhost:1234/v1/chat/completions', model: '' },
  { key: 'vllm', name: 'vLLM', provider: 'VLLM', baseUrl: 'http://localhost:8000/v1/chat/completions', model: '' },
  { key: 'custom', name: '自定义', provider: 'CUSTOM', baseUrl: '', model: '' },
]

/** 本地部署的推理服务：无需 API Key。 */
export const LOCAL_PROVIDERS = ['OLLAMA', 'LMSTUDIO', 'VLLM']

// 厂商标识：品牌色圆角底 + 风格化字形（非官方 LOGO 精确复刻，仅作辨识）。
/**
 * 厂商标记：有官方 SVG 的用官方（BRAND_ICONS），没有的用字母标。
 * 与客户端 settings/vendors.tsx 同一套图标源，避免两端长得不一样。
 *
 * OpenAI 用字母标：simple-icons 应品牌方要求下架了它的标记，凭记忆临摹只会画歪。
 */
const LETTER_MARK: Record<string, { bg: string; text: string }> = {
  OPENAI: { bg: '#000000', text: 'AI' },
  AGNES: { bg: '#10B981', text: 'A' },
  CUSTOM: { bg: 'var(--bg-subtle)', text: '·' },
}

export function vendorLogo(provider: string): React.ReactNode {
  const icon = BRAND_ICONS[(provider || '').toLowerCase()]
  if (icon) {
    return (
      <span className="vendor-logo" style={{ background: icon.hex }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d={icon.path} /></svg>
      </span>
    )
  }
  const m = LETTER_MARK[provider] || LETTER_MARK.CUSTOM
  const light = m.bg.startsWith('var(')
  return (
    <span className="vendor-logo" style={{ background: m.bg }}>
      <span style={{ fontSize: m.text.length > 1 ? 10 : 12, fontWeight: 800, color: light ? 'var(--text-secondary)' : '#fff' }}>{m.text}</span>
    </span>
  )
}

// ── 档位 ────────────────────────────────────────────────────────────────────
// 管理员原来要同时理解「逻辑路由名」和「模型类型」两个字段，而它们在实际使用里
// 表达的是同一件事：这个通道承接哪一档任务。合并成单一的「档位」概念，
// 自定义路由名降级到高级选项（网关仍支持任意 routeKey，能力没丢）。
//
// 定义本身**从后端取**（GET /api/v1/model/providers/tiers → ModelTiers），不在前端硬编码：
// 同一份档位此前在后端、管理端、客户端各存一份，加一档要改三端。

/** 档位/能力的 key。**故意不是闭合联合类型**：档位由后端 ModelTiers 运行时下发，
 *  前端写死一份枚举就必然漏（vision 加进来时列表标注全错成"标准档"就是这么来的）。 */
export type Tier = string

export interface TierDef {
  key: Tier
  name: string
  use: string
  alias: string        // 逻辑路由名（corp-default / corp-reasoning）
  modelType: string
  /** 兜底档：按 routeKey 字面匹配成员，且恒可用；其余档位按 modelType 过滤。 */
  fallback: boolean
  /** tier=对话档位（客户端可按它选模型）；capability=非对话能力（文生图/文生视频，只在配置界面出现）。 */
  kind?: 'tier' | 'capability'
}

/** 后端不可达时的兜底：配置界面总得能画出来，值与 ModelTiers 保持一致。 */
export const FALLBACK_TIERS: TierDef[] = [
  { key: 'standard', name: '标准档', use: '日常对话、技能执行、定时任务', alias: 'corp-default', modelType: 'chat', fallback: true, kind: 'tier' },
  { key: 'reasoning', name: '推理档', use: '复杂分析与长链推理，更慢但更准', alias: 'corp-reasoning', modelType: 'reasoning', fallback: false, kind: 'tier' },
  { key: 'vision', name: '视觉档', use: '看图：截图、扫描件、图表、界面', alias: 'corp-vision', modelType: 'vision', fallback: false, kind: 'tier' },
  { key: 'image', name: '图片生成', use: '文生图：配图、插画、海报底图', alias: 'corp-image', modelType: 'image', fallback: false, kind: 'capability' },
  { key: 'video', name: '视频生成', use: '文生视频：短片段、演示动画', alias: 'corp-video', modelType: 'video', fallback: false, kind: 'capability' },
]

export async function fetchTiers(): Promise<TierDef[]> {
  try {
    const res = await fetch('/api/v1/model/providers/tiers')
    if (!res.ok) return FALLBACK_TIERS
    const d = await res.json()
    return Array.isArray(d) && d.length ? d : FALLBACK_TIERS
  } catch { return FALLBACK_TIERS }
}

/**
 * 由已存的 modelType 反推档位（编辑回显 / 列表标注用）。
 *
 * 必须按传入的档位表匹配，不能写死判 'reasoning'——写死时视觉档/图片生成/视频生成
 * 全部回显成"标准档"，管理员一存就把 modelType 改成了 chat，通道从此被拉进对话候选池。
 * 传 tiers 才有正确结果；省略时退回兜底表（值与后端 ModelTiers 一致）。
 */
export function tierOf(modelType?: string, tiers: TierDef[] = FALLBACK_TIERS): string {
  const t = (modelType || '').trim().toLowerCase()
  return tiers.find(x => x.modelType.toLowerCase() === t)?.key || tiers[0].key
}
