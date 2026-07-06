// 登录会话 / LLM 连接测试 / 岗位专家列表与领用 IPC。纯搬迁自 main.ts。
import { ipcMain } from 'electron'
import { configGet, configSet, configGetAll } from '../db'
import { getAdminBaseUrl, authToken, authUser, authHeaders, afetch } from '../http'
import { swallow } from '../util'
import { getLoadedSkills, setSkillDisplayName, loadLocalSkills, pruneDeletedSkills, writeSkillFile } from '../skill-store'

export function registerAuthExpertHandlers(): void {
// LLM Connection Test - accepts config directly from renderer
ipcMain.handle('llm:test', async (_event, cfg: { mode: string; apiMode: string; baseUrl: string; apiKey: string; modelName: string }) => {
  const mode = cfg.mode || 'proxy'
  const apiMode = cfg.apiMode || 'chat'
  const baseUrl = cfg.baseUrl || ''
  const apiKey = cfg.apiKey || ''
  const modelName = cfg.modelName || ''

  let cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  if (cleanBaseUrl.endsWith('/chat/completions')) cleanBaseUrl = cleanBaseUrl.slice(0, -'/chat/completions'.length)
  if (cleanBaseUrl.endsWith('/v1/messages')) cleanBaseUrl = cleanBaseUrl.slice(0, -'/v1/messages'.length)

  let targetUrl = ''
  if (mode === 'proxy') {
    targetUrl = `${cleanBaseUrl}/chat`
  } else if (apiMode === 'anthropic') {
    targetUrl = `${cleanBaseUrl}/v1/messages`
  } else {
    targetUrl = `${cleanBaseUrl}/chat/completions`
  }

  const allConfigs = configGetAll()
  const diagnostics = {
    config: { mode, apiMode, baseUrl, modelName, apiKeyPrefix: apiKey?.substring(0, 12) + '...' },
    targetUrl,
    dbKeyCount: Object.keys(allConfigs).length,
    dbKeys: Object.keys(allConfigs)
  }

  if (!baseUrl || !apiKey || !modelName) {
    return { ...diagnostics, error: '配置不完整：Base URL、API Key 或模型名称为空', success: false }
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    let body: any = {}

    if (mode === 'proxy') {
      headers['Authorization'] = `Bearer ${apiKey}`
      body = { model: modelName, messages: [{ role: 'user', content: 'hi, reply with just the word OK' }] }
    } else if (apiMode === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      body = { model: modelName, max_tokens: 20, messages: [{ role: 'user', content: 'hi, reply with just the word OK' }] }
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`
      body = { model: modelName, messages: [{ role: 'user', content: 'hi, reply with just the word OK' }] }
    }

    const response = await fetch(targetUrl, { method: 'POST', headers, body: JSON.stringify(body) })
    const rawText = await response.text()
    let parsed: any = null
    try { parsed = JSON.parse(rawText) } catch (e) { swallow(e) }

    return {
      ...diagnostics,
      httpStatus: response.status,
      httpStatusText: response.statusText,
      rawResponse: rawText.substring(0, 2000),
      parsedContent: parsed?.choices?.[0]?.message?.content || parsed?.content?.[0]?.text || null,
      success: response.ok
    }
  } catch (err: any) {
    return {
      ...diagnostics,
      error: err.message,
      success: false
    }
  }
})

// 企业基础信息与规则：由管理端统一维护，构建系统指令时实时拉取，不在客户端写死。


// 个人知识库自动入库已拆至 personal-kb.ts，此处只留 IPC 编排。

// 从管理端拉取最新的岗位专家列表，供客户端「当前工作分身」展示与领用。
// ── 登录 IPC ──────────────────────────────────────────────────────────────
const REMEMBER_MS = 7 * 24 * 60 * 60 * 1000   // 「7天内自动登录」有效期
ipcMain.handle('auth:login', async (_event, { username, password, remember }: { username: string; password: string; remember?: boolean }) => {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': 'client' },
      body: JSON.stringify({ username, password })
    })
    const data: any = await r.json().catch(() => ({}))
    if (!r.ok || !data.success) return { ok: false, error: data.error || `登录失败(${r.status})` }
    configSet('auth-token', data.token)
    configSet('auth-user', JSON.stringify(data.user))
    configSet('auth-last-username', username)   // 记住上次登录用户名(下次预填)
    // 是否允许下次启动自动登录（勾选「7天内自动登录」）
    configSet('auth-remember', remember === false ? 'false' : 'true')
    configSet('auth-login-at', String(Date.now()))
    return { ok: true, user: data.user }
  } catch (e: any) {
    return { ok: false, error: `无法连接服务端：${e.message}` }
  }
})
ipcMain.handle('auth:session', async () => {
  const u = authUser()
  if (!u || !authToken()) return { user: null }
  // 「7天内自动登录」闸门：未勾选或已过期 → 不自动登录，清凭证要求重新输入密码
  const remember = configGet('auth-remember') === 'true'
  const loginAt = Number(configGet('auth-login-at') || '0')
  if (!remember || !loginAt || Date.now() - loginAt > REMEMBER_MS) {
    configSet('auth-token', ''); configSet('auth-user', '')
    return { user: null }
  }
  // 校验 token 仍有效（顺带刷新用户信息）
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/auth/me`, { headers: authHeaders() })
    if (r.ok) { const fresh: any = await r.json(); configSet('auth-user', JSON.stringify(fresh)); return { user: fresh } }
    if (r.status === 401) { configSet('auth-token', ''); configSet('auth-user', ''); return { user: null } }
  } catch (_) { /* 后端离线：沿用本地缓存用户，允许离线继续用 */ }
  return { user: u }
})
ipcMain.handle('auth:logout', async () => {
  configSet('auth-token', ''); configSet('auth-user', '')
  configSet('auth-remember', 'false'); configSet('auth-login-at', '')
  return { ok: true }
})
ipcMain.handle('auth:last-username', () => configGet('auth-last-username') || '')
ipcMain.handle('auth:forgot', async (_event, { username, phone }: { username: string; phone?: string }) => {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/auth/forgot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': 'client' },
      body: JSON.stringify({ username, phone: phone || '' })
    })
    const data: any = await r.json().catch(() => ({}))
    if (!r.ok || !data.success) return { ok: false, error: data.error || '提交失败' }
    return { ok: true, message: data.message }
  } catch (e: any) { return { ok: false, error: e.message } }
})
ipcMain.handle('auth:change-password', async (_event, { oldPassword, newPassword }: { oldPassword: string; newPassword: string }) => {
  try {
    const r = await fetch(`${getAdminBaseUrl()}/api/v1/auth/change-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ oldPassword, newPassword })
    })
    const data: any = await r.json().catch(() => ({}))
    if (!r.ok || !data.success) return { ok: false, error: data.error || `修改失败(${r.status})` }
    // 刷新本地用户信息（mustChangePassword 变 false）
    try {
      const me = await fetch(`${getAdminBaseUrl()}/api/v1/auth/me`, { headers: authHeaders() })
      if (me.ok) { const fresh: any = await me.json(); configSet('auth-user', JSON.stringify(fresh)); return { ok: true, user: fresh } }
    } catch (e) { swallow(e) }
    return { ok: true }
  } catch (e: any) { return { ok: false, error: e.message } }
})

ipcMain.handle('expert:list', async () => {
  try {
    const r = await afetch(`${getAdminBaseUrl()}/api/v1/experts`)
    if (!r.ok) return { success: false, error: `backend ${r.status}` }
    const list: any[] = await r.json()
    let experts = (Array.isArray(list) ? list : []).map((e: any) => ({
      id: e.id,
      title: e.title || '未命名分身',
      spec: e.spec || '',
      description: e.description || '',
      skills: Array.isArray(e.skills) ? e.skills.map((s: any) => ({ id: s.id, name: s.name, type: s.type, description: s.description || '', category: s.category || '', version: s.version || '', status: s.status || '', triggerKeywords: Array.isArray(s.triggerKeywords) ? s.triggerKeywords : [] })) : []
    }))
    // 按登录用户的「可领用岗位」过滤（allowAllExperts=true 或未登录则不限制）
    const u = authUser()
    if (u && !u.allowAllExperts) {
      const allow = new Set(u.assignedExpertIds || [])
      experts = experts.filter(e => allow.has(e.id))
    }
    return { success: true, experts }
  } catch (netErr: any) {
    console.warn(`[expert:list] Backend offline: ${netErr.message}`)
    return { success: false, error: 'offline' }
  }
})

ipcMain.handle('expert:claim', async (_event, expertId: string) => {
  console.log(`[expert:claim] expertId="${expertId}"`)

  let syncSuccess = false
  let skillsSynced: Array<{ id: string; name: string; type: string; description?: string; category?: string; version?: string; status?: string; triggerKeywords?: string[] }> = []
  let knowledgeScope: string[] = []

  // 1. Try syncing from Spring Boot backend server
  try {
    console.log(`[expert:claim] Requesting sync from backend for expert: ${expertId}`)
    const response = await afetch(`${getAdminBaseUrl()}/api/v1/experts/claim/${expertId}`, {
      method: 'POST'
    })

    if (response.ok) {
      const data: any = await response.json()
      console.log(`[expert:claim] Backend response:`, data)
      if (data.success && data.skillsSynced) {
        // Write each skill to physical folder
        for (const sk of data.skillsSynced) {
          writeSkillFile(sk)
          if (sk && sk.id && sk.name) setSkillDisplayName(String(sk.id), String(sk.name))
          skillsSynced.push({
            id: sk.id,
            name: sk.name,
            type: sk.type,   // 保留真实引擎类型（python-sandbox/playwright…），由 UI 映射友好标签
            description: sk.description || '',
            category: sk.category || '',
            version: sk.version || '',
            status: sk.status || '',
            triggerKeywords: Array.isArray(sk.triggerKeywords) ? sk.triggerKeywords : []
          })
        }
        // Remember the claimed expert for client heartbeat reporting
        configSet('lastClaimedExpertId', expertId)
        // 记录该岗位实际装配的技能 ID 集（技能匹配据此限定范围，避免误命中未装配/全局技能）
        configSet('boundSkills:' + expertId, JSON.stringify(data.skillsSynced.map((s: any) => String(s.id))))
        // Downlinked corporate knowledge-base retrieval scope for this expert
        if (Array.isArray(data.knowledgeScope)) {
          knowledgeScope = data.knowledgeScope
          configSet('kbScope:' + expertId, JSON.stringify(knowledgeScope))
          console.log(`[expert:claim] Knowledge scope downlinked: ${knowledgeScope.join(', ') || '(none)'}`)
        }
        syncSuccess = true
        console.log(`[expert:claim] Successfully synchronized ${data.skillsSynced.length} skills from backend.`)
      }
    } else {
      console.warn(`[expert:claim] Backend returned non-OK status: ${response.status}`)
    }
  } catch (netErr: any) {
    console.warn(`[expert:claim] Backend server offline or request failed: ${netErr.message}`)
  }

  // 2.（已移除）演示用记忆种子：曾在此伪造「岗位 SOP / 用户个人习惯」写入本地记忆库——
  // 数据与来源(“用户历史会话沉淀”)均系编造，且 agent SOP 每次认领会无条件覆盖真实沉淀，
  // 违反真实性红线。记忆应只来自真实沉淀（用户设置/会话记忆/管理端下发），空着就是空着。

  // 3. Load local skills dynamically (if syncSuccess is false, it loads what's already on disk)
  if (syncSuccess) await pruneDeletedSkills()   // 同步成功 → 以管理端为准清理已删技能
  loadLocalSkills()

  // 4. 管理端离线时的兜底：如实列出本地已落盘的技能（此前同步下来的），没有就是空——不特判、不硬造预置条目。
  if (!syncSuccess) {
    console.log(`[expert:claim] Backend sync offline. Listing local on-disk skills.`)
    getLoadedSkills().forEach(sk => {
      skillsSynced.push({ id: sk.id, name: sk.name, type: '本地已落盘技能 (Markdown SOP)' })
    })
  }

  return {
    success: true,
    skillsSynced,
    knowledgeScope
  }
})

// Files list and mock endpoints
}
