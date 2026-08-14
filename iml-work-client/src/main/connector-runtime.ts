// ================= 服务连接器运行时：凭证存储 + 探活验证 + 各服务 API 实现 =================
//
// 分层：connector-defs（纯数据目录）→ 本文件（存储与真实 API 调用）→ connector-tools（ToolSpec 组装）。
// 凭证存 config 键 `saasConnectors`（db.ts SECURE_KEYS 加密 + 按账号分库），绝不上传平台。
// 网络调用一律 global fetch + 15s 超时；错误如实抛出带服务端原话，绝不吞成「成功」。
import crypto from 'crypto'
import { configGet, configSet } from './db'
import { connectorDefOf, connectorFieldsComplete, CONNECTOR_DEFS, type ConnectorDef } from './connector-defs'
import { swallow, friendlyNetError } from './util'

const CONFIG_KEY = 'saasConnectors'
const TIMEOUT_MS = 15_000

/** 一个连接器的本地保存态。identity 是探活验证带回的身份标识（如 GitHub 登录名）。 */
export interface SavedConnector {
  enabled: boolean
  values: Record<string, string>
  identity?: string
  verifiedAt?: number
}

export interface ValidationResult { ok: boolean; identity?: string; error?: string }

// ─── 存储 ─────────────────────────────────────────────────────────────────────

export function loadConnectorConfigs(): Record<string, SavedConnector> {
  try {
    const raw = configGet(CONFIG_KEY)
    if (raw) return JSON.parse(raw) as Record<string, SavedConnector>
  } catch (e) { swallow(e, 'connector-load') }
  return {}
}

function persist(all: Record<string, SavedConnector>): void {
  configSet(CONFIG_KEY, JSON.stringify(all))
}

/**
 * 保存一个连接器的配置。密钥字段传空串 = 保留旧值（渲染层拿到的是掩码，
 * 用户没重填时不能拿掩码把真值覆盖掉）。
 */
export function saveConnectorConfig(key: string, patch: { enabled?: boolean; values?: Record<string, string> }): SavedConnector {
  const def = connectorDefOf(key)
  if (!def) throw new Error(`未知连接器：${key}`)
  const all = loadConnectorConfigs()
  const prev = all[key] || { enabled: false, values: {} }
  const values = { ...prev.values }
  for (const f of def.fields) {
    const v = (patch.values?.[f.key] ?? '').trim()
    if (v) values[f.key] = v
    else if (!f.secret) values[f.key] = v   // 非密钥字段允许清空；密钥留空=保留旧值
  }
  const next: SavedConnector = {
    enabled: patch.enabled ?? prev.enabled,
    values,
    // 凭证变过就作废旧的验证结论（身份可能已经不是原来那个了）
    ...(JSON.stringify(values) === JSON.stringify(prev.values) && prev.identity
      ? { identity: prev.identity, verifiedAt: prev.verifiedAt }
      : {}),
  }
  all[key] = next
  persist(all)
  return next
}

export function removeConnectorConfig(key: string): void {
  const all = loadConnectorConfigs()
  delete all[key]
  persist(all)
}

export function markVerified(key: string, identity: string): void {
  const all = loadConnectorConfigs()
  if (!all[key]) return
  all[key].identity = identity
  all[key].verifiedAt = Date.now()
  persist(all)
}

/** 已连接（启用 + 必填字段齐全）的连接器——工具门控的唯一判据。 */
export function connectedConnectors(): { def: ConnectorDef; saved: SavedConnector }[] {
  const all = loadConnectorConfigs()
  return CONNECTOR_DEFS
    .map(def => ({ def, saved: all[def.key] }))
    .filter((x): x is { def: ConnectorDef; saved: SavedConnector } =>
      !!x.saved && x.saved.enabled && connectorFieldsComplete(x.def, x.saved.values))
}

// ─── HTTP 基础 ────────────────────────────────────────────────────────────────

async function jfetch(url: string, init?: RequestInit): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch (e) { swallow(e, 'connector-jfetch-parse') }
  return { status: res.status, body, text }
}

function fail(service: string, r: { status: number; body: any; text: string }): never {
  const msg = r.body?.msg || r.body?.errmsg || r.body?.message || r.body?.errorMessages?.join('; ') || r.text.slice(0, 200)
  throw new Error(`${service} 调用失败（HTTP ${r.status}）：${msg || '无响应内容'}`)
}

// ─── 飞书（自建应用）──────────────────────────────────────────────────────────

const FEISHU_BASE = 'https://open.feishu.cn'

async function feishuToken(values: Record<string, string>): Promise<string> {
  const r = await jfetch(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: values.appId, app_secret: values.appSecret }),
  })
  if (r.body?.code !== 0 || !r.body?.tenant_access_token) {
    throw new Error(`飞书获取应用凭证失败：${r.body?.msg || `HTTP ${r.status}`}`)
  }
  return r.body.tenant_access_token as string
}

async function feishuApi(values: Record<string, string>, path: string, init?: RequestInit): Promise<any> {
  const token = await feishuToken(values)
  const r = await jfetch(`${FEISHU_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers as Record<string, string> | undefined) },
  })
  if (r.body?.code !== 0) fail('飞书', r)
  return r.body?.data
}

/** receiver 支持邮箱 / open_id(ou_…) / 群 chat_id(oc_…)，按形状推断 receive_id_type。 */
export async function feishuSendMessage(values: Record<string, string>, receiver: string, text: string): Promise<string> {
  const rid = receiver.trim()
  const type = rid.startsWith('oc_') ? 'chat_id' : rid.startsWith('ou_') ? 'open_id' : rid.includes('@') ? 'email' : ''
  if (!type) throw new Error(`无法识别接收者「${rid}」：请提供邮箱、open_id（ou_ 开头）或群 chat_id（oc_ 开头，可先用查看群列表工具获取）`)
  await feishuApi(values, `/open-apis/im/v1/messages?receive_id_type=${type}`, {
    method: 'POST',
    body: JSON.stringify({ receive_id: rid, msg_type: 'text', content: JSON.stringify({ text }) }),
  })
  return `已通过飞书发送给 ${rid}`
}

export async function feishuListChats(values: Record<string, string>): Promise<string> {
  const data = await feishuApi(values, '/open-apis/im/v1/chats?page_size=20')
  const items: any[] = data?.items || []
  if (!items.length) return '机器人当前不在任何群里（需先把应用机器人拉进目标群）。'
  return items.map(c => `· ${c.name || '(未命名群)'}  chat_id=${c.chat_id}`).join('\n')
}

async function validateFeishu(values: Record<string, string>): Promise<ValidationResult> {
  const token = await feishuToken(values)
  const r = await jfetch(`${FEISHU_BASE}/open-apis/bot/v3/info`, { headers: { Authorization: `Bearer ${token}` } })
  const name = r.body?.bot?.app_name
  return { ok: true, identity: name ? `应用「${name}」` : '应用凭证有效' }
}

// ─── 钉钉群机器人（Webhook + 加签）────────────────────────────────────────────

function dingtalkSignedUrl(values: Record<string, string>): string {
  const webhook = (values.webhook || '').trim()
  const secret = (values.signSecret || '').trim()
  if (!secret) return webhook
  const timestamp = Date.now()
  const sign = encodeURIComponent(
    crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64'))
  return `${webhook}&timestamp=${timestamp}&sign=${sign}`
}

export async function dingtalkSendGroup(values: Record<string, string>, text: string): Promise<string> {
  const r = await jfetch(dingtalkSignedUrl(values), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
  })
  if (r.body?.errcode !== 0) fail('钉钉群机器人', r)
  return '已发送到钉钉群'
}

// ─── 企业微信群机器人（Webhook）───────────────────────────────────────────────

export async function wecomSendGroup(values: Record<string, string>, text: string): Promise<string> {
  const r = await jfetch((values.webhook || '').trim(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
  })
  if (r.body?.errcode !== 0) fail('企业微信群机器人', r)
  return '已发送到企业微信群'
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

function ghBase(values: Record<string, string>): string {
  return ((values.apiBase || '').trim() || 'https://api.github.com').replace(/\/$/, '')
}

async function ghFetch(values: Record<string, string>, path: string, init?: RequestInit): Promise<any> {
  const r = await jfetch(`${ghBase(values)}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${values.token}`,
      'User-Agent': 'iml-work-client',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  })
  if (r.status >= 300) fail('GitHub', r)
  return r.body
}

/** repo 形如 owner/name；校验防把 URL 整段塞进来。 */
function assertRepo(repo: string): string {
  const v = repo.trim().replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(v)) throw new Error(`仓库名格式应为 owner/repo，收到「${repo}」`)
  return v
}

export async function githubListIssues(values: Record<string, string>, repo: string, state = 'open'): Promise<string> {
  const body = await ghFetch(values, `/repos/${assertRepo(repo)}/issues?state=${state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open'}&per_page=15`)
  const issues = (Array.isArray(body) ? body : []).filter((x: any) => !x.pull_request)
  if (!issues.length) return `仓库 ${repo} 没有${state === 'open' ? '开启中的' : ''} Issue。`
  return issues.map((i: any) => `#${i.number} [${i.state}] ${i.title}（${i.user?.login || '?'}，${(i.created_at || '').slice(0, 10)}）`).join('\n')
}

export async function githubCreateIssue(values: Record<string, string>, repo: string, title: string, body?: string): Promise<string> {
  const res = await ghFetch(values, `/repos/${assertRepo(repo)}/issues`, {
    method: 'POST', body: JSON.stringify({ title, ...(body ? { body } : {}) }),
  })
  return `已创建 Issue #${res.number}：${res.html_url}`
}

export async function githubCommentIssue(values: Record<string, string>, repo: string, number: number, body: string): Promise<string> {
  const res = await ghFetch(values, `/repos/${assertRepo(repo)}/issues/${number}/comments`, {
    method: 'POST', body: JSON.stringify({ body }),
  })
  return `已评论：${res.html_url}`
}

async function validateGithub(values: Record<string, string>): Promise<ValidationResult> {
  const user = await ghFetch(values, '/user')
  return { ok: true, identity: user?.login ? `@${user.login}` : '令牌有效' }
}

// ─── Gitee ────────────────────────────────────────────────────────────────────

const GITEE_BASE = 'https://gitee.com/api/v5'

export async function giteeListIssues(values: Record<string, string>, repo: string, state = 'open'): Promise<string> {
  const [owner, name] = assertRepo(repo).split('/')
  const r = await jfetch(`${GITEE_BASE}/repos/${owner}/${name}/issues?access_token=${encodeURIComponent(values.token)}&state=${state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open'}&per_page=15`)
  if (r.status >= 300) fail('Gitee', r)
  const issues: any[] = Array.isArray(r.body) ? r.body : []
  if (!issues.length) return `仓库 ${repo} 没有${state === 'open' ? '开启中的' : ''} Issue。`
  return issues.map(i => `#${i.number} [${i.state}] ${i.title}（${i.user?.login || '?'}）`).join('\n')
}

export async function giteeCreateIssue(values: Record<string, string>, repo: string, title: string, body?: string): Promise<string> {
  const [owner, name] = assertRepo(repo).split('/')
  const r = await jfetch(`${GITEE_BASE}/repos/${owner}/issues`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: values.token, repo: name, title, ...(body ? { body } : {}) }),
  })
  if (r.status >= 300) fail('Gitee', r)
  return `已创建 Issue #${r.body?.number}：${r.body?.html_url || ''}`
}

async function validateGitee(values: Record<string, string>): Promise<ValidationResult> {
  const r = await jfetch(`${GITEE_BASE}/user?access_token=${encodeURIComponent(values.token)}`)
  if (r.status >= 300) fail('Gitee', r)
  return { ok: true, identity: r.body?.login ? `@${r.body.login}` : '令牌有效' }
}

// ─── Jira ─────────────────────────────────────────────────────────────────────

function jiraHeaders(values: Record<string, string>): Record<string, string> {
  const basic = Buffer.from(`${values.email}:${values.apiToken}`).toString('base64')
  return { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json', Accept: 'application/json' }
}

function jiraBase(values: Record<string, string>): string {
  return (values.baseUrl || '').trim().replace(/\/$/, '')
}

export async function jiraSearch(values: Record<string, string>, jql: string, max = 10): Promise<string> {
  const r = await jfetch(`${jiraBase(values)}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(max, 20)}&fields=summary,status,assignee`, { headers: jiraHeaders(values) })
  if (r.status >= 300) fail('Jira', r)
  const issues: any[] = r.body?.issues || []
  if (!issues.length) return `没有匹配 JQL「${jql}」的工单。`
  return issues.map(i => `${i.key} [${i.fields?.status?.name || '?'}] ${i.fields?.summary}（负责人：${i.fields?.assignee?.displayName || '未分配'}）`).join('\n')
}

export async function jiraCreateIssue(values: Record<string, string>, projectKey: string, summary: string, description?: string, issueType = 'Task'): Promise<string> {
  const r = await jfetch(`${jiraBase(values)}/rest/api/2/issue`, {
    method: 'POST', headers: jiraHeaders(values),
    body: JSON.stringify({ fields: { project: { key: projectKey }, summary, issuetype: { name: issueType }, ...(description ? { description } : {}) } }),
  })
  if (r.status >= 300) fail('Jira', r)
  return `已创建工单 ${r.body?.key}：${jiraBase(values)}/browse/${r.body?.key}`
}

export async function jiraComment(values: Record<string, string>, issueKey: string, body: string): Promise<string> {
  const r = await jfetch(`${jiraBase(values)}/rest/api/2/issue/${encodeURIComponent(issueKey.trim())}/comment`, {
    method: 'POST', headers: jiraHeaders(values), body: JSON.stringify({ body }),
  })
  if (r.status >= 300) fail('Jira', r)
  return `已在 ${issueKey} 追加评论`
}

async function validateJira(values: Record<string, string>): Promise<ValidationResult> {
  const r = await jfetch(`${jiraBase(values)}/rest/api/2/myself`, { headers: jiraHeaders(values) })
  if (r.status >= 300) fail('Jira', r)
  return { ok: true, identity: r.body?.displayName || r.body?.name || '账号有效' }
}

// ─── 通用 Webhook ─────────────────────────────────────────────────────────────

export async function webhookPost(values: Record<string, string>, payload: unknown): Promise<string> {
  const auth = (values.authHeader || '').trim()
  const r = await jfetch((values.url || '').trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(payload),
  })
  if (r.status >= 300) fail('Webhook', r)
  return `已推送（HTTP ${r.status}）`
}

// ─── 探活验证分发 ─────────────────────────────────────────────────────────────

/**
 * 一次性探活：真调一次目标 API，成功带回身份标识。群机器人/Webhook 没有只读探活端点，
 * 验证即真实发送一条测试消息（描述符 testNotice 已在 UI 里如实告知）。
 */
export async function validateConnector(key: string, values: Record<string, string>): Promise<ValidationResult> {
  const def = connectorDefOf(key)
  if (!def) return { ok: false, error: `未知连接器：${key}` }
  if (!connectorFieldsComplete(def, values)) {
    const missing = def.fields.filter(f => !f.optional && !(values[f.key] || '').trim()).map(f => f.label)
    return { ok: false, error: `请先填写：${missing.join('、')}` }
  }
  try {
    switch (key) {
      case 'feishu': return await validateFeishu(values)
      case 'dingtalk_bot': await dingtalkSendGroup(values, '【iFlyWorker】连接测试：服务连接器配置成功 ✅'); return { ok: true, identity: '群机器人可达' }
      case 'wecom_bot': await wecomSendGroup(values, '【iFlyWorker】连接测试：服务连接器配置成功 ✅'); return { ok: true, identity: '群机器人可达' }
      case 'github': return await validateGithub(values)
      case 'gitee': return await validateGitee(values)
      case 'jira': return await validateJira(values)
      case 'webhook': await webhookPost(values, { type: 'connection_test', source: 'iFlyWorker', ts: Date.now() }); return { ok: true, identity: '接收端可达' }
      default: return { ok: false, error: `连接器 ${key} 暂无验证实现` }
    }
  } catch (e: any) {
    // 网络级失败翻译成人话；业务级错误（fail() 抛的带 HTTP 码 Error）原样透传
    return { ok: false, error: friendlyNetError(e) }
  }
}
