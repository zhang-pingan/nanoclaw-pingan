import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./ask-user-question.js', () => ({
  ASK_ACTION_ANSWER: 'ask_question_answer',
  ASK_ACTION_SKIP: 'ask_question_skip',
  handleAskQuestionResponse: vi.fn(async () => ({
    ok: true,
    userMessage: '',
    completed: true,
  })),
  dispatchCurrentAskQuestion: vi.fn(async () => ({
    ok: true,
    message: 'ok',
  })),
}));

const handleAssistantInboxBroadcastCardActionMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    toast: { type: 'success', content: 'inbox ok' },
  })),
);

vi.mock('./assistant/assistant-inbox-broadcast-actions.js', () => ({
  ASSISTANT_INBOX_BROADCAST_ACTION_PREFIX: 'assistant_inbox_broadcast_',
  handleAssistantInboxBroadcastCardAction:
    handleAssistantInboxBroadcastCardActionMock,
  logAssistantInboxBroadcastActionFailure: vi.fn(),
}));

import { createCardActionHandler } from './card-action-router.js';
import { handleAskQuestionResponse } from './ask-user-question.js';

describe('card-action-router ask dedupe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dedupes identical ask card actions in window', async () => {
    const handler = createCardActionHandler({
      registeredAgents: () => ({
        'web:g1': {
          name: 'G1',
          folder: 'agent-1',
          trigger: '@bot',
          added_at: new Date().toISOString(),
        },
      }),
      sendMessage: async () => {},
    });

    const action = {
      action: 'ask_question_answer',
      user_id: 'u1',
      message_id: 'm1',
      agent_folder: 'agent-1',
      form_value: {
        request_id: 'aq-1',
        agent_folder: 'agent-1',
        answer: 'A',
      },
    };

    handler(action);
    handler(action);
    await new Promise((r) => setTimeout(r, 0));

    expect(handleAskQuestionResponse).toHaveBeenCalledTimes(1);
  });

  it('does not dedupe different payloads', async () => {
    const handler = createCardActionHandler({
      registeredAgents: () => ({
        'web:g1': {
          name: 'G1',
          folder: 'agent-1',
          trigger: '@bot',
          added_at: new Date().toISOString(),
        },
      }),
      sendMessage: async () => {},
    });

    handler({
      action: 'ask_question_answer',
      user_id: 'u1',
      message_id: 'm2',
      agent_folder: 'agent-1',
      form_value: {
        request_id: 'aq-2',
        agent_folder: 'agent-1',
        answer: 'A',
      },
    });
    handler({
      action: 'ask_question_answer',
      user_id: 'u1',
      message_id: 'm2',
      agent_folder: 'agent-1',
      form_value: {
        request_id: 'aq-2',
        agent_folder: 'agent-1',
        answer: 'B',
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(handleAskQuestionResponse).toHaveBeenCalledTimes(2);
  });

  it('routes assistant inbox broadcast card actions with source Agent', async () => {
    const handler = createCardActionHandler({
      registeredAgents: () => ({
        'feishu:oc_allowed': {
          name: '主 Agent',
          folder: 'main',
          trigger: '',
          added_at: '1',
        },
      }),
      sendMessage: async () => {},
    });

    const result = await handler({
      action: 'assistant_inbox_broadcast_dismiss',
      user_id: 'u1',
      message_id: 'msg-inbox',
      actor_channel: 'feishu',
      agent_jid: 'feishu:oc_allowed',
      form_value: {
        item_id: 'agent-inbox-1',
      },
    });

    expect(handleAssistantInboxBroadcastCardActionMock).toHaveBeenCalledWith({
      action: 'assistant_inbox_broadcast_dismiss',
      formValue: {
        item_id: 'agent-inbox-1',
      },
      registeredAgents: {
        'feishu:oc_allowed': {
          name: '主 Agent',
          folder: 'main',
          trigger: '',
          added_at: '1',
        },
      },
      sendCard: undefined,
      sendMessage: expect.any(Function),
      userId: 'u1',
      actorChannel: 'feishu',
      messageId: 'msg-inbox',
      targetJid: 'feishu:oc_allowed',
    });
    expect(result).toEqual({
      ok: true,
      toast: { type: 'success', content: 'inbox ok' },
    });
  });
});
