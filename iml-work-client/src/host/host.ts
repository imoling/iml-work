// iFlyWorker Web 宿主入口（B/S 形态，形态 A：同机无头进程 + 浏览器 UI）。
//
// 与 Electron 壳（src/main/main.ts）共用同一批 ipc/*.ts 注册函数、同一个数据根（决策 D1）；
// 差异只有三点：总线是 WS（ipc-bus 注入）、事件推送走广播（window-ref 覆盖点）、
// 桌面原生能力降级（host-stubs）。浏览器自动化强制 Playwright 引擎（Electron 分区不可用）。
//
// 安全边界：默认只绑 127.0.0.1——页面能操作全部本地能力（技能执行/文件/凭证入口），
// 开放局域网前必须自行加访问控制（决策 D4：仅本机）。
import http from 'http'
import path from 'path'
import fs from 'fs'
import { WebSocketServer } from 'ws'
import { setIpcBus } from '../main/ipc-bus'
import { setEmitOverride } from '../main/window-ref'
import { appVersion, userDataDir } from '../main/app-paths'
import { INVOKE_CHANNELS } from '../shared/ipc-channels'
import { WsBus } from './ws-bus'
import { serveStatic, serveLocalFile } from './static-server'
import { workspaceDir, resolveWorkspaceFile } from '../main/workspace-files'
import { msgAdd } from '../main/db'
import { registerHostStubs } from './host-stubs'
import { superviseHostServices, shutdownHostServices } from './host-services'
import { initSkillStore } from '../main/skill-store'
import { registerDbHandlers } from '../main/ipc/db'
import { registerFocusHandlers } from '../main/ipc/focus'
import { registerAuthExpertHandlers } from '../main/ipc/auth-expert'
import { registerSkillAuthoringHandlers } from '../main/ipc/skill-authoring'
import { registerFilesKbHandlers } from '../main/ipc/files-kb'
import { registerMiscHandlers } from '../main/ipc/misc'
import { registerConnectorHandlers } from '../main/ipc/connectors'
import { registerBizSystemsHandlers } from '../main/ipc/biz-systems'
import { registerRecorderIpc } from '../main/ipc/recorder'
import { registerTurnHandlers } from '../main/ipc/agent-core'
import { registerAgentControlHandlers } from '../main/ipc/agent-control'
import { registerShellMiscHandlers } from '../main/ipc/shell-misc'

// 浏览器自动化：Web 形态没有 Electron 分区，登录/执行/录制一律走 Playwright 持久化 Profile
process.env.IML_ENGINE = process.env.IML_ENGINE || 'playwright'

const bus = new WsBus()
setIpcBus(bus)
setEmitOverride((channel, payload) => bus.broadcast(channel, payload))

// 兜底落库：turn 结果本由渲染层落库（桌面端契约）；发起页刷新/关闭后回执无处可送，
// 宿主替它把助手回复写进会话——刷新只是「暂时离开」，不再等于丢结果。
bus.onOrphanResult = (channel, args, result) => {
  if (channel !== 'turn:send-message') return
  const p = (args?.[0] || {}) as { convId?: string }
  const r = (result || {}) as Record<string, any>
  if (!p.convId || !r.content || r.permSwitch) return
  try {
    const hasMeta = r.sources?.length || r.webSources?.length || r.traceId || r.files?.length || r.execLogs?.length || r.ontology || r.loginRequest
    const meta = hasMeta ? JSON.stringify({
      sources: r.sources, webSources: r.webSources, traceId: r.traceId, files: r.files,
      execLogs: r.execLogs, ontology: r.ontology, loginRequest: r.loginRequest,
    }) : null
    msgAdd(p.convId, 'assistant', String(r.content), meta)
    console.log(`[host] 发起页已断开，助手回复已兜底落库 conv=${p.convId}`)
  } catch (e) { console.error('[host] 兜底落库失败', e) }
}

// stub 先占位（WsBus 先注册者优先）：窗口/应用偏好/自动更新/录制（D3 不开放）降级
registerHostStubs()

// 与 main.ts 同一批注册（少 registerWindowHandlers——其通道已全部由 stub 承接）
initSkillStore()
registerDbHandlers()
registerFocusHandlers()
registerAuthExpertHandlers()
registerSkillAuthoringHandlers()
registerFilesKbHandlers()
registerMiscHandlers()
registerConnectorHandlers()
registerBizSystemsHandlers()
registerRecorderIpc()   // recorder:* 已被 stub 占位；skill:save-recorded 等落库通道保留可用
registerTurnHandlers()
registerAgentControlHandlers()
registerShellMiscHandlers()

const ALLOWED: ReadonlySet<string> = new Set(INVOKE_CHANNELS)

function resolveDistDir(): string | null {
  const candidates = [path.resolve(__dirname, '../dist'), path.resolve(process.cwd(), 'dist')]
  return candidates.find(d => fs.existsSync(path.join(d, 'index.html'))) || null
}

const PORT = Number(process.env.IML_HOST_PORT) || 8046
const BIND = process.env.IML_HOST_BIND || '127.0.0.1'
const distDir = resolveDistDir()
if (!distDir) console.warn('[host] 未找到渲染层构建产物 dist/index.html——先执行 npm run build；当前仅 WS RPC 可用')

const server = http.createServer((req, res) => {
  const url = req.url || '/'
  // 工作空间产物只读直出（Web 形态「查看/下载」）。resolveWorkspaceFile 与 files:preview 同源：
  // 直拼命中根目录/带前缀路径，否则按基名在会话产物子目录里递归找；越界一律 404。
  if (url.startsWith('/workspace/')) {
    let name = ''
    try { name = decodeURIComponent(url.slice('/workspace/'.length).split('?')[0]) } catch { /* 非法编码按空处理 */ }
    const abs = name ? resolveWorkspaceFile(name) : null
    serveLocalFile(abs && abs.startsWith(workspaceDir()) ? abs : null, res)
    return
  }
  if (distDir) serveStatic(distDir, req, res)
  else { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('渲染层未构建：请先在 iml-work-client 下执行 npm run build') }
})

const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', (ws) => {
  bus.addClient(ws)
  try { ws.send(JSON.stringify({ t: 'hello', platform: process.platform, mode: 'web', version: appVersion() })) } catch (_) { /* 刚连就断 */ }
  ws.on('message', (raw) => {
    let m: any
    try { m = JSON.parse(String(raw)) } catch { return }
    if (m?.t === 'invoke' && typeof m.channel === 'string' && typeof m.id === 'number') void bus.dispatch(ws, m, ALLOWED)
  })
})

// 后台单例服务主从让位（D2 允许与客户端双开；客户端永远是主）
superviseHostServices()

server.listen(PORT, BIND, () => {
  console.log(`[host] iFlyWorker Web 宿主 v${appVersion()} 已启动: http://${BIND === '0.0.0.0' ? '127.0.0.1' : BIND}:${PORT}`)
  console.log(`[host] 数据目录: ${userDataDir()}（与桌面客户端共享，IML_USER_DATA_DIR 可覆盖）`)
})

const shutdown = () => { shutdownHostServices(); try { server.close() } catch (_) { /* 已关 */ } process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
