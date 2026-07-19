// db.ts 桩：内存 KV 替代 better-sqlite3（Electron ABI 无法在纯 Node 加载）。
// 种子值经环境变量注入：后端地址 / 登录 JWT / 绑定技能 / 工作空间目录。
// 会话/消息/画像等本地沉淀在 bench 语境下为空（等价于全新客户端）。

const kv = new Map<string, string>()

function seed(): void {
  const env = process.env
  const set = (k: string, v: string | undefined) => { if (v) kv.set(k, v) }
  set('adminBaseUrl', env.BENCH_ADMIN_BASE || 'http://localhost:8080')
  set('auth-token', env.BENCH_JWT)
  set('clientId', 'bench-client')
  set('workspaceDir', env.BENCH_WORKSPACE)
  set('llm-connection-mode', 'proxy')
  set('llm-api-mode', 'chat')
  set('llm-base-url', (env.BENCH_ADMIN_BASE || 'http://localhost:8080') + '/api/v1/model')
  set('llm-api-key', env.BENCH_CORP_KEY || 'sk-corp-default-key')
  set('llm-model-name', env.BENCH_MODEL || 'corp-default')
  if (env.BENCH_EXPERT_ID && env.BENCH_BOUND_SKILLS) kv.set('boundSkills:' + env.BENCH_EXPERT_ID, env.BENCH_BOUND_SKILLS)
  kv.set('userSkills', '[]')
}
seed()

export function encryptValue(plain: string): string { return plain }
export function decryptValue(stored: string | null): string | null { return stored }
export function setActiveUser(_id: string | null | undefined): void {}
export function getDb(): never { throw new Error('bench-stub: no sqlite') }

export function configGet(key: string): string | null { return kv.get(key) ?? null }
export function configSet(key: string, value: string): void { kv.set(key, value) }
export function configGetAll(): Record<string, string> { return Object.fromEntries(kv) }

export interface Conversation { id: string; expert_id: string; title: string; created_at: number }
export function convList(_e: string): Conversation[] { return [] }
export function convCreate(_e: string, _t = '新对话'): string { return 'bench-conv' }
export function convDelete(_id: string): void {}
export function convUpdateTitle(_id: string, _t: string): void {}

export interface DbMessage { id: string; conversation_id: string; role: string; content: string; meta: string | null; created_at: number }
export function msgAdd(): string { return 'bench-msg' }
export function msgUpdateMeta(): void {}
export function msgList(_c: string): DbMessage[] { return [] }

export interface ArtifactRow { conv_id: string; name: string; abs_path: string; size_bytes: number; source: string; created_at: number; title: string }
export function artifactInsert(): void {}
export function artifactDistinctNames(): string[] { return [] }
export function artifactRecentByConv(_c: string, _l: number): { name: string; abs_path: string }[] { return [] }
export function artifactListJoined(_l: number): ArtifactRow[] { return [] }

export interface MsgSearchHit { conv_id: string; message_id: string; role: string; content: string; created_at: number; conv_title: string }
export function msgSearch(): MsgSearchHit[] { return [] }

const memories = new Map<string, string>()
export function memoryGet(expertId: string, type: 'agent' | 'personal'): string { return memories.get(expertId + ':' + type) || '' }
export function memorySet(expertId: string, type: 'agent' | 'personal', content: string): void { memories.set(expertId + ':' + type, content) }

export interface FocusTouchInput { expertId: string; objectType: string; objectId: string; displayName: string; state?: string; eventKind?: string; eventSummary?: string }
export function focusTouch(_i: FocusTouchInput): void {}
export interface FocusRow { id: number; expert_id: string; object_type: string; object_id: string; displayName: string; lastState: string; profileSummary: string; touch_count: number; last_touch: number; pinned: number; archived: number }
export function focusRecent(_e: string, _t?: string, _l = 20): FocusRow[] { return [] }
export function focusSetProfile(_id: number, _s: string): void {}
export function focusSetFlag(): void {}
export function focusEvents(_f: number, _l = 5): { ts: number; kind: string; summary: string }[] { return [] }

export interface ScheduledTask {
  id: string; title: string; prompt: string; expertId: string; expertName: string
  freq: 'daily' | 'weekday' | 'weekly' | 'monthly'; time: string; dow: number; dom: number
  enabled: boolean; lastRun?: number
}
const scheds = new Map<string, ScheduledTask>()
export function schedList(): ScheduledTask[] { return [...scheds.values()] }
export function schedUpsert(t: Partial<ScheduledTask> & { id: string }): void { scheds.set(t.id, t as ScheduledTask) }
export function schedSetEnabled(id: string, enabled: boolean): void { const t = scheds.get(id); if (t) t.enabled = enabled }
export function schedSetLastRun(_id: string, _ts: number): void {}
export function schedDelete(id: string): void { scheds.delete(id) }
