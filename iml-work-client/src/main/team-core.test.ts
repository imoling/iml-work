// 跨岗位协作的纯规则单测。与 subagent-core.test 同理：这些规则错了都不报错，只悄悄出事——
// 能力边界写宽了就是承诺做不到的事，系统词漏了纪律就是拿别的岗位的名义编意见。
import { describe, it, expect } from 'vitest'
import {
  checkConsultQuota, shouldForwardConsultEvent, buildConsultPrompt, buildTeamRule,
  MAX_CONSULTS, CONSULT_TOTAL_MS, CONSULT_BUDGET_MS, type ExpertProfile,
} from './team-core'

const legal: ExpertProfile = {
  id: 'expert-legal', title: '法务专员',
  spec: '负责合同审查与合规风险把控',
  description: '熟悉采购、销售合同的常见风险条款',
  principles: ['风险揭示优先于结论', '不确定的条款一律标注待商榷'],
  workStyle: ['先看主体资格，再看权利义务对等性'],
  webSearchEnabled: false,
}

describe('checkConsultQuota', () => {
  it('首次放行并给单次预算', () => {
    const v = checkConsultQuota(0, 0)
    expect(v.ok).toBe(true)
    expect(v.ok && v.budgetMs).toBe(CONSULT_BUDGET_MS)
  })
  it(`最多请教 ${MAX_CONSULTS} 个岗位`, () => {
    expect(checkConsultQuota(MAX_CONSULTS - 1, 0).ok).toBe(true)
    expect(checkConsultQuota(MAX_CONSULTS, 0).ok).toBe(false)
  })
  it('总预算耗尽即拒，且剩余不足单次上限时按剩余给', () => {
    expect(checkConsultQuota(0, CONSULT_TOTAL_MS).ok).toBe(false)
    const v = checkConsultQuota(1, CONSULT_TOTAL_MS - 60_000)
    expect(v.ok && v.budgetMs).toBe(60_000)
  })
  it('拒绝理由要给下一步，否则模型换个措辞再问一遍', () => {
    const v = checkConsultQuota(MAX_CONSULTS, 0)
    expect(!v.ok && v.reason).toMatch(/已收到的意见|你自己的知识/)
  })
})

describe('shouldForwardConsultEvent', () => {
  it('边界事件与清单事件拦在闸外（否则主分身还在干活，界面显示已完成）', () => {
    for (const t of ['turn_start', 'turn_end', 'interrupted', 'todo_updated'] as const) {
      expect(shouldForwardConsultEvent(t)).toBe(false)
    }
  })
  it('工具事件与叙述照常转发', () => {
    for (const t of ['tool_proposed', 'tool_finished', 'tool_progress', 'narration'] as const) {
      expect(shouldForwardConsultEvent(t)).toBe(true)
    }
  })
})

describe('buildConsultPrompt：被请教岗位的系统词', () => {
  const p = buildConsultPrompt(legal, '这份供应商合同的付款条款有风险吗？', '账期 90 天，预付 30%')

  it('带上对方岗位的完整画像——否则只是换了个名字的同一个模型', () => {
    expect(p).toContain('法务专员')
    expect(p).toContain('合同审查')
    expect(p).toContain('风险揭示优先于结论')      // principles
    expect(p).toContain('先看主体资格')            // workStyle
  })

  it('问题与背景都要进去（它看不到对话上文）', () => {
    expect(p).toContain('付款条款有风险吗')
    expect(p).toContain('账期 90 天')
  })

  it('**能力边界必须写实**：不能操作业务系统、不能执行技能', () => {
    expect(p).toMatch(/不能.*执行.*技能/)
    expect(p).toMatch(/不能.*登录|操作任何业务系统/)
    // 且要给出"那该怎么办"——否则它会假装查过
    expect(p).toMatch(/我这里查不到|由发起方去处理/)
  })

  it('没有联网权限的岗位，系统词里不许承诺联网', () => {
    expect(p).not.toMatch(/也可以联网/)
    const online = buildConsultPrompt({ ...legal, webSearchEnabled: true }, 'q')
    expect(online).toMatch(/也可以联网/)
  })

  it('保留真实性红线，并点明"以该岗位名义"的额外危险', () => {
    expect(p).toMatch(/严禁编造/)
    expect(p).toMatch(/专业意见.*名义|名义.*写进/)
  })

  it('规定三段式输出（结论/依据/提示）——意见要能被直接引用', () => {
    expect(p).toContain('结论')
    expect(p).toContain('依据')
    expect(p).toContain('提示')
  })
})

describe('buildTeamRule：委派规则', () => {
  const rule = buildTeamRule([{ id: 'expert-legal', title: '法务专员' }, { id: 'expert-fin', title: '财务专员' }])

  it('名单为空时不下发（不能让模型看见一个点不出人的能力）', () => {
    expect(buildTeamRule([])).toBe('')
  })

  it('带上可请教的岗位与 id（模型要按 id 点名）', () => {
    expect(rule).toContain('法务专员')
    expect(rule).toContain('expert-legal')
  })

  it('必须要求指出分歧——那是多岗位会诊相对单分身的唯一硬价值', () => {
    expect(rule).toMatch(/分歧/)
    expect(rule).toMatch(/抹平|帮倒忙/)
  })

  it('不抢「第一步」——那是 TODO_RULE 的位置（小分身规则抢过一次，实测状态栏空白）', () => {
    expect(rule).not.toContain('第一步')
  })
})
