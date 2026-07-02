import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'

// ─── Initialise DB ────────────────────────────────────────────────────────────

const dbPath = path.join(app.getPath('userData'), 'iml-work.db')
let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    initSchema()
  }
  return db
}

function initSchema() {
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
  `)
}

// ─── Config ───────────────────────────────────────────────────────────────────

export function configGet(key: string): string | null {
  const database = getDb()
  const row = database.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function configSet(key: string, value: string): void {
  const database = getDb()
  database.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `).run(key, value)
}

export function configGetAll(): Record<string, string> {
  const database = getDb()
  const rows = database.prepare('SELECT key, value FROM config').all() as { key: string; value: string }[]
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

// ─── Conversations ────────────────────────────────────────────────────────────

export interface Conversation {
  id: string
  expert_id: string
  title: string
  created_at: number
  updated_at: number
}

export function convList(expertId: string): Conversation[] {
  const database = getDb()
  return database
    .prepare('SELECT * FROM conversations WHERE expert_id = ? ORDER BY updated_at DESC')
    .all(expertId) as Conversation[]
}

export function convCreate(expertId: string, title = '新对话'): string {
  const database = getDb()
  const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  database.prepare('INSERT INTO conversations (id, expert_id, title) VALUES (?, ?, ?)').run(id, expertId, title)
  return id
}

export function convDelete(id: string): void {
  const database = getDb()
  database.prepare('DELETE FROM conversations WHERE id = ?').run(id)
}

export function convUpdateTitle(id: string, title: string): void {
  const database = getDb()
  database.prepare('UPDATE conversations SET title = ?, updated_at = unixepoch() WHERE id = ?').run(title, id)
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export interface DbMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: number
}

export function msgAdd(conversationId: string, role: 'user' | 'assistant', content: string): string {
  const database = getDb()
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  database
    .prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)')
    .run(id, conversationId, role, content)
  database.prepare('UPDATE conversations SET updated_at = unixepoch() WHERE id = ?').run(conversationId)
  return id
}

export function msgList(conversationId: string): DbMessage[] {
  const database = getDb()
  return database
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as DbMessage[]
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export function memoryGet(expertId: string, type: 'agent' | 'personal'): string {
  const database = getDb()
  const row = database
    .prepare('SELECT content FROM memory WHERE expert_id = ? AND type = ?')
    .get(expertId, type) as { content: string } | undefined
  return row?.content ?? ''
}

export function memorySet(expertId: string, type: 'agent' | 'personal', content: string): void {
  const database = getDb()
  database
    .prepare(`
      INSERT INTO memory (expert_id, type, content, updated_at) VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(expert_id, type) DO UPDATE SET content = excluded.content, updated_at = unixepoch()
    `)
    .run(expertId, type, content)
}

// ─── Scheduled Tasks (定时任务) ─────────────────────────────────────────────────

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
  return (getDb().prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as any[]).map(rowToTask)
}

export function schedUpsert(t: Partial<ScheduledTask> & { id: string }): void {
  const db = getDb()
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
  getDb().prepare('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

export function schedSetLastRun(id: string, ts: number): void {
  getDb().prepare('UPDATE scheduled_tasks SET last_run = ? WHERE id = ?').run(ts, id)
}

export function schedDelete(id: string): void {
  getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
}
