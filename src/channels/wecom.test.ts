import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosGetMock, axiosPostMock, attachmentsDir } = vi.hoisted(() => {
  const tmpBase = process.env.TMPDIR || '/tmp';
  return {
    axiosGetMock: vi.fn(),
    axiosPostMock: vi.fn(),
    attachmentsDir: `${tmpBase.replace(/\/$/, '')}/icarus-wecom-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
});

vi.mock('axios', () => ({
  default: {
    get: axiosGetMock,
    post: axiosPostMock,
  },
}));

vi.mock('../config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    ATTACHMENTS_DIR: attachmentsDir,
  };
});

import type {
  OnChatMetadata,
  OnInboundMessage,
  RegisteredAgent,
} from '../types.js';
import { createWorkflowPackExecutionFileScopeAuthority } from '../workflow-packs/execution-file-scope-authority.js';
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

function registeredUserAgent(name = '张三'): RegisteredAgent {
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
  agents?: Record<string, RegisteredAgent>;
  allowedUserIds?: string[];
  onMessage?: ReturnType<typeof vi.fn>;
  onChatMetadata?: ReturnType<typeof vi.fn>;
  registerAgent?: (jid: string, agent: RegisteredAgent) => void;
}): WeComChannel {
  const agents = opts?.agents || {};
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
      registeredAgents: () => agents,
      registerAgent: opts?.registerAgent,
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
  fs.mkdirSync(attachmentsDir, { recursive: true });
  axiosGetMock.mockReset();
  axiosPostMock.mockReset();
});

afterAll(() => {
  fs.rmSync(attachmentsDir, { recursive: true, force: true });
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
      'https://qyapi.weixin.qq.com/cgi-bin/message/send',
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

  it('uploads temporary media and sends a self-built app file message', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-wecom-send-'));
    const filePath = path.join(tmpDir, 'report.txt');
    fs.writeFileSync(filePath, 'hello file', 'utf-8');
    const channel = createChannel();
    axiosGetMock.mockResolvedValue({
      data: {
        errcode: 0,
        access_token: 'access-token-1',
        expires_in: 7200,
      },
    });
    axiosPostMock
      .mockResolvedValueOnce({
        data: { errcode: 0, media_id: 'media-file-1' },
      })
      .mockResolvedValueOnce({ data: { errcode: 0 } })
      .mockResolvedValueOnce({ data: { errcode: 0 } });

    await channel.sendFile('wecom:user:zhangsan', filePath, '请查收');

    expect(axiosPostMock).toHaveBeenNthCalledWith(
      1,
      'https://qyapi.weixin.qq.com/cgi-bin/media/upload',
      expect.anything(),
      expect.objectContaining({
        params: {
          access_token: 'access-token-1',
          type: 'file',
        },
        headers: expect.objectContaining({
          'content-type': expect.stringContaining('multipart/form-data'),
        }),
      }),
    );
    expect(axiosPostMock).toHaveBeenNthCalledWith(
      2,
      'https://qyapi.weixin.qq.com/cgi-bin/message/send',
      {
        touser: 'zhangsan',
        msgtype: 'file',
        agentid: 1000002,
        file: { media_id: 'media-file-1' },
      },
      {
        params: { access_token: 'access-token-1' },
      },
    );
    expect(axiosPostMock).toHaveBeenNthCalledWith(
      3,
      'https://qyapi.weixin.qq.com/cgi-bin/message/send',
      {
        touser: 'zhangsan',
        msgtype: 'text',
        agentid: 1000002,
        text: { content: '请查收' },
      },
      {
        params: { access_token: 'access-token-1' },
      },
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    const agents = {
      'wecom:user:zhangsan': registeredUserAgent('张三'),
    };
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const channel = createChannel({ agents, onMessage, onChatMetadata });
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
    );
    expect(onMessage).toHaveBeenCalledWith('wecom:user:zhangsan', {
      id: 'wecom-987654321',
      chat_jid: 'wecom:user:zhangsan',
      sender: 'zhangsan',
      sender_name: '张三',
      content: '帮我查一下今天任务状态',
      timestamp: '1700000000000',
      is_from_me: true,
      is_bot_message: false,
    });
  });

  it('downloads inbound media and exposes an attachments container path', async () => {
    const agents = {
      'wecom:user:zhangsan': registeredUserAgent('张三'),
    };
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const channel = createChannel({ agents, onMessage, onChatMetadata });
    axiosGetMock
      .mockResolvedValueOnce({
        data: {
          errcode: 0,
          access_token: 'access-token-1',
          expires_in: 7200,
        },
      })
      .mockResolvedValueOnce({
        data: Buffer.from('file bytes'),
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="需求文档.pdf"',
        },
      });
    const { body, params } = encryptedPostBody(`
      <xml>
        <ToUserName><![CDATA[ww-demo-corp]]></ToUserName>
        <FromUserName><![CDATA[zhangsan]]></FromUserName>
        <CreateTime>1700000000</CreateTime>
        <MsgType><![CDATA[file]]></MsgType>
        <MediaId><![CDATA[media-file-1]]></MediaId>
        <FileName><![CDATA[fallback.txt]]></FileName>
        <MsgId>987654322</MsgId>
        <AgentID>1000002</AgentID>
      </xml>
    `);

    const response = await (channel as any).handlePostWebhook(body, params);

    expect(response).toMatchObject({ statusCode: 200, body: 'success' });
    expect(axiosGetMock).toHaveBeenNthCalledWith(
      2,
      'https://qyapi.weixin.qq.com/cgi-bin/media/get',
      {
        params: {
          access_token: 'access-token-1',
          media_id: 'media-file-1',
        },
        responseType: 'arraybuffer',
      },
    );
    expect(onMessage).toHaveBeenCalledWith(
      'wecom:user:zhangsan',
      expect.objectContaining({
        id: 'wecom-987654322',
        chat_jid: 'wecom:user:zhangsan',
        content: expect.stringContaining('/workspace/attachments/'),
        is_from_me: true,
      }),
    );
    const delivered = onMessage.mock.calls[0][1].content as string;
    expect(delivered).toContain('[文件: 需求文档.pdf]');
    const containerPath = delivered.match(
      /\/workspace\/attachments\/[^)]+/,
    )?.[0];
    expect(containerPath).toBeTruthy();
    const storedName = path.basename(containerPath!);
    expect(
      fs.readFileSync(path.join(attachmentsDir, storedName), 'utf-8'),
    ).toBe('file bytes');
  });

  it('keeps inbound attachment writes available during an overlapping read-only Pack Run', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-wecom-pack-isolation-'),
    );
    const shadow = path.join(root, 'shadow');
    fs.mkdirSync(shadow, { recursive: true });
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'wecom-overlap-run',
      queryId: 'wecom-overlap-query',
      agentFolder: 'wecom-agent',
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
    axiosGetMock
      .mockResolvedValueOnce({
        data: {
          errcode: 0,
          access_token: 'access-token-overlap',
          expires_in: 7200,
        },
      })
      .mockResolvedValueOnce({
        data: Buffer.from('wecom-overlap-bytes'),
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="overlap.pdf"',
        },
      });

    try {
      const downloaded = await (
        channel as unknown as {
          downloadTemporaryMedia: (input: {
            mediaId: string;
            msgType: string;
            messageId: string;
            agentFolder: string;
            filename?: string;
          }) => Promise<{
            hostPath: string;
            containerPath: string;
          } | null>;
        }
      ).downloadTemporaryMedia({
        mediaId: 'overlap-media',
        msgType: 'file',
        messageId: 'overlap-message',
        agentFolder: 'wecom-agent',
      });

      expect(downloaded?.containerPath).toMatch(/^\/workspace\/attachments\//);
      expect(fs.readFileSync(downloaded!.hostPath, 'utf8')).toBe(
        'wecom-overlap-bytes',
      );
      expect(fs.readdirSync(shadow)).toEqual([]);
    } finally {
      await authority.deactivateAndDrain();
      authority.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports media download failures as inbound messages', async () => {
    const agents = {
      'wecom:user:zhangsan': registeredUserAgent('张三'),
    };
    const onMessage = vi.fn();
    const channel = createChannel({ agents, onMessage });
    axiosGetMock
      .mockResolvedValueOnce({
        data: {
          errcode: 0,
          access_token: 'access-token-1',
          expires_in: 7200,
        },
      })
      .mockResolvedValueOnce({
        data: Buffer.from(
          JSON.stringify({ errcode: 40007, errmsg: 'invalid media_id' }),
        ),
        headers: {
          'content-type': 'application/json',
        },
      });
    const { body, params } = encryptedPostBody(`
      <xml>
        <FromUserName><![CDATA[zhangsan]]></FromUserName>
        <CreateTime>1700000000</CreateTime>
        <MsgType><![CDATA[image]]></MsgType>
        <MediaId><![CDATA[bad-media]]></MediaId>
        <MsgId>987654323</MsgId>
        <AgentID>1000002</AgentID>
      </xml>
    `);

    await (channel as any).handlePostWebhook(body, params);

    expect(onMessage).toHaveBeenCalledWith(
      'wecom:user:zhangsan',
      expect.objectContaining({
        content: expect.stringContaining('(下载失败)'),
      }),
    );
  });

  it('does not trigger the agent for unregistered and unallowlisted users', async () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const channel = createChannel({ onMessage, onChatMetadata });

    await (channel as any).handleInboundXml(`
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

  it('auto-registers allowlisted users with isolated defaults', async () => {
    const agents: Record<string, RegisteredAgent> = {};
    const onMessage = vi.fn();
    const registerAgent = vi.fn((jid: string, agent: RegisteredAgent) => {
      agents[jid] = agent;
    });
    const channel = createChannel({
      agents,
      allowedUserIds: ['lisi'],
      onMessage,
      registerAgent,
    });

    await (channel as any).handleInboundXml(`
      <xml>
        <FromUserName><![CDATA[lisi]]></FromUserName>
        <CreateTime>1700000000</CreateTime>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[hello]]></Content>
        <MsgId>msg-2</MsgId>
        <AgentID>1000002</AgentID>
      </xml>
    `);

    expect(registerAgent).toHaveBeenCalledWith(
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
        is_from_me: true,
      }),
    );
  });
});
