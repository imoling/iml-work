// 深度调研的纯函数单测：规划失败时的兜底检索词。
// 为什么值得钉：这条路径**只在模型挂掉时才走**，平时跑一百次也覆盖不到，
// 而它一旦产出不可搜的检索词，整条调研会以"素材不足"收场（2026-08-05 实锤）。
// deep-research 依赖链触电（db→electron、web-search→BrowserWindow），全部桩掉，只测本模块的纯逻辑。
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, BrowserWindow: class {}, safeStorage: {} }))
vi.mock('./db', () => ({ configGet: () => '', configSet: () => {} }))
vi.mock('./llm', () => ({ callLlm: async () => '', tierModel: () => '' }))
vi.mock('./web-search', () => ({
  webSearch: async () => null, followUpSearches: async () => [], outcomeBlock: () => '', lowTrustNotice: () => '',
}))
vi.mock('./workspace-files', () => ({ workspaceDir: () => '/tmp' }))
vi.mock('./artifact-index', () => ({ uniqueArtifactName: (_d: string, n: string) => n, registerArtifact: () => {} }))
vi.mock('./skill-exec', () => ({ CHART_PROTOCOL_HINT: '' }))
vi.mock('./automation-runtime', () => ({ runningState: { aborted: false } }))

const { fallbackQuery } = await import('./deep-research')

describe('fallbackQuery（规划失败兜底检索词）', () => {
  it('剥掉「深度调研」动词与交付指令，只留可搜的主体+主题', () => {
    const q = fallbackQuery('深度调研科大讯飞在教育AI市场的竞品格局，产出结构化调研报告（Markdown交付）')
    expect(q).toBe('科大讯飞在教育AI市场的竞品格局')
    expect(q).not.toMatch(/报告|Markdown|产出/)
  })

  it('不切在半个词上（旧实现 slice(0,40) 会切出「（Markdown交」这种残句）', () => {
    const q = fallbackQuery('调研新能源车 2026 上半年销量格局，输出一份对比报告')
    expect(q).toBe('调研新能源车 2026 上半年销量格局'.replace(/^调研/, ''))
    expect(q.endsWith('交')).toBe(false)
  })

  it('本来就是干净短问句 → 原样返回', () => {
    expect(fallbackQuery('宁德时代 2026 Q2 装机量')).toBe('宁德时代 2026 Q2 装机量')
  })

  it('削完太短 → 退回原句，不给空串（空检索词等于放弃）', () => {
    const q = fallbackQuery('调研一下')
    expect(q.length).toBeGreaterThan(0)
  })

  it('超长任务句截到 40 字以内（检索引擎对长句召回极差）', () => {
    expect(fallbackQuery('分析' + '半导体设备国产化率'.repeat(10)).length).toBeLessThanOrEqual(40)
  })
})
