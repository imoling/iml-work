// 后端 API 路径的**单一来源**（叶子，零依赖）。体检 P2-19：`/api/v1/*` 裸字符串散在 24 个文件里，
// 后端改一个路径（如 /skills → /skills/catalog 那次迁移）要全文 grep 才敢动。
//
// 用法：`afetch(`${getAdminBaseUrl()}${API.skills.catalog}`)`；带参的用函数形式 `API.skills.byId(id)`。
// 增量收敛（不一次性大改）：改到哪个文件，就把那个文件的裸路径迁进来——迁移期间两种写法并存是允许的，
// 但**新代码一律走这里**。
export const API = {
  auth: {
    login: '/api/v1/auth/login',
    me: '/api/v1/auth/me',
    changePassword: '/api/v1/auth/change-password',
    forgot: '/api/v1/auth/forgot',
  },
  skills: {
    /** 全量（含正文）——FDE 创作从列表取正文，动它先查 FDE */
    all: '/api/v1/skills',
    /** 瘦身目录（浏览/绑定/同步）——新消费端默认用它 */
    catalog: '/api/v1/skills/catalog',
    byId: (id: string) => `/api/v1/skills/${id}`,
    creator: '/api/v1/skills/creator',
    submitPackage: '/api/v1/skills/submit-package',
    mine: '/api/v1/skills/mine',
  },
  experts: {
    all: '/api/v1/experts',
    byId: (id: string) => `/api/v1/experts/${id}`,
    claim: (id: string) => `/api/v1/experts/claim/${id}`,
  },
  ontology: {
    resolveHints: '/api/v1/ontology/resolve-hints',
    objectRefs: '/api/v1/ontology/object-refs',
    events: '/api/v1/ontology/events',
    actions: '/api/v1/ontology/actions',
    types: '/api/v1/ontology/types',
  },
  connectorActions: {
    byId: (id: string) => `/api/v1/connector-actions/${id}`,
    catalog: '/api/v1/connector-actions/catalog',
  },
  integrations: '/api/v1/integrations',
  knowledge: {
    query: '/api/v1/knowledge/query',
    ingest: '/api/v1/knowledge/ingest',
    docs: '/api/v1/knowledge/docs',
    docById: (id: string) => `/api/v1/knowledge/docs/${id}`,
    promote: (id: string) => `/api/v1/knowledge/docs/${id}/promote`,
  },
  model: {
    chat: '/api/v1/model/chat',
    /** 客户端 llmConfig.baseUrl 的默认值（网关根，后面再拼 /chat 等） */
    base: '/api/v1/model',
  },
  search: '/api/v1/search',
  searchConfig: '/api/v1/search-config',
  sandbox: {
    exec: '/api/v1/sandbox/exec',
    execStatus: '/api/v1/sandbox/exec/status',
  },
  traces: {
    submit: '/api/v1/traces',
    payloads: (id: string) => `/api/v1/traces/${id}/payloads`,
    feedback: '/api/v1/traces/feedback',
  },
  confirmations: {
    issue: '/api/v1/confirmations',
    consume: (tokenId: string) => `/api/v1/confirmations/${tokenId}/consume`,
  },
  clients: {
    heartbeat: '/api/v1/clients/heartbeat',
    register: '/api/v1/clients/register',
  },
  sync: '/api/v1/sync',
  parse: {
    document: '/api/v1/parse/document',
    status: '/api/v1/parse/status',
  },
  enterprise: '/api/v1/enterprise',
  dicts: (key: string) => `/api/v1/dicts/${key}`,
} as const
