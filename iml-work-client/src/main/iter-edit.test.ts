import { describe, it, expect, vi } from 'vitest'
// workspace-files → db → app.getPath 在 node 环境会崩，桩掉 electron 与叶子依赖
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('./db', () => ({ configGet: () => '' }))
vi.mock('./http', () => ({ getAdminBaseUrl: () => '', afetch: async () => ({ ok: false }) }))
import { extractCandidateFilenames, DOC_EXT, ITER_INTENT, refersToExistingDoc, wantedDocExts } from './workspace-files'

// 迭代编辑「刚才那份」指代解析——纯文本提取那一路。回归防护：曾因只认固定话术
// 「保存到工作空间：<名>」而失效（分身实际回复是「已生成《x.docx》」，文件名裹在《》里）。
describe('extractCandidateFilenames', () => {
  it('从历史里抓出裹在《》中的文件名（就是当初 fail 的场景）', () => {
    const content = '在刚才那份文档最后加一节「常见问题」'
    const history = [{ role: 'assistant', content: '康Sir，已为您生成《WorkBuddy产品介绍.docx》文档，文件卡将在下方自动展示。' }]
    expect(extractCandidateFilenames(content, history)).toContain('WorkBuddy产品介绍.docx')
  })

  it('裸文件名 / 「」包裹 / 多种扩展名都能抓', () => {
    expect(extractCandidateFilenames('看下 report.xlsx')).toEqual(['report.xlsx'])
    expect(extractCandidateFilenames('打开「季度汇报.pptx」')).toEqual(['季度汇报.pptx'])
    const multi = extractCandidateFilenames('生成了 a.docx 和 b.pdf 两个文件')
    expect(multi).toContain('a.docx'); expect(multi).toContain('b.pdf')
  })

  it('【附件】引用按顿号拆分', () => {
    const r = extractCandidateFilenames('帮我看看\n【附件】合同.pdf、报价.xlsx（已加入工作空间）')
    expect(r).toContain('合同.pdf'); expect(r).toContain('报价.xlsx')
  })

  it('当前消息优先于上文（近者在前）', () => {
    const r = extractCandidateFilenames('改一下 new.docx', [{ role: 'assistant', content: '生成了 old.docx' }])
    expect(r[0]).toBe('new.docx')
  })

  it('去重', () => {
    const r = extractCandidateFilenames('a.docx a.docx', [{ role: 'assistant', content: '《a.docx》' }])
    expect(r).toEqual(['a.docx'])
  })

  it('无文件名时返回空（触发 fs 兜底那条路的前置条件）', () => {
    expect(extractCandidateFilenames('今天天气怎么样')).toEqual([])
  })
})

describe('迭代意图与文档扩展名判定', () => {
  it('ITER_INTENT 命中真实迭代话术', () => {
    for (const s of ['在刚才那份加一节', '把上面那份改一下', '基础上补充', '续写第三章', '润色一下']) {
      expect(ITER_INTENT.test(s)).toBe(true)
    }
  })
  it('ITER_INTENT 不误伤全新请求', () => {
    for (const s of ['帮我做一份 PPT', '查下今天待办', '你好']) {
      expect(ITER_INTENT.test(s)).toBe(false)
    }
  })
  it('refersToExistingDoc：「刚刚」与「操作动词+文档指称」都算指认已有文件（真实翻车话术）', () => {
    for (const s of ['格式化下刚刚的word文件。', '把这个pdf翻译一下', '把方才那份表格精简下', '上一轮的文档重新排版']) {
      expect(refersToExistingDoc(s)).toBe(true)
    }
  })
  it('refersToExistingDoc：全新生成请求不误触', () => {
    for (const s of ['做个PPT，主题是产品介绍', '帮我写一份周报', '生成一份说明文档', '格式化下']) {
      expect(refersToExistingDoc(s)).toBe(false)
    }
  })
  it('wantedDocExts：点名 word 绝不匹配 PPT（真实翻车：docx+pptx 同轮产出挂错文件）', () => {
    const re = wantedDocExts('格式化下刚刚的word文件。')!
    expect(re.test('科大讯飞股票汇报.docx')).toBe(true)
    expect(re.test('科大讯飞股票汇报.pptx')).toBe(false)
  })
  it('wantedDocExts：多类型取先出现的；没点名不过滤', () => {
    expect(wantedDocExts('把word转成ppt')!.test('a.docx')).toBe(true)
    expect(wantedDocExts('把word转成ppt')!.test('a.pptx')).toBe(false)
    expect(wantedDocExts('把刚才那份改一下')).toBeNull()
  })
  it('DOC_EXT 认文档、不认代码/图片', () => {
    for (const s of ['a.docx', 'b.PPTX', 'c.pdf', 'd.md']) expect(DOC_EXT.test(s)).toBe(true)
    for (const s of ['x.py', 'y.png', 'z.exe']) expect(DOC_EXT.test(s)).toBe(false)
  })
})
