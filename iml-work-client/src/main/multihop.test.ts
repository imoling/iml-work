// isMultiHopQuestion 单测：驱动 Round3 批次 D 的补查时延闸（单跳跳过补查、多跳保留）。
import { describe, it, expect } from 'vitest'
import { isMultiHopQuestion } from './web-search-core'

describe('isMultiHopQuestion', () => {
  it('单跳事实题 → false（跳过补查）', () => {
    expect(isMultiHopQuestion('In what year did Seiko release its first 300m diver watch?')).toBe(false)
    expect(isMultiHopQuestion('墨西哥歌手 Peso Pluma 的本名是什么？')).toBe(false)
    expect(isMultiHopQuestion('Who is the CEO of Acme?')).toBe(false)
  })
  it('多跳/比较/聚合题 → true（保留补查）', () => {
    expect(isMultiHopQuestion('Which band was named after a movie that was based on a novel, and who wrote it?')).toBe(true)
    expect(isMultiHopQuestion('How many years earlier was A founded than B?')).toBe(true)
    expect(isMultiHopQuestion('A 比 B 早几年成立？')).toBe(true)
    expect(isMultiHopQuestion('谁的身高更高，甲还是乙？')).toBe(true)
    expect(isMultiHopQuestion('the director of Inception also directed which other film')).toBe(true)
  })
})

// P1 agent 循环触发判定：多跳+计算才走通用循环，简单事实题/自足数学题不走。
import { needsAgentLoop, needsBrowseAgent } from './web-search-core'

// P3 browse 触发判定：只在"要在真实网站里多步操作"时才走 browse；普通问答/检索/文件题绝不误触发。
describe('needsBrowseAgent', () => {
  it('网站多步操作任务 → true（走 P3 browse）', () => {
    expect(needsBrowseAgent('帮我登录 12306 网站，买一张明天去上海的高铁票')).toBe(true)
    expect(needsBrowseAgent('去淘宝网站上搜索羽绒服，把第一个加入购物车')).toBe(true)
    expect(needsBrowseAgent('打开这个后台系统，点击审批并提交表单')).toBe(true)
    expect(needsBrowseAgent('Go to the site and fill out the registration form')).toBe(true)
    expect(needsBrowseAgent('log in to the dashboard and submit the expense form')).toBe(true)
    expect(needsBrowseAgent('在 https://example.com/order 页面下单并填写收货地址')).toBe(true)
  })
  it('普通问答/检索/多跳/文件题 → false（不误触发 browse）', () => {
    // 单事实
    expect(needsBrowseAgent('墨西哥歌手 Peso Pluma 的本名是什么？')).toBe(false)
    expect(needsBrowseAgent('What is the population of Tokyo?')).toBe(false)
    // 多跳/派生（应走 P1 web 循环，而非 browse）
    expect(needsBrowseAgent('How many more medals did France win in 2008 than in 2004?')).toBe(false)
    expect(needsBrowseAgent('A 比 B 早几年成立？两者相差多少年')).toBe(false)
    // 读网页取事实（走 read_page，不是 browse 操作）
    expect(needsBrowseAgent('读一下 https://en.wikipedia.org/wiki/Usain_Bolt 看他多高')).toBe(false)
    // 文件取数
    expect(needsBrowseAgent('这个 xlsx 里销售额一共多少？')).toBe(false)
    // 生成类
    expect(needsBrowseAgent('帮我生成一份股票信息汇报的 word 文档')).toBe(false)
  })
})

describe('needsAgentLoop', () => {
  it('求派生数值 + 实体锚 → true（走通用循环）', () => {
    expect(needsAgentLoop('How many more medals did France win in 2008 than in 2004?')).toBe(true)
    expect(needsAgentLoop('If Alice turned 36 on the day JFK was assassinated, how old would she be on the day the Berlin Wall fell?')).toBe(true)
    expect(needsAgentLoop('What age was the director of Inception (2010) when the film was released in the UK?')).toBe(true)
    expect(needsAgentLoop('What is the sum of the birth years of the two players in the 2008 Wimbledon final?')).toBe(true)
    expect(needsAgentLoop('清华大学比北京大学早几年成立？')).toBe(true)
  })
  it('多跳找实体（非求数值）+ 实体锚 → true（放宽后新覆盖，FRAMES 主体题型）', () => {
    // "在发生 Y 的同一年，谁做了 X" —— 需先定位从句年份再查主句，答案是实体而非数值
    expect(needsAgentLoop("Who won Britain's Got Talent in the same year that London hosted the Olympics?")).toBe(true)
    // "X of Y" 型专名（含小写 of）也算实体锚
    expect(needsAgentLoop('What US president was born in the same year that the Treaty of Resht was signed?')).toBe(true)
  })
  it('单事实 lookup / 简单题 → false（走快路径，不劫持）', () => {
    expect(needsAgentLoop('墨西哥歌手 Peso Pluma 的本名是什么？')).toBe(false)
    expect(needsAgentLoop('广州塔的高度是多少米？')).toBe(false)
    expect(needsAgentLoop('What is the population of Tokyo?')).toBe(false)
  })
  it('自足算术应用题 → false（本地算，绝不误进循环——防 GSM8K 回退）', () => {
    expect(needsAgentLoop('小明有12个苹果，给了5个，又买了8个，一共多少个？')).toBe(false)
    // GSM8K 型：isMultiHop=true（多个 of）但自足、用虚构角色+日常物品、无真实实体锚 → 必须 false
    expect(needsAgentLoop('Jen got 3 fish. They each need $1 worth of food a day. How much does it cost to feed them for a week?')).toBe(false)
  })
})
