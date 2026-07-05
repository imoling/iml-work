// 后端服务层：所有 /api/v1/** 调用经 Electron 主进程代理（main.js 的 fde:api），规避 CORS。
// dev 在浏览器里跑（无 window.api）时回退到 fetch，便于纯前端调试。

const LS = window.localStorage
// 优先运行时配置(UI 保存到 localStorage) → 构建期 env 默认 → 本地兜底。
export function getBaseUrl() { return LS.getItem('fde.adminBaseUrl') || import.meta.env.VITE_ADMIN_BASE_URL || 'http://localhost:8080' }
export function setBaseUrl(u) { LS.setItem('fde.adminBaseUrl', (u || '').trim()) }

// 登录会话（统一账户）：token + 用户信息存 localStorage，随请求带上 Bearer。
export function getToken() { return LS.getItem('fde.token') || '' }
export function setToken(t) { if (t) LS.setItem('fde.token', t); else LS.removeItem('fde.token') }
export function getUser() { try { const r = LS.getItem('fde.user'); return r ? JSON.parse(r) : null } catch (_) { return null } }
export function setUser(u) { if (u) LS.setItem('fde.user', JSON.stringify(u)); else LS.removeItem('fde.user') }

async function call(method, path, body) {
  const baseUrl = getBaseUrl()
  const token = getToken()
  if (window.api && window.api.invoke) {
    const r = await window.api.invoke('fde:api', { baseUrl, method, path, body, token })
    if (r && r.status === 401) { setToken(''); setUser(null); window.dispatchEvent(new Event('fde-auth-expired')) }
    if (!r || !r.ok) throw new Error((r && (r.error || ('HTTP ' + r.status))) || '请求失败')
    return r.data
  }
  // 浏览器回退（/model/chat 不带用户 token —— 网关会把非 corp 的 Bearer 当上游 key 转发，
  // 留空则网关用服务端默认 corp key）
  const headers = { 'Content-Type': 'application/json', 'X-Client': 'fde' }
  if (token && !path.startsWith('/api/v1/model/chat')) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(baseUrl.replace(/\/$/, '') + path, {
    method, headers,
    body: body != null ? JSON.stringify(body) : undefined
  })
  if (res.status === 401) { setToken(''); setUser(null); window.dispatchEvent(new Event('fde-auth-expired')) }
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const t = await res.text(); return t ? JSON.parse(t) : null
}

// ===== 鉴权 =====
export const Auth = {
  login: (username, password) => post('/api/v1/auth/login', { username, password }),
  me: () => get('/api/v1/auth/me'),
  changePassword: (oldPassword, newPassword) => post('/api/v1/auth/change-password', { oldPassword, newPassword }),
  forgot: (username, phone) => post('/api/v1/auth/forgot', { username, phone })
}

const get = (p) => call('GET', p)
const post = (p, b) => call('POST', p, b)
const put = (p, b) => call('PUT', p, b)
const del = (p) => call('DELETE', p)
const qs = (o) => { const s = Object.entries(o || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'); return s ? '?' + s : '' }

// （旧「项目/场景/蓝图/试运行/交付/模板」流水线 API 已随假页面移除；后端端点保留不受影响。）

// ===== 业务系统连接（验证态 + CRUD 能力；凭证只在本地，平台不存密码） =====
export const Connections = {
  list: (systemId) => get('/api/v1/connections' + qs({ systemId })),
  get: (id) => get('/api/v1/connections/' + id),
  create: (b) => post('/api/v1/connections', b),
  update: (id, b) => put('/api/v1/connections/' + id, b),
  verifyResult: (id, b) => post('/api/v1/connections/' + id + '/verify-result', b),
  suspend: (id) => post('/api/v1/connections/' + id + '/suspend'),
  revoke: (id) => post('/api/v1/connections/' + id + '/revoke'),
  remove: (id) => del('/api/v1/connections/' + id)
}

// ===== 一次性签名确认令牌（写操作；策略服务签发+校验消费，只收表单摘要） =====
export const Confirmations = {
  issue: (b) => post('/api/v1/confirmations', b),
  consume: (id, b) => post('/api/v1/confirmations/' + id + '/consume', b),
  get: (id) => get('/api/v1/confirmations/' + id)
}

// 本地计算表单摘要（SHA-256），明文字段不出本地
export async function formDataHash(obj) {
  const json = JSON.stringify(obj || {})
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ===== 连接器动作（可复用业务动作；录制产出，SKILL 引用动作 ID） =====
export const ConnectorActions = {
  list: (systemId) => get('/api/v1/connector-actions' + qs({ systemId })),
  byConnection: (connectionId) => get('/api/v1/connector-actions' + qs({ connectionId })),
  get: (id) => get('/api/v1/connector-actions/' + id),
  create: (b) => post('/api/v1/connector-actions', b),
  update: (id, b) => put('/api/v1/connector-actions/' + id, b),
  remove: (id) => del('/api/v1/connector-actions/' + id)
}

// ===== 上架：提交到企业技能中心（复用既有 from-recording 端点） =====
export const SkillCenter = {
  fromRecording: (b) => post('/api/v1/skills/from-recording', b),
  list: () => get('/api/v1/skills'),
  get: (id) => get('/api/v1/skills/' + id),
  update: (id, b) => put('/api/v1/skills/' + id, b),
  setStatus: (id, status) => post('/api/v1/skills/' + id + '/status', { status }),
  remove: (id) => del('/api/v1/skills/' + id)
}

// ===== 复用管理平台已有资产（只读引用） =====
export const Admin = {
  integrations: () => get('/api/v1/integrations'),
  experts: () => get('/api/v1/experts'),
  knowledgeDocs: () => get('/api/v1/knowledge/docs'),
  knowledgeQuery: (q) => get('/api/v1/knowledge/query' + qs({ q }))
}

// ===== 本体建模（对象类型 / 动作 / 对象引用 / 业务事件）——需 admin.ontology.manage =====
export const Ontology = {
  types: () => get('/api/v1/ontology/types'),
  createType: (b) => post('/api/v1/ontology/types', b),
  updateType: (id, b) => put('/api/v1/ontology/types/' + id, b),
  removeType: (id) => del('/api/v1/ontology/types/' + id),
  actions: () => get('/api/v1/ontology/actions'),
  createAction: (b) => post('/api/v1/ontology/actions', b),
  updateAction: (id, b) => put('/api/v1/ontology/actions/' + id, b),
  removeAction: (id) => del('/api/v1/ontology/actions/' + id),
  refs: () => get('/api/v1/ontology/object-refs'),
  events: () => get('/api/v1/ontology/events')
}

// ===== 企业模型中转站（AI 生成：场景抽取/流程建模/蓝图/诊断） =====
export async function modelChat(prompt, system) {
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })
  const data = await post('/api/v1/model/chat', { model: 'corp-default', messages })
  return data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : ''
}

// ===== 浏览器执行器（Playwright，经 Electron 主进程 IPC） =====
export const Browser = {
  available: () => !!(window.api && window.api.invoke),
  recorderStart: (p) => window.api.invoke('recorder:start', p),
  recorderStop: () => window.api.invoke('recorder:stop'),
  recorderCancel: () => window.api.invoke('recorder:cancel'),
  dryRun: (p) => window.api.invoke('skill:dry-run', p),
  dryRunClose: () => window.api.invoke('skill:dry-run-close'),
  testSkill: (p) => window.api.invoke('skill:test', p),
  genSop: (p) => window.api.invoke('skill:gen-sop', p),
  onLine: (cb) => window.api.on('dryrun:line', cb),
  onStep: (cb) => window.api.on('recorder:step', cb),
  // 连接本地登录验证
  verifyStart: (p) => window.api.invoke('connection:verify-start', p),
  verifyCheck: () => window.api.invoke('connection:verify-check'),
  verifyClose: () => window.api.invoke('connection:verify-close'),
  ping: (p) => window.api.invoke('connection:ping', p)
}
