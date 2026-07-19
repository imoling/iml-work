// 远程机器人起停测 / 追溯反馈 / 工作台总览 / 会话上下文整理 IPC。
import { ipcMain } from 'electron'
import { getAdminBaseUrl, afetch } from '../http'
import {  } from '../util'
import { type RemoteBotKey, getRemoteBotState, startRemoteBot, stopRemoteBot } from '../remote-bots'
import {  } from '../stats'
import { callLlm, type LlmConfig } from '../llm'
import { type Turn, buildSummaryMergePrompt } from '../context-core'
import { ctxSumGet, ctxSumSet } from '../agent-steps'

export function registerMiscHandlers(): void {
ipcMain.handle('remote-bot:status', () => getRemoteBotState())
ipcMain.handle('remote-bot:start', async (_e, key: RemoteBotKey, values: Record<string, string>) => {
  try { await startRemoteBot(key, values); return { success: true } }
  catch (e: any) { return { success: false, error: e?.message || String(e) } }
})
ipcMain.handle('remote-bot:stop', async (_e, key: RemoteBotKey) => {
  await stopRemoteBot(key); return { success: true }
})
// 用户对某条回答的质量反馈 → 回填到管理端 Trace（优先 traceId 精确回填，否则按问题文本兜底）
ipcMain.handle('trace:feedback', async (_e, data: { traceId?: string; userQuestion?: string; feedback: string | null }) => {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/traces/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ traceId: data.traceId, userQuestion: data.userQuestion, feedback: data.feedback })
    })
    return r.ok ? await r.json() : { success: false }
  } catch (e: any) { return { success: false, error: e?.message } }
})
// 工作台驾驶舱：一次拉取真实能力 + 最近任务 + 系统连接，供首页真实驱动展示
ipcMain.handle('workbench:overview', async () => {
  const base = getAdminBaseUrl()
  const get = async (p: string) => { try { const r = await afetch(`${base}${p}`); return r.ok ? await r.json() : [] } catch (_) { return [] } }
  const [skills, actions, traces, systems] = await Promise.all([
    get('/api/v1/skills/catalog'), get('/api/v1/ontology/actions'), get('/api/v1/traces'), get('/api/v1/integrations'),
  ])
  return {
    skills: Array.isArray(skills) ? skills : [],
    actions: Array.isArray(actions) ? actions : [],
    traces: (Array.isArray(traces) ? traces : []).slice(0, 6),
    systems: Array.isArray(systems) ? systems : [],
  }
})

// 手动「整理上下文」：把当前会话已发生的全部轮次并入会话级持久摘要（与自动滚动折叠同一机制、
// 同一份 KV）。之后的轮次只携带「要点摘要 + 新对话」——对标 Claude Code 的 /compact。
ipcMain.handle('context:compact', async (_e, data: { convId: string; history: Turn[]; histTotal?: number; llmConfig: LlmConfig }) => {
  try {
    if (!data?.convId || !Array.isArray(data.history) || !data.history.length) return { ok: false, error: '当前会话没有可整理的对话' }
    const sum = ctxSumGet(data.convId)
    const total = Math.max(data.histTotal ?? data.history.length, data.history.length)
    const offset = total - data.history.length
    const floorIdx = Math.min(data.history.length, Math.max(0, sum.upto - offset))
    const fold = data.history.slice(floorIdx)
    if (fold.length) {
      const merged = (await callLlm(buildSummaryMergePrompt(sum.summary, fold), data.llmConfig, { temperature: 0 })).trim()
      if (merged && merged !== '（无）') sum.summary = merged
    }
    sum.upto = total
    ctxSumSet(data.convId, sum)
    return { ok: true, summary: sum.summary }
  } catch (e: any) { return { ok: false, error: e?.message || String(e) } }
})

ipcMain.handle('remote-bot:test', async (_e, key: RemoteBotKey, values: Record<string, string>) => {
  // 建立真实长连接即为连通验证；成功后保持运行（等价于启用）
  try { await startRemoteBot(key, values); return { success: true, message: '连接成功，已建立官方长连接。' } }
  catch (e: any) { return { success: false, error: e?.message || String(e) } }
})
}
