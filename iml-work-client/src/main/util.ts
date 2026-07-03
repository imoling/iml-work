// 被有意吞掉的错误：默认静默（best-effort 操作失败通常是预期的，不应刷屏），
// 设置环境变量 IML_DEBUG 后统一输出，便于排障。用于替代裸 `catch (_) {}`。
export function swallow(e: unknown, tag?: string): void {
  if (process.env.IML_DEBUG) {
    const msg = (e && typeof e === 'object' && 'message' in e) ? (e as any).message : e
    console.debug(`[swallow]${tag ? ' ' + tag : ''}:`, msg)
  }
}
