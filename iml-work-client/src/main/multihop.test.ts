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
