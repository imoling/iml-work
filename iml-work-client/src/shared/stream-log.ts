// ============================================================================
// 流式进度日志的类型约定（主进程与渲染层共用，勿各写一份）。
//
// 背景：技能执行里「模型现场编写脚本」一步动辄几分钟，模型又是流式吐字——
// 把增量当普通日志逐条 append 会刷出上千条；这里约定一类特殊 type：
//   `stream:<id>`      —— 编写中，text 是当前累积的全文快照
//   `stream-done:<id>` —— 编写完成，text 是最终全文
// **同一 id 的多条按「替换」而非「追加」合并**（runLogs / convLogs / tool.progress
// 三处 reducer 都认这条规则），任何时刻列表里最多只有一条该 id 的记录。
// 渲染层把它画成默认折叠的实时进度框（点开看模型正在写什么）。
// ============================================================================

const STREAM_LOG_RE = /^stream(-done)?:(.+)$/

/** 流式进度日志的会话 id；非流式日志返回空串（调用方据此走普通 append）。 */
export function streamLogId(type: string): string {
  const m = STREAM_LOG_RE.exec(type || '')
  return m ? m[2] : ''
}

/** 该条是否为「已完成」的流式进度（决定进度框的头部文案与动效）。 */
export function isStreamDone(type: string): boolean {
  return (type || '').startsWith('stream-done:')
}

/**
 * 分区标记：带它的帧是「已有增量」的正文快照，不带的是静默期心跳（首行即人话，直接拿来当摘要）。
 * 为什么需要心跳帧：思考档模型在想的时候**上游一个增量都不发**（实测脚本生成静默 49s），
 * 等第一个 delta 才建框，用户看到的就是一段空白——框必须先出来、并让人看见它在等。
 */
export const STREAM_SECTION_MARK = '〔'

/** 单行人话摘要：跑马灯 / 精简实时进度 / 气泡「在干嘛」等一行位专用，绝不让脚本原文漏进去。 */
export function streamLogSummary(type: string, text: string): string {
  // 心跳帧 / 空轮收口帧：文案本身已是人话（含已等待秒数），原样当摘要，别去数它的字符数
  if (!text.startsWith(STREAM_SECTION_MARK)) return text.split('\n')[0]
  const kilo = text.length >= 1000 ? `${(text.length / 1000).toFixed(1)}k` : String(text.length)
  return isStreamDone(type) ? `执行脚本编写完成（${kilo} 字符）` : `正在编写执行脚本…（已写 ${kilo} 字符）`
}
