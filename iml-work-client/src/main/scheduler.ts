// 定时任务（自动化）：到点把任务的指令注入对话（schedule:fire 事件），
// 复用完整 agent 流程（含人工确认）。IPC 编排留在 main.ts。
import { Notification } from 'electron'
import { schedList, schedSetLastRun, type ScheduledTask } from './db'
import { emitToRenderer } from './window-ref'
import { swallow } from './util'

function scheduledFireTime(t: ScheduledTask, now: Date): Date | null {
  const [hh, mm] = (t.time || '09:00').split(':').map(n => parseInt(n, 10))
  const d = new Date(now); d.setHours(hh || 0, mm || 0, 0, 0)
  const dow = now.getDay(), dom = now.getDate()
  if (t.freq === 'daily') return d
  if (t.freq === 'weekday') return (dow >= 1 && dow <= 5) ? d : null
  if (t.freq === 'weekly') return (dow === t.dow) ? d : null
  if (t.freq === 'monthly') return (dom === t.dom) ? d : null
  return null
}

export function fireScheduledTask(t: ScheduledTask) {
  schedSetLastRun(t.id, Date.now())
  emitToRenderer('schedule:fire', { id: t.id, title: t.title, prompt: t.prompt, expertId: t.expertId, expertName: t.expertName })
  try { if (Notification.isSupported()) new Notification({ title: `定时任务 · ${t.title}`, body: (t.prompt || '').slice(0, 80) }).show() } catch (e) { swallow(e) }
}

let schedTimer: NodeJS.Timeout | null = null

function tickScheduler() {
  const now = new Date()
  for (const t of schedList()) {
    if (!t.enabled) continue
    const fire = scheduledFireTime(t, now)
    if (!fire) continue
    const fireTs = fire.getTime()
    if (now.getTime() >= fireTs && t.lastRun < fireTs) {
      // 计划时刻后 6 分钟内补触发；错过太久则标记本次已过，不补跑（避免开机后补跑很久以前的）
      if (now.getTime() - fireTs <= 6 * 60 * 1000) fireScheduledTask(t)
      else schedSetLastRun(t.id, fireTs)
    }
  }
}

export function startScheduler() {
  if (schedTimer) return
  schedTimer = setInterval(tickScheduler, 30_000)
  setTimeout(tickScheduler, 5_000)   // 启动 5s 后先跑一次（补触发刚错过的）
}
