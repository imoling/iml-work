// 阻止系统闲置休眠，让定时任务按时触发。
//
// 为什么需要：scheduler 是进程内 setInterval（30s tick），Mac 合盖或闲置睡眠后计时器随进程
// 一起挂起，到点的任务根本不会触发；醒来后 tickScheduler 只在「计划时刻后 6 分钟内」补触发，
// 睡过头就直接标记本次已过。更糟的是睡眠会杀掉执行中的任务，留下 running 态的孤儿运行记录
// （db.ts 打开用户库时清扫的正是这些）——那是在擦屁股，这里才是止血。
//
// 用 prevent-app-suspension 而不是 prevent-display-sleep：我们只要进程能继续跑，
// 不需要把屏幕一直点亮（后者在笔记本上就是耗电投诉）。
import { powerSaveBlocker } from 'electron'
import { configGet, configSet } from './db'
import { swallow } from './util'

const KEY = 'keep-awake'
let blockerId: number | null = null

export function isKeepAwakeOn(): boolean {
  return configGet(KEY) === '1'
}

/** 幂等：重复开/关不会叠加 blocker，也不会误停别人的。 */
export function applyKeepAwake(on: boolean): boolean {
  try {
    if (on) {
      if (blockerId === null || !powerSaveBlocker.isStarted(blockerId)) {
        blockerId = powerSaveBlocker.start('prevent-app-suspension')
      }
    } else if (blockerId !== null) {
      if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
      blockerId = null
    }
  } catch (e) {
    swallow(e, 'keep-awake')
    return isKeepAwakeOn()
  }
  return on
}

export function setKeepAwake(on: boolean): boolean {
  const applied = applyKeepAwake(!!on)
  configSet(KEY, applied ? '1' : '')
  return applied
}

/** 启动时恢复上次的选择（关闭状态什么都不做，不白占一个 blocker）。 */
export function initKeepAwake(): void {
  if (isKeepAwakeOn()) applyKeepAwake(true)
}

// ── 任务运行期自动保持唤醒（与上面的手动常驻开关互不干扰，各持各的 blocker）──
// 为什么需要：手动开关默认是关的，用户息屏几分钟系统就闲置休眠，执行中的任务
// 连同网络请求一起被挂起/杀死（实测反馈 2026-08-13：一息屏任务就没了）。
// 有任务在跑就该自动阻止闲置休眠，跑完立刻放开——不需要用户知道有这么个开关。
// 注意 prevent-app-suspension 挡不住合盖（合盖必睡），那种中断由 db 开库清扫补留痕。

let runHolds = 0
let runBlockerId: number | null = null

/** 引用计数：并发多任务共用一个 blocker，最后一个收尾时才释放。返回幂等的释放函数。 */
export function holdAwakeForRun(): () => void {
  runHolds++
  try {
    if (runBlockerId === null || !powerSaveBlocker.isStarted(runBlockerId)) {
      runBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    }
  } catch (e) { swallow(e, 'keep-awake-run') }
  let released = false
  return () => {
    if (released) return
    released = true
    runHolds = Math.max(0, runHolds - 1)
    if (runHolds === 0 && runBlockerId !== null) {
      try { if (powerSaveBlocker.isStarted(runBlockerId)) powerSaveBlocker.stop(runBlockerId) } catch (e) { swallow(e, 'keep-awake-run') }
      runBlockerId = null
    }
  }
}
