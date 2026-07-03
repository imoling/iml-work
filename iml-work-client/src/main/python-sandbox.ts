// 本地 Python 沙箱：Pyodide（WASM Python）。在 WASM 内运行，隔离于宿主文件系统/网络
// （仅 micropip 装包时按需访问 CDN），用于执行「代码型技能」并把产物取回工作目录。
// 懒加载单例：首次加载 wasm+stdlib 约 1~3s，之后复用。
import path from 'path'
import { createRequire } from 'module'
import { swallow } from './util'

const require = createRequire(__filename)

let pyPromise: Promise<any> | null = null
let healthy = false
let lastError = ''

async function getPyodide(): Promise<any> {
  if (!pyPromise) {
    pyPromise = (async () => {
      try {
        const mod: any = await import('pyodide')
        // 指向 node_modules/pyodide 供 wasm/stdlib 定位（bundle 后 import.meta 不可靠，显式给 indexURL）。
        const indexURL = path.dirname(require.resolve('pyodide/package.json'))
        const py = await mod.loadPyodide({ indexURL })
        healthy = true
        return py
      } catch (e: any) {
        healthy = false
        lastError = e?.message || String(e)
        pyPromise = null   // 允许下次重试
        throw e
      }
    })()
  }
  return pyPromise
}

export function sandboxHealthy(): boolean { return healthy }
export function sandboxLastError(): string { return lastError }

// 启动时后台预热（不阻塞窗口创建）；失败静默，仅置健康标志。
export function warmupSandbox(): void {
  getPyodide().then(() => { /* warmed */ }).catch(e => swallow(e, 'pyodide-warmup'))
}

export interface SandboxFile { name: string; base64: string }
export interface SandboxResult { ok: boolean; stdout: string; stderr: string; error?: string; files: SandboxFile[] }

/**
 * 在沙箱内执行 Python。脚本写入 /out 的文件会被取回（base64）。
 * packages: 需要的纯 Python 包（micropip 安装，如 python-docx / openpyxl）。
 */
export async function runPythonSandbox(code: string, opts?: { packages?: string[] }): Promise<SandboxResult> {
  let stdout = '', stderr = ''
  try {
    const py = await getPyodide()
    py.setStdout({ batched: (s: string) => { stdout += s + '\n' } })
    py.setStderr({ batched: (s: string) => { stderr += s + '\n' } })
    try { py.FS.mkdir('/out') } catch (e) { swallow(e) }   // 已存在则忽略

    for (const p of (opts?.packages || [])) {
      await py.loadPackage('micropip')
      const mp = py.pyimport('micropip')
      await mp.install(p)
    }

    await py.runPythonAsync(code)

    const files: SandboxFile[] = []
    for (const name of py.FS.readdir('/out')) {
      if (name === '.' || name === '..') continue
      try {
        const data: Uint8Array = py.FS.readFile('/out/' + name)
        files.push({ name, base64: Buffer.from(data).toString('base64') })
        py.FS.unlink('/out/' + name)   // 清理，保证下次执行干净
      } catch (e) { swallow(e) }
    }
    return { ok: true, stdout, stderr, files }
  } catch (e: any) {
    return { ok: false, stdout, stderr, error: e?.message || String(e), files: [] }
  }
}
