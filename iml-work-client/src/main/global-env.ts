import { app } from 'electron'
import os from 'os'
import path from 'path'
import fs from 'fs'

// 主进程是 CommonJS 输出（vite-plugin-electron），__filename/__dirname 原生即有。
// **绝不用 import.meta.url**——那是 ESM-only 语法，会让 rollup 把 main 当 ESM，触发 vite-plugin-electron
// 偶发把 main.cjs 编成 ESM 的 dev 打包竞态（Cannot use import statement outside a module，屡次卡启动）。
// 仍显式挂到 globalThis：个别 CJS 原生依赖（better-sqlite3 的 bindings）在特定加载路径会读 globalThis.__dirname。
try {
  ;(globalThis as any).__filename = __filename
  ;(globalThis as any).__dirname = __dirname
} catch { /* 万一在 ESM 上下文（无 __dirname）则跳过，不致命 */ }

// ── 数据目录布局（参照 WorkBuddy 约定）────────────────────────────────────────
// 内部数据（本地库/技能文件/浏览器缓存）收进 ~/.imlwork（隐藏目录）；任务产物在可见的
// ~/imlwork（见 workspace-files.workspaceDir）。setPath 必须先于 db.ts 求值
// （globalDbPath 在其模块顶层捕获 userData），所以放在 main.ts 的第一个 import 这里。
// dev 不改道：继续用默认 userData + cwd，避免与已安装应用串数据。
if (app?.isPackaged) {
  const dir = path.join(os.homedir(), '.imlwork')
  try {
    if (!fs.existsSync(dir)) {
      // 一次性迁移：老版本数据在默认 userData（…/Application Support/iml-work-client），
      // 整目录搬来，保住登录态/认领态/本地库；搬不动就新建空目录，绝不半迁移。
      const legacy = app.getPath('userData')
      if (fs.existsSync(legacy)) {
        fs.renameSync(legacy, dir)
        console.log(`[paths] 数据目录已迁移：${legacy} → ${dir}`)
      } else {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
    app.setPath('userData', dir)
  } catch (e) {
    console.error('[paths] ~/.imlwork 初始化/迁移失败，回退默认 userData:', e)
  }
}
