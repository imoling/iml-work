// 上游响应解析的纯函数（零依赖叶子——llm.ts 会 import db/electron，放那里就没法单测）。

// 模型偶尔把工具调用**当文本吐出来**而不是走 tool_calls 字段（实测 deepseek 在长对话里吐过
// `<||DSML|| tool_calls><||DSML|| invoke name="python">…`，整段原样显示给了用户）。
// 各家标记格式不同，这里按共同特征剥：形如 `<…tool_calls>` / `<…invoke …>` / `<…parameter …>` 的伪标签。
const TOOLCALL_ARTIFACT = /<\/?[^>\n]*?(?:tool_calls?|invoke|parameter|function_calls?)[^>\n]*?>/gi

/** 剥掉泄漏的工具调用标记。整段都是标记时返回空串，调用方据此按"空回复"处理。 */
export function stripToolCallArtifacts(text: string): string {
  if (!text || !/tool_calls?|invoke|function_calls?/i.test(text)) return text
  return text.replace(TOOLCALL_ARTIFACT, '').trim()
}
