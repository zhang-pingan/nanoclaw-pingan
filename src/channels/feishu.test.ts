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
            action: 'wb_broadcast_submit',
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
          action: 'wb_broadcast_submit',
          task_id: 'task-1',
          action_item_id: 'item-1',
        },
      },
    ]);
  });

  it('maps common human input fields and disables unsupported file forms', () => {
    const channel = createChannel();
    const card: InteractiveCard = {
      header: { title: '多字段表单', color: 'blue' },
      form: {
        name: 'multi-form',
        inputs: [
          {
            name: 'mode',
            type: 'enum',
            placeholder: '模式',
            options: [{ value: 'fast', label: '快速' }],
          },
          { name: 'enabled', type: 'boolean', placeholder: '启用' },
          { name: 'when', type: 'text', format: 'date', placeholder: '日期' },
          {
            name: 'secret',
            type: 'token',
            placeholder: 'Token',
            max_length: 32,
          },
          { name: 'attachment', type: 'file', placeholder: '附件' },
        ],
        submitButton: {
          id: 'submit',
          label: '提交',
          value: { action: 'wb_broadcast_resume' },
        },
      },
    };

    const feishuCard = (channel as any).convertToFeishuCard(card) as {
      elements: Array<Record<string, any>>;
    };
    const form = feishuCard.elements.find((element) => element.tag === 'form');

    expect(form?.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: 'select_static',
          name: 'mode',
          options: [
            {
              text: { tag: 'plain_text', content: '快速' },
              value: 'fast',
            },
          ],
        }),
        expect.objectContaining({
          tag: 'select_static',
          name: 'enabled',
          options: expect.arrayContaining([
            expect.objectContaining({ value: 'true' }),
            expect.objectContaining({ value: 'false' }),
          ]),
        }),
        expect.objectContaining({
          tag: 'date_picker',
          name: 'when',
        }),
        expect.objectContaining({
          tag: 'input',
          name: 'secret',
          input_type: 'password',
          max_length: 32,
        }),
        expect.objectContaining({
          tag: 'note',
        }),
        expect.objectContaining({
          tag: 'button',
          name: 'submit',
          disabled: true,
        }),
      ]),
    );
    expect(
      (form?.elements || []).some(
        (element: Record<string, unknown>) => element.name === 'attachment',
      ),
    ).toBe(false);
  });

  it('disables actions when the card does not allow Feishu channel', () => {
    const channel = createChannel();
    const card: InteractiveCard = {
      header: { title: '仅 Web', color: 'blue' },
      body: '只能在 Web 处理',
      allowed_channels: ['web'],
      buttons: [
        {
          id: 'approve',
          label: '确认',
          value: { action: 'wb_broadcast_confirm' },
        },
      ],
    };

    const feishuCard = (channel as any).convertToFeishuCard(card) as {
      elements: Array<Record<string, any>>;
    };
    const action = feishuCard.elements.find(
      (element) => element.tag === 'action',
    );

    expect(feishuCard.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: 'note',
          elements: [
            expect.objectContaining({
              content: '该操作不支持飞书渠道，可用渠道：web',
            }),
          ],
        }),
      ]),
    );
    expect(action?.actions?.[0]).toMatchObject({
      tag: 'button',
      disabled: true,
    });
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
          context: { open_message_id: 'msg-1', open_chat_id: 'oc_demo' },
          action: {
            value: {
              action: 'wb_broadcast_submit',
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
      action: 'wb_broadcast_submit',
      user_id: 'user-1',
      message_id: 'msg-1',
      actor_channel: 'feishu',
      group_jid: 'feishu:oc_demo',
      group_folder: undefined,
      workflow_id: undefined,
      form_value: {
        action: 'wb_broadcast_submit',
        task_id: 'task-1',
        action_item_id: 'item-1',
        access_token: 'demo-token',
        payload: JSON.stringify({ access_token: 'demo-token' }),
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
      action: 'wb_broadcast_submit',
      user_id: 'user-2',
      message_id: 'msg-2',
      actor_channel: 'feishu',
      group_jid: undefined,
      group_folder: undefined,
      workflow_id: undefined,
      form_value: {
        action: 'wb_broadcast_submit',
        action_item_id: 'item-1',
        access_token: 'demo-token',
        payload: JSON.stringify({ access_token: 'demo-token' }),
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
      actor_channel: 'feishu',
      group_jid: undefined,
      group_folder: undefined,
      workflow_id: undefined,
      form_value: {
        action: 'wb_broadcast_reply',
        request_id: 'aq-123',
        reply_text: '继续',
        payload: JSON.stringify({ reply_text: '继续' }),
      },
    });
  });

  it('infers workflow broadcast submit action from compact task-based form names', async () => {
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
          operator: { user_id: 'user-4' },
          context: { open_message_id: 'msg-4' },
          action: {
            name: 'wb-su-task-1',
            form_value: {
              access_token: 'demo-token',
            },
          },
        },
      },
      res,
    );

    expect(onCardAction).toHaveBeenCalledWith({
      action: 'wb_broadcast_submit',
      user_id: 'user-4',
      message_id: 'msg-4',
      actor_channel: 'feishu',
      group_jid: undefined,
      group_folder: undefined,
      workflow_id: undefined,
      form_value: {
        action: 'wb_broadcast_submit',
        task_id: 'task-1',
        access_token: 'demo-token',
        payload: JSON.stringify({ access_token: 'demo-token' }),
      },
    });
  });
});
