// 渲染层构建产物（dist/）的静态托管——零依赖，Node http 直出。
// COOP/COEP 头：语音输入的 wasm 线程（SharedArrayBuffer）需要跨源隔离；全站同源，加了无副作用。
import http from 'http'
import fs from 'fs'
import path from 'path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
}

export function serveStatic(distDir: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  let urlPath: string
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]) } catch { urlPath = '/' }
  // 路径净化：resolve 后必须仍在 distDir 内，杜绝 ../ 穿越
  let file = path.resolve(distDir, '.' + (urlPath === '/' ? '/index.html' : urlPath))
  if (!file.startsWith(distDir + path.sep) && file !== path.join(distDir, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return
  }
  try {
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distDir, 'index.html')   // SPA 回退
  } catch { file = path.join(distDir, 'index.html') }
  const ext = path.extname(file).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  })
  fs.createReadStream(file).on('error', () => { try { res.end() } catch (_) { /* 已断开 */ } }).pipe(res)
}

/**
 * Web 形态「查看/下载文件」：工作空间产物只读直出。
 * 路径解析在调用方（host.ts 用 resolveWorkspaceFile 递归定位——产物在会话子目录，
 * 根目录裸拼 basename 找不到，实测 404 过）；此处只负责存在性校验与流式输出。
 */
export function serveLocalFile(absPath: string | null, res: http.ServerResponse): void {
  const file = absPath || ''
  let ok = false
  try { ok = !!file && fs.existsSync(file) && !fs.statSync(file).isDirectory() } catch { ok = false }
  if (!ok) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('文件不存在'); return }
  const base = path.basename(file)
  const ext = path.extname(file).toLowerCase()
  // 可内联预览的类型新标签直开；浏览器打不开的（docx/xlsx/pptx/zip…）显式 attachment 触发下载
  //（与渲染层 ui-util.isWebInlineViewable 同口径）
  const INLINE_EXT = new Set(['.pdf', '.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.txt', '.md', '.markdown', '.csv', '.json', '.log'])
  const disposition = INLINE_EXT.has(ext) ? 'inline' : 'attachment'
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(base)}`,
  })
  fs.createReadStream(file).on('error', () => { try { res.end() } catch (_) { /* 已断开 */ } }).pipe(res)
}
