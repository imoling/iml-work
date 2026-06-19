// 后端服务层：所有 /api/v1/** 调用经 Electron 主进程代理（main.js 的 fde:api），规避 CORS。
// dev 在浏览器里跑（无 window.api）时回退到 fetch，便于纯前端调试。

const LS = window.localStorage
export function getBaseUrl() { return LS.getItem('fde.adminBaseUrl') || 'http://localhost:8080' }
export function setBaseUrl(u) { LS.setItem('fde.adminBaseUrl', (u || '').trim()) }

async function call(method, path, body) {
  const baseUrl = getBaseUrl()
  if (window.api && window.api.invoke) {
    const r = await window.api.invoke('fde:api', { baseUrl, method, path, body })
    if (!r || !r.ok) throw new Error((r && (r.error || ('HTTP ' + r.status))) || '请求失败')
    return r.data
  }
  // 浏览器回退
  const res = await fetch(baseUrl.replace(/\/$/, '') + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const t = await res.text(); return t ? JSON.parse(t) : null
}

const get = (p) => call('GET', p)
const post = (p, b) => call('POST', p, b)
const put = (p, b) => call('PUT', p, b)
const del = (p) => call('DELETE', p)
const qs = (o) => { const s = Object.entries(o || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'); return s ? '?' + s : '' }

// ===== FDE 生产线领域 =====
export const Projects = {
  list: () => get('/api/v1/fde/projects'),
  get: (id) => get('/api/v1/fde/projects/' + id),
  create: (b) => post('/api/v1/fde/projects', b),
  update: (id, b) => put('/api/v1/fde/projects/' + id, b),
  remove: (id) => del('/api/v1/fde/projects/' + id)
}
export const Scenarios = {
  list: (projectId) => get('/api/v1/fde/scenarios' + qs({ projectId })),
  get: (id) => get('/api/v1/fde/scenarios/' + id),
  create: (b) => post('/api/v1/fde/scenarios', b),
  update: (id, b) => put('/api/v1/fde/scenarios/' + id, b),
  remove: (id) => del('/api/v1/fde/scenarios/' + id)
}
export const Blueprints = {
  list: (scenarioId) => get('/api/v1/fde/blueprints' + qs({ scenarioId })),
  get: (id) => get('/api/v1/fde/blueprints/' + id),
  create: (b) => post('/api/v1/fde/blueprints', b),
  update: (id, b) => put('/api/v1/fde/blueprints/' + id, b),
  remove: (id) => del('/api/v1/fde/blueprints/' + id)
}
export const TestRuns = {
  list: (scenarioId) => get('/api/v1/fde/test-runs' + qs({ scenarioId })),
  get: (id) => get('/api/v1/fde/test-runs/' + id),
  create: (b) => post('/api/v1/fde/test-runs', b),
  remove: (id) => del('/api/v1/fde/test-runs/' + id)
}
export const Deliveries = {
  list: (scenarioId) => get('/api/v1/fde/deliveries' + qs({ scenarioId })),
  get: (id) => get('/api/v1/fde/deliveries/' + id),
  create: (b) => post('/api/v1/fde/deliveries', b),
  update: (id, b) => put('/api/v1/fde/deliveries/' + id, b),
  remove: (id) => del('/api/v1/fde/deliveries/' + id)
}
export const Templates = {
  list: (type) => get('/api/v1/fde/templates' + qs({ type })),
  get: (id) => get('/api/v1/fde/templates/' + id),
  create: (b) => post('/api/v1/fde/templates', b),
  update: (id, b) => put('/api/v1/fde/templates/' + id, b),
  remove: (id) => del('/api/v1/fde/templates/' + id)
}

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
  fromRecording: (b) => post('/api/v1/skills/from-recording', b)
}

// ===== 复用管理平台已有资产（只读引用） =====
export const Admin = {
  integrations: () => get('/api/v1/integrations'),
  experts: () => get('/api/v1/experts'),
  knowledgeDocs: () => get('/api/v1/knowledge/docs'),
  knowledgeQuery: (q) => get('/api/v1/knowledge/query' + qs({ q }))
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
  genSop: (p) => window.api.invoke('skill:gen-sop', p),
  onLine: (cb) => window.api.on('dryrun:line', cb),
  onStep: (cb) => window.api.on('recorder:step', cb),
  // 连接本地登录验证
  verifyStart: (p) => window.api.invoke('connection:verify-start', p),
  verifyCheck: () => window.api.invoke('connection:verify-check'),
  verifyClose: () => window.api.invoke('connection:verify-close')
}
