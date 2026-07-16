import { describe, it, expect } from 'vitest'
import { fuzzyPickIndex, FUZZY_PICK_SRC, namedSegments, namedTargetConflict } from './select-match-core'

const OPTS = ['宝钢钢铁数字化项目', '宝钢产线智能改造', '华东电网巡检平台二期']

describe('fuzzyPickIndex 下拉近似匹配', () => {
  it('真实翻车场景：提炼值「华东电网项目」→ 选项「华东电网巡检平台二期」', () => {
    expect(fuzzyPickIndex('华东电网项目', OPTS)).toBe(2)
  })

  it('精确/包含场景照样命中（不倒退）', () => {
    expect(fuzzyPickIndex('宝钢产线智能改造', OPTS)).toBe(1)
    expect(fuzzyPickIndex('产线智能改造', OPTS)).toBe(1)
  })

  it('反向包含：用户说全称、选项是简称', () => {
    expect(fuzzyPickIndex('上海宝钢集团公司', ['宝钢集团', '南方电网'])).toBe(0)
  })

  it('并列不猜：两个选项分不出高下 → -1（交给智能体兜底）', () => {
    // 「宝钢」在两个宝钢选项里得分相同——写操作绝不硬猜
    expect(fuzzyPickIndex('宝钢', OPTS)).toBe(-1)
  })

  it('完全无关 → -1；空值/单字 → -1', () => {
    expect(fuzzyPickIndex('今天天气不错', OPTS)).toBe(-1)
    expect(fuzzyPickIndex('', OPTS)).toBe(-1)
    expect(fuzzyPickIndex('钢', OPTS)).toBe(-1)
  })

  it('可区分的部分匹配：明显赢家才选', () => {
    expect(fuzzyPickIndex('宝钢数字化', OPTS)).toBe(0)
  })

  it('注入源码自包含：eval 后行为与直接调用一致（防止有人在函数体里引外部符号）', () => {
    // eslint-disable-next-line no-eval
    const fn = eval(`(${FUZZY_PICK_SRC})`) as typeof fuzzyPickIndex
    expect(fn('华东电网项目', OPTS)).toBe(2)
    expect(fn('宝钢', OPTS)).toBe(-1)
  })
})

describe('namedTargetConflict 写入技能目标一致性闸', () => {
  const SCRIPT_TARGETS = ['合同审批', '宝钢钢铁数字化项目采购合同', '同意']   // 真实翻车脚本的三步

  it('真实翻车场景：点名「宝钢产线智能改造项目」vs 写死「宝钢钢铁数字化项目采购合同」→ 拦截', () => {
    const c = namedTargetConflict('审批下宝钢产线智能改造项目', SCRIPT_TARGETS)
    expect(c).not.toBeNull()
    expect(c!.target).toBe('宝钢钢铁数字化项目采购合同')
  })
  it('点名与写死目标一致（说全名/说子串）→ 放行', () => {
    expect(namedTargetConflict('审批下宝钢钢铁数字化项目采购合同', SCRIPT_TARGETS)).toBeNull()
    expect(namedTargetConflict('把宝钢钢铁数字化项目的采购合同批了', SCRIPT_TARGETS)).toBeNull()
  })
  it('完全无关的点名（华为 vs 宝钢）→ 拦截', () => {
    expect(namedTargetConflict('审批华为智能基站建设项目合同', SCRIPT_TARGETS)).not.toBeNull()
  })
  it('泛指不点名（"审批下合同"）→ 放行（走原有确认流程）', () => {
    expect(namedTargetConflict('审批下合同', SCRIPT_TARGETS)).toBeNull()
    expect(namedTargetConflict('帮我处理一下合同审批', SCRIPT_TARGETS)).toBeNull()
  })
  it('脚本全是短按钮目标（无写死单据）→ 放行', () => {
    expect(namedTargetConflict('审批下宝钢产线智能改造项目', ['合同审批', '同意'])).toBeNull()
  })
  it('namedSegments 剥前缀：动作词剥净，短残留不算点名', () => {
    expect(namedSegments('审批下宝钢产线智能改造项目')).toEqual(['宝钢产线智能改造项目'])
    expect(namedSegments('审批下合同')).toEqual([])
  })
})
