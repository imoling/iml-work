// 单例后台服务的主从让位（决策 D2：允许客户端与宿主同时运行、D1：共享数据根）。
// 这些服务全进程只能有一份：调度器（任务双跑）、心跳（重复上报）、IM 机器人（消息双回）、
// 文件监听（重复摄入）。Electron 客户端永远是主（其行为不变）；宿主每 30s 探测信标，
// 客户端在跑就让位、退出了就接管。
import { electronAlive } from '../main/instance-beacon'
import { startHeartbeat, stopHeartbeat } from '../main/client-heartbeat'
import { startFileSyncWatcher, stopFileSyncWatcher } from '../main/file-sync'
import { startScheduler, stopScheduler } from '../main/scheduler'
import { bootRemoteBots, stopRemoteBot, type RemoteBotKey } from '../main/remote-bots'
import { ingestToPersonalKB } from '../main/personal-kb'
import { swallow } from '../main/util'

const BOT_KEYS: RemoteBotKey[] = ['feishu', 'dingtalk', 'qq']
let servicesOn = false

function startAll(): void {
  startFileSyncWatcher(p => { ingestToPersonalKB(p).catch(e => swallow(e, 'personal-kb-ingest')) })
  startHeartbeat()
  startScheduler()
  bootRemoteBots()
  // biz-keepalive（业务系统会话保活）依赖 Electron 分区窗口，Web 形态不启——登录态由 Playwright 持久化 Profile 承载
}

function stopAll(): void {
  stopHeartbeat()
  stopFileSyncWatcher()
  stopScheduler()
  for (const k of BOT_KEYS) { void stopRemoteBot(k) }
}

/** 启动即判一次，随后每 30s 复核：客户端出现→让位，客户端退出→接管。 */
export function superviseHostServices(): void {
  const tick = () => {
    const electronRunning = electronAlive()
    if (electronRunning && servicesOn) {
      console.log('[host] 检测到桌面客户端在跑，后台单例服务（调度/心跳/机器人/文件监听）让位给客户端')
      stopAll(); servicesOn = false
    } else if (!electronRunning && !servicesOn) {
      console.log('[host] 桌面客户端未在跑，宿主接管后台单例服务')
      startAll(); servicesOn = true
    }
  }
  tick()
  setInterval(tick, 30_000)
}

export function shutdownHostServices(): void {
  if (servicesOn) { stopAll(); servicesOn = false }
}
