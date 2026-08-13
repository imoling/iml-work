// 续写引擎契约钉子：接缝逻辑错了，症状是沙箱里 SyntaxError/缩进错乱——会被归因成
// "模型写的代码烂"，极难倒查回拼接层，必须在这里钉死。
import { describe, it, expect } from 'vitest'
import { isFenceTruncated, stripContinuationHead, trimOverlap, afterSentinel, generateWithContinuation, CONTINUATION_SENTINEL } from './gen-continuation'

describe('isFenceTruncated', () => {
  it('开栏无闭栏 = 截断', () => {
    expect(isFenceTruncated('```python\nprint(1)\nprint(2')).toBe(true)
  })
  it('开栏且闭栏 = 完整', () => {
    expect(isFenceTruncated('前言\n```python\nprint(1)\n```\n后记')).toBe(false)
  })
  it('无围栏（裸代码宽容路径）不算截断', () => {
    expect(isFenceTruncated('print(1)')).toBe(false)
  })
})

describe('stripContinuationHead', () => {
  it('剥掉重新开的围栏', () => {
    expect(stripContinuationHead('```python\nx = 1\n')).toBe('x = 1\n')
  })
  it('剥掉"接着上文"一类前缀+围栏', () => {
    expect(stripContinuationHead('接着上文继续：\n```python\nx = 1\n')).toBe('x = 1\n')
  })
  it('没有围栏原样返回（仅去头部空白）', () => {
    expect(stripContinuationHead('  \nx = 1\n')).toBe('x = 1\n')
  })
  it('正文中段的围栏不受影响', () => {
    const body = 'x = "' + 'a'.repeat(300) + '"\nmd = """\n```python\n示例\n```\n"""\n'
    expect(stripContinuationHead(body)).toBe(body)
  })
})

describe('afterSentinel', () => {
  it('取哨兵行之后的内容', () => {
    expect(afterSentinel(`${CONTINUATION_SENTINEL}\nd = 4\n\`\`\``)).toBe('d = 4\n```')
  })
  it('哨兵带缩进/尾随空白也认', () => {
    expect(afterSentinel(`  ${CONTINUATION_SENTINEL}  \nx = 1`)).toBe('x = 1')
  })
  it('前几行没有哨兵返回 null（走行级去重回退）', () => {
    expect(afterSentinel('d = 4\n```')).toBeNull()
  })
})

describe('trimOverlap（哨兵缺席时的回退）', () => {
  it('剪掉重复起笔的尾部行（短行也剪——整行精确相等）', () => {
    const prev = 'line1\n    line2 = compute()\nc = 3'
    const next = 'c = 3\nline4 = done()'
    expect(trimOverlap(prev, next)).toBe('line4 = done()')
  })
  it('多行重复起笔整段剪掉', () => {
    const prev = 'a = 1\n    b = 2\nc = 3'
    const next = '    b = 2\nc = 3\nd = 4'
    expect(trimOverlap(prev, next)).toBe('d = 4')
  })
  it('缩进不同的同名行不算重复（整行含缩进精确比对）', () => {
    expect(trimOverlap('x\n    )', ')\nend')).toBe(')\nend')
  })
  it('无重叠原样返回', () => {
    expect(trimOverlap('abc', 'def')).toBe('def')
  })
})

describe('generateWithContinuation 端到端（mock call）', () => {
  it('哨兵锚定：截断→按行边界续写→围栏闭合，接缝无重复无丢行', async () => {
    const calls: string[] = []
    const call = async (prompt: string): Promise<string> => {
      calls.push(prompt)
      if (calls.length === 1) {
        // 首轮：开栏、写了三行、第四行写到一半被截
        return '```python\na = 1\nb = 2\nc = 3\nd = 4444'
      }
      // 续写轮：模型守规矩输出哨兵行后从下一行接
      return `${CONTINUATION_SENTINEL}\nd = 4\nprint(a + b + c + d)\n\`\`\``
    }
    const out = await generateWithContinuation('任务说明', call, { maxTokens: 1000 })
    expect(out).toBe('```python\na = 1\nb = 2\nc = 3\nd = 4\nprint(a + b + c + d)\n```')
    expect(calls).toHaveLength(2)
    // 续写提示必须带上已写内容（截去不完整的最后一行）、哨兵要求与原任务
    expect(calls[1]).toContain('c = 3')
    expect(calls[1]).not.toContain('d = 4444')
    expect(calls[1]).toContain('任务说明')
    expect(calls[1]).toContain(CONTINUATION_SENTINEL)
  })

  it('模型忘了哨兵且重复起笔：行级去重兜底', async () => {
    let n = 0
    const call = async (): Promise<string> => {
      n++
      if (n === 1) return '```python\na = 1\nc = 3\nd = 4444'
      return 'c = 3\nd = 4\n```'
    }
    const out = await generateWithContinuation('t', call, { maxTokens: 1000 })
    expect(out).toBe('```python\na = 1\nc = 3\nd = 4\n```')
  })

  it('源码存在相邻重复行时哨兵路径不误剪', async () => {
    let n = 0
    const call = async (): Promise<string> => {
      n++
      if (n === 1) return '```python\nm = [\n    [1],\n    [1],\nxxxx'
      // 正确续写恰好又是一行 "    [1],"（与已写末行相同）——哨兵在，必须原样保留
      return `${CONTINUATION_SENTINEL}\n    [1],\n]\n\`\`\``
    }
    const out = await generateWithContinuation('t', call, { maxTokens: 1000 })
    expect(out).toBe('```python\nm = [\n    [1],\n    [1],\n    [1],\n]\n```')
  })

  it('首轮就完整则不发起续写', async () => {
    let n = 0
    const call = async (): Promise<string> => { n++; return '```python\nprint(1)\n```' }
    const out = await generateWithContinuation('t', call, { maxTokens: 1000 })
    expect(out).toBe('```python\nprint(1)\n```')
    expect(n).toBe(1)
  })

  it('轮数用尽仍未闭合则如实返回截断文本（上层按既有失败路径处理）', async () => {
    const call = async (): Promise<string> => '```python\nx = 1\ny = 2'
    const out = await generateWithContinuation('t', call, { maxTokens: 1000 })
    expect(isFenceTruncated(out)).toBe(true)
  })
})
