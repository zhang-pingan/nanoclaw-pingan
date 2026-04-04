import Database from 'better-sqlite3';
import path from 'path';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

let db: Database.Database;

export interface WebMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message: boolean;
  reply_to_id?: string | null;
  model?: string | null;
  model_reason?: string | null;
  workflow_id?: string | null;
  file_path?: string | null;
}

export function initWebDb(): void {
  const dbPath = path.join(STORE_DIR, 'web-messages.db');
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT,
      chat_jid    TEXT,
      sender      TEXT,
      sender_name TEXT,
      content     TEXT,
      timestamp   TEXT,
      is_from_me  INTEGER,
      is_bot_message INTEGER,
      model TEXT,
      model_reason TEXT,
      PRIMARY KEY (chat_jid, id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_time
      ON messages (chat_jid, timestamp);
  `);

  // Schema migration: add reply_to_id column if missing
  const columns = db.pragma('table_info(messages)') as { name: string }[];
  if (!columns.some((c) => c.name === 'reply_to_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN reply_to_id TEXT');
    logger.info('Web DB migrated: added reply_to_id column');
  }
  if (!columns.some((c) => c.name === 'model')) {
    db.exec('ALTER TABLE messages ADD COLUMN model TEXT');
    logger.info('Web DB migrated: added model column');
  }
  if (!columns.some((c) => c.name === 'model_reason')) {
    db.exec('ALTER TABLE messages ADD COLUMN model_reason TEXT');
    logger.info('Web DB migrated: added model_reason column');
  }
  if (!columns.some((c) => c.name === 'workflow_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN workflow_id TEXT');
    logger.info('Web DB migrated: added workflow_id column');
  }
  if (!columns.some((c) => c.name === 'file_path')) {
    db.exec('ALTER TABLE messages ADD COLUMN file_path TEXT');
    logger.info('Web DB migrated: added file_path column');
  }

  logger.info({ path: dbPath }, 'Web message DB initialized');
}

export function storeWebMessage(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  reply_to_id?: string | null;
  model?: string | null;
  model_reason?: string | null;
  workflow_id?: string | null;
  file_path?: string | null;
}): void {
  const isBotMessage = msg.is_bot_message ? 1 : 0;

  db.prepare(`
    INSERT INTO messages
      (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_id, model, model_reason, workflow_id, file_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_jid, id) DO UPDATE SET
      sender = excluded.sender,
      sender_name = excluded.sender_name,
      content = excluded.content,
      timestamp = excluded.timestamp,
      is_from_me = excluded.is_from_me,
      is_bot_message = excluded.is_bot_message,
      reply_to_id = COALESCE(excluded.reply_to_id, messages.reply_to_id),
      model = COALESCE(excluded.model, messages.model),
      model_reason = COALESCE(excluded.model_reason, messages.model_reason),
      workflow_id = COALESCE(excluded.workflow_id, messages.workflow_id),
      file_path = COALESCE(excluded.file_path, messages.file_path)
  `).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    isBotMessage,
    msg.reply_to_id || null,
    msg.model ?? null,
    msg.model_reason ?? null,
    msg.workflow_id ?? null,
    msg.file_path ?? null,
  );
}

/**
 * Backfill model for already persisted web user messages that were actually processed.
 * Returns number of updated rows.
 */
export function backfillWebMessageModel(
  chatJid: string,
  messageIds: string[],
  model: string,
  modelReason: string,
): number {
  if (!chatJid || !model || !modelReason || messageIds.length === 0) return 0;

  const dedupedIds = Array.from(new Set(messageIds.filter(Boolean)));
  if (dedupedIds.length === 0) return 0;

  const batchSize = 300;
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

export function getWebMessages(
  chatJid: string,
  sinceTimestamp: string = '0',
  limit: number = 200,
): WebMessage[] {
  return db
    .prepare(
      `
      SELECT id, chat_jid, sender, sender_name, content, timestamp,
             CAST(is_from_me AS INTEGER) AS is_from_me,
             CAST(is_bot_message AS INTEGER) AS is_bot_message,
             reply_to_id, model, model_reason, file_path
        FROM messages
       WHERE chat_jid = ? AND timestamp >= ?
       ORDER BY timestamp ASC
       LIMIT ?
    `,
    )
    .all(chatJid, sinceTimestamp, limit) as WebMessage[];
}

export function getWebMessagesBefore(
  chatJid: string,
  beforeTimestamp: string,
  limit: number = 50,
): WebMessage[] {
  return db
    .prepare(
      `
      SELECT id, chat_jid, sender, sender_name, content, timestamp,
             CAST(is_from_me AS INTEGER) AS is_from_me,
             CAST(is_bot_message AS INTEGER) AS is_bot_message,
             reply_to_id, model, model_reason, file_path
        FROM messages
       WHERE chat_jid = ? AND timestamp < ?
       ORDER BY timestamp DESC
       LIMIT ?
    `,
    )
    .all(chatJid, beforeTimestamp, limit)
    .reverse() as WebMessage[];
}

export function clearWebMessages(chatJid: string): void {
  db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
}

export function deleteWebMessagesByIds(chatJid: string, messageIds: string[]): number {
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
