import axios from 'axios';
import http from 'http';
import {
  Channel,
  NewMessage,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
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

            // Verify token if configured
            if (this.config.verificationToken) {
              const reqToken = payload.verification_token;
              if (reqToken !== this.config.verificationToken) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({ error: 'Invalid verification token' }),
                );
                return;
              }
            }
            this.handleWebhook(payload);
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
    await axios.post(
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

  // Handle inbound messages from Feishu webhook
  handleWebhook(payload: any): void {
    const event = payload.event;
    if (!event || event.type !== 'im.message.receive_v1') {
      return;
    }

    const message = event.message;
    const chatJid = message.chat_id;
    const senderId = message.sender_id?.user_id;
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

    // Create chat metadata first (required for foreign key)
    this.onChatMetadata(fullJid, message.create_time);

    this.onMessage(fullJid, {
      id: messageId,
      chat_jid: fullJid,
      sender: senderId || 'unknown',
      sender_name: senderId || 'unknown',
      content: (content.text || '').replace(/^@[^ ]+\s*/, ''),
      timestamp: message.create_time,
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
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN;
  const encryptKey = process.env.FEISHU_ENCRYPT_KEY;

  if (!appId || !appSecret) {
    return null;
  }

  return createFeishuChannel(
    { appId, appSecret, verificationToken, encryptKey },
    opts,
  );
});
