// 应用数据根目录的唯一来源。
//
// ⚠️ 打包后的 Electron 应用 **process.cwd() 是随机位置**（mac 常是 "/"，Windows 视启动方式而定，
// 且常无写权限）——曾把技能/工作空间都写到 cwd 下，开发模式一切正常，装出来的包
// 技能文件根本落不了盘 → 领用后路由永远匹配不到技能（生产实锤 2026-07-16）。
// 打包环境一律落 userData（每用户可写、随系统惯例），开发环境保持项目根（便于直接查看文件）。
import { app } from 'electron'

export function appDataRoot(): string {
  return app.isPackaged ? app.getPath('userData') : process.cwd()
}
