import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';

/** Format a Date to local timezone string (e.g., "2026-03-26 12:05:00") */
function formatLocalTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  AskQuestionRecord,
  Delegation,
  MemoryRecord,
  MemorySearchResult,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
  Workflow,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      model TEXT,
      model_reason TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add model column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN model TEXT`);
  } catch {
    /* column already exists */
  }

  // Add model_reason column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN model_reason TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add description column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN description TEXT`);
  } catch {
    /* column already exists */
  }

  // Add delegations table if it doesn't exist (migration for existing DBs)
  database.exec(`
    CREATE TABLE IF NOT EXISTS delegations (
      id TEXT PRIMARY KEY,
      source_jid TEXT NOT NULL,
      source_folder TEXT NOT NULL,
      target_jid TEXT NOT NULL,
      target_folder TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegations_source ON delegations(source_jid, status);
    CREATE INDEX IF NOT EXISTS idx_delegations_target ON delegations(target_jid, status);
  `);

  // Add workflows table if it doesn't exist (migration for existing DBs)
  database.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      service TEXT NOT NULL,
      branch TEXT DEFAULT '',
      deliverable TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'dev',
      current_delegation_id TEXT DEFAULT '',
      round INTEGER DEFAULT 0,
      source_jid TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
    CREATE INDEX IF NOT EXISTS idx_workflows_delegation ON workflows(current_delegation_id);
  `);

  // Add ask_questions table if it doesn't exist (human-in-the-loop questions)
  database.exec(`
    CREATE TABLE IF NOT EXISTS ask_questions (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL,
      answers_json TEXT,
      current_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      answered_at TEXT,
      responder_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ask_questions_status_expires ON ask_questions(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_ask_questions_group_status ON ask_questions(group_folder, status);
  `);

  // Add outcome column to delegations (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE delegations ADD COLUMN outcome TEXT`);
  } catch {
    /* column already exists */
  }

  // Add requester_jid column to delegations (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE delegations ADD COLUMN requester_jid TEXT`);
  } catch {
    /* column already exists */
  }

  // Add paused_from column to workflows (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE workflows ADD COLUMN paused_from TEXT`);
  } catch {
    /* column already exists */
  }

  // Add workflow_type column to workflows (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE workflows ADD COLUMN workflow_type TEXT DEFAULT 'dev_test'`,
    );
  } catch {
    /* column already exists */
  }

  // Structured memory store (new memory system, independent from file-based memory).
  database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      layer TEXT NOT NULL DEFAULT 'canonical',
      memory_type TEXT NOT NULL DEFAULT 'preference',
      status TEXT NOT NULL DEFAULT 'active',
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(group_folder, layer, updated_at);
  `);

  try {
    database.exec(`ALTER TABLE memories ADD COLUMN status TEXT DEFAULT 'active'`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE memories ADD COLUMN metadata TEXT`);
  } catch {
    /* column already exists */
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_metrics_scope_time ON memory_metrics(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_metrics_event_time ON memory_metrics(event, created_at);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_extract_config (
      group_folder TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, key)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_extract_config_group ON memory_extract_config(group_folder);
  `);

  // FTS5 full-text search index for messages
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;
  `);

  // Backfill FTS index if empty (one-time migration for existing data)
  const ftsCount = database
    .prepare(`SELECT COUNT(*) as cnt FROM messages_fts`)
    .get() as { cnt: number };
  const msgCount = database
    .prepare(`SELECT COUNT(*) as cnt FROM messages`)
    .get() as { cnt: number };
  if (ftsCount.cnt === 0 && msgCount.cnt > 0) {
    logger.info(
      { messageCount: msgCount.cnt },
      'Backfilling FTS index for existing messages',
    );
    database.exec(`
      INSERT INTO messages_fts(rowid, content)
      SELECT rowid, content FROM messages;
    `);
    logger.info('FTS backfill complete');
  }

  // FTS5 full-text index for structured memories
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);

  const memFtsCount = database
    .prepare(`SELECT COUNT(*) as cnt FROM memories_fts`)
    .get() as { cnt: number };
  const memCount = database
    .prepare(`SELECT COUNT(*) as cnt FROM memories`)
    .get() as { cnt: number };
  if (memFtsCount.cnt === 0 && memCount.cnt > 0) {
    database.exec(`
      INSERT INTO memories_fts(rowid, content)
      SELECT rowid, content FROM memories;
    `);
    logger.info({ memoryCount: memCount.cnt }, 'Memory FTS backfill complete');
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, Date.now().toString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = Date.now().toString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT INTO messages (
      id,
      chat_jid,
      sender,
      sender_name,
      content,
      timestamp,
      is_from_me,
      is_bot_message,
      model,
      model_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, chat_jid) DO UPDATE SET
      sender = excluded.sender,
      sender_name = excluded.sender_name,
      content = excluded.content,
      timestamp = excluded.timestamp,
      is_from_me = excluded.is_from_me,
      is_bot_message = excluded.is_bot_message,
      model = COALESCE(excluded.model, messages.model),
      model_reason = COALESCE(excluded.model_reason, messages.model_reason)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.model ?? null,
    msg.model_reason ?? null,
  );
}

/**
 * Backfill model for a set of user message IDs that were actually processed.
 * Returns number of updated rows.
 */
export function backfillMessageModel(
  chatJid: string,
  messageIds: string[],
  model: string,
  modelReason: string,
): number {
  if (!chatJid || !model || !modelReason || messageIds.length === 0) return 0;

  const dedupedIds = Array.from(new Set(messageIds.filter(Boolean)));
  if (dedupedIds.length === 0) return 0;

  const batchSize = 300; // Keep parameter count safely below SQLite limits.
  const updateBatch = db.transaction((ids: string[]) => {
    const placeholders = ids.map(() => '?').join(',');
    const stmt = db.prepare(
      `UPDATE messages
       SET model = ?, model_reason = ?
       WHERE chat_jid = ?
         AND is_bot_message = 0
         AND id IN (${placeholders})`,
    );
    const result = stmt.run(model, modelReason, chatJid, ...ids);
    return result.changes;
  });

  let updated = 0;
  for (let i = 0; i < dedupedIds.length; i += batchSize) {
    updated += updateBatch(dedupedIds.slice(i, i + batchSize));
  }
  return updated;
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  model?: string | null;
  model_reason?: string | null;
}): void {
  db.prepare(
    `INSERT INTO messages (
      id,
      chat_jid,
      sender,
      sender_name,
      content,
      timestamp,
      is_from_me,
      is_bot_message,
      model,
      model_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, chat_jid) DO UPDATE SET
      sender = excluded.sender,
      sender_name = excluded.sender_name,
      content = excluded.content,
      timestamp = excluded.timestamp,
      is_from_me = excluded.is_from_me,
      is_bot_message = excluded.is_bot_message,
      model = COALESCE(excluded.model, messages.model),
      model_reason = COALESCE(excluded.model_reason, messages.model_reason)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.model ?? null,
    msg.model_reason ?? null,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = formatLocalTime(new Date());
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = formatLocalTime(new Date());
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Clear / reset ---

export function clearMessages(chatJid: string): void {
  db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
}

export function deleteMessagesByIds(chatJid: string, messageIds: string[]): number {
  if (!chatJid || messageIds.length === 0) return 0;
  const del = db.prepare('DELETE FROM messages WHERE chat_jid = ? AND id = ?');
  const tx = db.transaction((ids: string[]) => {
    let deleted = 0;
    for (const id of ids) {
      const result = del.run(chatJid, id);
      deleted += result.changes;
    }
    return deleted;
  });
  return tx(messageIds);
}

export function clearSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        description: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    description: row.description || undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    group.description || null,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    description: string | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
      description: row.description || undefined,
    };
  }
  return result;
}

// --- Delegation accessors ---

export function createDelegation(delegation: Delegation): void {
  db.prepare(
    `INSERT INTO delegations (id, source_jid, source_folder, target_jid, target_folder, task, status, result, requester_jid, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    delegation.id,
    delegation.source_jid,
    delegation.source_folder,
    delegation.target_jid,
    delegation.target_folder,
    delegation.task,
    delegation.status,
    delegation.result,
    delegation.requester_jid,
    delegation.created_at,
    delegation.updated_at,
  );
}

export function getDelegation(id: string): Delegation | undefined {
  return db.prepare('SELECT * FROM delegations WHERE id = ?').get(id) as
    | Delegation
    | undefined;
}

export function updateDelegation(
  id: string,
  updates: Partial<Pick<Delegation, 'status' | 'result' | 'outcome'>>,
): void {
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now().toString()];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.result !== undefined) {
    fields.push('result = ?');
    values.push(updates.result);
  }
  if (updates.outcome !== undefined) {
    fields.push('outcome = ?');
    values.push(updates.outcome);
  }

  values.push(id);
  db.prepare(`UPDATE delegations SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function getDelegationsBySource(sourceFolder: string): Delegation[] {
  return db
    .prepare(
      `SELECT * FROM delegations WHERE source_folder = ? ORDER BY created_at DESC`,
    )
    .all(sourceFolder) as Delegation[];
}

export function getDelegationsByTarget(targetFolder: string): Delegation[] {
  return db
    .prepare(
      `SELECT * FROM delegations WHERE target_folder = ? ORDER BY created_at DESC`,
    )
    .all(targetFolder) as Delegation[];
}

// --- Ask-user-question accessors ---

export function createAskQuestion(record: AskQuestionRecord): void {
  db.prepare(
    `INSERT INTO ask_questions (
      id, group_folder, chat_jid, status, payload_json, answers_json,
      current_index, created_at, expires_at, answered_at, responder_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.group_folder,
    record.chat_jid,
    record.status,
    record.payload_json,
    record.answers_json,
    record.current_index,
    record.created_at,
    record.expires_at,
    record.answered_at,
    record.responder_user_id,
  );
}

export function getAskQuestion(id: string): AskQuestionRecord | undefined {
  return db.prepare('SELECT * FROM ask_questions WHERE id = ?').get(id) as
    | AskQuestionRecord
    | undefined;
}

export function updateAskQuestion(
  id: string,
  updates: Partial<
    Pick<
      AskQuestionRecord,
      | 'status'
      | 'answers_json'
      | 'current_index'
      | 'answered_at'
      | 'responder_user_id'
      | 'expires_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.answers_json !== undefined) {
    fields.push('answers_json = ?');
    values.push(updates.answers_json);
  }
  if (updates.current_index !== undefined) {
    fields.push('current_index = ?');
    values.push(updates.current_index);
  }
  if (updates.answered_at !== undefined) {
    fields.push('answered_at = ?');
    values.push(updates.answered_at);
  }
  if (updates.responder_user_id !== undefined) {
    fields.push('responder_user_id = ?');
    values.push(updates.responder_user_id);
  }
  if (updates.expires_at !== undefined) {
    fields.push('expires_at = ?');
    values.push(updates.expires_at);
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE ask_questions SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function getExpiredPendingAskQuestions(nowIso: string): AskQuestionRecord[] {
  return db
    .prepare(
      `SELECT * FROM ask_questions
       WHERE status = 'pending' AND expires_at <= ?
       ORDER BY expires_at ASC`,
    )
    .all(nowIso) as AskQuestionRecord[];
}

// --- Workflow accessors ---

export function createWorkflow(workflow: Workflow): void {
  db.prepare(
    `INSERT INTO workflows (id, name, service, branch, deliverable, status, current_delegation_id, round, source_jid, paused_from, workflow_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workflow.id,
    workflow.name,
    workflow.service,
    workflow.branch,
    workflow.deliverable,
    workflow.status,
    workflow.current_delegation_id,
    workflow.round,
    workflow.source_jid,
    workflow.paused_from || null,
    workflow.workflow_type,
    workflow.created_at,
    workflow.updated_at,
  );
}

export function getWorkflow(id: string): Workflow | undefined {
  return db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as
    | Workflow
    | undefined;
}

export function updateWorkflow(
  id: string,
  updates: Partial<
    Pick<
      Workflow,
      | 'branch'
      | 'deliverable'
      | 'status'
      | 'current_delegation_id'
      | 'round'
      | 'paused_from'
      | 'workflow_type'
    >
  >,
): void {
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [new Date().toISOString()];

  if (updates.branch !== undefined) {
    fields.push('branch = ?');
    values.push(updates.branch);
  }
  if (updates.deliverable !== undefined) {
    fields.push('deliverable = ?');
    values.push(updates.deliverable);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.current_delegation_id !== undefined) {
    fields.push('current_delegation_id = ?');
    values.push(updates.current_delegation_id);
  }
  if (updates.round !== undefined) {
    fields.push('round = ?');
    values.push(updates.round);
  }
  if (updates.paused_from !== undefined) {
    fields.push('paused_from = ?');
    values.push(updates.paused_from);
  }
  if (updates.workflow_type !== undefined) {
    fields.push('workflow_type = ?');
    values.push(updates.workflow_type);
  }

  values.push(id);
  db.prepare(`UPDATE workflows SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function getWorkflowByDelegation(
  delegationId: string,
): Workflow | undefined {
  return db
    .prepare('SELECT * FROM workflows WHERE current_delegation_id = ?')
    .get(delegationId) as Workflow | undefined;
}

export function getAllActiveWorkflows(): Workflow[] {
  return db
    .prepare(
      `SELECT * FROM workflows WHERE status NOT IN ('passed', 'ops_failed', 'cancelled') ORDER BY created_at DESC`,
    )
    .all() as Workflow[];
}

export function getAllWorkflows(): Workflow[] {
  return db
    .prepare(`SELECT * FROM workflows ORDER BY created_at DESC`)
    .all() as Workflow[];
}

export function deleteWorkflow(id: string): void {
  db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
}

export function deleteAllWorkflows(): void {
  db.prepare('DELETE FROM workflows').run();
}

// --- Structured memory accessors ---

export function createMemory(input: {
  group_folder: string;
  layer: 'working' | 'episodic' | 'canonical';
  memory_type: 'preference' | 'rule' | 'fact' | 'summary';
  content: string;
  source?: string;
  metadata?: string;
}): MemoryRecord {
  const now = Date.now().toString();
  const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO memories (id, group_folder, layer, memory_type, status, content, source, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.group_folder,
    input.layer,
    input.memory_type,
    'active',
    input.content.trim(),
    input.source || 'manual',
    input.metadata || null,
    now,
    now,
  );
  reconcileMemoryStatuses(input.group_folder);
  return db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRecord;
}

export function searchMemories(
  groupFolder: string,
  query: string,
  limit: number = 10,
): MemorySearchResult[] {
  try {
    return db
      .prepare(
        `
      SELECT m.id, m.layer, m.memory_type, m.content, m.updated_at, bm25(memories_fts) AS score
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
        AND m.group_folder = ?
        AND m.status != 'deprecated'
      ORDER BY score ASC, m.updated_at DESC
      LIMIT ?
    `,
      )
      .all(query, groupFolder, limit) as MemorySearchResult[];
  } catch (err) {
    logger.error({ err, groupFolder, query }, 'Memory FTS search failed');
    return [];
  }
}

export function listMemories(
  groupFolder: string,
  limit: number = 20,
): MemoryRecord[] {
  return db
    .prepare(
      `
      SELECT * FROM memories
      WHERE group_folder = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `,
    )
    .all(groupFolder, limit) as MemoryRecord[];
}

export function getMemoryById(id: string): MemoryRecord | undefined {
  return db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as
    | MemoryRecord
    | undefined;
}

export function updateMemory(
  id: string,
  updates: Partial<
    Pick<MemoryRecord, 'content' | 'layer' | 'memory_type' | 'source' | 'status' | 'metadata'>
  >,
): void {
  const existing = getMemoryById(id);
  if (!existing) return;
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now().toString()];

  if (updates.content !== undefined) {
    fields.push('content = ?');
    values.push(updates.content.trim());
  }
  if (updates.layer !== undefined) {
    fields.push('layer = ?');
    values.push(updates.layer);
  }
  if (updates.memory_type !== undefined) {
    fields.push('memory_type = ?');
    values.push(updates.memory_type);
  }
  if (updates.source !== undefined) {
    fields.push('source = ?');
    values.push(updates.source);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.metadata !== undefined) {
    fields.push('metadata = ?');
    values.push(updates.metadata);
  }

  values.push(id);
  db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
  if (updates.status === undefined || updates.status !== 'deprecated') {
    reconcileMemoryStatuses(existing.group_folder);
  }
}

export function deleteMemory(id: string): void {
  const existing = getMemoryById(id);
  db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  if (existing) reconcileMemoryStatuses(existing.group_folder);
}

// --- Full-text search ---

export interface SearchResult {
  sender_name: string;
  content: string;
  timestamp: string;
  rank: number;
}

export interface MemoryDuplicateGroup {
  key: string;
  ids: string[];
}

export interface MemoryConflictGroup {
  key: string;
  positiveIds: string[];
  negativeIds: string[];
}

export interface MemoryDoctorReport {
  total: number;
  duplicateGroups: MemoryDuplicateGroup[];
  conflictGroups: MemoryConflictGroup[];
  staleWorkingIds: string[];
}

export interface MemoryGcResult {
  dryRun: boolean;
  duplicateDeletedIds: string[];
  staleDeletedIds: string[];
}

export interface MemoryMetricSummary {
  hours: number;
  total: number;
  byEvent: Array<{ event: string; count: number }>;
}

export interface MemoryExtractConfig {
  canonical_max: number;
  working_max: number;
  episodic_max: number;
  canonical_min_confidence: number;
  working_min_confidence: number;
  episodic_min_confidence: number;
}

const MEMORY_EXTRACT_DEFAULT_CONFIG: MemoryExtractConfig = {
  canonical_max: 3,
  working_max: 4,
  episodic_max: 1,
  canonical_min_confidence: 0.8,
  working_min_confidence: 0.55,
  episodic_min_confidence: 0.65,
};

function normalizeMemoryText(content: string): string {
  return content
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[，。！？；：,.!?;:]/g, ' ')
    .trim();
}

function getPolarity(content: string): 1 | -1 | 0 {
  const c = content.toLowerCase();
  const hasNegative = /(never|don't|do not|不要|不能|不许|禁止)/.test(c);
  const hasPositive = /(always|must|请务必|必须|总是)/.test(c);
  if (hasNegative && !hasPositive) return -1;
  if (hasPositive && !hasNegative) return 1;
  return 0;
}

function polarityKey(content: string): string {
  return normalizeMemoryText(content)
    .replace(
      /\b(always|must|never|don't|do not)\b|不要|不能|不许|禁止|请务必|必须|总是/g,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function reconcileMemoryStatuses(groupFolder: string): void {
  // Reset non-deprecated rows to active first.
  db.prepare(
    `UPDATE memories
     SET status = 'active'
     WHERE group_folder = ? AND status != 'deprecated'`,
  ).run(groupFolder);

  const rows = db
    .prepare(
      `SELECT id, layer, memory_type, content, status
       FROM memories
       WHERE group_folder = ? AND status != 'deprecated'
       ORDER BY updated_at DESC`,
    )
    .all(groupFolder) as Array<{
      id: string;
      layer: string;
      memory_type: string;
      content: string;
      status: string;
    }>;

  const conflictMap = new Map<
    string,
    { positiveIds: string[]; negativeIds: string[] }
  >();
  for (const row of rows) {
    const polarity = getPolarity(row.content);
    if (polarity === 0) continue;
    const key = `${row.layer}|${row.memory_type}|${polarityKey(row.content)}`;
    if (!key || key.endsWith('|')) continue;
    const slot = conflictMap.get(key) || { positiveIds: [], negativeIds: [] };
    if (polarity > 0) slot.positiveIds.push(row.id);
    else slot.negativeIds.push(row.id);
    conflictMap.set(key, slot);
  }

  const markStmt = db.prepare(`UPDATE memories SET status = 'conflicted' WHERE id = ?`);
  for (const slot of conflictMap.values()) {
    if (slot.positiveIds.length === 0 || slot.negativeIds.length === 0) continue;
    for (const id of [...slot.positiveIds, ...slot.negativeIds]) {
      markStmt.run(id);
    }
  }
}

export interface ResolveConflictKeepResult {
  kept: MemoryRecord;
  deprecated: MemoryRecord;
}

export interface ResolveConflictMergeResult {
  merged: MemoryRecord;
  deprecated: [MemoryRecord, MemoryRecord];
}

export function resolveConflict(
  mode: 'keep',
  opts: { keepId: string; deprecateId: string; groupFolder: string },
): ResolveConflictKeepResult;
export function resolveConflict(
  mode: 'merge',
  opts: { mergeIds: [string, string]; mergedContent: string; groupFolder: string },
): ResolveConflictMergeResult;
export function resolveConflict(
  mode: 'keep' | 'merge',
  opts: {
    keepId?: string;
    deprecateId?: string;
    mergeIds?: [string, string];
    mergedContent?: string;
    groupFolder: string;
  },
): ResolveConflictKeepResult | ResolveConflictMergeResult {
  const now = new Date().toISOString();

  if (mode === 'keep') {
    const { keepId, deprecateId, groupFolder } = opts;
    if (!keepId || !deprecateId) throw new Error('keep mode requires keepId and deprecateId');

    const keepMem = getMemoryById(keepId);
    const deprecateMem = getMemoryById(deprecateId);
    if (!keepMem) throw new Error(`Memory not found: ${keepId}`);
    if (!deprecateMem) throw new Error(`Memory not found: ${deprecateId}`);
    if (keepMem.group_folder !== groupFolder) throw new Error(`Memory ${keepId} does not belong to group ${groupFolder}`);
    if (deprecateMem.group_folder !== groupFolder) throw new Error(`Memory ${deprecateId} does not belong to group ${groupFolder}`);
    if (keepMem.status !== 'conflicted') throw new Error(`Memory ${keepId} is not conflicted (status: ${keepMem.status})`);
    if (deprecateMem.status !== 'conflicted') throw new Error(`Memory ${deprecateId} is not conflicted (status: ${deprecateMem.status})`);

    const txn = db.transaction(() => {
      updateMemory(deprecateId, {
        status: 'deprecated',
        metadata: JSON.stringify({
          deprecated_reason: 'conflict_resolution',
          resolved_by: 'keep',
          resolved_at: now,
          counterpart_id: keepId,
        }),
      });
      updateMemory(keepId, {
        status: 'active',
        metadata: JSON.stringify({
          resolved_conflict_with: deprecateId,
          resolved_at: now,
        }),
      });
    });
    txn();

    reconcileMemoryStatuses(groupFolder);

    return {
      kept: getMemoryById(keepId)!,
      deprecated: getMemoryById(deprecateId)!,
    };
  }

  // merge mode
  const { mergeIds, mergedContent, groupFolder } = opts;
  if (!mergeIds || mergeIds.length !== 2) throw new Error('merge mode requires exactly 2 mergeIds');
  if (!mergedContent) throw new Error('merge mode requires mergedContent');

  const memA = getMemoryById(mergeIds[0]);
  const memB = getMemoryById(mergeIds[1]);
  if (!memA) throw new Error(`Memory not found: ${mergeIds[0]}`);
  if (!memB) throw new Error(`Memory not found: ${mergeIds[1]}`);
  if (memA.group_folder !== groupFolder) throw new Error(`Memory ${mergeIds[0]} does not belong to group ${groupFolder}`);
  if (memB.group_folder !== groupFolder) throw new Error(`Memory ${mergeIds[1]} does not belong to group ${groupFolder}`);
  if (memA.status !== 'conflicted') throw new Error(`Memory ${mergeIds[0]} is not conflicted (status: ${memA.status})`);
  if (memB.status !== 'conflicted') throw new Error(`Memory ${mergeIds[1]} is not conflicted (status: ${memB.status})`);

  let newMem: MemoryRecord;

  const txn = db.transaction(() => {
    updateMemory(mergeIds[0], {
      status: 'deprecated',
      metadata: JSON.stringify({
        deprecated_reason: 'conflict_resolution',
        resolved_by: 'merge',
        resolved_at: now,
        counterpart_id: mergeIds[1],
      }),
    });
    updateMemory(mergeIds[1], {
      status: 'deprecated',
      metadata: JSON.stringify({
        deprecated_reason: 'conflict_resolution',
        resolved_by: 'merge',
        resolved_at: now,
        counterpart_id: mergeIds[0],
      }),
    });
    newMem = createMemory({
      group_folder: memA.group_folder,
      layer: memA.layer,
      memory_type: memA.memory_type,
      content: mergedContent,
      source: 'conflict_resolution',
      metadata: JSON.stringify({
        merged_from: [mergeIds[0], mergeIds[1]],
        resolved_at: now,
      }),
    });
  });
  txn();

  reconcileMemoryStatuses(groupFolder);

  return {
    merged: newMem!,
    deprecated: [getMemoryById(mergeIds[0])!, getMemoryById(mergeIds[1])!],
  };
}

export function doctorMemories(
  groupFolder: string,
  staleWorkingDays: number = 7,
): MemoryDoctorReport {
  const memories = listMemories(groupFolder, 2000);
  const duplicateMap = new Map<string, string[]>();
  for (const m of memories) {
    const key = `${m.layer}|${m.memory_type}|${normalizeMemoryText(m.content)}`;
    const arr = duplicateMap.get(key) || [];
    arr.push(m.id);
    duplicateMap.set(key, arr);
  }

  const duplicateGroups: MemoryDuplicateGroup[] = [];
  for (const [key, ids] of duplicateMap.entries()) {
    if (ids.length > 1) duplicateGroups.push({ key, ids });
  }

  const conflictMap = new Map<
    string,
    { positiveIds: string[]; negativeIds: string[] }
  >();
  for (const m of memories) {
    const polarity = getPolarity(m.content);
    if (polarity === 0) continue;
    const key = `${m.layer}|${m.memory_type}|${polarityKey(m.content)}`;
    if (!key || key.endsWith('|')) continue;
    const slot = conflictMap.get(key) || { positiveIds: [], negativeIds: [] };
    if (polarity > 0) slot.positiveIds.push(m.id);
    else slot.negativeIds.push(m.id);
    conflictMap.set(key, slot);
  }

  const conflictGroups: MemoryConflictGroup[] = [];
  for (const [key, slot] of conflictMap.entries()) {
    if (slot.positiveIds.length > 0 && slot.negativeIds.length > 0) {
      conflictGroups.push({
        key,
        positiveIds: slot.positiveIds,
        negativeIds: slot.negativeIds,
      });
    }
  }

  const staleCutoff = Date.now() - staleWorkingDays * 24 * 60 * 60 * 1000;
  const staleWorkingIds = memories
    .filter((m) => m.layer === 'working')
    .filter(
      (m) => Number(m.updated_at) > 0 && Number(m.updated_at) < staleCutoff,
    )
    .map((m) => m.id);

  return {
    total: memories.length,
    duplicateGroups,
    conflictGroups,
    staleWorkingIds,
  };
}

export function gcMemories(
  groupFolder: string,
  opts?: { dryRun?: boolean; staleWorkingDays?: number },
): MemoryGcResult {
  const dryRun = opts?.dryRun !== undefined ? opts.dryRun : true;
  const staleWorkingDays = opts?.staleWorkingDays ?? 14;
  const memories = listMemories(groupFolder, 4000);

  const dupGroups = new Map<string, MemoryRecord[]>();
  for (const m of memories) {
    const key = `${m.layer}|${m.memory_type}|${normalizeMemoryText(m.content)}`;
    const arr = dupGroups.get(key) || [];
    arr.push(m);
    dupGroups.set(key, arr);
  }

  const duplicateDeletedIds: string[] = [];
  for (const arr of dupGroups.values()) {
    if (arr.length <= 1) continue;
    arr.sort((a, b) => Number(b.updated_at) - Number(a.updated_at));
    for (const m of arr.slice(1)) duplicateDeletedIds.push(m.id);
  }

  const cutoff = Date.now() - staleWorkingDays * 24 * 60 * 60 * 1000;
  const staleDeletedIds = memories
    .filter((m) => m.layer === 'working')
    .filter((m) => Number(m.updated_at) > 0 && Number(m.updated_at) < cutoff)
    .map((m) => m.id);

  if (!dryRun) {
    const ids = Array.from(new Set([...duplicateDeletedIds, ...staleDeletedIds]));
    const stmt = db.prepare(`DELETE FROM memories WHERE id = ?`);
    for (const id of ids) stmt.run(id);
  }

  return {
    dryRun,
    duplicateDeletedIds,
    staleDeletedIds,
  };
}

export function recordMemoryMetric(
  groupFolder: string,
  event: string,
  detail?: string,
): void {
  db.prepare(
    `INSERT INTO memory_metrics (group_folder, event, detail, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(groupFolder, event, detail || null, Date.now().toString());
}

export function getMemoryMetricSummary(
  groupFolder: string,
  hours: number = 24,
): MemoryMetricSummary {
  const safeHours = Math.max(1, Math.min(hours, 24 * 30));
  const since = Date.now() - safeHours * 60 * 60 * 1000;
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as cnt
       FROM memory_metrics
       WHERE group_folder = ? AND CAST(created_at AS INTEGER) >= ?`,
    )
    .get(groupFolder, since) as { cnt: number };

  const byEvent = db
    .prepare(
      `SELECT event, COUNT(*) as count
       FROM memory_metrics
       WHERE group_folder = ? AND CAST(created_at AS INTEGER) >= ?
       GROUP BY event
       ORDER BY count DESC, event ASC`,
    )
    .all(groupFolder, since) as Array<{ event: string; count: number }>;

  return {
    hours: safeHours,
    total: totalRow.cnt || 0,
    byEvent,
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const n = Math.trunc(value);
  return Math.max(min, Math.min(max, n));
}

function clampFloat(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function getMemoryExtractConfig(groupFolder: string): MemoryExtractConfig {
  const rows = db
    .prepare(
      `SELECT group_folder, key, value
       FROM memory_extract_config
       WHERE group_folder IN ('*', ?)`,
    )
    .all(groupFolder) as Array<{
      group_folder: string;
      key: string;
      value: string;
    }>;

  const cfg: MemoryExtractConfig = { ...MEMORY_EXTRACT_DEFAULT_CONFIG };
  rows
    .sort((a, b) => (a.group_folder === '*' ? -1 : 1) - (b.group_folder === '*' ? -1 : 1))
    .forEach((row) => {
      const raw = Number(row.value);
      switch (row.key) {
        case 'canonical_max':
          cfg.canonical_max = clampInt(raw, 0, 20);
          break;
        case 'working_max':
          cfg.working_max = clampInt(raw, 0, 50);
          break;
        case 'episodic_max':
          cfg.episodic_max = clampInt(raw, 0, 10);
          break;
        case 'canonical_min_confidence':
          cfg.canonical_min_confidence = clampFloat(raw, 0, 1);
          break;
        case 'working_min_confidence':
          cfg.working_min_confidence = clampFloat(raw, 0, 1);
          break;
        case 'episodic_min_confidence':
          cfg.episodic_min_confidence = clampFloat(raw, 0, 1);
          break;
        default:
          break;
      }
    });

  return cfg;
}

export function setMemoryExtractConfig(
  groupFolder: string,
  key: keyof MemoryExtractConfig,
  value: number,
): void {
  db.prepare(
    `INSERT INTO memory_extract_config (group_folder, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(group_folder, key)
     DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(groupFolder, key, String(value), Date.now().toString());
}

/**
 * Search messages using FTS5 full-text search, scoped to a group's chat JIDs.
 */
export function searchMessages(
  groupFolder: string,
  query: string,
  limit: number = 10,
): SearchResult[] {
  // Find chat JIDs associated with this group folder
  const group = db
    .prepare(`SELECT jid FROM registered_groups WHERE folder = ?`)
    .get(groupFolder) as { jid: string } | undefined;

  if (!group) return [];

  const chatJid = group.jid;

  try {
    const results = db
      .prepare(
        `
      SELECT m.sender_name, m.content, m.timestamp, fts.rank
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      WHERE messages_fts MATCH ?
        AND m.chat_jid = ?
      ORDER BY fts.rank
      LIMIT ?
    `,
      )
      .all(query, chatJid, limit) as SearchResult[];
    return results;
  } catch (err) {
    logger.error({ err, groupFolder, query }, 'FTS search failed');
    return [];
  }
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
