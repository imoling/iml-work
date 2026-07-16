import { describe, it, expect } from 'vitest'
import { rankByFocus, renderFocusBlock, focusMentioned, matchFieldsToTypes, type FocusLite } from './focus-core'

const NOW = 1_800_000_000

const cand = (text: string) => ({ text })

describe('rankByFocus 消解候选加权', () => {
  it('最近接触过的对象排到前面', () => {
    const focus: FocusLite[] = [{ displayName: '上海 · 宝钢集团', lastSeen: NOW - 3600, touchCount: 3 }]
    const out = rankByFocus([cand('北京 · MDD'), cand('上海 · 宝钢集团'), cand('广州 · 南方电网')], focus, NOW)
    expect(out[0].text).toBe('上海 · 宝钢集团')
  })

  it('候选文本包含画像名（局部匹配）也能命中', () => {
    const focus: FocusLite[] = [{ displayName: '宝钢集团', lastSeen: NOW - 3600, touchCount: 2 }]
    const out = rankByFocus([cand('北京 · MDD'), cand('上海 · 宝钢集团 · CL-2026-0007')], focus, NOW)
    expect(out[0].text).toContain('宝钢')
  })

  it('无画像 / 单候选：原样返回（零开销路径）', () => {
    const cands = [cand('A'), cand('B')]
    expect(rankByFocus(cands, [], NOW)).toEqual(cands)
    expect(rankByFocus([cand('A')], [{ displayName: 'A', lastSeen: NOW, touchCount: 1 }], NOW)).toEqual([cand('A')])
  })

  it('都没匹配上时保持原始顺序（稳定排序——列表页自然顺序有意义）', () => {
    const focus: FocusLite[] = [{ displayName: '完全无关的对象', lastSeen: NOW, touchCount: 9 }]
    const out = rankByFocus([cand('甲'), cand('乙'), cand('丙')], focus, NOW)
    expect(out.map(c => c.text)).toEqual(['甲', '乙', '丙'])
  })

  it('超过 7 天的接触不再抬序（新近度衰减到 0，且频次对数压缩不霸榜）', () => {
    const focus: FocusLite[] = [
      { displayName: '旧客户', lastSeen: NOW - 10 * 86400, touchCount: 50 },
      { displayName: '新客户', lastSeen: NOW - 3600, touchCount: 1 },
    ]
    const out = rankByFocus([cand('旧客户'), cand('新客户')], focus, NOW)
    expect(out[0].text).toBe('新客户')
  })

  it('置顶对象优先于一切', () => {
    const focus: FocusLite[] = [
      { displayName: '热门客户', lastSeen: NOW - 60, touchCount: 30 },
      { displayName: '置顶客户', lastSeen: NOW - 6 * 86400, touchCount: 1, pinned: 1 },
    ]
    const out = rankByFocus([cand('热门客户'), cand('置顶客户')], focus, NOW)
    expect(out[0].text).toBe('置顶客户')
  })
})

describe('renderFocusBlock 画像注入块', () => {
  it('无事件返回空串（不注入空块）', () => {
    expect(renderFocusBlock('宝钢', 'pending', [])).toBe('')
  })
  it('带画像摘要时摘要先于流水；只有摘要没流水也能出块', () => {
    const out = renderFocusBlock('宝钢', '待审批', [{ ts: NOW, summary: '审批差旅' }], '近两周推进宝钢差旅审批，一次退回后重报已通过。')
    expect(out.indexOf('跟进画像')).toBeLessThan(out.indexOf('审批差旅'))
    expect(renderFocusBlock('宝钢', '', [], '只有摘要')).toContain('只有摘要')
  })
  it('带日期、状态与快照声明', () => {
    const out = renderFocusBlock('宝钢集团', '待审批', [{ ts: NOW, summary: '审批通过差旅单' }])
    expect(out).toContain('宝钢集团')
    expect(out).toContain('待审批')
    expect(out).toContain('非实时')
    expect(out).toMatch(/\d+\/\d+：审批通过差旅单/)
  })
})

describe('focusMentioned 消息点名匹配', () => {
  const rows = [
    { displayName: '上海 · 宝钢集团' },
    { displayName: '北京 · MDD' },
    { displayName: '广州南方电网二期项目' },
  ]
  it('片段提及（二元组）也能命中', () => {
    expect(focusMentioned('宝钢那个合同批了吗', rows).map(r => r.displayName)).toEqual(['上海 · 宝钢集团'])
  })
  it('全名直含是强命中，排最前', () => {
    const out = focusMentioned('看下广州南方电网二期项目和宝钢的进展', rows)
    expect(out[0].displayName).toBe('广州南方电网二期项目')
    expect(out.length).toBe(2)
  })
  it('没提及返回空；英文名靠全名匹配', () => {
    expect(focusMentioned('今天天气怎么样', rows)).toEqual([])
    expect(focusMentioned('北京 · MDD 的差旅呢', rows).map(r => r.displayName)).toEqual(['北京 · MDD'])
  })
})

describe('matchFieldsToTypes 技能字段→本体对象映射', () => {
  const TYPES = [
    { typeKey: 'Opportunity', label: '商机', domain: 'CRM' },
    { typeKey: 'Customer', label: '客户', domain: 'CRM' },
    { typeKey: 'Contact', label: '联系人', domain: 'CRM' },
  ]
  it('真实场景：录拜访的确认字段 → 商机 + 联系人（日期/纪要不误沉）', () => {
    const out = matchFieldsToTypes([
      { label: '关联商机', value: '华东电网巡检平台二期' },
      { label: '联系人', value: '李主任' },
      { label: '拜访日期', value: '2026-07-14' },
      { label: '拜访纪要', value: '沟通了项目最新建设情况' },
    ], TYPES)
    expect(out.map(m => `${m.typeKey}:${m.value}`)).toEqual(['Opportunity:华东电网巡检平台二期', 'Contact:李主任'])
  })
  it('取最长标签命中：「联系人」不被短标签抢走', () => {
    const out = matchFieldsToTypes([{ label: '联系人', value: '王五' }],
      [{ typeKey: 'Person', label: '人' }, { typeKey: 'Contact', label: '联系人' }])
    expect(out[0].typeKey).toBe('Contact')
  })
  it('标签含类型词但值是金额/日期 → 不沉（"预计商机金额"不产生假商机对象）', () => {
    const out = matchFieldsToTypes([
      { label: '预计商机金额(元)', value: '50000' },
      { label: '拜访日期', value: '2026-07-15' },
      { label: '关联商机', value: '华东电网巡检平台二期' },
    ], TYPES)
    expect(out.map(m => m.value)).toEqual(['华东电网巡检平台二期'])
  })
  it('空值/超短值不沉；无命中返回空', () => {
    expect(matchFieldsToTypes([{ label: '关联商机', value: '' }, { label: '客户名称', value: 'A' }], TYPES)).toEqual([])
    expect(matchFieldsToTypes([{ label: '备注', value: '随便写点' }], TYPES)).toEqual([])
  })
})
