import axios from 'axios';
import fs from 'fs';
import http from 'http';
import path from 'path';
import {
  Channel,
  NewMessage,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { GROUPS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel } from './registry.js';

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const FEISHU_API_BASE_V2 = 'https://open.feishu.cn/open-apis/v2';
const WEBHOOK_PORT = process.env.FEISHU_WEBHOOK_PORT
  ? parseInt(process.env.FEISHU_WEBHOOK_PORT, 10)
  : 3002;

interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
}

class FeishuChannel implements Channel {
  name = 'feishu';
  private config: FeishuConfig;
  private token: string | null = null;
  private tokenExpiry: number = 0;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;
  private connected = false;
  private server: http.Server | null = null;

  constructor(
    config: FeishuConfig,
    opts: {
      onMessage: OnInboundMessage;
      onChatMetadata: OnChatMetadata;
      registeredGroups: () => Record<string, RegisteredGroup>;
    },
  ) {
    this.config = config;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
  }

  async connect(): Promise<void> {
    await this.getTenantAccessToken();
    this.startWebhookServer();
    this.connected = true;
  }

  private startWebhookServer(): void {
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/webhook/feishu')) {
        // Verification challenge from Feishu - return the verification_token from URL params
        const url = new URL(req.url, `http://localhost:${WEBHOOK_PORT}`);
        const verificationToken = url.searchParams.get('verification_token');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(verificationToken || '');
        return;
      }

      if (req.method === 'POST' && req.url?.startsWith('/webhook/feishu')) {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const payload = JSON.parse(body);

            // If this is a verification challenge (type = "url_verification"), return the challenge
            if (payload.type === 'url_verification') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  challenge: payload.challenge,
                }),
              );
              return;
            }

            // Verify token if configured (v1.0: payload.verification_token, v2.0: payload.header.token)
            if (this.config.verificationToken) {
              const reqToken =
                payload.verification_token || payload.header?.token;
              if (reqToken !== this.config.verificationToken) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({ error: 'Invalid verification token' }),
                );
                return;
              }
            }
            this.handleWebhook(payload).catch((err) => {
              console.error('[feishu] handleWebhook error:', err);
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 0, msg: 'success' }));
          } catch (e) {
            console.error('[feishu] Webhook error:', e);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid payload' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    this.server.listen(WEBHOOK_PORT, '0.0.0.0', () => {
      console.log(`[feishu] Webhook server listening on port ${WEBHOOK_PORT}`);
    });
  }

  async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpiry) {
      return this.token;
    }

    const response = await axios.post(
      `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`,
      {
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      },
    );

    if (response.data.code !== 0) {
      throw new Error(
        `Failed to get tenant access token: ${response.data.msg}`,
      );
    }

    this.token = response.data.tenant_access_token;
    this.tokenExpiry = now + response.data.expire * 1000 - 60000;
    return this.token!;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    // Strip feishu: prefix if present
    const actualJid = jid.startsWith('feishu:') ? jid.slice(7) : jid;
    const receiveIdType = actualJid.startsWith('ou_') ? 'user_id' : 'chat_id';

    // Send as query param (required by Feishu API)
    const response = await axios.post(
      `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        receive_id: actualJid,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    // Feishu returns HTTP 200 even on errors — check the body code
    if (response.data?.code !== 0) {
      const errMsg = `Feishu API error: code=${response.data?.code} msg=${response.data?.msg}`;
      logger.error(
        { jid, code: response.data?.code, msg: response.data?.msg },
        errMsg,
      );
      throw new Error(errMsg);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // Check both with and without feishu: prefix
    const jidWithoutPrefix = jid.startsWith('feishu:') ? jid.slice(7) : jid;
    return (
      jidWithoutPrefix.startsWith('ou_') || jidWithoutPrefix.startsWith('oc_')
    );
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.connected = false;
  }

  // Download a file/image resource from a Feishu message and save to group attachments dir.
  // Returns the saved file path (relative to group dir, for agent access), or null on failure.
  // Uses messageId in filename to avoid duplicate downloads of the same file.
  private async downloadMessageResource(
    messageId: string,
    fileKey: string,
    fileName: string,
    type: 'file' | 'image',
    groupFolder: string,
  ): Promise<string | null> {
    try {
      const attachDir = path.join(GROUPS_DIR, groupFolder, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      // Use messageId as prefix for deduplication — same quoted message won't re-download
      const safeName = `${messageId}_${fileName.replace(/[/\\]/g, '_')}`;
      const filePath = path.join(attachDir, safeName);

      if (fs.existsSync(filePath)) {
        logger.info(
          { messageId, filePath },
          'Feishu file already downloaded, skipping',
        );
        return `attachments/${safeName}`;
      }

      const token = await this.getTenantAccessToken();
      const response = await axios.get(
        `${FEISHU_API_BASE}/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          responseType: 'arraybuffer',
        },
      );

      fs.writeFileSync(filePath, response.data);
      logger.info(
        { messageId, fileKey, filePath },
        'Downloaded Feishu file resource',
      );
      return `attachments/${safeName}`;
    } catch (err) {
      logger.warn(
        { messageId, fileKey, err },
        'Failed to download Feishu file resource',
      );
      return null;
    }
  }

  // Extract readable text from Feishu message content based on msg_type.
  // For file/image types, downloads the resource if groupFolder and messageId are provided.
  private async extractMessageText(
    msgType: string,
    content: any,
    messageId?: string,
    groupFolder?: string,
  ): Promise<string> {
    switch (msgType) {
      case 'text':
        return content.text || '';
      case 'post': {
        // Rich text (富文本): extract all text segments
        const title = content.title ? `${content.title}\n` : '';
        const body = ((content.content as any[][]) || [])
          .flat()
          .filter((seg: any) => seg.tag === 'text' || seg.tag === 'a')
          .map((seg: any) => seg.text || seg.href || '')
          .join('');
        return `${title}${body}`;
      }
      case 'file': {
        const fileName = content.file_name || '未知文件';
        if (messageId && groupFolder && content.file_key) {
          const relPath = await this.downloadMessageResource(
            messageId,
            content.file_key,
            fileName,
            'file',
            groupFolder,
          );
          if (relPath)
            return `[文件: ${fileName}] (已下载到 /workspace/group/${relPath})`;
        }
        return `[文件: ${fileName}]`;
      }
      case 'image': {
        if (messageId && groupFolder && content.image_key) {
          const relPath = await this.downloadMessageResource(
            messageId,
            content.image_key,
            `${content.image_key}.png`,
            'image',
            groupFolder,
          );
          if (relPath) return `[图片] (已下载到 /workspace/group/${relPath})`;
        }
        return '[图片]';
      }
      case 'media': {
        const mediaName = content.file_name || '媒体文件';
        if (messageId && groupFolder && content.file_key) {
          const relPath = await this.downloadMessageResource(
            messageId,
            content.file_key,
            mediaName,
            'file',
            groupFolder,
          );
          if (relPath)
            return `[视频/音频: ${mediaName}] (已下载到 /workspace/group/${relPath})`;
        }
        return `[视频/音频: ${mediaName}]`;
      }
      case 'sticker':
        return '[表情]';
      case 'audio':
        return '[语音消息]';
      case 'share_chat':
        return `[分享群聊: ${content.chat_id || ''}]`;
      case 'share_user':
        return `[分享用户: ${content.user_id || ''}]`;
      case 'system':
        return '[系统消息]';
      default:
        return `[${msgType || '未知类型'}消息]`;
    }
  }

  // Fetch a message by ID from Feishu API (used to get quoted/parent messages).
  // When groupFolder is provided, file/image resources are downloaded to the group's attachments dir.
  private async getMessageContent(
    messageId: string,
    groupFolder?: string,
  ): Promise<{ text: string; senderName: string } | null> {
    try {
      const token = await this.getTenantAccessToken();
      const response = await axios.get(
        `${FEISHU_API_BASE}/im/v1/messages/${messageId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (response.data?.code !== 0) {
        logger.warn(
          { messageId, code: response.data?.code },
          'Failed to fetch parent message',
        );
        return null;
      }
      const item = response.data?.data?.items?.[0];
      if (!item) return null;

      // Feishu API returns content in item.body.content (not item.content)
      const rawContent = item.body?.content || item.content || '{}';
      const content = JSON.parse(rawContent);
      const msgType = item.msg_type || 'text';
      const senderName = item.sender?.id || 'unknown';
      logger.info(
        { messageId, msgType, content, groupFolder },
        'Fetched parent message',
      );
      const text = await this.extractMessageText(
        msgType,
        content,
        messageId,
        groupFolder,
      );
      return { text, senderName };
    } catch (err) {
      logger.warn({ messageId, err }, 'Error fetching parent message');
      return null;
    }
  }

  // Handle inbound messages from Feishu webhook
  async handleWebhook(payload: any): Promise<void> {
    // Support both v1.0 (event.type) and v2.0 (header.event_type) formats
    const eventType = payload.event?.type || payload.header?.event_type;
    if (eventType !== 'im.message.receive_v1') {
      return;
    }
    const event = payload.event;

    const message = event.message;
    const chatJid = message.chat_id;
    const senderIds = event.sender?.sender_id || {};
    const senderId = senderIds.user_id || senderIds.open_id || '';
    const content = JSON.parse(message.content || '{}');

    // Check if it's the main group (no trigger required)
    const groups = this.registeredGroups();
    const groupKey = `feishu:${chatJid}`;
    const group = groups[groupKey];
    const isMainGroup = group?.isMain === true;

    if (!isMainGroup) {
      // Check for trigger pattern
      const triggerPattern = /^@[^ ]+/;
      if (!triggerPattern.test(content.text || '')) {
        return;
      }
    }

    const messageId = message.message_id || `feishu_${Date.now()}`;
    const fullJid = `feishu:${chatJid}`;

    // If this is a reply, fetch the quoted/parent message content.
    // Append (not prepend) quoted text so @trigger at the start of content is preserved.
    let messageContent = content.text || '';
    const parentId = message.parent_id || message.upper_message_id;
    if (parentId) {
      const parentMsg = await this.getMessageContent(parentId, group?.folder);
      if (parentMsg?.text) {
        messageContent = `${messageContent}\n[引用消息: ${parentMsg.text}]`;
      }
    }

    // Create chat metadata first (required for foreign key)
    this.onChatMetadata(fullJid, message.create_time);

    const envCfg = readEnvFile(['FEISHU_ADMIN_USER_ID']);
    const adminUserId =
      process.env.FEISHU_ADMIN_USER_ID || envCfg.FEISHU_ADMIN_USER_ID;
    this.onMessage(fullJid, {
      id: messageId,
      chat_jid: fullJid,
      sender: senderId || 'unknown',
      sender_name: senderId || 'unknown',
      content: messageContent,
      timestamp: message.create_time,
      is_from_me: !!(adminUserId && senderId === adminUserId),
    });
  }
}

export function createFeishuChannel(
  config: FeishuConfig,
  opts: {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
  },
): Channel | null {
  if (!config.appId || !config.appSecret) {
    return null;
  }
  return new FeishuChannel(config, opts);
}

// Self-registration
registerChannel('feishu', (opts) => {
  const env = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_VERIFICATION_TOKEN',
    'FEISHU_ENCRYPT_KEY',
  ]);
  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;
  const verificationToken = env.FEISHU_VERIFICATION_TOKEN;
  const encryptKey = env.FEISHU_ENCRYPT_KEY;

  if (!appId || !appSecret) {
    return null;
  }

  return createFeishuChannel(
    { appId, appSecret, verificationToken, encryptKey },
    opts,
  );
});
