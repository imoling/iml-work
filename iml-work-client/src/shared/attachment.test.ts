import { describe, it, expect } from 'vitest'
import { imageNamesInMessage } from './attachment'

// 「用户亲手递过来的附件」与「正文里提一嘴文件名」授权含义不同，不能被同一个开关一起挡掉。
// 实测事故（2026-08-03）：用户关掉工作空间访问后发图，图片没被附给视觉模型，
// 模型只拿到一个文件名，写 python 去沙箱里找了 7 轮工具调用才放弃。
describe('本轮该看哪些图片', () => {
  const ATTACH = '【附件】「管理端沙箱页.png」（已加入工作空间）\n介绍下图片'

  it('显式附件：即使关掉工作空间访问也要看', () => {
    expect(imageNamesInMessage(ATTACH, { includeMentions: false })).toEqual(['管理端沙箱页.png'])
  })

  it('正文裸提及：跟随工作空间开关', () => {
    const t = '看下 报错截图.png 是什么问题'
    expect(imageNamesInMessage(t, { includeMentions: true })).toEqual(['报错截图.png'])
    expect(imageNamesInMessage(t, { includeMentions: false })).toEqual([])
  })

  it('多个附件都收', () => {
    const t = '【附件】「a.png」「b.jpg」（已加入工作空间）\n对比一下'
    expect(imageNamesInMessage(t)).toEqual(['a.png', 'b.jpg'])
  })

  it('非图片附件不进图片通道（docx 走文档解析，不该塞给视觉模型）', () => {
    expect(imageNamesInMessage('【附件】「季度报告.docx」（已加入工作空间）\n总结一下')).toEqual([])
  })

  it('没有附件也没有提及 → 空', () => {
    expect(imageNamesInMessage('今天天气怎么样')).toEqual([])
  })
})
