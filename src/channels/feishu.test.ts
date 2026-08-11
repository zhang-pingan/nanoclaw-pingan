import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { attachmentsDir, axiosGetMock } = vi.hoisted(() => ({
  attachmentsDir: `${(process.env.TMPDIR || '/tmp').replace(/\/$/, '')}/icarus-feishu-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  axiosGetMock: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    get: axiosGetMock,
    post: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({ ATTACHMENTS_DIR: attachmentsDir }));

import { FeishuChannel } from './feishu.js';
import type { InteractiveCard } from '../types.js';
import { createWorkflowPackExecutionFileScopeAuthority } from '../workflow-packs/execution-file-scope-authority.js';

afterEach(() => {
  axiosGetMock.mockReset();
  fs.rmSync(attachmentsDir, { recursive: true, force: true });
});

function createChannel(): FeishuChannel {
  return new FeishuChannel(
    {
      appId: 'app-id',
      appSecret: 'app-secret',
    },
    {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredAgents: () => ({}),
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
            action: 'ask_question_skip',
            request_id: 'request-1',
            agent_folder: 'main',
          },
        },
      ],
      form: {
        name: 'ask-question-request-1',
        inputs: [
          {
            name: 'access_token',
            type: 'text',
            placeholder: '请输入 access_token',
            required: true,
          },
        ],
        submitButton: {
          id: 'ask-question-submit',
          label: '填写 access_token 并开始测试',
          type: 'primary',
          value: {
            action: 'ask_question_answer',
            request_id: 'request-1',
            agent_folder: 'main',
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
      name: 'ask-question-request-1',
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
        name: 'ask-question-submit',
        text: {
          tag: 'plain_text',
          content: '填写 access_token 并开始测试',
        },
        action_type: 'form_submit',
        type: 'primary',
        value: {
          action: 'ask_question_answer',
          request_id: 'request-1',
          agent_folder: 'main',
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
          {
            name: 'features',
            type: 'multi_select',
            placeholder: '特性',
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' },
            ],
          },
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
          value: { action: 'ask_question_answer' },
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
          tag: 'multi_select_static',
          name: 'features',
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
          value: {
            action: 'assistant_inbox_broadcast_execute',
            item_id: 'agent-inbox-1',
          },
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

describe('Feishu attachment writes during a read-only Pack Run', () => {
  it('keeps the channel write available while an overlapping authority is active', async () => {
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-feishu-pack-isolation-'),
    );
    const shadow = path.join(root, 'shadow');
    fs.mkdirSync(shadow, { recursive: true });
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'feishu-overlap-run',
      queryId: 'feishu-overlap-query',
      agentFolder: 'feishu-agent',
      isMain: false,
      hostActions: [],
      mappings: [
        {
          scope: 'attachments',
          sourcePath: attachmentsDir,
          shadowHostPath: shadow,
        },
      ],
    });
    authority.register();
    const channel = createChannel();
    Object.assign(channel as unknown as Record<string, unknown>, {
      token: 'cached-token',
      tokenExpiry: Date.now() + 60_000,
    });
    axiosGetMock.mockResolvedValue({ data: Buffer.from('feishu-bytes') });

    try {
      const containerPath = await (
        channel as unknown as {
          downloadMessageResource: (
            messageId: string,
            fileKey: string,
            fileName: string,
            type: 'file' | 'image',
            agentFolder: string,
          ) => Promise<string | null>;
        }
      ).downloadMessageResource(
        'message-1',
        'file-key-1',
        'brief.pdf',
        'file',
        'feishu-agent',
      );

      expect(containerPath).toMatch(/^\/workspace\/attachments\//);
      expect(
        fs.readFileSync(
          path.join(attachmentsDir, path.basename(containerPath!)),
          'utf8',
        ),
      ).toBe('feishu-bytes');
      expect(fs.readdirSync(shadow)).toEqual([]);
    } finally {
      await authority.deactivateAndDrain();
      authority.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('FeishuChannel card action callbacks', () => {
  it('forwards typed Ask User Question actions and form values', async () => {
    const channel = createChannel();
    const onCardAction = vi.fn(async () => ({
      toast: { type: 'success' as const, content: 'ok' },
    }));
    channel.onCardAction = onCardAction;
    const res = { writeHead: vi.fn(), end: vi.fn() };

    await (channel as any).handleCardActionEvent(
      {
        event: {
          operator: { user_id: 'user-1' },
          context: { open_message_id: 'msg-1', open_chat_id: 'oc_demo' },
          action: {
            value: {
              action: 'ask_question_answer',
              request_id: 'request-1',
              agent_folder: 'main',
            },
            form_value: { answer: '继续' },
          },
        },
      },
      res,
    );

    expect(onCardAction).toHaveBeenCalledWith({
      action: 'ask_question_answer',
      user_id: 'user-1',
      message_id: 'msg-1',
      actor_channel: 'feishu',
      agent_jid: 'feishu:oc_demo',
      agent_folder: 'main',
      form_value: {
        action: 'ask_question_answer',
        request_id: 'request-1',
        agent_folder: 'main',
        answer: '继续',
        payload: JSON.stringify({ answer: '继续' }),
      },
    });
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'application/json',
    });
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({ toast: { type: 'success', content: 'ok' } }),
    );
  });

  it('forwards typed Assistant inbox actions', async () => {
    const channel = createChannel();
    const onCardAction = vi.fn(async () => ({
      toast: { type: 'success' as const, content: 'adopted' },
    }));
    channel.onCardAction = onCardAction;
    const res = { writeHead: vi.fn(), end: vi.fn() };

    await (channel as any).handleCardActionEvent(
      {
        event: {
          operator: { user_id: 'user-2' },
          context: { open_message_id: 'msg-2' },
          action: {
            value: {
              action: 'assistant_inbox_broadcast_dismiss',
              item_id: 'agent-inbox-1',
            },
          },
        },
      },
      res,
    );

    expect(onCardAction).toHaveBeenCalledWith({
      action: 'assistant_inbox_broadcast_dismiss',
      user_id: 'user-2',
      message_id: 'msg-2',
      actor_channel: 'feishu',
      agent_jid: undefined,
      agent_folder: undefined,
      form_value: {
        action: 'assistant_inbox_broadcast_dismiss',
        item_id: 'agent-inbox-1',
      },
    });
  });
});
