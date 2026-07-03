// ================= 远程控制机器人（飞书 / 钉钉 / QQ 官方长连接）=================
// 在主进程持有官方 SDK 的 WebSocket 长连接：本地即可收发消息，无需公网回调地址。
// 凭证只存本地配置库、绝不上传；收到指令后经工作分身 + 中转模型生成回答再回传。
import { configGet } from './db'
import { callLlm, currentLlmConfig } from './llm'
import { emitToRenderer } from './window-ref'
import { incImCommandCount } from './stats'

export type RemoteBotKey = 'feishu' | 'dingtalk' | 'qq'
export interface RemoteBotState { status: 'stopped' | 'starting' | 'running' | 'error'; error?: string; since?: number }

const remoteBotClients: Record<string, any> = {}
const remoteBotState: Record<string, RemoteBotState> = {
  feishu: { status: 'stopped' }, dingtalk: { status: 'stopped' }, qq: { status: 'stopped' },
}

export function getRemoteBotState(): Record<string, RemoteBotState> { return remoteBotState }

function setRemoteBotState(key: RemoteBotKey, s: RemoteBotState) {
  remoteBotState[key] = s
  emitToRenderer('remote-bot:status', { key, ...s })
}

// 远程指令 → 工作分身 + 中转模型作答（真实性边界：不编造业务数据）
async function remoteBotReply(channel: string, userText: string): Promise<string> {
  incImCommandCount()
  const expertName = configGet('lastClaimedExpertName') || '企业工作分身'
  const background = configGet('user-background') || ''
  const sys = `你是企业「工作分身」助手「${expertName}」，正在通过${channel}远程接收用户指令并作答。\n` +
    (background ? `【工作背景】\n${background}\n` : '') +
    `要求：用简洁专业的中文作答；你本身无法访问真实业务系统数据，若指令需要真实系统数据或执行 RPA，请说明需先在客户端「业务技能」中配置对应技能并绑定目标业务系统，严禁编造任何业务数据。`
  try {
    const out = await callLlm(`${sys}\n\n【用户远程指令】\n${userText}\n\n【你的回答】`, currentLlmConfig())
    return (out || '').trim() || '（未获得模型回复）'
  } catch (e: any) {
    return `处理失败：${e?.message || e}`
  }
}

async function startFeishuBot(values: Record<string, string>) {
  const lark = require('@larksuiteoapi/node-sdk')
  const appId = (values.appId || '').trim(), appSecret = (values.appSecret || '').trim()
  if (!appId || !appSecret) throw new Error('缺少 App ID / App Secret')
  const api = new lark.Client({ appId, appSecret })
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
      try {
        const msg = data?.message
        const messageId = msg?.message_id
        let text = ''
        try { text = JSON.parse(msg?.content || '{}').text || '' } catch (_) {}
        text = text.replace(/@_user_\d+/g, '').trim()
        if (!messageId || !text) return
        const reply = await remoteBotReply('飞书', text)
        await api.im.message.reply({ path: { message_id: messageId }, data: { msg_type: 'text', content: JSON.stringify({ text: reply }) } })
      } catch (e: any) { console.error('[feishu-bot] handle err:', e?.message) }
    },
  })
  const ws = new lark.WSClient({ appId, appSecret })
  await ws.start({ eventDispatcher: dispatcher })
  remoteBotClients.feishu = { ws, api }
}

async function startDingtalkBot(values: Record<string, string>) {
  const { DWClient, TOPIC_ROBOT, EventAck } = require('dingtalk-stream')
  const clientId = (values.clientId || '').trim(), clientSecret = (values.clientSecret || '').trim()
  if (!clientId || !clientSecret) throw new Error('缺少 Client ID / Client Secret')
  const client = new DWClient({ clientId, clientSecret, keepAlive: true })
  client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
    const messageId = res?.headers?.messageId
    try {
      const msg = JSON.parse(res?.data || '{}')
      const text = (msg?.text?.content || '').trim()
      const webhook = msg?.sessionWebhook
      if (messageId) { try { client.socketCallBackResponse(messageId, { status: EventAck.SUCCESS, message: 'OK' }) } catch (_) {} }
      if (!text || !webhook) return
      const reply = await remoteBotReply('钉钉', text)
      await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: reply } }) })
    } catch (e: any) { console.error('[dingtalk-bot] handle err:', e?.message) }
  })
  await client.connect()
  remoteBotClients.dingtalk = client
}

async function startQQBot(values: Record<string, string>) {
  const { Bot } = require('qq-official-bot')
  const appid = (values.appId || '').trim(), secret = (values.appSecret || '').trim()
  if (!appid || !secret) throw new Error('缺少 App ID / App Secret')
  const bot = new Bot({ appid, secret, sandbox: false, mode: 'websocket',
    intents: ['GROUP_AND_C2C_EVENT', 'DIRECT_MESSAGE', 'GUILD_MESSAGES', 'PUBLIC_GUILD_MESSAGES'] })
  bot.on('message', async (e: any) => {
    try {
      const text = (e?.raw_message || '').trim()
      if (!text) return
      const reply = await remoteBotReply('QQ', text)
      await e.reply(reply)
    } catch (err: any) { console.error('[qq-bot] handle err:', err?.message) }
  })
  await bot.start()
  remoteBotClients.qq = bot
}

export async function stopRemoteBot(key: RemoteBotKey) {
  const c = remoteBotClients[key]
  try {
    if (c) {
      if (key === 'feishu') c.ws?.close?.()
      else if (key === 'dingtalk') c.disconnect?.()
      else if (key === 'qq') await c.stop?.()
    }
  } catch (_) {}
  delete remoteBotClients[key]
  setRemoteBotState(key, { status: 'stopped' })
}

export async function startRemoteBot(key: RemoteBotKey, values: Record<string, string>) {
  await stopRemoteBot(key)
  setRemoteBotState(key, { status: 'starting' })
  try {
    if (key === 'feishu') await startFeishuBot(values)
    else if (key === 'dingtalk') await startDingtalkBot(values)
    else if (key === 'qq') await startQQBot(values)
    else throw new Error('未知机器人类型')
    setRemoteBotState(key, { status: 'running', since: Date.now() })
  } catch (e: any) {
    setRemoteBotState(key, { status: 'error', error: e?.message || String(e) })
    throw e
  }
}

// 启动时自动拉起「已启用且配置完整」的机器人
export async function bootRemoteBots() {
  try {
    const raw = configGet('remoteBots')
    if (!raw) return
    const cfg = JSON.parse(raw) as Record<string, { enabled?: boolean; values?: Record<string, string> }>
    for (const key of ['feishu', 'dingtalk', 'qq'] as RemoteBotKey[]) {
      const b = cfg[key]
      if (b && b.enabled && b.values) {
        startRemoteBot(key, b.values).catch(e => console.error(`[remote-bot] 自动启动 ${key} 失败:`, e?.message))
      }
    }
  } catch (e: any) { console.error('[remote-bot] boot err:', e?.message) }
}
