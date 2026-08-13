import Database from 'better-sqlite3'
import { safeStorage } from 'electron'
import { userDataDir } from './app-paths'
import path from 'path'
import { swallow } from './util'
import type { CoreMessage } from '../shared/core-protocol'
import { convModelKey } from '../shared/llm-service'

// ─── 双库隔离（跨账号串号修复）──────────────────────────────────────────────────
// 机器/会话级配置（auth、后端地址、机器级模型/工作区/机器状态）放「全局库」iml-work.db，
// 登录前也要能读；其余配置 + 全部会话/消息/记忆/日程按登录账号隔离到「账号库」
// iml-work-user-<id>.db，杜绝"换个账号登录却看到上一个账号的会话/画像"。
const globalDbPath = path.join(userDataDir(), 'iml-work.db')
let globalDb: Database.Database
let userDb: Database.Database | undefined
let activeUserId = '_anon'

// 全局键（跨账号共享）：精确键 + 前缀。其余键一律落当前账号库。
const GLOBAL_KEY_SET = new Set<string>([
  'auth-token', 'auth-user', 'auth-remember', 'auth-login-at', 'auth-last-username',
  'adminBaseUrl', 'clientId', 'theme', 'float-ball', 'update-feed-url', 'workspaceDir',
  'remoteBots', 'kb-autoingest', 'keep-business-session', 'keep-awake',
  'llm-connection-mode', 'llm-api-mode', 'llm-base-url', 'llm-api-key', 'llm-model-name',
  // 模型能力/口径类事实：与登录账号无关，跟着「这台机器连的这个网关」走
  'llm-research-model', 'llm-summary-model', 'llm-script-model', 'llm-context-window', 'llm-tier-models', 'llm-providers', 'llm-default-model', 'llm-vendor-key',
  // 网关专用凭证（与 llm-api-key 厂商密钥物理分离，杜绝模式/环境切换后的残留串键——三次 401 工单的治本）
  'llm-corp-key',
])
// llm-tools-capable:<model> —— 该模型认不认 function-calling 的探测结论。属于「机器+网关」级事实、
// 与登录账号无关：落账号库的话换个账号就得重探一遍，而每次探测都是一次真实的 4xx 请求。
const GLOBAL_KEY_PREFIXES = ['bizsys-linked:', 'kb-doc:', 'kb-exclude:', 'kb-hash:', 'fhash:', 'skillFp:', 'llm-tools-capable:']
function isGlobalKey(k: string): boolean {
  return GLOBAL_KEY_SET.has(k) || GLOBAL_KEY_PREFIXES.some(p => k.startsWith(p))
}

// ─── At-rest encryption (safeStorage / 系统钥匙串) ───────────────────────────────
// 敏感 config key 落盘前用操作系统钥匙串加密；其余明文。旧明文值在读取时按前缀识别，
// 首次重新写入即自动迁移为密文。safeStorage 不可用时（部分 Linux 环境）优雅回退明文。
const SECURE_KEYS = new Set(['auth-token', 'llm-api-key', 'llm-corp-key', 'remoteBots', 'saasConnectors', 'mcpServers'])   // remoteBots 含 IM 机器人 appSecret/clientSecret；saasConnectors 含服务连接器 token/webhook；mcpServers 的 env/headers 常放 token
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

// 进程启动时刻：孤儿运行记录清扫的判据（本进程内启动的任务 started_at 必然晚于它，不会误伤）
const PROCESS_START_EPOCH = Math.floor(Date.now() / 1000)

function getUserDb(): Database.Database {
  if (!userDb) {
    userDb = openDb(path.join(userDataDir(), `iml-work-user-${activeUserId}.db`))
    // 孤儿运行记录兜底：running 态不跨进程存活——客户端重启/断电/系统睡眠杀死执行后，
    // task-run:finish 永远不会回填，记录就永远转圈（实测：定时任务 00:01 触发后被硬重启杀死）。
    // 每次打开用户库时把"启动前就在 running"的记录如实标记为中断。
    try {
      userDb.prepare(`UPDATE task_run SET status = 'error',
          summary = '执行被中断（客户端重启或系统睡眠）——可点「立即运行」重跑',
          ended_at = unixepoch()
        WHERE status = 'running' AND started_at < ?`).run(PROCESS_START_EPOCH)
    } catch (e) { console.error('[db] 孤儿运行记录清扫失败:', e) }

    // 对话任务的中断留痕（与上面 task_run 清扫同理，但对象是**对话消息**）：
    // 助手消息只在任务完成时落库，执行中被杀（重启/断电/系统睡眠）什么都不会留下——
    // 用户醒来看到的对话里只剩自己的提问，像被"清空"（实测反馈 2026-08-13 息屏工单）。
    // 任务启动时在 config 记 run-inflight 标记、正常收尾时清除；开库时还残留的就是被杀的，
    // 给对应会话补一条如实的中断说明。
    try {
      const raw = userDb.prepare('SELECT value FROM config WHERE key = ?').get('run-inflight') as { value?: string } | undefined
      const map = raw?.value ? JSON.parse(raw.value) as Record<string, number> : null
      if (map && Object.keys(map).length) {
        const ins = userDb.prepare('INSERT INTO messages (id, conversation_id, role, content, meta) VALUES (?, ?, ?, ?, NULL)')
        for (const convId of Object.keys(map)) {
          ins.run(`msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, convId, 'system',
            '⚠️ 上次任务在执行中被中断（客户端退出或系统休眠），未完成、结果未保存。请重新发送该任务；长任务建议在 设置→工作空间 打开「保持唤醒」。')
        }
        userDb.prepare('DELETE FROM config WHERE key = ?').run('run-inflight')
      }
    } catch (e) { console.error('[db] 中断任务留痕失败:', e) }

    // 匿名库里**不该有任何 config**：全局键走全局库，per-account 键需要先有账号。
    // 出现在这里的一律是「切库之前就读写了」漏进来的（心跳的首个 tick、早期版本的认领落盘…）。
    // 留着的害处不是占地方，而是**将来某次读错库时它会给出一个陈年旧值**——那比读到空更难查：
    // 空至少一眼看得出"没读到"，旧值会让人以为数据本身就是错的。
    // （分身自定义昵称丢失那次，幸好匿名库是空的；若那里存着半年前的旧名，排查会绕远得多。）
    if (activeUserId === '_anon') {
      try { userDb.prepare('DELETE FROM config').run() } catch (e) { console.error('[db] 匿名库配置清理失败:', e) }
    }
  }
  return userDb
}

/** 切换当前登录账号 → 切到其专属库（会话/记忆/画像/日程按账号隔离）。登录/会话恢复/登出时调用。 */
/**
 * 账号库是否已就位（即已经切到某个具体账号，而不是匿名库）。
 *
 * 给「启动期就跑、但读写的是 per-account 数据」的后台任务用（心跳/技能同步）：
 * 它们在 app.whenReady 就启动，而 setActiveUser 要等渲染层走完 auth:session 才发生——
 * 中间这段窗口期里 configGet/configSet 全部落在匿名库，既读不到真数据、又把匿名库写脏。
 */
export function hasActiveUser(): boolean {
  return activeUserId !== '_anon'
}

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

    -- 执行内核（AgentCore）的完整轨迹：模型上下文的真值，含 tool 调用与结果。
    -- 与上面的 messages（展示用气泡）**刻意分表**：那张表驱动 UI 气泡且被多处消费，
    -- 把 tool 消息混进去会污染所有现有消费端；而轨迹的生命周期也不同（可单独压缩/清理）。
    -- seq 而非 created_at 排序：秒级时间戳在同一轮里会撞，顺序错乱就等于上下文错乱。
    CREATE TABLE IF NOT EXISTS turn_message (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL DEFAULT '',
      tool_calls      TEXT,
      tool_call_id    TEXT,
      tool_name       TEXT,
      status          TEXT,
      notice_kind     TEXT,
      display         TEXT,
      reasoning_content TEXT,
      image_paths     TEXT,
      ts              INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_turn_message_conv ON turn_message(conversation_id, seq);

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

    /* 定时任务运行记录（对齐主流形态："每次运行是一个独立会话"）：
       每次触发（定时/手动/补跑）落一行，指向该次运行的专属会话——详情页的 Runs 列表 / Open 跳转靠它。
       不建外键：会话可被用户删除，运行记录（状态/摘要）仍应保留供追溯。 */
    CREATE TABLE IF NOT EXISTS task_run (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL,
      conv_id    TEXT NOT NULL DEFAULT '',
      trigger    TEXT NOT NULL DEFAULT 'schedule',  /* schedule=到点 / manual=Run now / catchup=补跑 */
      status     TEXT NOT NULL DEFAULT 'running',   /* running / ok / error */
      summary    TEXT NOT NULL DEFAULT '',
      file_count INTEGER DEFAULT 0,
      started_at INTEGER DEFAULT (unixepoch()),
      ended_at   INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_task ON task_run(task_id, started_at);

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
  try { db.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER DEFAULT 0') } catch (_) { /* already exists */ }
  try { db.exec("ALTER TABLE focus_object ADD COLUMN profile_summary TEXT NOT NULL DEFAULT ''") } catch (_) { /* already exists */ }
  try { db.exec('ALTER TABLE focus_object ADD COLUMN profile_at INTEGER DEFAULT 0') } catch (_) { /* already exists */ }
  // 思维模式模型的思维链：刷新页面后由 turnMsgList 重建轨迹再继续对话时，
  // 这一列缺了下一轮就是 400（上游要求原样回传，见 CoreMessage.reasoningContent）。
  try { db.exec('ALTER TABLE turn_message ADD COLUMN reasoning_content TEXT') } catch (_) { /* already exists */ }
  // 图片消息的附图路径（只存路径，不存内容——base64 进库会让轨迹表迅速膨胀）
  try { db.exec('ALTER TABLE turn_message ADD COLUMN image_paths TEXT') } catch (_) { /* already exists */ }
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

/** 单条会话标题（产物目录命名用；查不到返回空串由调用方兜底）。 */
export function convTitle(id: string): string {
  if (!id) return ''
  try {
    const row = getUserDb().prepare('SELECT title FROM conversations WHERE id = ?').get(id) as { title?: string } | undefined
    return row?.title || ''
  } catch (e) { swallow(e, 'db-conv-title'); return '' }
}

export function convCreate(expertId: string, title = '新对话'): string {
  const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  getUserDb().prepare('INSERT INTO conversations (id, expert_id, title) VALUES (?, ?, ?)').run(id, expertId, title)
  return id
}

export function convDelete(id: string): void {
  // messages 靠外键 ON DELETE CASCADE 自动清；turn_message 刻意没建外键（轨迹表独立于展示表，
  // 见其建表注释），所以这里显式删——漏了就是永久泄漏的孤儿轨迹。
  getUserDb().prepare('DELETE FROM turn_message WHERE conversation_id = ?').run(id)
  // 会话级模型选择同理：config 表没有外键，不显式删就是孤儿键（键名单一来源见 shared/llm-service）
  getUserDb().prepare('DELETE FROM config WHERE key = ?').run(convModelKey(id))
  getUserDb().prepare('DELETE FROM conversations WHERE id = ?').run(id)
}

export function convSetPinned(id: string, pinned: boolean): void {
  getUserDb().prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
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

export function msgAdd(conversationId: string, role: 'user' | 'assistant' | 'system', content: string, meta?: string | null): string {
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

// ── 执行中任务的中断留痕标记（run-inflight）────────────────────────────────
// 任务启动记入、正常收尾清除；进程被杀（重启/断电/系统睡眠）时残留，
// 下次开库由 getUserDb 的清扫逻辑给对应会话补中断说明。键在用户库（per-account）。

function readInflight(): Record<string, number> {
  try { return JSON.parse(configGet('run-inflight') || '{}') } catch { return {} }
}

export function markRunInflight(convId: string): void {
  if (!convId) return
  const map = readInflight()
  map[convId] = Date.now()
  configSet('run-inflight', JSON.stringify(map))
}

export function clearRunInflight(convId: string): void {
  const map = readInflight()
  if (!(convId in map)) return
  delete map[convId]
  configSet('run-inflight', Object.keys(map).length ? JSON.stringify(map) : '')
}

export function msgList(conversationId: string): DbMessage[] {
  return getUserDb()
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as DbMessage[]
}

// ─── 执行内核轨迹 turn_message（AgentCore 的模型上下文真值）───────────────────────
//
// 存的是**结构化**的 tool_calls / tool_result，而不是压平的文本块。这正是多轮追问能准的原因：
// 下一轮模型能看见自己上一轮到底调了什么工具、拿回什么结果（旧的 buildHistoryBlock 把这层轨迹压没了）。

/** 追加一批轨迹消息（一轮任务结束后整批落库，避免每条一次事务）。 */
export function turnMsgAppend(conversationId: string, messages: CoreMessage[]): void {
  if (!messages.length) return
  const database = getUserDb()
  const row = database.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM turn_message WHERE conversation_id = ?')
    .get(conversationId) as { m: number }
  let seq = (row?.m ?? -1) + 1
  const stmt = database.prepare(
    `INSERT INTO turn_message (conversation_id, seq, role, content, tool_calls, tool_call_id, tool_name, status, notice_kind, display, reasoning_content, image_paths, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const tx = database.transaction((items: CoreMessage[]) => {
    for (const m of items) {
      stmt.run(
        conversationId, seq++, m.role, m.content ?? '',
        m.toolCalls ? JSON.stringify(m.toolCalls) : null,
        m.toolCallId ?? null, m.toolName ?? null, m.status ?? null, m.noticeKind ?? null,
        m.display ? JSON.stringify(m.display) : null,
        m.reasoningContent ?? null,
        m.imagePaths?.length ? JSON.stringify(m.imagePaths) : null,
        m.ts ?? Date.now(),
      )
    }
  })
  tx(messages)
}

/** 读回整条会话的轨迹（顺序即 seq）。JSON 列解析失败时降级成空，绝不因为一条坏数据丢整段上下文。 */
export function turnMsgList(conversationId: string): CoreMessage[] {
  const rows = getUserDb()
    .prepare('SELECT * FROM turn_message WHERE conversation_id = ? ORDER BY seq ASC')
    .all(conversationId) as Record<string, any>[]
  return rows.map(r => {
    const m: CoreMessage = { role: r.role, content: r.content ?? '', ts: r.ts || 0 }
    if (r.tool_calls) { try { m.toolCalls = JSON.parse(r.tool_calls) } catch (e) { swallow(e, 'db-turnmsg-toolcalls') } }
    if (r.display) { try { m.display = JSON.parse(r.display) } catch (e) { swallow(e, 'db-turnmsg-display') } }
    if (r.tool_call_id) m.toolCallId = r.tool_call_id
    if (r.tool_name) m.toolName = r.tool_name
    if (r.status) m.status = r.status
    if (r.notice_kind) m.noticeKind = r.notice_kind
    if (r.reasoning_content) m.reasoningContent = r.reasoning_content
    if (r.image_paths) { try { m.imagePaths = JSON.parse(r.image_paths) } catch (e) { swallow(e, 'db-turnmsg-images') } }
    return m
  })
}

/** 清空一条会话的轨迹（手动压缩上下文 / 删除会话时调用）。 */
export function turnMsgClear(conversationId: string): void {
  getUserDb().prepare('DELETE FROM turn_message WHERE conversation_id = ?').run(conversationId)
}

// ─── 定时任务运行记录 task_run ───────────────────────────────────────────────

export interface TaskRun {
  id: number; task_id: string; conv_id: string; trigger: string
  status: string; summary: string; file_count: number; started_at: number; ended_at: number
}

export function taskRunAdd(taskId: string, convId: string, trigger: string): number {
  const r = getUserDb().prepare('INSERT INTO task_run (task_id, conv_id, trigger) VALUES (?, ?, ?)')
    .run(taskId, convId, trigger)
  return Number(r.lastInsertRowid)
}

export function taskRunFinish(runId: number, status: string, summary: string, fileCount = 0): void {
  getUserDb().prepare('UPDATE task_run SET status = ?, summary = ?, file_count = ?, ended_at = unixepoch() WHERE id = ?')
    .run(status, summary.slice(0, 300), fileCount, runId)
}

/** 近 200 条运行的 任务→会话 映射（侧栏未读角标/运行中状态归属用，轻量窄投影）。 */
export function taskRunRecentConvs(): { task_id: string; conv_id: string }[] {
  return getUserDb().prepare("SELECT task_id, conv_id FROM task_run WHERE conv_id != '' ORDER BY started_at DESC LIMIT 200")
    .all() as { task_id: string; conv_id: string }[]
}

/** 删除一条运行记录，并连带删除该次运行的专属会话（⏰ 会话除详情页外无其他入口）。 */
export function taskRunDelete(runId: number): void {
  const row = getUserDb().prepare('SELECT conv_id FROM task_run WHERE id = ?').get(runId) as { conv_id: string } | undefined
  getUserDb().prepare('DELETE FROM task_run WHERE id = ?').run(runId)
  if (row?.conv_id) convDelete(row.conv_id)
}

export function taskRunList(taskId: string, limit = 20): TaskRun[] {
  return getUserDb().prepare('SELECT * FROM task_run WHERE task_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(taskId, Math.min(limit, 50)) as TaskRun[]
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
