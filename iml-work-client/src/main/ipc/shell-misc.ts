// 壳层杂项 IPC：定时任务/运行记录/本地沙箱/语音模型地址/设备信息/token 用量。
// 原先内联在 main.ts；B/S 化后 register 函数化，Electron 壳与 Web 宿主共用（经 ipc-bus 注册）。
import { ipcMain } from '../ipc-bus'
import {
  schedList, schedUpsert, schedSetEnabled, schedDelete, configGet,
  type ScheduledTask, taskRunAdd, taskRunFinish, taskRunList, taskRunRecentConvs, taskRunDelete,
} from '../db'
import { getConvUsage } from '../automation-runtime'
import { localStatus, installLocalImage, installDockerRuntime, getSandboxMode, setSandboxMode } from '../sandbox-local'
import { getAdminBaseUrl } from '../http'
import { emitToRenderer } from '../window-ref'
import { fireScheduledTask } from '../scheduler'

export function registerShellMiscHandlers() {
  ipcMain.handle('schedule:list', () => schedList())
  // 任务运行记录（详情页 Runs 列表）：add 由渲染层在为运行开出专属会话后调用，finish 在任务收尾时回填
  ipcMain.handle('task-run:add', (_e, p: { taskId: string; convId: string; trigger?: string }) =>
    taskRunAdd(String(p?.taskId || ''), String(p?.convId || ''), String(p?.trigger || 'schedule')))
  ipcMain.handle('task-run:finish', (_e, p: { runId: number; status?: string; summary?: string; fileCount?: number }) => {
    taskRunFinish(Number(p?.runId || 0), String(p?.status || 'ok'), String(p?.summary || ''), Number(p?.fileCount || 0))
    return true
  })
  ipcMain.handle('task-run:list', (_e, taskId: string) => taskRunList(String(taskId || '')))
  ipcMain.handle('task-run:recent-convs', () => taskRunRecentConvs())
  ipcMain.handle('task-run:delete', (_e, runId: number) => { taskRunDelete(Number(runId || 0)); return true })
  // 安全沙箱管理：本地/云端切换 + 本机 Docker 状态 + 镜像一键安装（进度经事件推渲染层）
  ipcMain.handle('sandbox-local:status', async () => ({ ...(await localStatus()), mode: getSandboxMode() }))
  ipcMain.handle('sandbox-local:set-mode', (_e, mode: string) => { setSandboxMode(mode === 'local' ? 'local' : 'cloud'); return true })
  ipcMain.handle('sandbox-local:install', async () => {
    return installLocalImage((msg) => emitToRenderer('sandbox-local:install-progress', { msg }))
  })
  ipcMain.handle('sandbox-local:install-docker', async () => {
    return installDockerRuntime((msg) => emitToRenderer('sandbox-local:install-progress', { msg }))
  })
  // 语音输入（本地 whisper）：模型基址（企业平台优先，渲染层探测可达性）+ 设备信息（设置页兼容性卡）
  ipcMain.handle('stt:model-base', () => getAdminBaseUrl())
  ipcMain.handle('app:device-info', () => {
    const os = require('os') as typeof import('os')
    return {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      memGb: Math.round(os.totalmem() / (1024 ** 3)),
      cores: os.cpus().length,
    }
  })

  // composer Token 用量：**当前会话**的累计 + 最近一次请求的上下文占用；新会话为零
  ipcMain.handle('llm:usage-stats', (_e, convId?: string) => {
    const u = convId ? getConvUsage(String(convId)) : undefined
    const win = Number(configGet('llm-context-window')) || 128_000
    // 进行中的调用：真实 usage 未到，用字符 ÷2 粗估 token（中英混排的折中；渲染层标「估算」，
    // 完成后被真值替换）。没有它，长调用进行中圆环恒 0%，看着像统计坏了（2026-08-14 实锤）。
    const live = u?.live
      ? { prompt: Math.round(u.live.promptChars / 2), completion: Math.round(u.live.outChars / 2) }
      : null
    return {
      prompt: u?.prompt || 0,
      completion: u?.completion || 0,
      byModel: u?.byModel || {},
      last: u?.last || { prompt: 0, completion: 0, model: '' },
      contextWindow: win,
      live,
    }
  })
  ipcMain.handle('schedule:save', (_e, t: ScheduledTask) => { schedUpsert(t); return schedList() })
  ipcMain.handle('schedule:toggle', (_e, { id, enabled }: { id: string; enabled: boolean }) => { schedSetEnabled(id, enabled); return schedList() })
  ipcMain.handle('schedule:delete', (_e, { id }: { id: string }) => { schedDelete(id); return schedList() })
  ipcMain.handle('schedule:run-now', (_e, { id }: { id: string }) => { const t = schedList().find(x => x.id === id); if (t) fireScheduledTask(t, 'manual'); return { ok: true } })
}
