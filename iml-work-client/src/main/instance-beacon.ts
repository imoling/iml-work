// Electron 客户端「在跑」信标——D2（允许客户端与 Web 宿主同时运行）下的主从让位依据：
// 客户端启动写 pid 文件、退出删除；宿主读到活 pid 就把单例后台服务（调度器/心跳/IM 机器人/
// 文件监听）让给客户端，避免定时任务双跑、机器人双回。叶子模块，两个入口共用。
import path from 'path'
import fs from 'fs'
import { userDataDir } from './app-paths'
import { swallow } from './util'

function beaconPath(): string {
  return path.join(userDataDir(), 'electron-instance.json')
}

export function writeElectronBeacon(): void {
  try {
    fs.writeFileSync(beaconPath(), JSON.stringify({ pid: process.pid, ts: Date.now() }))
  } catch (e) { swallow(e, 'beacon-write') }
}

export function clearElectronBeacon(): void {
  try { fs.unlinkSync(beaconPath()) } catch (_) { /* 不存在即目标态 */ }
}

/** 信标 pid 是否还活着（宿主侧探测；kill(pid, 0) 只探活不发信号）。崩溃残留的死 pid 视为不在跑。 */
export function electronAlive(): boolean {
  try {
    const j = JSON.parse(fs.readFileSync(beaconPath(), 'utf-8'))
    if (!j?.pid) return false
    process.kill(j.pid, 0)
    return true
  } catch { return false }
}
