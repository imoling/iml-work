// 应用数据根目录/数据库目录/版本号的唯一来源——Electron 与无头宿主（B/S 形态）共用。
//
// ⚠️ 打包后的 Electron 应用 **process.cwd() 是随机位置**（mac 常是 "/"，Windows 视启动方式而定，
// 且常无写权限）——曾把技能/工作空间都写到 cwd 下，开发模式一切正常，装出来的包
// 技能文件根本落不了盘 → 领用后路由永远匹配不到技能（生产实锤 2026-07-16）。
// 打包环境一律落 userData（每用户可写、随系统惯例），开发环境保持项目根（便于直接查看文件）。
//
// B/S 化后本模块必须在「无 Electron 的纯 Node 宿主」下可用：electron 惰性求值——
// 纯 Node 里 require('electron') 返回的是二进制路径字符串（devDependency 的桩），不是 API 对象，
// 据此判别环境；Electron 下取值路径与改造前逐字节一致。
import path from 'path'
import os from 'os'
import fs from 'fs'

function electronApp(): Electron.App | null {
  try {
    const e = require('electron')
    return e && typeof e === 'object' && e.app ? (e.app as Electron.App) : null
  } catch { return null }
}

export function appDataRoot(): string {
  const app = electronApp()
  if (app) return app.isPackaged ? app.getPath('userData') : process.cwd()
  return process.env.IML_DATA_ROOT || process.cwd()
}

/** dev 下 Electron 默认 userData（db.ts 在 setName 前求值，历史目录名是 'Electron'）。 */
function devElectronUserData(): string {
  const home = os.homedir()
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Electron')
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Electron')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Electron')
}

let cachedUserData: string | null = null

/** 该数据目录是否有**活着的**桌面客户端信标（写入方见 instance-beacon.ts，文件名两处保持一致）。 */
function beaconAlive(dir: string): boolean {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'electron-instance.json'), 'utf-8'))
    if (!j?.pid) return false
    process.kill(j.pid, 0)
    return true
  } catch { return false }
}

/** 数据目录的最近写入时间。WAL 模式下真实写入先落 -wal，主库 mtime 不动——必须一起看。 */
function lastActivity(dir: string): number {
  let t = 0
  for (const f of ['iml-work.db-wal', 'iml-work.db']) {
    try { t = Math.max(t, fs.statSync(path.join(dir, f)).mtimeMs) } catch { /* 无此文件 */ }
  }
  return t
}

/**
 * sqlite 分库所在目录。Electron：app.getPath('userData')（与 db.ts 原实现一致，
 * 含 global-env 打包改道 ~/.imlwork）。无头宿主按「D1 共享数据根」探测，优先级：
 * 环境变量显式指定 > **活信标目录**（桌面客户端此刻正用的那份——打包版与 dev 版数据目录
 * 不同，两份都存在时选错会出现「网页和客户端画像不一样」，实锤过）> 最近写入 > 新建 ~/.imlwork。
 */
export function userDataDir(): string {
  const app = electronApp()
  if (app) return app.getPath('userData')
  if (cachedUserData) return cachedUserData

  const explicit = process.env.IML_USER_DATA_DIR
  if (explicit) {
    fs.mkdirSync(explicit, { recursive: true })
    cachedUserData = explicit
  } else {
    const candidates = [path.join(os.homedir(), '.imlwork'), devElectronUserData()]
      .filter(c => fs.existsSync(path.join(c, 'iml-work.db')))
    cachedUserData = candidates.find(beaconAlive)
      || candidates.sort((a, b) => lastActivity(b) - lastActivity(a))[0]
      || null
    if (!cachedUserData) {
      cachedUserData = path.join(os.homedir(), '.imlwork')
      fs.mkdirSync(cachedUserData, { recursive: true })
    }
  }
  console.log(`[app-paths] 无头宿主数据目录: ${cachedUserData}（IML_USER_DATA_DIR 可显式指定）`)
  return cachedUserData
}

/** 应用版本号：Electron 走 app.getVersion()（原行为）；无头宿主由构建脚本注入。 */
export function appVersion(): string {
  const app = electronApp()
  if (app && typeof app.getVersion === 'function') return app.getVersion()
  return process.env.IML_APP_VERSION || '0.0.0-host'
}
