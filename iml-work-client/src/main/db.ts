import Database from 'better-sqlite3'
import { app, safeStorage } from 'electron'
import path from 'path'

// ─── 双库隔离（跨账号串号修复）──────────────────────────────────────────────────
// 机器/会话级配置（auth、后端地址、机器级模型/工作区/机器状态）放「全局库」iml-work.db，
// 登录前也要能读；其余配置 + 全部会话/消息/记忆/日程按登录账号隔离到「账号库」
// iml-work-user-<id>.db，杜绝"换个账号登录却看到上一个账号的会话/画像"。
const globalDbPath = path.join(app.getPath('userData'), 'iml-work.db')
let globalDb: Database.Database
let userDb: Database.Database | undefined
let activeUserId = '_anon'

// 全局键（跨账号共享）：精确键 + 前缀。其余键一律落当前账号库。
const GLOBAL_KEY_SET = new Set<string>([
  'auth-token', 'auth-user', 'auth-remember', 'auth-login-at', 'auth-last-username',
  'adminBaseUrl', 'clientId', 'theme', 'float-ball', 'update-feed-url', 'workspaceDir',
  'remoteBots', 'kb-autoingest', 'keep-business-session',
  'llm-connection-mode', 'llm-api-mode', 'llm-base-url', 'llm-api-key', 'llm-model-name',
])
const GLOBAL_KEY_PREFIXES = ['bizsys-linked:', 'kb-doc:', 'kb-exclude:', 'kb-hash:', 'fhash:', 'skillFp:']
function isGlobalKey(k: string): boolean {
  return GLOBAL_KEY_SET.has(k) || GLOBAL_KEY_PREFIXES.some(p => k.startsWith(p))
}

// ─── At-rest encryption (safeStorage / 系统钥匙串) ───────────────────────────────
// 敏感 config key 落盘前用操作系统钥匙串加密；其余明文。旧明文值在读取时按前缀识别，
// 首次重新写入即自动迁移为密文。safeStorage 不可用时（部分 Linux 环境）优雅回退明文。
const SECURE_KEYS = new Set(['auth-token', 'llm-api-key'])
const ENC_PREFIX = 'enc:v1:'

export function encryptValue(plain: string): string {
  if (!plain) return plain
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
    }
  } catch (_) { /* 回退明文 */ }
  return plain
}

export function decryptValue(stored: string | null): string | null {
  if (stored == null) return null
  if (stored.startsWith(ENC_PREFIX)) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
    } catch (_) { return null }
  }
  return stored   // 旧明文（尚未迁移）
}

function openDb(p: string): Database.Database {
  const d = new Database(p)
  d.pragma('journal_mode = WAL')
  d.pragma('foreign_keys = ON')
  initSchema(d)
  return d
}

function getGlobalDb(): Database.Database {
  if (!globalDb) globalDb = openDb(globalDbPath)
  return globalDb
}

function getUserDb(): Database.Database {
  if (!userDb) userDb = openDb(path.join(app.getPath('userData'), `iml-work-user-${activeUserId}.db`))
  return userDb
}

/** 切换当前登录账号 → 切到其专属库（会话/记忆/画像/日程按账号隔离）。登录/会话恢复/登出时调用。 */
export function setActiveUser(userId: string | null | undefined): void {
  const uid = (userId && String(userId).trim()) ? String(userId).trim() : '_anon'
  if (uid === activeUserId && userDb) return
  try { userDb?.close() } catch (_) { /* ignore */ }
  userDb = undefined
  activeUserId = uid
  getUserDb()   // 立即打开 + 建表
}

/** 向后兼容：getDb() 指全局库（历史仅内部用；配置/数据已按键/域各自路由）。 */
export function getDb(): Database.Database {
  return getGlobalDb()
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      expert_id  TEXT NOT NULL,
      title      TEXT DEFAULT '新对话',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS memory (
      expert_id  TEXT NOT NULL,
      type       TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      updated_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (expert_id, type)
    );

    /* 岗位画像沉淀：岗位持续跟进的业务对象（销售的客户/生产的订单…）。
       与 memory 表的分工：memory 记「人怎么干活」（偏好/SOP），focus 记「活本身」（对象+交互流水）。
       红线：只沉淀真实读到过的对象（消解锚定/动作执行），实例画像只留本地、绝不上传。 */
    CREATE TABLE IF NOT EXISTS focus_object (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      expert_id    TEXT NOT NULL,
      object_type  TEXT NOT NULL,
      external_id  TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      system_id    TEXT NOT NULL DEFAULT '',
      last_state   TEXT NOT NULL DEFAULT '',   /* 本地已知的最近状态（快照，不是真值） */
      fields_json  TEXT NOT NULL DEFAULT '',   /* 最近一次真实读到的详情字段 */
      first_seen   INTEGER DEFAULT (unixepoch()),
      last_seen    INTEGER DEFAULT (unixepoch()),
      touch_count  INTEGER DEFAULT 1,
      pinned       INTEGER DEFAULT 0,
      archived     INTEGER DEFAULT 0,
      profile_summary TEXT NOT NULL DEFAULT '',  /* LLM 画像摘要缓存（低频重生成，不每次任务烧 tokens） */
      profile_at      INTEGER DEFAULT 0,         /* 摘要生成时间 */
      UNIQUE(expert_id, object_type, external_id, display_name)
    );
    CREATE INDEX IF NOT EXISTS idx_focus_expert ON focus_object(expert_id, object_type, last_seen);

    CREATE TABLE IF NOT EXISTS focus_event (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      focus_id  INTEGER NOT NULL REFERENCES focus_object(id) ON DELETE CASCADE,
      ts        INTEGER DEFAULT (unixepoch()),
      kind      TEXT NOT NULL DEFAULT 'action',  /* action=本体动作 / skill=技能执行字段 / resolve=消解锚定 / mention=对话提及 */
      summary   TEXT NOT NULL DEFAULT '',
      trace_id  TEXT NOT NULL DEFAULT ''         /* 回链审计 */
    );
    CREATE INDEX IF NOT EXISTS idx_focus_event ON focus_event(focus_id, ts);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      expert_id   TEXT DEFAULT '',
      expert_name TEXT DEFAULT '',
      freq        TEXT NOT NULL DEFAULT 'daily',
      time        TEXT NOT NULL DEFAULT '09:00',
      dow         INTEGER DEFAULT 1,
      dom         INTEGER DEFAULT 1,
      enabled     INTEGER DEFAULT 1,
      last_run    INTEGER DEFAULT 0,
      created_at  INTEGER DEFAULT (unixepoch())
    );

    /* 产物登记索引：任务(会话) → 产物文件。目录只管存，索引管找（出处/分组/@引用/KB排除）。 */
    CREATE TABLE IF NOT EXISTS task_files (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id    TEXT NOT NULL DEFAULT '',
      name       TEXT NOT NULL,
      abs_path   TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      source     TEXT DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_task_files_conv ON task_files(conv_id);
  `)

  // 迁移:消息附加元数据(知识溯源 sources/traceId 等,JSON)。列已存在时忽略。
  try { db.exec('ALTER TABLE messages ADD COLUMN meta TEXT') } catch (_) { /* already exists */ }
  try { db.exec("ALTER TABLE focus_object ADD COLUMN profile_summary TEXT NOT NULL DEFAULT ''") } catch (_) { /* already exists */ }
  try { db.exec('ALTER TABLE focus_object ADD COLUMN profile_at INTEGER DEFAULT 0') } catch (_) { /* already exists */ }
}

// ─── Config（按键路由：全局键→全局库，其余→当前账号库）───────────────────────────

export function configGet(key: string): string | null {
  const database = isGlobalKey(key) ? getGlobalDb() : getUserDb()
  const row = database.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
  const raw = row?.value ?? null
  return SECURE_KEYS.has(key) ? decryptValue(raw) : raw
}

export function configSet(key: string, value: string): void {
  const database = isGlobalKey(key) ? getGlobalDb() : getUserDb()
  const stored = SECURE_KEYS.has(key) ? encryptValue(value) : value
  database.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `).run(key, stored)
}

export function configGetAll(): Record<string, string> {
  // 只合并「全局库的全局键」+「当前账号库的全部键」。全局库里若残留旧的 per-user 键
  // （分库前/迁移前的历史数据），一律不暴露，避免经 getAll 把上一个账号的画像串给当前账号。
  const rows = [
    ...(getGlobalDb().prepare('SELECT key, value FROM config').all() as { key: string; value: string }[]).filter(r => isGlobalKey(r.key)),
    ...(getUserDb().prepare('SELECT key, value FROM config').all() as { key: string; value: string }[]),
  ]
  return Object.fromEntries(rows.map((r) => [r.key, SECURE_KEYS.has(r.key) ? (decryptValue(r.value) ?? '') : r.value]))
}

// ─── Conversations（当前账号库）─────────────────────────────────────────────────

export interface Conversation {
  id: string
  expert_id: string
  title: string
  created_at: number
  updated_at: number
}

export function convList(expertId: string): Conversation[] {
  return getUserDb()
    .prepare('SELECT * FROM conversations WHERE expert_id = ? ORDER BY updated_at DESC')
    .all(expertId) as Conversation[]
}

export function convCreate(expertId: string, title = '新对话'): string {
  const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  getUserDb().prepare('INSERT INTO conversations (id, expert_id, title) VALUES (?, ?, ?)').run(id, expertId, title)
  return id
}

export function convDelete(id: string): void {
  getUserDb().prepare('DELETE FROM conversations WHERE id = ?').run(id)
}

export function convUpdateTitle(id: string, title: string): void {
  getUserDb().prepare('UPDATE conversations SET title = ?, updated_at = unixepoch() WHERE id = ?').run(title, id)
}

// ─── Messages（当前账号库）──────────────────────────────────────────────────────

export interface DbMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: number
  meta?: string | null   // JSON:{ sources?, traceId? } 知识溯源等附加信息
}

export function msgAdd(conversationId: string, role: 'user' | 'assistant', content: string, meta?: string | null): string {
  const database = getUserDb()
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  database
    .prepare('INSERT INTO messages (id, conversation_id, role, content, meta) VALUES (?, ?, ?, ?, ?)')
    .run(id, conversationId, role, content, meta ?? null)
  database.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(conversationId)
  return id
}

export function msgUpdateMeta(messageId: string, meta: string): void {
  getUserDb().prepare('UPDATE messages SET meta = ? WHERE id = ?').run(meta, messageId)
}

export function msgList(conversationId: string): DbMessage[] {
  return getUserDb()
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as DbMessage[]
}

// ─── 产物登记 task_files（SQL 单一来源在此；fs/会话组合逻辑见 artifact-index.ts）───────

export interface ArtifactRow { conv_id: string; name: string; abs_path: string; size_bytes: number; source: string; created_at: number; title: string }

export function artifactInsert(convId: string, name: string, absPath: string, sizeBytes: number, source: string): void {
  getUserDb()
    .prepare('INSERT INTO task_files (conv_id, name, abs_path, size_bytes, source) VALUES (?, ?, ?, ?, ?)')
    .run(convId, name, absPath, sizeBytes, source)
}

export function artifactDistinctNames(): string[] {
  return (getUserDb().prepare('SELECT DISTINCT name FROM task_files').all() as { name: string }[]).map(r => r.name)
}

export function artifactRecentByConv(convId: string, limit: number): { name: string; abs_path: string }[] {
  return getUserDb()
    .prepare('SELECT name, abs_path FROM task_files WHERE conv_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(convId, limit) as { name: string; abs_path: string }[]
}

/** 全部产物（新→旧），带会话标题（会话被删则 title 为空串）。 */
export function artifactListJoined(limit: number): ArtifactRow[] {
  return getUserDb().prepare(`
    SELECT t.conv_id, t.name, t.abs_path, t.size_bytes, t.source, t.created_at,
           COALESCE(c.title, '') AS title
    FROM task_files t LEFT JOIN conversations c ON c.id = t.conv_id
    ORDER BY t.created_at DESC, t.id DESC LIMIT ?
  `).all(limit) as ArtifactRow[]
}

export interface MsgSearchHit {
  messageId: string
  conversationId: string
  conversationTitle: string
  role: string
  snippet: string       // 命中关键词前后各若干字的上下文片段
  createdAt: number
}

/**
 * 跨会话消息全文搜索（限当前岗位）：对中文用 LIKE 子串匹配——比 FTS5 更可靠，
 * FTS5 的 trigram 分词对「合同」这类 2 字中文词匹配不到、unicode61 又需分词器，坑多；
 * 个人规模消息量（数千条）LIKE 足够快。返回命中消息 + 所属会话标题 + 高亮片段，按时间倒序。
 */
export function msgSearch(expertId: string, query: string, limit = 60): MsgSearchHit[] {
  const q = (query || '').trim()
  if (!q) return []
  const like = `%${q.replace(/[%_\\]/g, m => '\\' + m)}%`   // 转义 LIKE 通配，按字面量搜
  const rows = getUserDb().prepare(`
    SELECT m.id AS messageId, m.conversation_id AS conversationId, m.role AS role,
           m.content AS content, m.created_at AS createdAt, c.title AS conversationTitle
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.expert_id = ? AND m.content LIKE ? ESCAPE '\\'
    ORDER BY m.created_at DESC LIMIT ?
  `).all(expertId, like, limit) as (Omit<MsgSearchHit, 'snippet'> & { content: string })[]

  return rows.map(r => {
    const idx = r.content.toLowerCase().indexOf(q.toLowerCase())
    const from = Math.max(0, idx - 24)
    const raw = r.content.slice(from, from + 80).replace(/\s+/g, ' ').trim()
    const snippet = (from > 0 ? '…' : '') + raw + (from + 80 < r.content.length ? '…' : '')
    return { messageId: r.messageId, conversationId: r.conversationId, conversationTitle: r.conversationTitle, role: r.role, snippet, createdAt: r.createdAt }
  })
}

// ─── Memory（当前账号库）────────────────────────────────────────────────────────

export function memoryGet(expertId: string, type: 'agent' | 'personal'): string {
  const row = getUserDb()
    .prepare('SELECT content FROM memory WHERE expert_id = ? AND type = ?')
    .get(expertId, type) as { content: string } | undefined
  return row?.content ?? ''
}

export function memorySet(expertId: string, type: 'agent' | 'personal', content: string): void {
  getUserDb()
    .prepare(`
      INSERT INTO memory (expert_id, type, content, updated_at) VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(expert_id, type) DO UPDATE SET content = excluded.content, updated_at = unixepoch()
    `)
    .run(expertId, type, content)
}

// ===== 岗位画像沉淀（focus）=====
// 沉淀只在本体链路真实接触对象时发生；这里只管 upsert + 流水，不做任何推断。

export interface FocusTouchInput {
  expertId: string; objectType: string; externalId?: string; displayName: string
  systemId?: string; state?: string; fieldsJson?: string
  kind: 'action' | 'skill' | 'resolve' | 'mention'; summary: string; traceId?: string
}

export function focusTouch(i: FocusTouchInput): void {
  const db = getUserDb()
  db.prepare(`
    INSERT INTO focus_object (expert_id, object_type, external_id, display_name, system_id, last_state, fields_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(expert_id, object_type, external_id, display_name) DO UPDATE SET
      last_seen   = unixepoch(),
      touch_count = touch_count + 1,
      last_state  = CASE WHEN excluded.last_state  != '' THEN excluded.last_state  ELSE last_state  END,
      fields_json = CASE WHEN excluded.fields_json != '' THEN excluded.fields_json ELSE fields_json END,
      system_id   = CASE WHEN excluded.system_id   != '' THEN excluded.system_id   ELSE system_id   END
  `).run(i.expertId, i.objectType, i.externalId || '', i.displayName, i.systemId || '', i.state || '', i.fieldsJson || '')
  const row = db.prepare('SELECT id FROM focus_object WHERE expert_id = ? AND object_type = ? AND external_id = ? AND display_name = ?')
    .get(i.expertId, i.objectType, i.externalId || '', i.displayName) as { id: number } | undefined
  if (row) db.prepare('INSERT INTO focus_event (focus_id, kind, summary, trace_id) VALUES (?, ?, ?, ?)')
    .run(row.id, i.kind, i.summary.slice(0, 300), i.traceId || '')
}

export interface FocusRow {
  id: number; objectType: string; externalId: string; displayName: string; systemId: string
  lastState: string; fieldsJson: string; firstSeen: number; lastSeen: number; touchCount: number; pinned: number
  profileSummary: string; profileAt: number
}

/** 某岗位最近接触的对象（消解加权/画像注入用）。archived 的不出。 */
export function focusRecent(expertId: string, objectType?: string, limit = 20): FocusRow[] {
  const db = getUserDb()
  const sql = `SELECT id, object_type as objectType, external_id as externalId, display_name as displayName,
                      system_id as systemId, last_state as lastState, fields_json as fieldsJson,
                      first_seen as firstSeen, last_seen as lastSeen, touch_count as touchCount, pinned,
                      profile_summary as profileSummary, profile_at as profileAt
               FROM focus_object WHERE expert_id = ? AND archived = 0
               ${objectType ? 'AND object_type = ?' : ''}
               ORDER BY pinned DESC, last_seen DESC LIMIT ?`
  return (objectType ? db.prepare(sql).all(expertId, objectType, limit) : db.prepare(sql).all(expertId, limit)) as FocusRow[]
}

/** 存 LLM 画像摘要（低频重生成的缓存）。 */
export function focusSetProfile(id: number, summary: string): void {
  getUserDb().prepare('UPDATE focus_object SET profile_summary = ?, profile_at = unixepoch() WHERE id = ?')
    .run(summary.slice(0, 800), id)
}

/** 置顶/归档（「我的关注」面板操作）。 */
export function focusSetFlag(id: number, field: 'pinned' | 'archived', value: boolean): void {
  getUserDb().prepare(`UPDATE focus_object SET ${field === 'pinned' ? 'pinned' : 'archived'} = ? WHERE id = ?`).run(value ? 1 : 0, id)
}

/** 对象的最近交互流水（画像注入 prompt 用）。 */
export function focusEvents(focusId: number, limit = 5): { ts: number; kind: string; summary: string }[] {
  return getUserDb().prepare('SELECT ts, kind, summary FROM focus_event WHERE focus_id = ? ORDER BY ts DESC LIMIT ?')
    .all(focusId, limit) as { ts: number; kind: string; summary: string }[]
}

// ─── Scheduled Tasks (定时任务，当前账号库) ─────────────────────────────────────

export interface ScheduledTask {
  id: string
  title: string
  prompt: string
  expertId: string
  expertName: string
  freq: 'daily' | 'weekday' | 'weekly' | 'monthly'
  time: string        // HH:MM
  dow: number         // weekly: 0=Sun..6=Sat
  dom: number         // monthly: 1..28
  enabled: boolean
  lastRun: number
  createdAt: number
}

function rowToTask(r: any): ScheduledTask {
  return {
    id: r.id, title: r.title, prompt: r.prompt, expertId: r.expert_id || '', expertName: r.expert_name || '',
    freq: r.freq, time: r.time, dow: r.dow, dom: r.dom, enabled: !!r.enabled, lastRun: r.last_run || 0, createdAt: r.created_at || 0
  }
}

export function schedList(): ScheduledTask[] {
  return (getUserDb().prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as any[]).map(rowToTask)
}

export function schedUpsert(t: Partial<ScheduledTask> & { id: string }): void {
  const db = getUserDb()
  const exist = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(t.id)
  if (exist) {
    db.prepare(`UPDATE scheduled_tasks SET title=?, prompt=?, expert_id=?, expert_name=?, freq=?, time=?, dow=?, dom=?, enabled=? WHERE id=?`)
      .run(t.title, t.prompt, t.expertId || '', t.expertName || '', t.freq, t.time, t.dow ?? 1, t.dom ?? 1, t.enabled ? 1 : 0, t.id)
  } else {
    db.prepare(`INSERT INTO scheduled_tasks (id, title, prompt, expert_id, expert_name, freq, time, dow, dom, enabled) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(t.id, t.title, t.prompt, t.expertId || '', t.expertName || '', t.freq || 'daily', t.time || '09:00', t.dow ?? 1, t.dom ?? 1, t.enabled === false ? 0 : 1)
  }
}

export function schedSetEnabled(id: string, enabled: boolean): void {
  getUserDb().prepare('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

export function schedSetLastRun(id: string, ts: number): void {
  getUserDb().prepare('UPDATE scheduled_tasks SET last_run = ? WHERE id = ?').run(ts, id)
}

export function schedDelete(id: string): void {
  getUserDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
}
