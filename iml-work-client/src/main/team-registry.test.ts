// 被请教岗位的工具表单测。两条都是**安全边界**，不是功能：
// ① 全只读（并行的协作分身共享 RunContext 的确认通道）；
// ② 比小分身更窄——不给 read_file（工作空间是当前用户的，与对方岗位无关）、
//    不给 run_skill（本地根本没有对方岗位的技能包，挂上去只会让它调一个不存在的东西）。
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
vi.mock('./http', () => ({ afetch: vi.fn(), getAdminBaseUrl: () => 'http://localhost:8080' }))
vi.mock('./core-knowledge', () => ({
  makeKnowledgeTool: (expertId: string) => ({
    spec: {
      name: 'search_knowledge', description: `kb:${expertId}`, parameters: { type: 'object', properties: {} },
      metadata: { label: '查企业知识库', risk: 'low', category: 'knowledge' }, run: async () => '',
    },
    hits: () => [],
  }),
}))
vi.mock('./llm', () => ({ callLlmTools: vi.fn(), tierModel: () => '' }))

const { buildConsultRegistry } = await import('./agent-team')

const deps = () => ({
  parentRunId: 'r1',
  trace: { beginSpan: () => ({ id: 's1', end: () => {} }), attachIo: () => {} },
  cfg: { mode: 'proxy', apiMode: 'chat', baseUrl: 'x', apiKey: 'k', modelName: 'm' },
  permMode: 'full' as const,
  fromExpertId: 'expert-sales',
  collaborators: [{ id: 'expert-legal', title: '法务专员' }],
  emit: vi.fn(),
}) as unknown as Parameters<typeof buildConsultRegistry>[0]

const legal = { id: 'expert-legal', title: '法务专员', webSearchEnabled: false }

describe('被请教岗位的工具表', () => {
  it('全只读——断言不误触发，且工具表非空', () => {
    expect(() => buildConsultRegistry(deps(), legal)).not.toThrow()
    expect(buildConsultRegistry(deps(), legal).names().length).toBeGreaterThan(0)
  })

  it('每个工具都是 low 档且无需审批（并行安全的唯一前提）', () => {
    for (const s of buildConsultRegistry(deps(), legal).list()) {
      expect(s.metadata.risk, `工具 ${s.name}`).toBe('low')
      expect(s.metadata.requiresApproval, `工具 ${s.name}`).toBeFalsy()
    }
  })

  it('知识库按**被请教岗位**的 id 检索——这是跨岗位协作的核心价值', () => {
    const kb = buildConsultRegistry(deps(), legal).get('search_knowledge')
    expect(kb?.description).toBe('kb:expert-legal')   // 不是发起方 expert-sales
  })

  it('不给 read_file：工作空间是当前用户的文件，与对方岗位无关', () => {
    expect(buildConsultRegistry(deps(), legal).names()).not.toContain('read_file')
  })

  it('不给 run_skill / browse / consult_expert 自身', () => {
    const names = buildConsultRegistry(deps(), legal).names()
    for (const forbidden of ['run_skill', 'browse', 'consult_expert', 'run_subagent', 'ask_user', 'install_skill']) {
      expect(names, `协作岗位不该有 ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('联网权限跟**被请教岗位**走，不是发起方', () => {
    expect(buildConsultRegistry(deps(), legal).names()).not.toContain('web_search')
    expect(buildConsultRegistry(deps(), { ...legal, webSearchEnabled: true }).names()).toContain('web_search')
  })

  it('计算能力照给——否则它只能心算硬报金额，直接踩真实性红线', () => {
    expect(buildConsultRegistry(deps(), legal).names()).toContain('python')
  })
})
