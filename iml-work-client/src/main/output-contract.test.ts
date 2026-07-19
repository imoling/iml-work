// output-contract 确定性校验单测：驱动 IFEval 生成后校验+重写闸的检测器（Round3 批次 C）。
import { describe, it, expect } from 'vitest'
import { hasExplicitFormatConstraints, collectFormatViolations } from './output-contract'

describe('hasExplicitFormatConstraints', () => {
  it('识别显式格式约束', () => {
    expect(hasExplicitFormatConstraints('Write exactly 2 sentences. Do not use any commas.')).toBe(true)
    expect(hasExplicitFormatConstraints('用全小写回答，不要逗号')).toBe(true)
    expect(hasExplicitFormatConstraints('output valid json')).toBe(true)
  })
  it('普通对话不误判', () => {
    expect(hasExplicitFormatConstraints('帮我分析一下这份销售数据')).toBe(false)
    expect(hasExplicitFormatConstraints('今天北京天气怎么样')).toBe(false)
  })
})

describe('collectFormatViolations', () => {
  it('禁逗号：违规与合规', () => {
    expect(collectFormatViolations('Do not use any commas.', 'Teamwork is great, really.')).toHaveLength(1)
    expect(collectFormatViolations('Do not use any commas.', 'Teamwork is great and effective.')).toHaveLength(0)
    expect(collectFormatViolations("Don't use any commas in your answer.", 'a, b and c')).toHaveLength(1)   // Don't 变体
    expect(collectFormatViolations('不要使用逗号', '团队协作很重要，很有效')).toHaveLength(1)
  })
  it('全小写：覆盖 "all of the letters are lowercase" 变体', () => {
    expect(collectFormatViolations('all of the letters are lowercase', 'Hello World')).toHaveLength(1)
    expect(collectFormatViolations('all of the letters are lowercase', 'hello world')).toHaveLength(0)
  })
  it('全小写', () => {
    expect(collectFormatViolations('respond in all lowercase', 'Hello World')).toHaveLength(1)
    expect(collectFormatViolations('respond in all lowercase', 'hello world')).toHaveLength(0)
  })
  it('两段回答需 ****** 分隔', () => {
    expect(collectFormatViolations('Give two different responses separated by asterisks', 'one response only')).toHaveLength(1)
    expect(collectFormatViolations('Give two different responses', 'first\n******\nsecond')).toHaveLength(0)
  })
  it('JSON 格式', () => {
    expect(collectFormatViolations('output valid json', 'not json at all')).toHaveLength(1)
    expect(collectFormatViolations('output valid json', '{"a": 1}')).toHaveLength(0)
    expect(collectFormatViolations('output valid json', '```json\n{"a":1}\n```')).toHaveLength(0)
  })
  it('精确句数', () => {
    expect(collectFormatViolations('exactly 2 sentences', 'One. Two. Three.')).toHaveLength(1)
    expect(collectFormatViolations('exactly 2 sentences', 'One thing here. Two things there.')).toHaveLength(0)
  })
  it('禁词：抽出被禁词并核对', () => {
    expect(collectFormatViolations('Do not use the word "happy" in your response.', 'I am so happy today.')).toHaveLength(1)
    expect(collectFormatViolations('Do not use the word "happy" in your response.', 'I am so glad today.')).toHaveLength(0)
    expect(collectFormatViolations('Do not include the keywords cat and dog.', 'The dog ran fast.')).toHaveLength(1)
  })
  it('词频：某词至少出现 N 次', () => {
    expect(collectFormatViolations('The word "love" should appear at least 3 times.', 'love is love and love')).toHaveLength(0)
    expect(collectFormatViolations('The word "love" should appear at least 3 times.', 'love only once')).toHaveLength(1)
  })
  it('字数下限', () => {
    expect(collectFormatViolations('Write at least 20 words about the sea.', 'The sea is blue.')).toHaveLength(1)
    expect(collectFormatViolations('Write less than 5 words.', 'one two three four five six')).toHaveLength(1)
  })
  it('无约束/合规不报违规', () => {
    expect(collectFormatViolations('随便聊聊', '好的康Sir，今天聊什么')).toHaveLength(0)
  })
})
