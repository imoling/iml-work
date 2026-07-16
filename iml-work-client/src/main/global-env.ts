import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { app } from 'electron'
import os from 'os'
import path from 'path'
import fs from 'fs'

// In ES Module context, define __filename and __dirname on global scope
// so that CommonJS libraries like bindings (used by better-sqlite3) can resolve them.
const filename = fileURLToPath(import.meta.url)
const dirnameVal = dirname(filename)

;(globalThis as any).__filename = filename
;(globalThis as any).__dirname = dirnameVal

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
