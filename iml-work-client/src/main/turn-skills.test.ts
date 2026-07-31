// 技能工具化的单测。重点钉两条安全语义：
// ① 只读档不得执行写技能（旧链路出过「只读模式下看考勤却真打了卡」的事故，工具化后这道闸必须跟着搬过来）；
// ② 判不出技能读写属性时按**写**处理（宁可多拦一道，也不能漏放一次真实写入）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRunCustomSkill = vi.fn()
const mockIsWriteSkill = vi.fn()
const SKILLS = [
  { id: 'skill-read', name: '查待办', description: '读取统一待办列表', triggerKeywords: [], allowedRoles: [], sopContent: '' },
  { id: 'skill-write', name: '上班打卡', description: '在考勤系统打卡', triggerKeywords: [], allowedRoles: [], sopContent: '' },
]

vi.mock('./skill-store', () => ({
  loadLocalSkills: () => {},
  getLoadedSkills: () => SKILLS,
  skillLabel: (s: any) => s?.name || s?.id || '',
  skillDisplayName: () => undefined,   // 未缓存展示名：走"name 等于 id 就不重复显示"的分支
}))
vi.mock('./skill-orchestrator', () => ({ scopedSkillsFor: () => scoped }))
vi.mock('./skill-custom', () => ({ runCustomSkill: (...a: unknown[]) => mockRunCustomSkill(...a) }))
vi.mock('./skill-exec', () => ({ isWriteSkill: (...a: unknown[]) => mockIsWriteSkill(...a) }))
const mockExtract = vi.fn(async (..._a: unknown[]) => '')
vi.mock('./workspace-files', () => ({ workspaceDir: () => '/ws', extractFileText: (p: string) => mockExtract(p) }))

const { makeSkillTools } = await import('./turn-skills')

const logs: string[] = []
const ctx = { sendLog: ((_t: string, text: string) => { logs.push(text) }) as any }
const trace = { markRoute: () => {}, submit: async () => {} } as any

let scoped = SKILLS
function build(a?: 'readonly' | 'full' | any[], b?: 'readonly' | 'full') {
  const permMode = (Array.isArray(a) ? b : a) || 'full'
  scoped = Array.isArray(a) ? a : SKILLS
  return makeSkillTools({ data: { permMode, content: 'x' } as any, trace, expertId: 'e1' })
}

beforeEach(() => {
  mockRunCustomSkill.mockReset(); mockIsWriteSkill.mockReset(); logs.length = 0
  mockRunCustomSkill.mockImplementation(async (_s: any, _l: any, _d: any, _sl: any, _t: any, out: any) => {
    out.skillResult = '执行结果'
    return null
  })
  mockIsWriteSkill.mockResolvedValue(false)
  mockExtract.mockReset(); mockExtract.mockResolvedValue('')
})

describe('技能目录（渐进披露）', () => {
  it('目录带上触发词——那是"什么话该用这个技能"的最强线索', () => {
    const { catalog } = build([
      { ...SKILLS[0], triggerKeywords: ['待办', '统一待办'] },
      SKILLS[1],
    ])
    expect(catalog).toContain('skill-read')
    expect(catalog).toContain('〔待办、统一待办〕')
    expect(catalog).toContain('读取统一待办列表')
    expect(catalog).toContain('run_skill')
    expect(catalog).not.toContain('sopContent')   // 渐进披露：正文留到执行时才读
  })

  it('name 等于 id 时不重复显示（实测目录曾长成「skill-x：skill-x —— …」，模型认不出）', () => {
    const { catalog } = build()
    expect(catalog).not.toContain('skill-read skill-read')
  })

  it('本岗位无技能 → 不注册工具也不给目录（免得诱导模型瞎调）', async () => {
    vi.resetModules()
    vi.doMock('./skill-orchestrator', () => ({ scopedSkillsFor: () => [] }))
    const { makeSkillTools: fresh } = await import('./turn-skills')
    const h = fresh({ data: {} as any, trace, expertId: 'e1' })
    expect(h.specs).toHaveLength(0)
    expect(h.catalog).toBe('')
    vi.doUnmock('./skill-orchestrator')
    vi.resetModules()
  })
})

describe('只读档拦截（安全红线）', () => {
  it('只读 + 写技能 → 拦截，绝不执行', async () => {
    mockIsWriteSkill.mockResolvedValue(true)
    const out = await build('readonly').specs[0].run({ skillId: 'skill-write' }, ctx)
    expect(mockRunCustomSkill).not.toHaveBeenCalled()
    expect(out).toContain('只读模式')
    expect(logs.join()).toContain('🔒')
  })

  it('只读 + 读技能 → 照常执行', async () => {
    mockIsWriteSkill.mockResolvedValue(false)
    const out = await build('readonly').specs[0].run({ skillId: 'skill-read' }, ctx)
    expect(mockRunCustomSkill).toHaveBeenCalledOnce()
    expect(out).toBe('执行结果')
  })

  it('读写属性判不出来时按**写**处理——宁可多拦，不能漏放', async () => {
    mockIsWriteSkill.mockRejectedValue(new Error('后端不可达'))
    const out = await build('readonly').specs[0].run({ skillId: 'skill-write' }, ctx)
    expect(mockRunCustomSkill).not.toHaveBeenCalled()
    expect(out).toContain('只读模式')
  })

  it('完全权限档不拦（技能内部有自己的确认卡，不在这里再包一层）', async () => {
    mockIsWriteSkill.mockResolvedValue(true)
    await build('full').specs[0].run({ skillId: 'skill-write' }, ctx)
    expect(mockRunCustomSkill).toHaveBeenCalledOnce()
  })
})

describe('执行结果回灌', () => {
  it('未知技能 → 列出可用技能让模型自纠', async () => {
    const out = await build().specs[0].run({ skillId: 'skill-ghost' }, ctx)
    expect(out).toContain('没有找到技能')
    expect(out).toContain('skill-read')
  })

  it('技能早返回（表单取消/安全闸拦截）→ 原样回灌它的终态', async () => {
    mockRunCustomSkill.mockResolvedValue({ content: '🚫 已取消，未做任何改动。', success: true })
    const out = await build().specs[0].run({ skillId: 'skill-write' }, ctx)
    expect(out).toContain('已取消')
  })

  it('技能抛错 → 如实回灌，并要求不得编造结果', async () => {
    mockRunCustomSkill.mockRejectedValue(new Error('沙箱不可用'))
    const out = await build().specs[0].run({ skillId: 'skill-read' }, ctx)
    expect(out).toContain('沙箱不可用')
    expect(out).toContain('不要编造')
  })

  it('产出文件被收集（结果卡的文件卡要用）', async () => {
    mockRunCustomSkill.mockImplementation(async (_s: any, _l: any, _d: any, _sl: any, _t: any, out: any) => {
      out.skillResult = '已生成'
      out.skillFiles = [{ name: '汇报.pptx', sizeBytes: 12345 }]
      return null
    })
    const h = build()
    await h.specs[0].run({ skillId: 'skill-read' }, ctx)
    expect(h.files()).toEqual([{ name: '汇报.pptx', sizeBytes: 12345 }])
  })
})

describe('失败要说清原因（不许用"环境问题"搪塞）', () => {
  it('skillOk=false → 回灌具体原因并禁止模糊措辞', async () => {
    mockRunCustomSkill.mockImplementation(async (_s: any, _l: any, _d: any, _sl: any, _t: any, out: any) => {
      out.skillOk = false
      out.skillPromptHint = '依赖包不在沙箱出网白名单：python-pptx'
      return null
    })
    const out = await build().specs[0].run({ skillId: 'skill-read' }, ctx)
    expect(out).toContain('python-pptx')          // 具体原因必须带上
    expect(out).toContain('未能成功执行')
    expect(out).toContain('不要用')               // 明确禁止模糊搪塞
  })

  it('skillOk 未标注时按成功处理（存量技能不都会设这个字段）', async () => {
    const out = await build().specs[0].run({ skillId: 'skill-read' }, ctx)
    expect(out).toBe('执行结果')
  })
})


describe('外层计划与产物一致性（实测：说好 SWOT，文档里没有）', () => {
  it('task 参数传导给技能——技能只看得见这段文字，不传它就只拿用户原话', async () => {
    await build().specs[0].run({ skillId: 'skill-read', task: '按以下大纲写文档：一、SWOT 二、定价' }, ctx)
    const dataArg = mockRunCustomSkill.mock.calls[0][2] as { content: string }
    expect(dataArg.content).toBe('按以下大纲写文档：一、SWOT 二、定价')
  })

  it('不传 task → 技能拿用户原话（兼容既有行为）', async () => {
    await build().specs[0].run({ skillId: 'skill-read' }, ctx)
    const dataArg = mockRunCustomSkill.mock.calls[0][2] as { content: string }
    expect(dataArg.content).toBe('x')
  })

  it('有产物 → 回读真实内容节选并附上汇报纪律（不许按设想描述文档）', async () => {
    mockRunCustomSkill.mockImplementation(async (_s: any, _l: any, _d: any, _sl: any, _t: any, out: any) => {
      out.skillResult = '已生成'
      out.skillFiles = [{ name: '竞品分析.docx', sizeBytes: 100 }]
      return null
    })
    mockExtract.mockResolvedValue('一、平台覆盖度…… 二、核心功能对比…… 三、定价策略……')
    const outText = await build().specs[0].run({ skillId: 'skill-read' }, ctx)
    expect(outText).toContain('真实内容节选')
    expect(outText).toContain('平台覆盖度')
    expect(outText).toContain('概述文件里的关键内容')   // 交付纪律：必须概述，不许只说'已生成'
    expect(outText).toContain('真实节选')
  })

  it('产物解析失败 → 不炸，返回原执行说明', async () => {
    mockRunCustomSkill.mockImplementation(async (_s: any, _l: any, _d: any, _sl: any, _t: any, out: any) => {
      out.skillResult = '已生成'
      out.skillFiles = [{ name: 'x.docx', sizeBytes: 1 }]
      return null
    })
    mockExtract.mockRejectedValue(new Error('解析失败'))
    expect(await build().specs[0].run({ skillId: 'skill-read' }, ctx)).toBe('已生成')
  })
})

describe('触发词点名提示（软规则拦不住"自己当引擎跑"，点名比规则硬）', () => {
  it('命中触发词 → 点名该技能并要求第一步就调', () => {
    const h = build([{ ...SKILLS[0], triggerKeywords: ['深度调研', '调研报告'] }, SKILLS[1]])
    const hint = h.triggerHint('深度调研下当前桌面智能体的市场分析')
    expect(hint).toContain('「深度调研」')
    expect(hint).toContain('skill-read')
    expect(hint).toContain('第一步就调 run_skill')
    expect(hint).toContain('确实不相符才可以不调')   // 保留否决权，防触发词截胡复辟
  })

  it('未命中 → 空串（不添噪音）', () => {
    const h = build([{ ...SKILLS[0], triggerKeywords: ['深度调研'] }, SKILLS[1]])
    expect(h.triggerHint('今天天气怎么样')).toBe('')
  })
})
