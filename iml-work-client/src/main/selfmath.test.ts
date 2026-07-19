// isSelfContainedMath 单测：GSM8K 类自足算术题应判 true（不联网），真需外部数据的问题判 false。
import { describe, it, expect } from 'vitest'
import { isSelfContainedMath } from './web-search-core'

describe('isSelfContainedMath', () => {
  it('自足算术应用题 → true（含时效叙事词也不联网）', () => {
    // gs22：recent floods 框架，但所有数字自带
    expect(isSelfContainedMath('The recent floods left families without food. Mamou distributes 1360 meals. She gave 64 on Friday, 30 on Saturday, 48 on Sunday. How many meals remain?')).toBe(true)
    // gs21：now/currently 框架，但自足
    expect(isSelfContainedMath('Six years ago Noah was half as old as Cera. Currently Cera is 46. The population was 3000 times Noah age. Calculate the population now.')).toBe(true)
    expect(isSelfContainedMath('小明有 12 个苹果，给了小红 5 个，又买了 8 个，现在一共有多少个？')).toBe(true)
  })
  it('真需外部数据的问题 → false（照常联网）', () => {
    expect(isSelfContainedMath('What is the current stock price of Apple?')).toBe(false)
    expect(isSelfContainedMath('今天上证指数收盘多少点？')).toBe(false)
    expect(isSelfContainedMath('Who won the 2022 World Cup?')).toBe(false)
  })
  it('数字不足或无计算问法 → false', () => {
    expect(isSelfContainedMath('How many people live in Tokyo?')).toBe(false)   // 无题内数字
    expect(isSelfContainedMath('Explain how photosynthesis works in 3 steps.')).toBe(false)
  })
})
