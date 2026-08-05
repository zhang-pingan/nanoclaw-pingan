import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  _initTestWebDb,
  getWebMessages,
  getWebMessagesBefore,
  storeWebMessage,
} from './web-db.js';

beforeEach(() => {
  _initTestWebDb();
});

function store(i: number): void {
  storeWebMessage({
    id: `web-${i}`,
    chat_jid: 'web:group',
    sender: 'user:user',
    sender_name: 'User',
    content: `message ${i}`,
    timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
  });
}

describe('web message query LIMIT', () => {
  beforeEach(() => {
    for (let i = 1; i <= 10; i++) {
      store(i);
    }
  });

  it('getWebMessages returns the most recent rows in chronological order', () => {
    const messages = getWebMessages('web:group', '0', 3);

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('getWebMessagesBefore returns older rows in chronological order', () => {
    const messages = getWebMessagesBefore(
      'web:group',
      '2024-01-01T00:00:06.000Z',
      3,
    );

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 3');
    expect(messages[2].content).toBe('message 5');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });
});

describe('removed web message schema cleanup', () => {
  it('does not create legacy columns in a fresh database', () => {
    const database = new Database(':memory:');
    _initTestWebDb(database);

    const columns = database.pragma('table_info(messages)') as Array<{
      name: string;
    }>;
    expect(
      columns.filter((column) => column.name.startsWith('workflow_')),
    ).toEqual([]);
  });

  it('removes existing legacy columns and indexes without losing messages', () => {
    const database = new Database(':memory:');
    _initTestWebDb(database);
    store(1);
    database.exec(`
      ALTER TABLE messages ADD COLUMN workflow_id TEXT;
      ALTER TABLE messages ADD COLUMN workflow_stage TEXT;
      CREATE INDEX idx_web_messages_workflow_id ON messages(workflow_id);
      CREATE INDEX idx_web_messages_workflow_stage ON messages(workflow_stage);
    `);

    _initTestWebDb(database);

    const columns = database.pragma('table_info(messages)') as Array<{
      name: string;
    }>;
    const indexes = database.pragma('index_list(messages)') as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).not.toContain('workflow_id');
    expect(columns.map((column) => column.name)).not.toContain(
      'workflow_stage',
    );
    expect(indexes.map((index) => index.name)).not.toContain(
      'idx_web_messages_workflow_id',
    );
    expect(indexes.map((index) => index.name)).not.toContain(
      'idx_web_messages_workflow_stage',
    );
    expect(getWebMessages('web:group')).toHaveLength(1);
  });
});
