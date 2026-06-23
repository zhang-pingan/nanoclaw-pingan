import { describe, expect, it } from 'vitest';

import {
  parseRunOnceRequest,
  UnsupportedMessagesShapeError,
} from './schemas.js';

describe('internal run-once schemas', () => {
  it('accepts a single user message', () => {
    const parsed = parseRunOnceRequest({
      system: 'system prompt',
      messages: [{ role: 'user', content: 'question' }],
      chat_jid: 'web:l3agent',
    });

    expect(parsed.require_result).toBe(true);
    expect(parsed.metadata).toEqual({});
  });

  it('rejects history in the first version', () => {
    expect(() =>
      parseRunOnceRequest({
        system: 'system prompt',
        messages: [
          { role: 'user', content: 'old question' },
          { role: 'assistant', content: 'old answer' },
          { role: 'user', content: 'new question' },
        ],
        chat_jid: 'web:l3agent',
      }),
    ).toThrow(UnsupportedMessagesShapeError);
  });

  it('requires result mode', () => {
    expect(() =>
      parseRunOnceRequest({
        system: 'system prompt',
        messages: [{ role: 'user', content: 'question' }],
        chat_jid: 'web:l3agent',
        require_result: false,
      }),
    ).toThrow();
  });

  it('rejects host file paths in structured file inputs', () => {
    expect(() =>
      parseRunOnceRequest({
        system: 'system prompt',
        messages: [{ role: 'user', content: 'question' }],
        chat_jid: 'web:l3agent',
        files: [
          {
            name: 'secret.txt',
            agent_path: '/Users/alice/Desktop/secret.txt',
          },
        ],
      }),
    ).toThrow();
  });
});
