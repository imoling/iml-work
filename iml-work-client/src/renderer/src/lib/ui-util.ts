// 渲染层的 swallow 对等物：预期内可忽略的异常（轮询失败、可选能力探测…）
// 不许空 catch，也不该在正常路径刷屏——localStorage.IML_DEBUG = '1' 时输出。
export function swallowUi(e: unknown, tag: string): void {
  try {
    if (localStorage.getItem('IML_DEBUG')) console.warn(`[${tag}]`, e)
  } catch { /* localStorage 不可用时无事可做 */ }
}

// Web 形态（浏览器经 web-bridge 连本机宿主）判定：桌面专属 UI（自启/悬浮球/访达/录制/更新…）
// 据此隐藏或换实现。Electron preload 不设置 mode 字段，恒为 false。
export function isWebMode(): boolean {
  return (window as any).api?.mode === 'web'
}

// Web 形态浏览器能内联预览的类型：新标签直开；其余（docx/xlsx/pptx/zip…）走下载。
// 与宿主 static-server.serveWorkspaceFile 的 disposition 分流同口径。
const WEB_INLINE_RE = /\.(pdf|html?|png|jpe?g|gif|webp|svg|txt|md|markdown|csv|json|log)$/i
export function isWebInlineViewable(name: string): boolean { return WEB_INLINE_RE.test(name) }

/** Web 形态打开工作空间文件：可预览类型新标签查看，其余触发浏览器下载（不留空白标签）。 */
export function openWorkspaceInBrowser(name: string): void {
  const url = `/workspace/${encodeURIComponent(name)}`
  if (isWebInlineViewable(name)) { window.open(url, '_blank', 'noopener'); return }
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** ArrayBuffer → base64（分块拼接，避免大文件展开参数栈溢出）。Web 形态附件上传用。 */
export function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const CHUNK = 0x8000
  let bin = ''
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}
