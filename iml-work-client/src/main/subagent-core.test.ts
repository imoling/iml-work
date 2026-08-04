// 子智能体三条纯规则的单测。这些规则错了都**不会报错**，只会悄悄出事：
// 配额漏了是账单事故、事件闸漏了是界面提前收尾、系统词漏了真实性纪律是子智能体编数据。
import { describe, it, expect } from 'vitest'
import {
  checkQuota, shouldForwardSubEvent, buildSubagentPrompt, subagentHint, SUBAGENT_RULE,
  MAX_SUBAGENTS, TOTAL_BUDGET_MS, SINGLE_BUDGET_MS,
} from './subagent-core'

describe('checkQuota：子智能体的配额闸', () => {
  it('首次派发放行，给单次预算', () => {
    const v = checkQuota(0, 0)
    expect(v.ok).toBe(true)
    expect(v.ok && v.budgetMs).toBe(SINGLE_BUDGET_MS)
  })

  it(`派满 ${MAX_SUBAGENTS} 个就拒——这是防账单事故的硬闸`, () => {
    expect(checkQuota(MAX_SUBAGENTS - 1, 0).ok).toBe(true)
    expect(checkQuota(MAX_SUBAGENTS, 0).ok).toBe(false)
    expect(checkQuota(MAX_SUBAGENTS + 9, 0).ok).toBe(false)
  })

  it('总预算耗尽就拒，即使次数还没用完', () => {
    expect(checkQuota(1, TOTAL_BUDGET_MS).ok).toBe(false)
    expect(checkQuota(1, TOTAL_BUDGET_MS - 5_000).ok).toBe(false)   // 剩 5s 起来也跑不完一步
  })

  it('剩余预算不足单次上限时，按剩余给——不能让最后一个子智能体超支', () => {
    const v = checkQuota(1, TOTAL_BUDGET_MS - 60_000)
    expect(v.ok).toBe(true)
    expect(v.ok && v.budgetMs).toBe(60_000)
  })

  it('拒绝理由必须给出下一步，否则模型换个措辞就再派一次', () => {
    const byCount = checkQuota(MAX_SUBAGENTS, 0)
    const byTime = checkQuota(0, TOTAL_BUDGET_MS)
    expect(byCount.ok).toBe(false)
    expect(byTime.ok).toBe(false)
    // 两条理由都要包含「你该怎么办」，不能只说"不行"
    expect(!byCount.ok && byCount.reason).toMatch(/自己的工具|已有的子智能体结论/)
    expect(!byTime.ok && byTime.reason).toMatch(/自己的工具|已经拿到的结论/)
  })
})

describe('shouldForwardSubEvent：子事件转发闸', () => {
  it('拦掉一轮任务的边界事件——否则主分身还在干活，界面已显示"已完成"', () => {
    expect(shouldForwardSubEvent('turn_start')).toBe(false)
    expect(shouldForwardSubEvent('turn_end')).toBe(false)
    expect(shouldForwardSubEvent('interrupted')).toBe(false)
  })

  it('拦掉 todo_updated——执行计划是主分身的，子智能体不能覆盖', () => {
    expect(shouldForwardSubEvent('todo_updated')).toBe(false)
  })

  it('工具类事件照常转发（子智能体的轨迹要能嵌套显示）', () => {
    for (const t of ['tool_proposed', 'tool_started', 'tool_progress', 'tool_finished'] as const) {
      expect(shouldForwardSubEvent(t)).toBe(true)
    }
  })

  it('narration 转发——渲染层会把它归到子卡上，不会抢主分身的进度行', () => {
    expect(shouldForwardSubEvent('narration')).toBe(true)
  })
})

describe('subagentHint：并列调查的点名提示', () => {
  it('命中实测那句——它自己拆对了三个调查面，却串行搜了 8 次', () => {
    const h = subagentHint('分别调查一下 workbuddy、dumate、loomy 三个产品最近半年的动向，做个对比')
    expect(h).toContain('run_subagent')
    expect(h).toMatch(/一次全部分出去/)   // 要的是"一次全分"（并行），不是"逐个派"
    expect(h).toContain('小分身')          // 用户可见措辞统一，模型照着这里写叙述
    // 不能再抢"第一步"——那是 TODO_RULE 的位置。两条规则都说"第一步"时，
    // 实测模型选了委派、跳过列计划，状态栏整片空白（见 SUBAGENT_RULE 的兜底注释）。
    expect(h).not.toMatch(/第一步/)
  })

  it('两组词必须同时命中——只有"分别"没有调查动词不点名', () => {
    expect(subagentHint('把这三份文件分别改成 PDF')).toBe('')
    expect(subagentHint('分别把附件发给张三和李四')).toBe('')
  })

  it('普通问答不点名（宁可漏，不要冒出莫名其妙的提示）', () => {
    expect(subagentHint('你好')).toBe('')
    expect(subagentHint('帮我查一下今天的报销标准')).toBe('')
    expect(subagentHint('分析一下这份财报')).toBe('')
  })

  it('留否决权：提示里要说明"有依赖就别拆"', () => {
    expect(subagentHint('分别了解一下这几家供应商')).toMatch(/依赖/)
  })
})

describe('SUBAGENT_RULE：常驻委派规则', () => {
  it('判据必须可数——用"几个对象"，不用"复杂/多步"这类形容词', () => {
    expect(SUBAGENT_RULE).toMatch(/2 个以上/)
    expect(SUBAGENT_RULE).toMatch(/不是「难不难」/)
  })
  it('给出理由（上下文会被挤掉），否则模型没有动机改变默认做法', () => {
    expect(SUBAGENT_RULE).toMatch(/独立的上下文/)
  })
  it('明确要求模型对用户用「小分身」措辞——它的叙述是直接上屏给用户看的', () => {
    expect(SUBAGENT_RULE).toContain('小分身')
    expect(SUBAGENT_RULE).toMatch(/别说.*子智能体/)
  })
  it('不与 TODO_RULE 抢「第一步」——两条都说第一步时模型会跳过列计划（实测状态栏空白）', () => {
    expect(SUBAGENT_RULE).toMatch(/先用 todo_write 列出计划/)
    expect(SUBAGENT_RULE).not.toMatch(/第一步就把/)
  })
})

describe('用户可见文案统一为「小分身」（技术词不许漏到界面上）', () => {
  it('配额拒绝理由不带技术黑话——它会被模型转述给用户', () => {
    const byCount = checkQuota(MAX_SUBAGENTS, 0)
    const byTime = checkQuota(0, TOTAL_BUDGET_MS)
    for (const v of [byCount, byTime]) {
      expect(v.ok).toBe(false)
      expect(!v.ok && v.reason).toContain('小分身')
      expect(!v.ok && v.reason).not.toContain('子智能体')
    }
  })

  it('小分身自己的系统词里，本体不叫"主分身/子智能体"', () => {
    const p = buildSubagentPrompt('查点东西')
    expect(p).toContain('小分身')
    expect(p).not.toContain('子智能体')
    expect(p).not.toContain('主分身')
  })
})

describe('buildSubagentPrompt：子智能体系统词', () => {
  const p = buildSubagentPrompt('查清竞品B近半年的产品发布节奏')

  it('带上子任务原文（子智能体只看得见这段，没有对话上文）', () => {
    expect(p).toContain('查清竞品B近半年的产品发布节奏')
  })

  it('说明输出会被直接引用——这是措辞纪律的根据', () => {
    expect(p).toMatch(/直接引用/)
  })

  it('保留真实性红线：不许编造', () => {
    expect(p).toMatch(/严禁编造/)
    expect(p).toMatch(/未查到/)
  })

  it('说清它问不了用户——否则它会把问题写进结论等人回答', () => {
    expect(p).toMatch(/无法向用户提问/)
  })
})

describe('失败要给出可诊断的原因（实测：4 次检索全成功却只报「空手而归(error)」）', () => {
  // 这里测的是**契约**：内核把失败原因记进最后一条 error notice，调用方必须取出来。
  // 取不出来的后果实测过——主分身既判断不了要不要换方式重来，也没法如实告诉用户为什么。
  const pickWhy = (messages: { role: string; content: string; noticeKind?: string }[]) =>
    [...messages].reverse().find(m => m.role === 'notice' && m.noticeKind === 'error')?.content

  it('从消息里取到内核记录的失败原因', () => {
    const msgs = [
      { role: 'user', content: '查一下' },
      { role: 'notice', content: 'context length exceeded: 32768 tokens', noticeKind: 'error' },
    ]
    expect(pickWhy(msgs)).toContain('context length')
  })

  it('多条错误取**最后一条**（最接近真正终止原因的那次）', () => {
    const msgs = [
      { role: 'notice', content: '第一次失败：timeout', noticeKind: 'error' },
      { role: 'assistant', content: '重试' },
      { role: 'notice', content: '第二次失败：429 rate limited', noticeKind: 'error' },
    ]
    expect(pickWhy(msgs)).toContain('429')
  })

  it('中断类 notice 不当成错误原因（那是用户点的停止，不是故障）', () => {
    const msgs = [{ role: 'notice', content: '已中止', noticeKind: 'interrupted' }]
    expect(pickWhy(msgs)).toBeUndefined()
  })

  it('没有错误 notice 时返回 undefined，由调用方退回报 status', () => {
    expect(pickWhy([{ role: 'assistant', content: 'ok' }])).toBeUndefined()
  })
})
