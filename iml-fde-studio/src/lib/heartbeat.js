// 登录保活心跳（全局单例）：定时在本地已登录的 Chrome Profile 里无头静默访问已验证系统，
// 访问即触发服务端刷新会话有效期（滑动过期），同时检测在线并回写连接状态。
// 全局运行（不随页面卸载停止）；Layout 常驻订阅展示状态，系统连接页共用同一 store。凭证只在本地，不上传。
import { Admin, Connections, Browser } from '../services/api.js'

const KEY = 'fde.hb', OWNER = 'fde-local'
const readEnabled = () => { try { return localStorage.getItem(KEY) !== 'off' } catch (_) { return true } }

let state = { enabled: readEnabled(), busy: false, lastAt: '', online: 0, total: 0, supported: false }
const subs = new Set()
const emit = () => subs.forEach(f => { try { f(state) } catch (_) {} })
const set = (p) => { state = { ...state, ...p }; emit() }

export function subscribe(cb) { subs.add(cb); cb(state); return () => subs.delete(cb) }
export function getState() { return state }
export function setEnabled(v) {
  try { localStorage.setItem(KEY, v ? 'on' : 'off') } catch (_) {}
  set({ enabled: v })
  if (v) runHeartbeat()
}

let running = false
export async function runHeartbeat() {
  if (!Browser.available() || running) return
  running = true; set({ busy: true, supported: true })
  try {
    const [systems, conns] = await Promise.all([Admin.integrations(), Connections.list()])
    const targets = (systems || [])
      .map(s => ({ s, c: (conns || []).find(c => c.systemId === s.id && c.ownerUserId === OWNER) }))
      .filter(x => x.c && x.c.status === 'verified' && x.s.baseUrl)
    let online = 0
    for (const { s, c } of targets) {
      try {
        const r = await Browser.ping({ systemId: s.id, baseUrl: s.baseUrl })
        if (!r || r.ok === false || r.skipped) { online++; continue }   // 跳过/失败本轮不改判，视为维持原态
        if (r.loggedIn) online++
        await Connections.verifyResult(c.id, { ok: !!r.loggedIn, message: r.loggedIn ? '心跳保活：会话有效' : '心跳检测：登录会话已失效' })
      } catch (_) {}
    }
    const now = new Date()
    const at = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    set({ busy: false, lastAt: at, online, total: targets.length })
  } catch (_) { set({ busy: false }) }
  finally { running = false }
}

let timer = null
export function startLoop(intervalMs = 4 * 60 * 1000) {
  if (timer || !Browser.available()) return
  set({ supported: true })
  timer = setInterval(() => { if (state.enabled) runHeartbeat() }, intervalMs)
}
