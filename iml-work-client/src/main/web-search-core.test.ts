import { describe, it, expect } from 'vitest'
import { primarySearchTerm, relevantToTerm, searchTerms, relevantToAny } from './web-search-core'

describe('检索结果相关性过滤', () => {
  it('主体词组：剔除日期串与泛化修饰词，短英文主体（AI）不能漏', () => {
    expect(primarySearchTerm('科大讯飞 最新 股票行情 2026年7月')).toBe('科大讯飞')   // 同长稳定排序取先出现者（主体实体通常在句首）
    expect(primarySearchTerm('科大讯飞 股票 2026年7月')).toBe('科大讯飞')
    expect(searchTerms('2026年7月 新闻')).toEqual([])                 // 日期串+泛化词 → 无主体，不过滤
    // 真实翻车：「昨天 AI 最新动态」主体被抽成「最新动态」→ 细读 8 篇全被滤光，误报"未搜到"
    expect(searchTerms('2026年7月17日 AI 最新动态 行业要闻')).toEqual(['AI'])
    expect(searchTerms('小米 汽车 销量')).toEqual(['小米', '汽车', '销量'])   // 2 字实体词现在参与任一命中
  })
  it('相关性：任一文本段命中任一主体词即相关（英文不分大小写）', () => {
    expect(relevantToTerm('科大讯飞', '中国科学技术大学', '大学简介')).toBe(false)
    expect(relevantToTerm('科大讯飞', '科大讯飞2026年第二季度财报', '')).toBe(true)
    expect(relevantToTerm('科大讯飞', '', undefined, '正文提到科大讯飞股价…')).toBe(true)
    expect(relevantToTerm('', '任何内容')).toBe(true)          // 无主体词 → 不过滤
    expect(relevantToAny(['AI'], 'OpenAI发布新模型', '')).toBe(true)          // 大小写不敏感命中
    expect(relevantToAny(['AI'], '汽车销量周报', '')).toBe(false)
    expect(relevantToAny([], '任何内容')).toBe(true)
    expect(relevantToAny(['小米', '汽车'], '小米SU7上市', '')).toBe(true)     // 任一命中即相关
  })
})
