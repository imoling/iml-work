// 渲染层版 swallow：被有意吞掉的错误默认静默（best-effort 操作失败通常是预期的，不应刷屏），
// 在 DevTools 里执行 localStorage.setItem('iml-debug','1') 后统一输出，便于排障。
// 与主进程 util.ts 的 swallow（IML_DEBUG 环境变量开关）为同一约定的两端实现。
export function swallow(e: unknown, tag?: string): void {
  let debug = false
  try { debug = !!localStorage.getItem('iml-debug') } catch { debug = false }
  if (debug) {
    const msg = e && typeof e === 'object' && 'message' in e ? (e as { message?: unknown }).message : e
    console.debug(`[swallow]${tag ? ' ' + tag : ''}:`, msg)
  }
}
