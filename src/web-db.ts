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
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_id || null,
  );
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
             reply_to_id
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
             reply_to_id
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
