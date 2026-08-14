// 流式进度日志约定的单测。钉住两件事，它们错了都是「界面看着没在跑」的静默故障：
// ① 同 id 帧靠 streamLogId 识别（四处 reducer 都按它做替换合并）；
// ② 摘要不能把脚本原文/心跳文案搞混——一行位漏出脚本原文，或把心跳当正文数字符，都很难看。
import { describe, it, expect } from 'vitest'
import { streamLogId, isStreamDone, streamLogSummary, STREAM_SECTION_MARK } from './stream-log'

describe('streamLogId / isStreamDone', () => {
  it('识别流式帧并取出会话 id', () => {
    expect(streamLogId('stream:script-a1')).toBe('script-a1')
    expect(streamLogId('stream-done:script-a1')).toBe('script-a1')
    // 同一 id 的进行中/完成帧必须解析出同一个 id，否则收口帧会另起一行、旧框永远转圈
    expect(streamLogId('stream:script-a1')).toBe(streamLogId('stream-done:script-a1'))
  })

  it('普通日志类型不是流式帧（走原有追加渲染）', () => {
    for (const t of ['thinking', 'acting', 'observing', 'stdout', 'completed']) {
      expect(streamLogId(t)).toBe('')
    }
  })

  it('done 标记只认 stream-done 前缀', () => {
    expect(isStreamDone('stream-done:x')).toBe(true)
    expect(isStreamDone('stream:x')).toBe(false)
  })
})

describe('streamLogSummary（一行位专用摘要）', () => {
  const body = `${STREAM_SECTION_MARK}脚本〕\n` + 'x'.repeat(2000)

  it('正文帧只报字数，绝不把脚本原文漏进一行位', () => {
    const s = streamLogSummary('stream:script-a1', body)
    expect(s).toContain('正在编写执行脚本')
    expect(s).toContain('2.0k')
    expect(s).not.toContain('xxx')
  })

  it('完成帧报完成与总字数', () => {
    expect(streamLogSummary('stream-done:script-a1', body)).toContain('执行脚本编写完成')
  })

  it('心跳帧（思考静默期，无分区标记）原样用首行，不去数字符数', () => {
    const hb = '模型正在构思脚本（已 12s）…思考阶段上游不发增量，开始写代码后这里会实时滚动'
    const s = streamLogSummary('stream:script-a1', hb)
    expect(s).toBe(hb)
    expect(s).not.toContain('字符')
  })

  it('多行文本只取首行（一行位不能被撑破）', () => {
    expect(streamLogSummary('stream:script-a1', '第一行\n第二行')).toBe('第一行')
  })
})
