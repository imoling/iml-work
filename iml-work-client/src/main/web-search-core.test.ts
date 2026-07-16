import { describe, it, expect } from 'vitest'
import { primarySearchTerm, relevantToTerm } from './web-search-core'

describe('检索结果相关性过滤', () => {
  it('主体词：取最长非日期串（真实翻车：「科大讯飞」搜出中国科学技术大学）', () => {
    expect(primarySearchTerm('科大讯飞 最新 股票行情 2026年7月')).toBe('科大讯飞')   // 同长稳定排序取先出现者（主体实体通常在句首）
    expect(primarySearchTerm('科大讯飞 股票 2026年7月')).toBe('科大讯飞')
    expect(primarySearchTerm('2026年7月 新闻')).toBe('')     // 日期串不算主体，短词不判定
    expect(primarySearchTerm('小米 汽车 销量')).toBe('')      // 全是 2 字词 → 保守不过滤
  })
  it('相关性：任一文本段含主体词即相关', () => {
    expect(relevantToTerm('科大讯飞', '中国科学技术大学', '大学简介')).toBe(false)
    expect(relevantToTerm('科大讯飞', '科大讯飞2026年第二季度财报', '')).toBe(true)
    expect(relevantToTerm('科大讯飞', '', undefined, '正文提到科大讯飞股价…')).toBe(true)
    expect(relevantToTerm('', '任何内容')).toBe(true)          // 无主体词 → 不过滤
  })
})
