import { describe, it, expect } from 'vitest'
import { formatCatalog, buildRouterPrompt, parseRouterOutput } from './skill-router-core'

describe('skill-router-core', () => {
  const skills = [
    { id: 'sk-ppt', name: 'pptx', description: '生成 PPT 演示文稿' },
    { id: 'sk-doc', name: 'docx', description: '生成 Word 文档' },
  ]

  describe('formatCatalog', () => {
    it('渲染 id/名称/描述，描述截断 240 字', () => {
      const long = { id: 'sk-x', name: 'x', description: 'a'.repeat(400) }
      const out = formatCatalog([long])
      expect(out).toContain('id: sk-x')
      expect(out).toContain('名称: x')
      expect(out.match(/a+/)![0].length).toBe(240)
    })
    it('displayName 覆盖 name', () => {
      const out = formatCatalog(skills, id => id === 'sk-ppt' ? '演示文稿技能' : undefined)
      expect(out).toContain('名称: 演示文稿技能')
      expect(out).toContain('名称: docx')   // 无覆盖时退回 name
    })
    it('描述缺失时退回 sopContent', () => {
      const out = formatCatalog([{ id: 'sk-y', name: 'y', sopContent: 'SOP 正文' }])
      expect(out).toContain('SOP 正文')
    })
  })

  describe('buildRouterPrompt', () => {
    it('含产出形态三分类与目录', () => {
      const p = buildRouterPrompt('把大纲做成 PPT', formatCatalog(skills))
      expect(p).toContain('wants')
      expect(p).toContain('file')
      expect(p).toContain('action')
      expect(p).toContain('answer')
      expect(p).toContain('把大纲做成 PPT')
      expect(p).toContain('id: sk-ppt')
    })
  })

  describe('parseRouterOutput', () => {
    const ids = ['sk-ppt', 'sk-doc']
    it('解析 file + 命中技能', () => {
      const r = parseRouterOutput('{"wants":"file","skillIds":["sk-ppt"]}', ids)
      expect(r.wants).toBe('file')
      expect(r.picked).toEqual(['sk-ppt'])
    })
    it('answer 强制清空 picked（双保险：模型误给技能也丢弃）', () => {
      const r = parseRouterOutput('{"wants":"answer","skillIds":["sk-ppt"]}', ids)
      expect(r.wants).toBe('answer')
      expect(r.picked).toEqual([])
    })
    it('过滤目录外的非法 id', () => {
      const r = parseRouterOutput('{"wants":"file","skillIds":["sk-ppt","sk-hacked"]}', ids)
      expect(r.picked).toEqual(['sk-ppt'])
    })
    it('从含解释噪声的输出里抠出首个 JSON', () => {
      const r = parseRouterOutput('好的，我的判断是：{"wants":"action","skillIds":["sk-doc"]} 仅供参考', ids)
      expect(r.wants).toBe('action')
      expect(r.picked).toEqual(['sk-doc'])
    })
    it('坏 JSON / 空输出安全降级', () => {
      expect(parseRouterOutput('不是 JSON', ids)).toEqual({ wants: '', picked: [] })
      expect(parseRouterOutput('', ids)).toEqual({ wants: '', picked: [] })
    })
  })
})
