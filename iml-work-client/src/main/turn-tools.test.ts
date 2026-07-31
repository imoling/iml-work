// browse 工具的写前签字闸单测——阶段 2 把「写保护」从路由词表挪到工具层，这里钉住新语义。
//
// 为什么重要：旧链路靠 writeVerb 中文动词表判断"这是不是写任务"，判漏就等于无确认写入。
// 新链路里那张表只决定走哪个引擎，真正的闸在 browse 点击写按钮的一刻——
// 所以「词表判漏了，闸还拦不拦得住」必须有测试盯着。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockConfirm = vi.fn()
vi.mock('./confirm-token', () => ({
  requestSignedConfirmation: (...a: unknown[]) => mockConfirm(...a),
  tokenStateNote: (s: string) => `token:${s}`,
}))

// automation-runtime 拉 electron（emitToRenderer）；ask_user 只需要表单通道，整层桩掉。
const mockForm = vi.fn()
// currentRun 可被单测改写：批量授权用例往 batchApproved 里塞键
let mockRunCtx: { batchApproved: Set<string> } | undefined
vi.mock('./automation-runtime', () => ({
  requestFormConfirmation: (...a: unknown[]) => mockForm(...a),
  currentRun: () => mockRunCtx,
}))
vi.mock('./window-ref', () => ({ emitToRenderer: vi.fn() }))

// 只读工具工厂与 browse 同处一个文件，但它那条链（agent-tools → web-search → http → db）
// 会拉起 electron。本测试与它无关，整层桩掉。
const stubTool = (name: string) => ({ name, description: name, argsHint: '{}', run: async () => '' })
vi.mock('./agent-tools', () => ({
  makeWebSearchTool: () => stubTool('web_search'),
  makePythonTool: () => stubTool('python'),
  makeReadPageTool: () => stubTool('read_page'),
  makeReadFileTool: () => stubTool('read_file'),
  workspaceFileList: () => [],
}))

// agent-browse 依赖 electron 的 BrowserWindow；这里只关心工具**拿到了什么 onWriteConfirm**，
// 所以把 makeBrowseTool 换成一个把钩子暴露出来的桩。
let capturedConfirm: ((c: { actionLabel: string; pageText: string }) => Promise<boolean>) | undefined
vi.mock('./agent-browse', () => ({
  makeBrowseTool: (opts: any) => {
    capturedConfirm = opts?.onWriteConfirm
    return { name: 'browse', description: 'browse', argsHint: '{"action":"goto"}', run: async () => 'ok' }
  },
}))

const { browseTools, askUserTool, needsWorkspaceFiles, wantsGeneratedFile } = await import('./turn-tools')
const { WRITE_TASK_VERB } = await import('./write-intent-core')

const logs: string[] = []
const sendLog = (_t: string, text: string) => { logs.push(text) }

beforeEach(() => { mockConfirm.mockReset(); mockForm.mockReset(); logs.length = 0; capturedConfirm = undefined; mockRunCtx = undefined })

function buildAndGetConfirm(over: Partial<Parameters<typeof browseTools>[0]> = {}) {
  browseTools({ permMode: 'full', sendLog: sendLog as any, systemName: '讯飞OA', partition: 'persist:bizsys-x', ...over })
  if (!capturedConfirm) throw new Error('onWriteConfirm 未注入——写保护会整个失效')
  return capturedConfirm
}

describe('browse 写前签字闸', () => {
  it('钩子必须注入（漏传 = 写保护静默失效）', () => {
    expect(buildAndGetConfirm()).toBeTypeOf('function')
  })

  it('只读档：写按钮直接拒，不弹卡', async () => {
    const confirm = buildAndGetConfirm({ permMode: 'readonly' })
    expect(await confirm({ actionLabel: '提交', pageText: '差旅申请' })).toBe(false)
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(logs.join()).toContain('只读模式')
  })

  it('无人值守：不替用户签字', async () => {
    const confirm = buildAndGetConfirm({ unattended: true })
    expect(await confirm({ actionLabel: '提交', pageText: 'x' })).toBe(false)
    expect(mockConfirm).not.toHaveBeenCalled()
  })

  it('正常档：签字通过才放行，且确认卡摆出按钮与页面摘要供核对', async () => {
    mockConfirm.mockResolvedValue({ values: { ok: '1' }, tokenState: 'consumed' })
    const confirm = buildAndGetConfirm()
    expect(await confirm({ actionLabel: '审批通过', pageText: '合同 HT-2026-0028  金额 120 万' })).toBe(true)
    const fields = mockConfirm.mock.calls[0][0] as { name: string; value: string }[]
    expect(fields.find(f => f.name === '_act')?.value).toBe('审批通过')
    expect(fields.find(f => f.name === '_page')?.value).toContain('HT-2026-0028')
  })

  it('令牌被拒 → 不点击', async () => {
    mockConfirm.mockResolvedValue({ values: null, tokenState: 'rejected', rejectReason: '已过期' })
    expect(await buildAndGetConfirm()({ actionLabel: '删除', pageText: 'x' })).toBe(false)
  })

  it('用户取消 → 不点击', async () => {
    mockConfirm.mockResolvedValue({ values: null, tokenState: 'cancelled' })
    expect(await buildAndGetConfirm()({ actionLabel: '提交', pageText: 'x' })).toBe(false)
  })
})

describe('写任务动词表（只选引擎，不再当安全判据）', () => {
  it('典型写任务命中', () => {
    for (const q of ['在OA里提交差旅申请', '把合同审批通过', '帮我打卡', '新建一个工单']) {
      expect(WRITE_TASK_VERB.test(q)).toBe(true)
    }
  })

  it('典型读任务不命中', () => {
    for (const q of ['打开讯飞OA看待办', '看看考勤记录', '查一下我的统一待办']) {
      expect(WRITE_TASK_VERB.test(q)).toBe(false)
    }
  })

  it('词表判漏的说法（「补个卡」「作废掉」）——正因如此才不能拿它当安全闸', async () => {
    // 这两句实际上是写意图，但动词表认不出来。旧链路里这就等于绕过写保护；
    // 新链路里它只是走进通用内核，真要点写按钮时照样被上面那道签字闸拦下。
    expect(WRITE_TASK_VERB.test('帮我补个卡')).toBe(false)
    expect(WRITE_TASK_VERB.test('这单作废掉')).toBe(false)
    // 兜底成立的证据：只读档下，工具层照拒不误。
    const confirm = buildAndGetConfirm({ permMode: 'readonly' })
    expect(await confirm({ actionLabel: '补卡', pageText: '考勤维护' })).toBe(false)
  })
})

describe('工作空间访问判定（防"拿文件回答一切"）', () => {
  const files = ['iML Work 企业执行操作系统.pdf', 'implementation_plan.md', '股票分析报告.xlsx']

  it('实测踩过的两个坑：问身份、问待办都不该去翻工作空间', () => {
    // 图1：问「我是谁」，分身翻了一堆报告来猜用户职业
    expect(needsWorkspaceFiles('我是谁', files)).toBe(false)
    expect(needsWorkspaceFiles('叫我什么', files)).toBe(false)
    // 图2：问「我的待办」，分身从几份报告里编出一张待办清单（踩不虚构业务数据的红线）
    expect(needsWorkspaceFiles('我的待办', files)).toBe(false)
    expect(needsWorkspaceFiles('今天天气怎么样', files)).toBe(false)
  })

  it('确实与文件有关时才放行', () => {
    expect(needsWorkspaceFiles('【附件】「x.xlsx」（已加入工作空间）\n帮我算总额', files)).toBe(true)
    expect(needsWorkspaceFiles('总结一下 implementation_plan.md', files)).toBe(true)
    expect(needsWorkspaceFiles('把那个表格里的数据汇总一下', files)).toBe(true)
    expect(needsWorkspaceFiles('工作空间里都有什么资料', files)).toBe(true)
  })

  it('工作空间为空 → 恒 false（没文件却挂工具只会诱导模型瞎试）', () => {
    expect(needsWorkspaceFiles('总结一下那份文档', [])).toBe(false)
  })
})

describe('生成交付物 → 让给技能路由', () => {
  it('要文件的请求命中（通用循环没有写文件的能力）', () => {
    for (const q of [
      '分析下最新的A股情况，给我做个汇报PPT',   // 实测：被检索意图抢走，跑完 10 轮只能让用户自己复制
      '帮我做一份介绍产品的演示文稿',
      '生成一份本月的费用统计表格',
      '把这些整理成 word 文档',
    ]) expect(wantsGeneratedFile(q)).toBe(true)
  })

  it('纯分析/检索不命中（不该把它们也推给技能）', () => {
    for (const q of [
      '分析下最新的A股情况',
      '查一下 2026 年 7 月 AI 行业有什么新闻',
      '总结一下这份报告讲了什么',
    ]) expect(wantsGeneratedFile(q)).toBe(false)
  })
})


// ── ask_user：中途向用户提问（统一循环参考实现 形态）────────────────────────────────
describe('askUserTool', () => {
  const ctx = { sendLog: sendLog as any }

  it('无人值守：不弹卡，回灌「基于已有信息继续」指引', async () => {
    const out = await askUserTool({ unattended: true }).run({ question: '去哪个城市？' }, ctx)
    expect(out).toContain('用户不在场')
    expect(mockForm).not.toHaveBeenCalled()
  })

  it('用户回答后：答案作为观察回灌，带 options 时用点选', async () => {
    mockForm.mockResolvedValue({ answer: '北京 → 上海' })
    const out = await askUserTool({}).run({ question: '出发地和目的地？', options: ['北京 → 上海', '上海 → 北京'] }, ctx)
    expect(out).toBe('用户回答：北京 → 上海')
    const [fields, opts] = mockForm.mock.calls[0]
    expect(fields[0].type).toBe('select')
    expect(fields[0].options).toEqual(['北京 → 上海', '上海 → 北京'])
    expect(opts.kind).toBe('ask')
  })

  it('多字段：fields 逐项成表单，回答按「字段=值」汇总回灌', async () => {
    mockForm.mockResolvedValue({ f0: '合肥', f1: '北京', f2: '', _extra: '尽量靠窗' })
    const out = await askUserTool({}).run({
      question: '请补充行程信息',
      fields: [{ label: '出发地' }, { label: '目的地' }, { label: '席别', options: ['二等座', '一等座'] }],
    }, ctx)
    expect(out).toContain('出发地=合肥')
    expect(out).toContain('目的地=北京')
    expect(out).toContain('补充说明=尽量靠窗')
    expect(out).toContain('1 项未填')
    const [fields, opts] = mockForm.mock.calls[0]
    expect(fields).toHaveLength(4)                       // 3 业务字段 + 自动附加的补充说明
    expect(fields[2].type).toBe('select')
    expect(fields[3]).toMatchObject({ name: '_extra', type: 'textarea' })
    expect(opts.title).toBe('请补充行程信息')
  })

  it('日期字段用日期控件：显式 type=date 或 label 含「日期」都生效', async () => {
    mockForm.mockResolvedValue({ f0: '2026-08-01', f1: '08:30' })
    await askUserTool({}).run({
      question: '什么时候出发？',
      fields: [{ label: '出发日期' }, { label: '出发时刻', type: 'time' }],
    }, ctx)
    const [fields] = mockForm.mock.calls[0]
    expect(fields[0].type).toBe('date')      // label 兜底推断
    expect(fields[1].type).toBe('time')      // 显式声明
  })

  it('用户取消（空回答）：如实告知模型，不编造', async () => {
    mockForm.mockResolvedValue({})
    const out = await askUserTool({}).run({ question: '哪天出发？' }, ctx)
    expect(out).toContain('用户取消了回答')
  })
})


// ── 批量授权：同类写动作首次签名后本任务内放行 ─────────────────────────────────
describe('批量授权（本任务内同类写动作）', () => {
  it('确认卡勾选「不再逐条确认」→ 键入集合；下次同类动作直接放行', async () => {
    mockRunCtx = { batchApproved: new Set() }
    mockConfirm.mockResolvedValue({ values: { _batch: '本任务内同类操作不再逐条确认' }, tokenState: 'consumed' })
    const confirm = buildAndGetConfirm()
    expect(await confirm({ actionLabel: '提交', pageText: '报销单' })).toBe(true)
    expect(mockRunCtx.batchApproved.has('persist:bizsys-x:提交')).toBe(true)
    // 第二次同类：不再弹卡
    mockConfirm.mockClear()
    expect(await confirm({ actionLabel: '提交', pageText: '另一张报销单' })).toBe(true)
    expect(mockConfirm).not.toHaveBeenCalled()
    // 不同按钮不共享授权
    mockConfirm.mockResolvedValue({ values: { _batch: '仅此一次' }, tokenState: 'consumed' })
    await confirm({ actionLabel: '删除', pageText: 'x' })
    expect(mockConfirm).toHaveBeenCalled()
  })

  it('默认「仅此一次」→ 不入集合，次次都确认', async () => {
    mockRunCtx = { batchApproved: new Set() }
    mockConfirm.mockResolvedValue({ values: { _batch: '仅此一次' }, tokenState: 'consumed' })
    const confirm = buildAndGetConfirm()
    await confirm({ actionLabel: '提交', pageText: 'a' })
    expect(mockRunCtx.batchApproved.size).toBe(0)
  })
})
