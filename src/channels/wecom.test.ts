import { beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosGetMock, axiosPostMock } = vi.hoisted(() => ({
  axiosGetMock: vi.fn(),
  axiosPostMock: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    get: axiosGetMock,
    post: axiosPostMock,
  },
}));

import type {
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import {
  WeComChannel,
  buildWeComSignature,
  encryptWeComPayload,
  verifyWeComSignature,
} from './wecom.js';

const ENCODING_AES_KEY = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index + 1),
)
  .toString('base64')
  .slice(0, 43);

const BASE_CONFIG = {
  corpId: 'ww-demo-corp',
  agentId: '1000002',
  appSecret: 'app-secret',
  token: 'callback-token',
  encodingAesKey: ENCODING_AES_KEY,
};

function registeredUserGroup(name = '张三'): RegisteredGroup {
  return {
    name,
    folder: 'wecom_user_zhangsan',
    trigger: '',
    added_at: '2026-01-01T00:00:00.000Z',
    requiresTrigger: false,
    isMain: false,
    description: `企业微信自建应用一对一会话：${name}`,
  };
}

function createChannel(opts?: {
  groups?: Record<string, RegisteredGroup>;
  allowedUserIds?: string[];
  onMessage?: ReturnType<typeof vi.fn>;
  onChatMetadata?: ReturnType<typeof vi.fn>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}): WeComChannel {
  const groups = opts?.groups || {};
  const onMessage = (opts?.onMessage || vi.fn()) as unknown as OnInboundMessage;
  const onChatMetadata = (opts?.onChatMetadata ||
    vi.fn()) as unknown as OnChatMetadata;
  return new WeComChannel(
    {
      ...BASE_CONFIG,
      allowedUserIds: opts?.allowedUserIds,
    },
    {
      onMessage,
      onChatMetadata,
      registeredGroups: () => groups,
      registerGroup: opts?.registerGroup,
    },
  );
}

function encryptedPostBody(xml: string): {
  body: string;
  params: URLSearchParams;
} {
  const encrypted = encryptWeComPayload(
    xml,
    ENCODING_AES_KEY,
    BASE_CONFIG.corpId,
    Buffer.alloc(16, 1),
  );
  const timestamp = '1700000000';
  const nonce = 'nonce-1';
  const signature = buildWeComSignature(
    BASE_CONFIG.token,
    timestamp,
    nonce,
    encrypted,
  );
  return {
    body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
    params: new URLSearchParams({
      msg_signature: signature,
      timestamp,
      nonce,
    }),
  };
}

beforeEach(() => {
  axiosGetMock.mockReset();
  axiosPostMock.mockReset();
});

describe('WeComChannel', () => {
  it('owns only wecom user JIDs', () => {
    const channel = createChannel();

    expect(channel.ownsJid('wecom:user:zhangsan')).toBe(true);
    expect(channel.ownsJid('wecom:group:dev')).toBe(false);
    expect(channel.ownsJid('feishu:chat')).toBe(false);
  });

  it('parses user JID and sends a self-built app text message', async () => {
    const channel = createChannel();
    axiosGetMock.mockResolvedValueOnce({
      data: {
        errcode: 0,
        access_token: 'access-token-1',
        expires_in: 7200,
      },
    });
    axiosPostMock.mockResolvedValueOnce({ data: { errcode: 0 } });

    await channel.sendMessage('wecom:user:zhangsan', '你好');

    expect(axiosGetMock).toHaveBeenCalledWith(
      'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
      {
        params: {
          corpid: 'ww-demo-corp',
          corpsecret: 'app-secret',
        },
      },
    );
    expect(axiosPostMock).toHaveBeenCalledWith(
      'http://callback.chelaile.net.cn/cgi-bin/message/send',
      {
        touser: 'zhangsan',
        msgtype: 'text',
        agentid: 1000002,
        text: { content: '你好' },
      },
      {
        params: { access_token: 'access-token-1' },
      },
    );
  });

  it('caches access tokens until expiry', async () => {
    const channel = createChannel();
    axiosGetMock.mockResolvedValue({
      data: {
        errcode: 0,
        access_token: 'cached-token',
        expires_in: 7200,
      },
    });

    await expect(channel.getAccessToken()).resolves.toBe('cached-token');
    await expect(channel.getAccessToken()).resolves.toBe('cached-token');

    expect(axiosGetMock).toHaveBeenCalledTimes(1);
  });

  it('rejects webhook callbacks with invalid signatures', async () => {
    const channel = createChannel();
    const xml =
      '<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello]]></Content></xml>';
    const encrypted = encryptWeComPayload(
      xml,
      ENCODING_AES_KEY,
      BASE_CONFIG.corpId,
      Buffer.alloc(16, 1),
    );

    expect(
      verifyWeComSignature(
        BASE_CONFIG.token,
        'bad-signature',
        '1700000000',
        'nonce-1',
        encrypted,
      ),
    ).toBe(false);

    const response = await (channel as any).handlePostWebhook(
      `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
      new URLSearchParams({
        msg_signature: 'bad-signature',
        timestamp: '1700000000',
        nonce: 'nonce-1',
      }),
    );

    expect(response.statusCode).toBe(401);
  });

  it('converts encrypted inbound text messages to NewMessage', async () => {
    const groups = {
      'wecom:user:zhangsan': registeredUserGroup('张三'),
    };
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const channel = createChannel({ groups, onMessage, onChatMetadata });
    const { body, params } = encryptedPostBody(`
      <xml>
        <ToUserName><![CDATA[ww-demo-corp]]></ToUserName>
        <FromUserName><![CDATA[zhangsan]]></FromUserName>
        <CreateTime>1700000000</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[帮我查一下今天任务状态]]></Content>
        <MsgId>987654321</MsgId>
        <AgentID>1000002</AgentID>
      </xml>
    `);

    const response = await (channel as any).handlePostWebhook(body, params);

    expect(response).toMatchObject({ statusCode: 200, body: 'success' });
    expect(onChatMetadata).toHaveBeenCalledWith(
      'wecom:user:zhangsan',
      '1700000000000',
      '张三',
      'wecom',
      false,
    );
    expect(onMessage).toHaveBeenCalledWith('wecom:user:zhangsan', {
      id: 'wecom-987654321',
      chat_jid: 'wecom:user:zhangsan',
      sender: 'zhangsan',
      sender_name: '张三',
      content: '帮我查一下今天任务状态',
      timestamp: '1700000000000',
      is_from_me: false,
      is_bot_message: false,
    });
  });

  it('does not trigger the agent for unregistered and unallowlisted users', () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const channel = createChannel({ onMessage, onChatMetadata });

    (channel as any).handleInboundXml(`
      <xml>
        <FromUserName><![CDATA[unknown-user]]></FromUserName>
        <CreateTime>1700000000</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[hello]]></Content>
        <MsgId>msg-1</MsgId>
        <AgentID>1000002</AgentID>
      </xml>
    `);

    expect(onChatMetadata).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('auto-registers allowlisted users with isolated defaults', () => {
    const groups: Record<string, RegisteredGroup> = {};
    const onMessage = vi.fn();
    const registerGroup = vi.fn((jid: string, group: RegisteredGroup) => {
      groups[jid] = group;
    });
    const channel = createChannel({
      groups,
      allowedUserIds: ['lisi'],
      onMessage,
      registerGroup,
    });

    (channel as any).handleInboundXml(`
      <xml>
        <FromUserName><![CDATA[lisi]]></FromUserName>
        <CreateTime>1700000000</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[hello]]></Content>
        <MsgId>msg-2</MsgId>
        <AgentID>1000002</AgentID>
      </xml>
    `);

    expect(registerGroup).toHaveBeenCalledWith(
      'wecom:user:lisi',
      expect.objectContaining({
        name: 'lisi',
        folder: 'wecom_user_lisi',
        trigger: '',
        requiresTrigger: false,
        isMain: false,
      }),
    );
    expect(onMessage).toHaveBeenCalledWith(
      'wecom:user:lisi',
      expect.objectContaining({
        chat_jid: 'wecom:user:lisi',
        sender: 'lisi',
        content: 'hello',
      }),
    );
  });
});
