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
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO messages
      (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
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
             CAST(is_bot_message AS INTEGER) AS is_bot_message
        FROM messages
       WHERE chat_jid = ? AND timestamp >= ?
       ORDER BY timestamp ASC
       LIMIT ?
    `,
    )
    .all(chatJid, sinceTimestamp, limit) as WebMessage[];
}

export function clearWebMessages(chatJid: string): void {
  db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
}
