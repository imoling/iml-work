// 渲染层的 swallow 对等物：预期内可忽略的异常（轮询失败、可选能力探测…）
// 不许空 catch，也不该在正常路径刷屏——localStorage.IML_DEBUG = '1' 时输出。
export function swallowUi(e: unknown, tag: string): void {
  try {
    if (localStorage.getItem('IML_DEBUG')) console.warn(`[${tag}]`, e)
  } catch { /* localStorage 不可用时无事可做 */ }
}
