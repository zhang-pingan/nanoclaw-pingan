import { beforeEach, describe, expect, it } from 'vitest';

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
    chat_jid: 'group@g.us',
    sender: 'user@s.whatsapp.net',
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
    const messages = getWebMessages('group@g.us', '0', 3);

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('getWebMessagesBefore returns older rows in chronological order', () => {
    const messages = getWebMessagesBefore(
      'group@g.us',
      '2024-01-01T00:00:06.000Z',
      3,
    );

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 3');
    expect(messages[2].content).toBe('message 5');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });
});
