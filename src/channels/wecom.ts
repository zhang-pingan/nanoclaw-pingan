import axios from 'axios';
import crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

import type {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, type ChannelOpts } from './registry.js';
import { registerWebhookRoute } from './webhook-ingress.js';

const WECOM_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
const WECOM_MESSAGE_SEND_URL = `${WECOM_API_BASE}/message/send`;
const WECOM_USER_JID_PREFIX = 'wecom:user:';
const PKCS7_BLOCK_SIZE = 32;

export interface WeComConfig {
  corpId: string;
  agentId: string;
  appSecret: string;
  token: string;
  encodingAesKey: string;
  allowedUserIds?: string[];
}

interface WebhookResponse {
  statusCode: number;
  contentType: string;
  body: string;
}

interface DecryptedWeComPayload {
  xml: string;
  receiveId: string;
}

function parseCsvList(value?: string): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toAgentId(value: string): string | number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && String(parsed) === value ? parsed : value;
}

function wecomUserJid(userid: string): string {
  return `${WECOM_USER_JID_PREFIX}${userid}`;
}

export function wecomUserFolder(userid: string): string {
  const prefix = 'wecom_user_';
  const maxUserPartLength = 64 - prefix.length;
  let safe = userid
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!safe) {
    safe = crypto
      .createHash('sha256')
      .update(userid)
      .digest('hex')
      .slice(0, 12);
  }
  return `${prefix}${safe.slice(0, maxUserPartLength)}`;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseWeComXml(xml: string): Record<string, string> {
  const trimmed = xml.trim();
  const inner = trimmed.replace(/^<xml>\s*/i, '').replace(/\s*<\/xml>$/i, '');
  const fields: Record<string, string> = {};
  const tagPattern =
    /<([A-Za-z0-9_:-]+)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/\1>/g;
  for (const match of inner.matchAll(tagPattern)) {
    const rawValue = match[2] ?? match[3] ?? '';
    fields[match[1]] =
      match[2] === undefined ? decodeXmlEntities(rawValue) : rawValue;
  }
  return fields;
}

export function buildWeComSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
): string {
  return crypto
    .createHash('sha1')
    .update([token, timestamp, nonce, encrypted].sort().join(''))
    .digest('hex');
}

export function verifyWeComSignature(
  token: string,
  signature: string | null | undefined,
  timestamp: string | null | undefined,
  nonce: string | null | undefined,
  encrypted: string | null | undefined,
): boolean {
  if (!signature || !timestamp || !nonce || !encrypted) return false;
  const expected = buildWeComSignature(token, timestamp, nonce, encrypted);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature.toLowerCase());
  return (
    expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function decodeEncodingAesKey(encodingAesKey: string): Buffer {
  const key = Buffer.from(`${encodingAesKey}=`, 'base64');
  if (key.length !== 32) {
    throw new Error('Invalid WECOM_APP_ENCODING_AES_KEY');
  }
  return key;
}

function stripPkcs7Padding(buffer: Buffer): Buffer {
  if (buffer.length === 0) throw new Error('Empty decrypted WeCom payload');
  const padding = buffer[buffer.length - 1];
  if (padding < 1 || padding > PKCS7_BLOCK_SIZE) {
    throw new Error('Invalid WeCom payload padding');
  }
  return buffer.subarray(0, buffer.length - padding);
}

function addPkcs7Padding(buffer: Buffer): Buffer {
  const remainder = buffer.length % PKCS7_BLOCK_SIZE;
  const padding =
    remainder === 0 ? PKCS7_BLOCK_SIZE : PKCS7_BLOCK_SIZE - remainder;
  return Buffer.concat([buffer, Buffer.alloc(padding, padding)]);
}

export function decryptWeComPayload(
  encrypted: string,
  encodingAesKey: string,
  expectedReceiveId: string,
): DecryptedWeComPayload {
  const aesKey = decodeEncodingAesKey(encodingAesKey);
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    aesKey,
    aesKey.subarray(0, 16),
  );
  decipher.setAutoPadding(false);

  const decrypted = Buffer.concat([
    decipher.update(encrypted, 'base64'),
    decipher.final(),
  ]);
  const payload = stripPkcs7Padding(decrypted);
  if (payload.length < 20) {
    throw new Error('Invalid WeCom payload length');
  }

  const xmlLength = payload.readUInt32BE(16);
  const xmlStart = 20;
  const xmlEnd = xmlStart + xmlLength;
  if (xmlEnd > payload.length) {
    throw new Error('Invalid WeCom XML length');
  }

  const xml = payload.subarray(xmlStart, xmlEnd).toString('utf-8');
  const receiveId = payload.subarray(xmlEnd).toString('utf-8');
  if (receiveId !== expectedReceiveId) {
    throw new Error('WeCom receive id mismatch');
  }
  return { xml, receiveId };
}

export function encryptWeComPayload(
  xml: string,
  encodingAesKey: string,
  receiveId: string,
  randomBytes = crypto.randomBytes(16),
): string {
  if (randomBytes.length !== 16) {
    throw new Error('WeCom random prefix must be 16 bytes');
  }
  const aesKey = decodeEncodingAesKey(encodingAesKey);
  const xmlBuffer = Buffer.from(xml, 'utf-8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(xmlBuffer.length, 0);
  const plain = addPkcs7Padding(
    Buffer.concat([
      randomBytes,
      lengthBuffer,
      xmlBuffer,
      Buffer.from(receiveId, 'utf-8'),
    ]),
  );
  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    aesKey,
    aesKey.subarray(0, 16),
  );
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString(
    'base64',
  );
}

function createAutoRegisteredGroup(
  userid: string,
  displayName: string,
): RegisteredGroup {
  return {
    name: displayName || userid,
    folder: wecomUserFolder(userid),
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
    description: `企业微信自建应用一对一会话：${displayName || userid}`,
  };
}

function timestampFromCreateTime(createTime?: string): string {
  const seconds = Number.parseInt(createTime || '', 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return String(seconds * 1000);
  }
  return String(Date.now());
}

export class WeComChannel implements Channel {
  name = 'wecom';

  private token: string | null = null;
  private tokenExpiry = 0;
  private connected = false;
  private unregisterWebhookRoute: (() => Promise<void>) | null = null;
  private readonly allowedUserIds: Set<string>;

  constructor(
    private readonly config: WeComConfig,
    private readonly opts: ChannelOpts,
  ) {
    this.allowedUserIds = new Set(config.allowedUserIds || []);
  }

  async connect(): Promise<void> {
    await this.getAccessToken();
    await this.startWebhookServer();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    const unregisterWebhookRoute = this.unregisterWebhookRoute;
    this.unregisterWebhookRoute = null;
    this.connected = false;
    if (unregisterWebhookRoute) await unregisterWebhookRoute();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(WECOM_USER_JID_PREFIX);
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpiry) {
      return this.token;
    }

    const response = await axios.get(`${WECOM_API_BASE}/gettoken`, {
      params: {
        corpid: this.config.corpId,
        corpsecret: this.config.appSecret,
      },
    });
    const data = response.data || {};
    if (data.errcode !== 0) {
      throw new Error(
        `Failed to get WeCom access token: errcode=${data.errcode} errmsg=${data.errmsg}`,
      );
    }

    this.token = data.access_token;
    this.tokenExpiry = now + Number(data.expires_in || 7200) * 1000 - 60_000;
    return this.token!;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) {
      throw new Error(`WeComChannel cannot send to JID: ${jid}`);
    }
    const userid = jid.slice(WECOM_USER_JID_PREFIX.length);
    if (!userid) {
      throw new Error('WeCom user JID is missing userid');
    }

    const accessToken = await this.getAccessToken();
    const response = await axios.post(
      WECOM_MESSAGE_SEND_URL,
      {
        touser: userid,
        msgtype: 'text',
        agentid: toAgentId(this.config.agentId),
        text: { content: text },
      },
      {
        params: { access_token: accessToken },
      },
    );
    const data = response.data || {};
    if (data.errcode !== 0) {
      throw new Error(
        `WeCom message send failed: errcode=${data.errcode} errmsg=${data.errmsg}`,
      );
    }
  }

  private async startWebhookServer(): Promise<void> {
    if (this.unregisterWebhookRoute) return;
    this.unregisterWebhookRoute = await registerWebhookRoute({
      name: 'wecom',
      pathPrefix: '/webhook/wecom/app',
      handler: ({ req, res, url }) => this.handleHttpRequest(req, res, url),
    });
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (url.pathname !== '/webhook/wecom/app') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method === 'GET') {
      this.writeWebhookResponse(
        res,
        this.handleUrlVerification(url.searchParams),
      );
      return;
    }

    if (req.method === 'POST') {
      const body = await this.readRequestBody(req);
      const response = await this.handlePostWebhook(body, url.searchParams);
      this.writeWebhookResponse(res, response);
      return;
    }

    res.writeHead(405);
    res.end();
  }

  private writeWebhookResponse(
    res: ServerResponse,
    response: WebhookResponse,
  ): void {
    res.writeHead(response.statusCode, {
      'Content-Type': response.contentType,
    });
    res.end(response.body);
  }

  private readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf-8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  private handleUrlVerification(params: URLSearchParams): WebhookResponse {
    const encrypted = params.get('echostr');
    if (
      !verifyWeComSignature(
        this.config.token,
        params.get('msg_signature'),
        params.get('timestamp'),
        params.get('nonce'),
        encrypted,
      )
    ) {
      logger.warn('WeCom URL verification rejected: invalid signature');
      return {
        statusCode: 401,
        contentType: 'text/plain; charset=utf-8',
        body: 'invalid signature',
      };
    }

    try {
      const { xml } = decryptWeComPayload(
        encrypted!,
        this.config.encodingAesKey,
        this.config.corpId,
      );
      return {
        statusCode: 200,
        contentType: 'text/plain; charset=utf-8',
        body: xml,
      };
    } catch (err) {
      logger.warn({ err }, 'WeCom URL verification decrypt failed');
      return {
        statusCode: 400,
        contentType: 'text/plain; charset=utf-8',
        body: 'invalid echostr',
      };
    }
  }

  private async handlePostWebhook(
    body: string,
    params: URLSearchParams,
  ): Promise<WebhookResponse> {
    const fields = parseWeComXml(body);
    const encrypted = fields.Encrypt;
    if (!encrypted) {
      return {
        statusCode: 400,
        contentType: 'text/plain; charset=utf-8',
        body: 'missing Encrypt',
      };
    }

    if (
      !verifyWeComSignature(
        this.config.token,
        params.get('msg_signature'),
        params.get('timestamp'),
        params.get('nonce'),
        encrypted,
      )
    ) {
      logger.warn('WeCom webhook rejected: invalid signature');
      return {
        statusCode: 401,
        contentType: 'text/plain; charset=utf-8',
        body: 'invalid signature',
      };
    }

    try {
      const { xml } = decryptWeComPayload(
        encrypted,
        this.config.encodingAesKey,
        this.config.corpId,
      );
      this.handleInboundXml(xml);
      return {
        statusCode: 200,
        contentType: 'text/plain; charset=utf-8',
        body: 'success',
      };
    } catch (err) {
      logger.warn({ err }, 'WeCom webhook decrypt or dispatch failed');
      return {
        statusCode: 400,
        contentType: 'text/plain; charset=utf-8',
        body: 'invalid payload',
      };
    }
  }

  private handleInboundXml(xml: string): void {
    const fields = parseWeComXml(xml);
    const msgType = fields.MsgType;
    const userid = fields.FromUserName;
    if (!userid) {
      logger.warn(
        { xmlPreview: xml.slice(0, 300) },
        'WeCom webhook missing userid',
      );
      return;
    }

    if (
      fields.AgentID &&
      String(fields.AgentID) !== String(this.config.agentId)
    ) {
      logger.debug(
        { userid, agentId: fields.AgentID },
        'WeCom webhook ignored: message for another app agent',
      );
      return;
    }

    if (msgType !== 'text') {
      logger.debug(
        { userid, msgType },
        'WeCom webhook ignored: unsupported message',
      );
      return;
    }

    const content = fields.Content || '';
    if (!content) {
      logger.debug({ userid }, 'WeCom webhook ignored: empty text message');
      return;
    }

    const jid = wecomUserJid(userid);
    const group = this.ensureAuthorizedGroup(userid);
    if (!group) {
      logger.warn(
        { userid, jid },
        'WeCom inbound message ignored: user not authorized',
      );
      return;
    }

    const timestamp = timestampFromCreateTime(fields.CreateTime);
    const messageId = fields.MsgId || fields.MsgID || `${timestamp}-${userid}`;
    const senderName = group.name || userid;
    this.opts.onChatMetadata(jid, timestamp, senderName, 'wecom', false);

    const message: NewMessage = {
      id: `wecom-${messageId}`,
      chat_jid: jid,
      sender: userid,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    };
    this.opts.onMessage(jid, message);
  }

  private ensureAuthorizedGroup(userid: string): RegisteredGroup | null {
    const jid = wecomUserJid(userid);
    const existing = this.opts.registeredGroups()[jid];
    if (existing) return existing;
    if (!this.allowedUserIds.has(userid)) return null;

    const group = createAutoRegisteredGroup(userid, userid);
    if (!this.opts.registerGroup) {
      logger.warn(
        { userid, jid },
        'WeCom allowlisted user could not be auto-registered: registerGroup unavailable',
      );
      return null;
    }

    this.opts.registerGroup(jid, group);
    return group;
  }
}

export function createWeComChannel(
  config: WeComConfig,
  opts: {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
    registerGroup?: (jid: string, group: RegisteredGroup) => void;
  },
): WeComChannel | null {
  if (
    !config.corpId ||
    !config.agentId ||
    !config.appSecret ||
    !config.token ||
    !config.encodingAesKey
  ) {
    return null;
  }
  return new WeComChannel(config, opts);
}

registerChannel('wecom', (opts) => {
  const env = readEnvFile([
    'WECOM_CORP_ID',
    'WECOM_AGENT_ID',
    'WECOM_APP_SECRET',
    'WECOM_APP_TOKEN',
    'WECOM_APP_ENCODING_AES_KEY',
    'WECOM_ALLOWED_USER_IDS',
    'WECOM_USER_ALLOWLIST',
  ]);
  const corpId = env.WECOM_CORP_ID;
  const agentId = env.WECOM_AGENT_ID;
  const appSecret = env.WECOM_APP_SECRET;
  const token = env.WECOM_APP_TOKEN;
  const encodingAesKey = env.WECOM_APP_ENCODING_AES_KEY;
  const allowedUserIds = parseCsvList(
    env.WECOM_ALLOWED_USER_IDS || env.WECOM_USER_ALLOWLIST,
  );

  return createWeComChannel(
    {
      corpId,
      agentId,
      appSecret,
      token,
      encodingAesKey,
      allowedUserIds,
    },
    opts,
  );
});
