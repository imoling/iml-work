// 子智能体工具表的单测——**并行安全的前提就是这张表全只读**，所以它必须被钉住。
//
// 两个方向都要测：
// ① 断言不能误触发（误触发 = 子智能体每次调用都直接报错，而这只有真跑才看得见）；
// ② 白名单不能漏（漏进 browse/run_skill 就是子智能体拿到了写能力与递归能力）。
//
// mock 策略照抄 core-tools.test.ts：只桩掉**会拉起 electron 的工具工厂**，
// 而 risk 标注本身来自 core-tools 的真实代码——所以哪天有人把某个只读工具改成 write，这里会红。
import { describe, it, expect, vi } from 'vitest'

const stubTool = (name: string) => ({ name, description: name, argsHint: '{}', run: async () => '' })
vi.mock('./agent-tools', () => ({
  makeWebSearchTool: () => stubTool('web_search'),
  makePythonTool: () => stubTool('python'),
  makeReadPageTool: () => stubTool('read_page'),
  makeReadFileTool: () => stubTool('read_file'),
  makeFetchDocumentTool: () => stubTool('fetch_document'),
  workspaceFileList: () => ['报表.xlsx'],
}))
vi.mock('./agent-browse', () => ({ makeBrowseTool: () => stubTool('browse') }))
vi.mock('./confirm-token', () => ({ requestSignedConfirmation: vi.fn(), tokenStateNote: () => '' }))
vi.mock('./automation-runtime', () => ({ requestFormConfirmation: vi.fn(), currentRun: () => undefined }))
vi.mock('./window-ref', () => ({ emitToRenderer: vi.fn() }))
vi.mock('./core-knowledge', () => ({
  makeKnowledgeTool: () => ({
    spec: {
      name: 'search_knowledge', description: '', parameters: { type: 'object', properties: {} },
      metadata: { label: '查企业知识库', risk: 'low', category: 'knowledge' }, run: async () => '',
    },
    hits: () => [],
  }),
}))
vi.mock('./llm', () => ({ callLlmTools: vi.fn(), tierModel: () => '' }))

const { buildSubRegistry } = await import('./agent-subagent')

/** 只需要 span 与 payload 两个口子；trace 本体会拉 db/http，测试里不碰。 */
const fakeTrace = {
  beginSpan: () => ({ id: 'sp-1', end: () => {} }),
  attachIo: () => {},
} as unknown as Parameters<typeof buildSubRegistry>[0]['trace']

const deps = (over: Record<string, unknown> = {}) => ({
  parentRunId: 'run-1',
  trace: fakeTrace,
  cfg: { mode: 'proxy', apiMode: 'chat', baseUrl: 'x', apiKey: 'k', modelName: 'm' },
  permMode: 'full' as const,
  expertId: 'exp-1',
  allowWeb: true,
  allowFiles: true,
  emit: vi.fn(),
  ...over,
}) as Parameters<typeof buildSubRegistry>[0]

describe('子智能体工具表', () => {
  it('全只读——断言不误触发（误触发就等于子智能体整个不可用）', () => {
    expect(() => buildSubRegistry(deps())).not.toThrow()
    const names = buildSubRegistry(deps()).names()
    expect(names.length).toBeGreaterThan(0)
  })

  it('每个工具都是 low 档且不需审批——这是并行安全成立的唯一前提', () => {
    for (const s of buildSubRegistry(deps()).list()) {
      expect(s.metadata.risk, `工具 ${s.name} 的风险档`).toBe('low')
      expect(s.metadata.requiresApproval, `工具 ${s.name} 是否需审批`).toBeFalsy()
    }
  })

  it('绝不包含 browse / run_skill / install_skill / ask_user / todo_write', () => {
    const names = buildSubRegistry(deps()).names()
    for (const forbidden of ['browse', 'run_skill', 'install_skill', 'ask_user', 'todo_write', 'propose_actions']) {
      expect(names, `子智能体不该有 ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('**不含自身**——第二层递归从结构上就不存在', () => {
    expect(buildSubRegistry(deps()).names()).not.toContain('run_subagent')
  })

  it('联网/文件权限跟随派它的分身，不多不少', () => {
    const noWeb = buildSubRegistry(deps({ allowWeb: false })).names()
    expect(noWeb).not.toContain('web_search')
    expect(noWeb).not.toContain('read_page')
    expect(noWeb).toContain('python')            // 计算能力与联网无关，照给

    const noFiles = buildSubRegistry(deps({ allowFiles: false })).names()
    expect(noFiles).not.toContain('read_file')
  })

  it('计算能力必须给——否则子智能体只能心算硬报，直接踩真实性红线', () => {
    expect(buildSubRegistry(deps()).names()).toContain('python')
  })
})
