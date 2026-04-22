import { describe, expect, it, vi } from 'vitest';

import { FeishuChannel } from './feishu.js';
import type { InteractiveCard } from '../types.js';

function createChannel(): FeishuChannel {
  return new FeishuChannel(
    {
      appId: 'app-id',
      appSecret: 'app-secret',
    },
    {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    },
  );
}

describe('FeishuChannel form cards', () => {
  it('stores submit action payload on the form and keeps the submit button renderable', () => {
    const channel = createChannel();
    const card: InteractiveCard = {
      header: { title: '测试卡片', color: 'orange' },
      body: '请输入 token 后开始测试',
      buttons: [
        {
          id: 'skip',
          label: '跳过鉴权直接测试',
          value: {
            action: 'wb_broadcast_skip',
            task_id: 'task-1',
            action_item_id: 'item-1',
          },
        },
      ],
      form: {
        name: 'wb-submit-item-1',
        inputs: [
          {
            name: 'access_token',
            type: 'text',
            placeholder: '请输入 access_token',
            required: true,
          },
        ],
        submitButton: {
          id: 'item-1-submit-access-token',
          label: '填写 access_token 并开始测试',
          type: 'primary',
          value: {
            action: 'wb_broadcast_submit_access_token',
            task_id: 'task-1',
            action_item_id: 'item-1',
          },
        },
      },
    };

    const feishuCard = (channel as any).convertToFeishuCard(card) as {
      elements: Array<Record<string, unknown>>;
    };
    const form = feishuCard.elements.find((element) => element.tag === 'form');

    expect(form).toMatchObject({
      tag: 'form',
      name: 'wb-submit-item-1',
    });
    expect(form?.elements).toEqual([
      {
        tag: 'input',
        name: 'access_token',
        label: { tag: 'plain_text', content: '请输入 access_token' },
        label_position: 'left',
        placeholder: { tag: 'plain_text', content: '请输入 access_token' },
        required: true,
      },
      {
        tag: 'button',
        name: 'item-1-submit-access-token',
        text: {
          tag: 'plain_text',
          content: '填写 access_token 并开始测试',
        },
        action_type: 'form_submit',
        type: 'primary',
        value: {
          action: 'wb_broadcast_submit_access_token',
          task_id: 'task-1',
          action_item_id: 'item-1',
        },
      },
    ]);
  });
});

describe('FeishuChannel card action callbacks', () => {
  it('forwards workbench broadcast actions without workflow_id or group_folder', async () => {
    const channel = createChannel();
    const onCardAction = vi.fn(async () => ({
      toast: { type: 'success' as const, content: 'ok' },
    }));
    channel.onCardAction = onCardAction;

    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };

    await (channel as any).handleCardActionEvent(
      {
        event: {
          operator: { user_id: 'user-1' },
          context: { open_message_id: 'msg-1' },
          action: {
            value: {
              action: 'wb_broadcast_submit_access_token',
              task_id: 'task-1',
              action_item_id: 'item-1',
            },
            form_value: {
              access_token: 'demo-token',
            },
          },
        },
      },
      res,
    );

    expect(onCardAction).toHaveBeenCalledWith({
      action: 'wb_broadcast_submit_access_token',
      user_id: 'user-1',
      message_id: 'msg-1',
      group_folder: undefined,
      workflow_id: undefined,
      form_value: {
        action: 'wb_broadcast_submit_access_token',
        task_id: 'task-1',
        action_item_id: 'item-1',
        access_token: 'demo-token',
      },
    });
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'application/json',
    });
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({
        toast: {
          type: 'success',
          content: 'ok',
        },
      }),
    );
  });

  it('infers workbench broadcast submit action from form button name when value is absent', async () => {
    const channel = createChannel();
    const onCardAction = vi.fn(async () => ({
      toast: { type: 'success' as const, content: 'ok' },
    }));
    channel.onCardAction = onCardAction;

    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };

    await (channel as any).handleCardActionEvent(
      {
        event: {
          operator: { user_id: 'user-2' },
          context: { open_message_id: 'msg-2' },
          action: {
            name: 'item-1-submit-access-token',
            form_value: {
              access_token: 'demo-token',
            },
          },
        },
      },
      res,
    );

    expect(onCardAction).toHaveBeenCalledWith({
      action: 'wb_broadcast_submit_access_token',
      user_id: 'user-2',
      message_id: 'msg-2',
      group_folder: undefined,
      workflow_id: undefined,
      form_value: {
        action: 'wb_broadcast_submit_access_token',
        action_item_id: 'item-1',
        access_token: 'demo-token',
      },
    });
  });

  it('infers ask-question broadcast reply action from compact request-based form names', async () => {
    const channel = createChannel();
    const onCardAction = vi.fn(async () => ({
      toast: { type: 'success' as const, content: 'ok' },
    }));
    channel.onCardAction = onCardAction;

    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };

    await (channel as any).handleCardActionEvent(
      {
        event: {
          operator: { user_id: 'user-3' },
          context: { open_message_id: 'msg-3' },
          action: {
            name: 'wb-reply-aq-123',
            form_value: {
              reply_text: '继续',
            },
          },
        },
      },
      res,
    );

    expect(onCardAction).toHaveBeenCalledWith({
      action: 'wb_broadcast_reply',
      user_id: 'user-3',
      message_id: 'msg-3',
      group_folder: undefined,
      workflow_id: undefined,
      form_value: {
        action: 'wb_broadcast_reply',
        request_id: 'aq-123',
        reply_text: '继续',
      },
    });
  });
});
