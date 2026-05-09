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

vi.mock('./workflow.js', () => ({
  handleCardAction: vi.fn(),
}));

vi.mock('./workbench-broadcast-actions.js', () => ({
  handleWorkbenchBroadcastCardAction: vi.fn(async () => ({
    ok: true,
    toast: { type: 'success', content: 'ok' },
  })),
  logWorkbenchBroadcastActionFailure: vi.fn(),
}));

import { createCardActionHandler } from './card-action-router.js';
import { handleAskQuestionResponse } from './ask-user-question.js';
import { handleCardAction } from './workflow.js';
import { handleWorkbenchBroadcastCardAction } from './workbench-broadcast-actions.js';

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

  it('returns workflow card action results to the channel', async () => {
    vi.mocked(handleCardAction).mockReturnValueOnce({
      ok: false,
      toast: { type: 'error', content: 'channel not allowed' },
    });
    const handler = createCardActionHandler({
      registeredGroups: () => ({}),
      sendMessage: async () => {},
    });

    const result = await handler({
      action: 'workflow_interrupt_resume',
      user_id: 'u1',
      message_id: 'm3',
      form_value: {
        interrupt_id: 'wi-1',
        resume_action: 'approve',
      },
    });

    expect(result).toEqual({
      ok: false,
      toast: { type: 'error', content: 'channel not allowed' },
    });
  });

  it('forwards broadcast message ids to the workbench handler', async () => {
    const handler = createCardActionHandler({
      registeredGroups: () => ({}),
      sendMessage: async () => {},
    });

    const result = await handler({
      action: 'wb_broadcast_submit',
      user_id: 'u1',
      message_id: 'msg-1',
      actor_channel: 'feishu',
      form_value: {
        task_id: 'task-1',
        action_item_id: 'item-1',
      },
    });

    expect(handleWorkbenchBroadcastCardAction).toHaveBeenCalledWith({
      action: 'wb_broadcast_submit',
      formValue: {
        task_id: 'task-1',
        action_item_id: 'item-1',
      },
      registeredGroups: {},
      sendCard: undefined,
      sendMessage: expect.any(Function),
      userId: 'u1',
      actorChannel: 'feishu',
      messageId: 'msg-1',
    });
    expect(result).toEqual({
      ok: true,
      toast: { type: 'success', content: 'ok' },
    });
  });
});
