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

const handleAssistantEvolutionCardActionMock = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    toast: { type: 'success', content: 'evolution ok' },
  })),
);

vi.mock('./assistant/evolution-card-actions.js', () => ({
  ASSISTANT_EVOLUTION_CARD_ACTION: 'assistant_evolution_action',
  handleAssistantEvolutionCardAction: handleAssistantEvolutionCardActionMock,
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
      registeredGroups: () => ({
        'g1@g.us': {
          name: 'G1',
          folder: 'group-1',
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
      group_folder: 'group-1',
      form_value: {
        request_id: 'aq-1',
        group_folder: 'group-1',
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
      registeredGroups: () => ({
        'g1@g.us': {
          name: 'G1',
          folder: 'group-1',
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
      group_folder: 'group-1',
      form_value: {
        request_id: 'aq-2',
        group_folder: 'group-1',
        answer: 'A',
      },
    });
    handler({
      action: 'ask_question_answer',
      user_id: 'u1',
      message_id: 'm2',
      group_folder: 'group-1',
      form_value: {
        request_id: 'aq-2',
        group_folder: 'group-1',
        answer: 'B',
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(handleAskQuestionResponse).toHaveBeenCalledTimes(2);
  });

  it('routes assistant evolution card actions', async () => {
    const handler = createCardActionHandler({
      registeredGroups: () => ({}),
      sendMessage: async () => {},
    });

    const result = await handler({
      action: 'assistant_evolution_action',
      user_id: 'u1',
      message_id: 'msg-evo',
      form_value: {
        item_id: 'evo-1',
        evolution_action: 'adopt',
      },
    });

    expect(handleAssistantEvolutionCardActionMock).toHaveBeenCalledWith({
      itemId: 'evo-1',
      evolutionAction: 'adopt',
    });
    expect(result).toEqual({
      ok: true,
      toast: { type: 'success', content: 'evolution ok' },
    });
  });

  it('routes assistant inbox broadcast card actions with source group', async () => {
    const handler = createCardActionHandler({
      registeredGroups: () => ({
        'feishu:oc_allowed': {
          name: '主群',
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
      group_jid: 'feishu:oc_allowed',
      form_value: {
        item_id: 'agent-inbox-1',
      },
    });

    expect(handleAssistantInboxBroadcastCardActionMock).toHaveBeenCalledWith({
      action: 'assistant_inbox_broadcast_dismiss',
      formValue: {
        item_id: 'agent-inbox-1',
      },
      registeredGroups: {
        'feishu:oc_allowed': {
          name: '主群',
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
