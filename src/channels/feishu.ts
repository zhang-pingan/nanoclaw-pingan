import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import http from 'http';
import path from 'path';
import {
  CardActionHandler,
  Channel,
  FeishuCard,
  InteractiveCard,
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
const feishuEnv = readEnvFile(['FEISHU_WEBHOOK_PORT']);
const webhookPortRaw =
  process.env.FEISHU_WEBHOOK_PORT || feishuEnv.FEISHU_WEBHOOK_PORT || '3002';
const parsedWebhookPort = Number.parseInt(webhookPortRaw, 10);
const WEBHOOK_PORT = Number.isFinite(parsedWebhookPort)
  ? parsedWebhookPort
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
  onCardAction: CardActionHandler | null = null;

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
            const eventType = payload.event?.type || payload.header?.event_type;
            logger.debug(
              {
                eventType,
                hasEncrypt: !!payload.encrypt,
                hasHeader: !!payload.header,
              },
              'Feishu webhook received',
            );

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
                logger.warn(
                  {
                    eventType,
                    chatId: payload.event?.message?.chat_id,
                  },
                  'Feishu webhook rejected: invalid verification token',
                );
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({ error: 'Invalid verification token' }),
                );
                return;
              }
            }
            // Card action callbacks need synchronous response with updated card
            if (eventType === 'card.action.trigger') {
              this.handleCardActionEvent(payload, res);
              return;
            }

            this.handleWebhook(payload).catch((err) => {
              console.error('[feishu] handleWebhook error:', err);
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 0, msg: 'success' }));
          } catch (e) {
            logger.error(
              {
                error: e,
                bodyPreview: body.slice(0, 500),
              },
              '[feishu] Webhook error',
            );
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

  /** Convert a channel-agnostic InteractiveCard to Feishu's native card format. */
  private convertToFeishuCard(card: InteractiveCard): FeishuCard {
    const elements: unknown[] = [];

    // Body text
    if (card.body) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: card.body },
      });
    }

    // Top-level buttons
    if (card.buttons && card.buttons.length > 0) {
      const actions: unknown[] = card.buttons.map((btn) => {
        const button: Record<string, unknown> = {
          tag: 'button',
          text: { tag: 'plain_text', content: btn.label },
          value: btn.value,
        };
        if (btn.type && btn.type !== 'default') button.type = btn.type;
        return button;
      });
      elements.push({ tag: 'action', actions });
    }

    // Form (revision form)
    if (card.form) {
      elements.push({ tag: 'hr' });
      const formElements: unknown[] = [];
      for (const input of card.form.inputs) {
        formElements.push({
          tag: 'input',
          name: input.name,
          placeholder: { tag: 'plain_text', content: input.placeholder || '' },
        });
      }
      formElements.push({
        tag: 'button',
        name: card.form.submitButton.id,
        text: { tag: 'plain_text', content: card.form.submitButton.label },
        value: card.form.submitButton.value,
      });
      elements.push({
        tag: 'form',
        name: card.form.name,
        elements: formElements,
      });
    }

    // Sections (workflow list items)
    if (card.sections) {
      for (let i = 0; i < card.sections.length; i++) {
        const section = card.sections[i];
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: section.body },
        });
        if (section.buttons && section.buttons.length > 0) {
          const actions: unknown[] = section.buttons.map((btn) => {
            const button: Record<string, unknown> = {
              tag: 'button',
              text: { tag: 'plain_text', content: btn.label },
              value: btn.value,
            };
            if (btn.type && btn.type !== 'default') button.type = btn.type;
            return button;
          });
          elements.push({ tag: 'action', actions });
        }
        // Add hr between sections (not after last)
        if (i < card.sections.length - 1) {
          elements.push({ tag: 'hr' });
        }
      }
    }

    return {
      header: {
        title: card.header.title,
        template: card.header.color || 'blue',
      },
      elements,
    };
  }

  async sendCard(jid: string, card: InteractiveCard): Promise<string | undefined> {
    const feishuCard = this.convertToFeishuCard(card);
    const token = await this.getTenantAccessToken();
    const actualJid = jid.startsWith('feishu:') ? jid.slice(7) : jid;
    const receiveIdType = actualJid.startsWith('ou_') ? 'user_id' : 'chat_id';

    const cardContent = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: feishuCard.header.title },
        template: feishuCard.header.template || 'blue',
      },
      elements: feishuCard.elements,
    };

    const response = await axios.post(
      `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        receive_id: actualJid,
        msg_type: 'interactive',
        content: JSON.stringify(cardContent),
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (response.data?.code !== 0) {
      const errMsg = `Feishu card API error: code=${response.data?.code} msg=${response.data?.msg}`;
      logger.error(
        { jid, code: response.data?.code, msg: response.data?.msg },
        errMsg,
      );
      throw new Error(errMsg);
    }

    return response.data?.data?.message_id;
  }

  private static readonly FILE_TYPE_MAP: Record<string, string> = {
    pdf: 'pdf', doc: 'doc', docx: 'doc',
    xls: 'xls', xlsx: 'xls',
    ppt: 'ppt', pptx: 'ppt',
    mp4: 'mp4', opus: 'opus', ogg: 'opus',
  };

  private static readonly IMAGE_EXTS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'webp', 'ico',
  ]);

  private async uploadImage(filePath: string): Promise<string> {
    const token = await this.getTenantAccessToken();
    const form = new FormData();
    form.append('image_type', 'message');
    form.append('image', fs.createReadStream(filePath));

    const response = await axios.post(
      `${FEISHU_API_BASE}/im/v1/images`,
      form,
      { headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() } },
    );

    if (response.data?.code !== 0) {
      throw new Error(
        `Feishu uploadImage error: code=${response.data?.code} msg=${response.data?.msg}`,
      );
    }
    return response.data.data.image_key;
  }

  private async uploadFile(filePath: string, fileType: string): Promise<string> {
    const token = await this.getTenantAccessToken();
    const form = new FormData();
    form.append('file_type', fileType);
    form.append('file_name', path.basename(filePath));
    form.append('file', fs.createReadStream(filePath));

    const response = await axios.post(
      `${FEISHU_API_BASE}/im/v1/files`,
      form,
      { headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() } },
    );

    if (response.data?.code !== 0) {
      throw new Error(
        `Feishu uploadFile error: code=${response.data?.code} msg=${response.data?.msg}`,
      );
    }
    return response.data.data.file_key;
  }

  async sendFile(jid: string, filePath: string, caption?: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const actualJid = jid.startsWith('feishu:') ? jid.slice(7) : jid;
    const receiveIdType = actualJid.startsWith('ou_') ? 'user_id' : 'chat_id';

    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const isImage = FeishuChannel.IMAGE_EXTS.has(ext);

    if (isImage) {
      const imageKey = await this.uploadImage(filePath);
      const response = await axios.post(
        `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
        {
          receive_id: actualJid,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (response.data?.code !== 0) {
        throw new Error(
          `Feishu send image error: code=${response.data?.code} msg=${response.data?.msg}`,
        );
      }
    } else {
      const fileType = FeishuChannel.FILE_TYPE_MAP[ext] || 'stream';
      const fileKey = await this.uploadFile(filePath, fileType);
      const response = await axios.post(
        `${FEISHU_API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`,
        {
          receive_id: actualJid,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (response.data?.code !== 0) {
        throw new Error(
          `Feishu send file error: code=${response.data?.code} msg=${response.data?.msg}`,
        );
      }
    }

    if (caption) {
      await this.sendMessage(jid, caption);
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

  // Handle card action callback from Feishu
  private handleCardActionEvent(payload: any, res: http.ServerResponse): void {
    const action = payload.event?.action;
    const value = action?.value as
      | { workflow_id?: string; action?: string; group_folder?: string }
      | undefined;
    const userId = payload.event?.operator?.user_id || '';
    const messageId = payload.event?.context?.open_message_id || '';

    const formValue = action?.form_value as Record<string, string> | undefined;

    if ((value?.workflow_id || value?.group_folder) && value?.action && this.onCardAction) {
      const mergedFormValue = {
        ...(value || {}),
        ...(formValue || {}),
      };
      this.onCardAction({
        action: value.action,
        user_id: userId,
        message_id: messageId,
        group_folder: value.group_folder,
        workflow_id: value.workflow_id,
        form_value: mergedFormValue,
      });
    }

    // Return empty JSON to acknowledge (card update handled separately)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({}));
  }

  // Handle inbound messages from Feishu webhook
  async handleWebhook(payload: any): Promise<void> {
    // Support both v1.0 (event.type) and v2.0 (header.event_type) formats
    const eventType = payload.event?.type || payload.header?.event_type;
    if (eventType !== 'im.message.receive_v1') {
      logger.debug({ eventType }, 'Feishu webhook ignored: unsupported event');
      return;
    }
    const event = payload.event;

    const message = event.message;
    const chatJid = message.chat_id;
    const senderIds = event.sender?.sender_id || {};
    const senderId = senderIds.user_id || senderIds.open_id || '';
    let content: Record<string, any> = {};
    try {
      content = JSON.parse(message.content || '{}');
    } catch (err) {
      logger.warn(
        {
          chatJid,
          messageId: message.message_id,
          error: err,
          contentPreview: String(message.content || '').slice(0, 200),
        },
        'Feishu webhook message content parse failed',
      );
    }

    // Check if it's the main group (no trigger required)
    const groups = this.registeredGroups();
    const groupKey = `feishu:${chatJid}`;
    const group = groups[groupKey];
    const isMainGroup = group?.isMain === true;
    logger.info(
      {
        chatJid,
        messageId: message.message_id,
        msgType: message.message_type,
        senderId,
        isMainGroup,
      },
      'Feishu inbound message received',
    );

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
    const chatName = group?.name || fullJid;
    this.onChatMetadata(fullJid, message.create_time, chatName, 'feishu', true);

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
): FeishuChannel | null {
  if (!config.appId || !config.appSecret) {
    return null;
  }
  return new FeishuChannel(config, opts);
}

export { FeishuChannel };

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
