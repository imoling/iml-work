/**
 * 模型服务的三分类判据（单一来源，主进程与渲染层共用）。
 *
 * 为什么要抽出来：设置页(LlmTab)靠 connectionMode + baseUrl 反推服务类型来回显厂商预设，
 * composer 的模型选择器要靠**同一个判据**决定「显不显示真实 model id」。两处各写一遍，
 * 迟早会漂移成"设置页认为是本地、选择器认为是直连"这种自相矛盾的状态。
 *
 * 叶子纪律：纯函数，不 import electron / db / 任何主进程模块（渲染层要直接 import）。
 */

export type ServiceType = 'gateway' | 'network' | 'local'

/** 本地推理端点的特征：回环地址，或 Ollama/LM Studio/vLLM 的约定端口。 */
const LOCAL_ENDPOINT = /localhost|127\.0\.0\.1|11434|1234|:8000/

/**
 * 由已保存的连接配置反推服务类型。
 * proxy 模式恒为企业中转站（密钥是网关哨兵 key，baseUrl 指向管理端）；
 * 其余按 baseUrl 区分本机推理与厂商直连。
 */
export function deriveServiceType(mode: string, baseUrl: string): ServiceType {
  if (mode === 'proxy') return 'gateway'
  return LOCAL_ENDPOINT.test((baseUrl || '').toLowerCase()) ? 'local' : 'network'
}

/**
 * 该服务类型下是否向用户暴露真实 model id。
 *
 * 判据是**这套配置归谁所有**，不是"要不要保护用户"：
 * - gateway：模型由管理端统一调度，员工看到 `deepseek-chat` 这类字符串没有决策价值，
 *   反而把后端选型泄漏进终端界面；且管理员随时可换上游，界面锁死一个 id 就成了谎报。
 *   → 只显示语义档位（如"企业模型 · 快 / 强"）。
 * - network / local：baseUrl 与 model id 本来就是用户自己在设置页敲进去的，
 *   composer 里藏起来反而与设置页不一致。→ 如实显示。
 */
export function exposesModelId(t: ServiceType): boolean {
  return t !== 'gateway'
}

/**
 * 走自配模型 = 业务数据绕过企业中转站，直接流向用户自填的厂商端点。
 * 选择器需要据此给出可见标注（分组标题/角标），企业分发形态下还要能被管理端禁用。
 */
export function bypassesCorpGateway(t: ServiceType): boolean {
  return t === 'network'
}

/**
 * 会话级模型选择的 config 键。放在这里是因为**读写方与清理方分处两个模块**：
 * llm.ts 读写（解析生效模型），db.ts 在 convDelete 里清理（db 是叶子，不能反向 import llm）。
 * 键名散成两份字面量的话，改一处漏一处就会留下永久孤儿键。
 */
export const convModelKey = (convId: string) => `llm-conv-model:${convId}`

// ── 自配模式的档位映射 ────────────────────────────────────────────────
//
// 企业中转站模式下，「档位 → 实际模型」由网关按通道 modelType 解析，客户端只发别名。
// 自配模式没有网关做这一步，所以档位映射必须存在客户端本地——否则员工自配了 DeepSeek，
// 就只能二选一：要么全程 deepseek-chat（复杂推理不够用），要么全程 deepseek-reasoner
// （日常对话又慢又贵）。一份配置同时配好多档，才是「导入一个模型服务」而不是「填一个模型名」。

/** config 键。读写方在 llm.ts、清理与白名单在 db.ts、编辑在 LlmTab —— 键名只此一处。 */
export const TIER_MODELS_KEY = 'llm-tier-models'

export type TierKey = 'standard' | 'reasoning' | 'vision'
export type TierModels = Partial<Record<TierKey, string>>

/** 档位别名（与后端 ModelTiers 的 alias 一致）→ 本地映射的键。不是别名就返回 null。 */
export function tierKeyOfAlias(alias: string): TierKey | null {
  switch ((alias || '').trim().toLowerCase()) {
    case 'corp-default': return 'standard'
    case 'corp-reasoning': return 'reasoning'
    case 'corp-vision': return 'vision'
    default: return null
  }
}

export function parseTierModels(raw: string | null | undefined): TierModels {
  try {
    const o = JSON.parse(raw || '{}')
    if (!o || typeof o !== 'object') return {}
    const out: TierModels = {}
    for (const k of ['standard', 'reasoning', 'vision'] as TierKey[]) {
      const v = o[k]
      if (typeof v === 'string' && v.trim()) out[k] = v.trim()
    }
    return out
  } catch { return {} }
}

/**
 * 从拉取到的模型列表自动分档（"导入模型服务"的核心一步）。
 *
 * 判据来自后端 ModelTypeGuess（`/model/guess-types`），客户端不另抄一套规则——
 * 抄一份的下场是两端对同一个模型给出不同档位。
 * types 缺失时只填标准档：宁可少分一档让用户自己补，也不要瞎猜把日常对话打到贵模型上。
 */
export function autoAssignTiers(
  models: string[],
  types: Record<string, { type?: string; chatCapable?: boolean }>,
): TierModels {
  const chat = models.filter(m => types[m]?.chatCapable !== false)
  const reasoning = chat.filter(m => types[m]?.type === 'reasoning')
  const plain = chat.filter(m => types[m]?.type !== 'reasoning')
  // 标准档偏好快档命名（日常对话要便宜快），没有就取第一个可对话模型
  const fast = plain.find(m => /flash|mini|lite|turbo|fast|air/i.test(m)) || plain[0]
  const out: TierModels = {}
  if (fast) out.standard = fast
  if (reasoning[0]) out.reasoning = reasoning[0]
  return out
}

// ── 多提供商并存 ──────────────────────────────────────────────────────
//
// 企业中转站已经承担了"统一调度多家"的角色；员工自配如果只能连一家，它就只是个降级备胎。
// 而真正会去自配的人，恰恰是想混着用不同厂商的长处（这家的推理强、那家的长上下文便宜）。
// 所以自配侧改成**多提供商并存**：每家独立密钥与连接状态，勾选的模型汇总进 composer 选择器。
//
// 只作用于自配（network/local）。企业中转站模式完全不走这套——那边的多通道调度在服务端。

export const PROVIDERS_KEY = 'llm-providers'
/** 新会话的默认模型（引用形如 `providerId::model`）。 */
export const DEFAULT_MODEL_KEY = 'llm-default-model'

export interface LlmProvider {
  /** 稳定 id：厂商预设用 vendorKey（deepseek…），自定义用 custom-<n>。删掉再加不复用旧 id。 */
  id: string
  vendorKey: string
  name: string
  baseUrl: string
  apiKey: string
  /** chat（OpenAI 兼容）| anthropic */
  apiMode: string
  /** 上次拉取到的全部模型 */
  models: string[]
  /** 勾选的模型：只有这些出现在 composer 选择器里 */
  enabled: string[]
}

/** 模型引用：跨提供商唯一。用 `::` 是因为模型名里可能含 `/`（如 qwen/qwen2.5）但不会含它。 */
export function modelRef(providerId: string, model: string): string {
  return `${providerId}::${model}`
}
export function parseModelRef(ref: string): { providerId: string; model: string } | null {
  const i = (ref || '').indexOf('::')
  if (i <= 0) return null
  return { providerId: ref.slice(0, i), model: ref.slice(i + 2) }
}

export function parseProviders(raw: string | null | undefined): LlmProvider[] {
  try {
    const a = JSON.parse(raw || '[]')
    if (!Array.isArray(a)) return []
    return a.filter(p => p && typeof p.id === 'string' && p.id).map(p => ({
      id: String(p.id),
      vendorKey: String(p.vendorKey || 'custom'),
      name: String(p.name || p.id),
      baseUrl: String(p.baseUrl || ''),
      apiKey: String(p.apiKey || ''),
      apiMode: String(p.apiMode || 'chat'),
      models: Array.isArray(p.models) ? p.models.filter((m: unknown) => typeof m === 'string' && m) : [],
      enabled: Array.isArray(p.enabled) ? p.enabled.filter((m: unknown) => typeof m === 'string' && m) : [],
    }))
  } catch { return [] }
}

/**
 * 旧的单提供商配置 → 迁移成一条 provider。
 *
 * 老用户本地存的是 llm-base-url / llm-api-key / llm-model-name 三个平铺键。
 * 不迁移的话，升级后设置页会显示"一个提供商都没有"，而对话其实还在用那套旧配置——
 * 界面与实际行为对不上，用户会以为配置丢了然后重填一遍。
 * 只在自配模式下迁移；企业中转站模式那三个键指向网关，不是提供商。
 */
export function migrateLegacyProvider(o: {
  mode: string; baseUrl: string; apiKey: string; modelName: string; apiMode?: string; vendorKey?: string; name?: string
}): LlmProvider[] {
  if (o.mode === 'proxy' || !o.baseUrl) return []
  const id = o.vendorKey || 'legacy'
  const model = (o.modelName || '').trim()
  return [{
    id, vendorKey: id, name: o.name || id,
    baseUrl: o.baseUrl, apiKey: o.apiKey || '', apiMode: o.apiMode || 'chat',
    models: model ? [model] : [],
    enabled: model ? [model] : [],
  }]
}

/** 所有已勾选的模型，按提供商展开成可渲染的扁平列表（composer 选择器用）。 */
export function enabledModels(list: LlmProvider[]): { ref: string; model: string; provider: string }[] {
  const out: { ref: string; model: string; provider: string }[] = []
  for (const p of list) {
    for (const m of p.enabled) {
      if (p.models.length && !p.models.includes(m)) continue   // 上游已下架的模型不再列出
      out.push({ ref: modelRef(p.id, m), model: m, provider: p.name })
    }
  }
  return out
}

/**
 * 把「用户选的东西」解析成实际连接参数。**纯函数**，主进程与测试共用。
 *
 * 顺序不能反：先解档位、再解引用。
 * 档位映射里存的可能**本身就是跨提供商引用**（推理档 = ds::deepseek-reasoner），
 * 先解引用的话，corp-reasoning 这一步还没发生，引用解析看到的只是个别名、原样放过，
 * 最后就把字面量 "ds::deepseek-reasoner" 当模型名发给上游 → 400。
 *
 * @param picked 会话里选的（可能是档位别名 / 跨提供商引用 / 裸模型名 / 空）
 */
export function resolveSelection(
  base: { mode: string; apiMode: string; baseUrl: string; apiKey: string; modelName: string },
  picked: string,
  ctx: { providers: LlmProvider[]; tiers: TierModels; defaultRef: string },
): { mode: string; apiMode: string; baseUrl: string; apiKey: string; modelName: string } {
  if (base.mode === 'proxy') return picked ? { ...base, modelName: picked } : base

  let name = (picked || base.modelName || '').trim()

  // ① 档位别名 → 该档位配的模型（可能是引用）
  const tk = tierKeyOfAlias(name)
  if (tk) name = ctx.tiers[tk] || ctx.defaultRef || base.modelName

  // ② 跨提供商引用 → 换端点、密钥、协议
  const ref = parseModelRef(name)
  if (!ref) return { ...base, modelName: name }
  const p = ctx.providers.find(x => x.id === ref.providerId)
  // 提供商已被删掉：至少别把 "id::model" 原样当模型名发出去
  if (!p) return { ...base, modelName: ref.model }
  return { mode: base.mode, apiMode: p.apiMode || base.apiMode, baseUrl: p.baseUrl, apiKey: p.apiKey, modelName: ref.model }
}
