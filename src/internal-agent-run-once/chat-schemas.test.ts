import { describe, expect, it } from 'vitest';

import { parseAgentChatRequest } from './chat-schemas.js';

describe('internal agent chat schemas', () => {
  it('accepts the generic agent chat contract', () => {
    const parsed = parseAgentChatRequest({
      chat_jid: 'web:l3agent',
      session_id: 'session-prev',
      system: 'system prompt',
      message: 'question',
      metadata: { trace_id: 'trace-1' },
    });

    expect(parsed).toMatchObject({
      chat_jid: 'web:l3agent',
      session_id: 'session-prev',
      system: 'system prompt',
      message: 'question',
      metadata: { trace_id: 'trace-1' },
    });
  });

  it('rejects Deep Research-specific context fields', () => {
    expect(() =>
      parseAgentChatRequest({
        chat_jid: 'web:l3agent',
        message: 'question',
        deep_research: {
          conversation_id: 'drs_1',
          mounted_root: '/workspace/extra/deep-research',
          referenced_task_ids: ['dr_1'],
        },
      }),
    ).toThrow();
  });
});
