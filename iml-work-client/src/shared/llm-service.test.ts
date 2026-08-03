import { describe, it, expect } from 'vitest'
import {
  tierKeyOfAlias, parseTierModels, autoAssignTiers, exposesModelId, deriveServiceType,
  modelRef, parseModelRef, parseProviders, migrateLegacyProvider, enabledModels, resolveSelection,
} from './llm-service'

describe('档位别名 → 本地映射键', () => {
  it('三个档位别名都认得', () => {
    expect(tierKeyOfAlias('corp-default')).toBe('standard')
    expect(tierKeyOfAlias('corp-reasoning')).toBe('reasoning')
    expect(tierKeyOfAlias('corp-vision')).toBe('vision')
  })
  it('真实模型名不是别名——认错了会把用户选的模型换掉', () => {
    expect(tierKeyOfAlias('deepseek-chat')).toBeNull()
    expect(tierKeyOfAlias('')).toBeNull()
  })
})

describe('parseTierModels 容错', () => {
  it('坏 JSON / 空值不炸，返回空映射', () => {
    expect(parseTierModels('')).toEqual({})
    expect(parseTierModels('{bad')).toEqual({})
    expect(parseTierModels(null)).toEqual({})
  })
  it('只收字符串且去空白，脏值直接丢掉', () => {
    expect(parseTierModels('{"standard":" a ","reasoning":123,"junk":"x"}')).toEqual({ standard: 'a' })
  })
})

describe('自动分档（导入模型服务的核心一步）', () => {
  const T = (o: Record<string, any>) => o
  it('DeepSeek：chat 进标准档、reasoner 进推理档', () => {
    const r = autoAssignTiers(['deepseek-chat', 'deepseek-reasoner'],
      T({ 'deepseek-chat': { type: 'chat', chatCapable: true }, 'deepseek-reasoner': { type: 'reasoning', chatCapable: true } }))
    expect(r).toEqual({ standard: 'deepseek-chat', reasoning: 'deepseek-reasoner' })
  })
  it('标准档偏好快档命名——日常对话别默认打到贵模型上', () => {
    const r = autoAssignTiers(['agnes-2.5-pro-alpha', 'agnes-2.0-flash'],
      T({ 'agnes-2.5-pro-alpha': { type: 'chat', chatCapable: true }, 'agnes-2.0-flash': { type: 'chat', chatCapable: true } }))
    expect(r.standard).toBe('agnes-2.0-flash')
  })
  it('文生图/文生视频绝不进任何档位——它们不是对话模型', () => {
    const r = autoAssignTiers(['agnes-image-2.0-flash', 'agnes-video-v2.0', 'agnes-2.0-flash'],
      T({ 'agnes-image-2.0-flash': { type: 'chat', chatCapable: false },
          'agnes-video-v2.0': { type: 'chat', chatCapable: false },
          'agnes-2.0-flash': { type: 'chat', chatCapable: true } }))
    expect(Object.values(r)).toEqual(['agnes-2.0-flash'])
  })
  it('拿不到类型判定时只填标准档——宁可少分一档，不瞎猜', () => {
    const r = autoAssignTiers(['m1', 'm2'], T({}))
    expect(r).toEqual({ standard: 'm1' })
  })
})

describe('服务类型判据（既有行为不得回退）', () => {
  it('proxy 恒为企业中转站且不暴露 model id', () => {
    expect(deriveServiceType('proxy', 'http://x/api/v1/model')).toBe('gateway')
    expect(exposesModelId('gateway')).toBe(false)
  })
  it('自配与本地如实显示 model id', () => {
    expect(deriveServiceType('direct', 'https://api.deepseek.com')).toBe('network')
    expect(deriveServiceType('direct', 'http://localhost:11434/v1')).toBe('local')
    expect(exposesModelId('network')).toBe(true)
  })
})

describe('模型引用（跨提供商唯一标识）', () => {
  it('往返一致', () => {
    expect(parseModelRef(modelRef('deepseek', 'deepseek-chat'))).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
  })
  it('模型名里带斜杠也不会被切坏——用 :: 就是为了这个', () => {
    expect(parseModelRef(modelRef('ollama', 'qwen/qwen2.5:7b'))).toEqual({ providerId: 'ollama', model: 'qwen/qwen2.5:7b' })
  })
  it('裸模型名不是合法引用（旧值不能被误当成引用解析）', () => {
    expect(parseModelRef('deepseek-chat')).toBeNull()
    expect(parseModelRef('')).toBeNull()
  })
})

describe('parseProviders 容错', () => {
  it('坏 JSON / 非数组 → 空列表，不炸', () => {
    expect(parseProviders('{')).toEqual([])
    expect(parseProviders('{"a":1}')).toEqual([])
    expect(parseProviders(null)).toEqual([])
  })
  it('缺 id 的条目直接丢弃；字段补默认值', () => {
    const r = parseProviders('[{"name":"没有id"},{"id":"ds","baseUrl":"https://x"}]')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: 'ds', apiMode: 'chat', models: [], enabled: [] })
  })
})

describe('旧单提供商配置迁移', () => {
  it('自配配置迁成一条 provider，并把原模型标为已启用', () => {
    const r = migrateLegacyProvider({ mode: 'direct', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', modelName: 'deepseek-chat', vendorKey: 'deepseek' })
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: 'deepseek', baseUrl: 'https://api.deepseek.com', enabled: ['deepseek-chat'] })
  })
  it('企业中转站模式不迁移——那三个键指向网关，不是提供商', () => {
    expect(migrateLegacyProvider({ mode: 'proxy', baseUrl: 'http://x/api/v1/model', apiKey: 'k', modelName: 'corp-default' })).toEqual([])
  })
  it('没有 baseUrl 不迁移', () => {
    expect(migrateLegacyProvider({ mode: 'direct', baseUrl: '', apiKey: '', modelName: 'm' })).toEqual([])
  })
})

describe('已启用模型汇总（composer 选择器的数据源）', () => {
  const ps = [
    { id: 'ds', vendorKey: 'deepseek', name: 'DeepSeek', baseUrl: 'u', apiKey: 'k', apiMode: 'chat',
      models: ['deepseek-chat', 'deepseek-reasoner'], enabled: ['deepseek-reasoner'] },
    { id: 'km', vendorKey: 'moonshot', name: 'Kimi', baseUrl: 'u', apiKey: 'k', apiMode: 'chat',
      models: ['kimi-k2'], enabled: ['kimi-k2'] },
  ]
  it('跨提供商汇总，带上出处', () => {
    expect(enabledModels(ps)).toEqual([
      { ref: 'ds::deepseek-reasoner', model: 'deepseek-reasoner', provider: 'DeepSeek' },
      { ref: 'km::kimi-k2', model: 'kimi-k2', provider: 'Kimi' },
    ])
  })
  it('上游已下架的模型不再列出——否则用户选中一个必然 404 的模型', () => {
    const stale = [{ ...ps[0], enabled: ['deepseek-chat', '已下架的模型'] }]
    expect(enabledModels(stale).map(x => x.model)).toEqual(['deepseek-chat'])
  })
})

describe('选择解析：档位 → 引用 → 端点/密钥（顺序敏感）', () => {
  const DS = { id: 'ds', vendorKey: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-ds', apiMode: 'chat', models: ['deepseek-chat', 'deepseek-reasoner'], enabled: ['deepseek-chat', 'deepseek-reasoner'] }
  const KM = { id: 'km', vendorKey: 'moonshot', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-km', apiMode: 'chat', models: ['kimi-k2'], enabled: ['kimi-k2'] }
  const base = { mode: 'direct', apiMode: 'chat', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-ds', modelName: 'deepseek-chat' }
  const ctx = { providers: [DS, KM], tiers: { standard: 'ds::deepseek-chat', reasoning: 'ds::deepseek-reasoner' }, defaultRef: 'ds::deepseek-chat' }

  it('选另一家的模型 → 端点与密钥一起换掉', () => {
    // 只换 modelName 而沿用上一家的 baseUrl/apiKey，就是拿 A 家密钥打 B 家端点，必然 401
    const r = resolveSelection(base, 'km::kimi-k2', ctx)
    expect(r).toMatchObject({ baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-km', modelName: 'kimi-k2' })
  })

  it('档位别名 → 先解档位、再解引用（顺序反了就把 "ds::x" 当模型名发出去）', () => {
    const r = resolveSelection(base, 'corp-reasoning', ctx)
    expect(r.modelName).toBe('deepseek-reasoner')
    expect(r.baseUrl).toBe('https://api.deepseek.com')
  })

  it('档位跨厂商也能指——推理档指到 Kimi 就该换成 Kimi 的端点', () => {
    const r = resolveSelection(base, 'corp-reasoning', { ...ctx, tiers: { reasoning: 'km::kimi-k2' } })
    expect(r).toMatchObject({ baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-km', modelName: 'kimi-k2' })
  })

  it('没配该档位 → 回落默认模型，而不是整轮失败', () => {
    const r = resolveSelection(base, 'corp-vision', { ...ctx, tiers: {} })
    expect(r.modelName).toBe('deepseek-chat')
  })

  it('提供商被删掉 → 至少别把 "id::model" 原样当模型名发出去', () => {
    const r = resolveSelection(base, 'gone::some-model', ctx)
    expect(r.modelName).toBe('some-model')
  })

  it('裸模型名原样透传（旧配置/手填的仍然能用）', () => {
    expect(resolveSelection(base, 'deepseek-chat', ctx).modelName).toBe('deepseek-chat')
  })

  it('企业中转站模式完全不走这套——别名要原样发给网关解析', () => {
    const gw = { ...base, mode: 'proxy', modelName: 'corp-default' }
    expect(resolveSelection(gw, 'corp-reasoning', ctx)).toMatchObject({ modelName: 'corp-reasoning', baseUrl: gw.baseUrl })
  })
})
