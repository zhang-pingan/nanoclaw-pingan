import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';

import { readEnvFile } from './env.js';

export interface MailSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface MailFromConfig {
  address: string;
  name?: string;
}

export interface MailDefaultsConfig {
  to: string[];
  cc: string[];
  bcc: string[];
}

export interface MailProfile {
  smtp: MailSmtpConfig;
  from: MailFromConfig;
  reply_to: string | null;
  defaults: MailDefaultsConfig;
}

export interface MailSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  attachments?: string[];
}

export interface MailSendResult {
  recipients: string[];
}

interface SmtpResponse {
  code: number;
  lines: string[];
}

function normalizeAddressList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => normalizeAddressList(entry))
      .filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getMailConfigPath(): string {
  const env = readEnvFile(['NANOCLAW_MAIL_CONFIG_PATH']);
  const raw =
    process.env.NANOCLAW_MAIL_CONFIG_PATH ||
    env.NANOCLAW_MAIL_CONFIG_PATH ||
    path.join(process.env.HOME || os.homedir(), '.config', 'nanoclaw', 'mail.json');
  const home = process.env.HOME || os.homedir();
  return path.resolve(raw.replace(/^~/, home));
}

export function loadMailProfile(): MailProfile {
  const configPath = getMailConfigPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `读取邮件配置失败: ${configPath} (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const raw = (parsed || {}) as Record<string, unknown>;
  const smtp = (raw.smtp || {}) as Record<string, unknown>;
  const from = (raw.from || {}) as Record<string, unknown>;
  const defaults = (raw.defaults || {}) as Record<string, unknown>;
  const host = typeof smtp.host === 'string' ? smtp.host.trim() : '';
  const port =
    typeof smtp.port === 'number'
      ? Math.trunc(smtp.port)
      : Number.parseInt(String(smtp.port || ''), 10);
  const secure =
    typeof smtp.secure === 'boolean'
      ? smtp.secure
      : String(smtp.secure || '').trim().toLowerCase() === 'true';
  const user = typeof smtp.user === 'string' ? smtp.user.trim() : '';
  const pass = typeof smtp.pass === 'string' ? smtp.pass : '';
  const fromAddress =
    typeof from.address === 'string' ? from.address.trim() : user;
  const fromName = typeof from.name === 'string' ? from.name.trim() : '';
  const replyTo =
    typeof raw.reply_to === 'string' && raw.reply_to.trim().length > 0
      ? raw.reply_to.trim()
      : null;

  if (!host) throw new Error('邮件配置缺少 smtp.host');
  if (!Number.isFinite(port) || port <= 0) throw new Error('邮件配置缺少有效的 smtp.port');
  if (!user) throw new Error('邮件配置缺少 smtp.user');
  if (!pass) throw new Error('邮件配置缺少 smtp.pass');
  if (!fromAddress) throw new Error('邮件配置缺少 from.address');

  return {
    smtp: {
      host,
      port,
      secure: secure || port === 465,
      user,
      pass,
    },
    from: {
      address: fromAddress,
      name: fromName || undefined,
    },
    reply_to: replyTo,
    defaults: {
      to: normalizeAddressList(defaults.to),
      cc: normalizeAddressList(defaults.cc),
      bcc: normalizeAddressList(defaults.bcc),
    },
  };
}

function uniqueAddresses(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function encodeMimeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

function formatAddressHeader(addresses: string[]): string {
  return uniqueAddresses(addresses).join(', ');
}

function formatFromHeader(from: MailFromConfig): string {
  const address = from.address.trim();
  if (!from.name) return address;
  return `${encodeMimeWord(from.name)} <${address}>`;
}

function wrapBase64(value: string): string {
  const lines: string[] = [];
  for (let index = 0; index < value.length; index += 76) {
    lines.push(value.slice(index, index + 76));
  }
  return lines.join('\r\n');
}

function buildMessageId(domain: string): string {
  return `<nanoclaw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@${domain}>`;
}

function buildPlainTextMessage(input: {
  profile: MailProfile;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}): string {
  const bodyBase64 = wrapBase64(Buffer.from(input.body, 'utf-8').toString('base64'));
  const headerLines = [
    `From: ${formatFromHeader(input.profile.from)}`,
    `To: ${formatAddressHeader(input.to)}`,
    input.cc.length > 0 ? `Cc: ${formatAddressHeader(input.cc)}` : '',
    input.profile.reply_to ? `Reply-To: ${input.profile.reply_to}` : '',
    `Subject: ${encodeMimeWord(input.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${buildMessageId(input.profile.smtp.host)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  return `${headerLines.join('\r\n')}\r\n\r\n${bodyBase64}\r\n`;
}

async function connectSocket(profile: MailProfile): Promise<net.Socket | tls.TLSSocket> {
  if (profile.smtp.secure || profile.smtp.port === 465) {
    return await new Promise((resolve, reject) => {
      const socket = tls.connect(
        {
          host: profile.smtp.host,
          port: profile.smtp.port,
          servername: profile.smtp.host,
        },
        () => resolve(socket),
      );
      socket.once('error', reject);
    });
  }
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(
      { host: profile.smtp.host, port: profile.smtp.port },
      () => resolve(socket),
    );
    socket.once('error', reject);
  });
}

function createLineReader(socket: net.Socket | tls.TLSSocket) {
  let buffer = '';
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];

  socket.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) break;
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queue.push(line);
    }
  });

  async function nextLine(): Promise<string> {
    if (queue.length > 0) return queue.shift() || '';
    return await new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  return { nextLine };
}

async function readResponse(
  nextLine: () => Promise<string>,
): Promise<SmtpResponse> {
  const lines: string[] = [];
  let responseCode = 0;
  while (true) {
    const line = await nextLine();
    lines.push(line);
    const match = line.match(/^(\d{3})([ -])/);
    if (!match) continue;
    const code = Number.parseInt(match[1], 10);
    if (!responseCode) responseCode = code;
    if (code === responseCode && match[2] === ' ') {
      return { code: responseCode, lines };
    }
  }
}

function writeSocket(
  socket: net.Socket | tls.TLSSocket,
  payload: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(payload, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function sendCommand(input: {
  socket: net.Socket | tls.TLSSocket;
  nextLine: () => Promise<string>;
  command: string;
  expectedCodes: number[];
}): Promise<SmtpResponse> {
  await writeSocket(input.socket, `${input.command}\r\n`);
  const response = await readResponse(input.nextLine);
  if (!input.expectedCodes.includes(response.code)) {
    throw new Error(
      `SMTP 命令失败 (${input.command}): ${response.lines.join(' | ')}`,
    );
  }
  return response;
}

async function upgradeToTls(
  socket: net.Socket,
  host: string,
): Promise<tls.TLSSocket> {
  return await new Promise((resolve, reject) => {
    const secureSocket = tls.connect(
      {
        socket,
        servername: host,
      },
      () => resolve(secureSocket),
    );
    secureSocket.once('error', reject);
  });
}

function dotStuff(value: string): string {
  return value
    .replace(/\r?\n/g, '\r\n')
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

export async function sendMail(
  input: MailSendInput,
  profile: MailProfile = loadMailProfile(),
): Promise<MailSendResult> {
  const to = uniqueAddresses(input.to);
  const cc = uniqueAddresses(input.cc || []);
  const bcc = uniqueAddresses(input.bcc || []);
  const attachments = uniqueAddresses(input.attachments || []);
  const recipients = uniqueAddresses([...to, ...cc, ...bcc]);

  if (!input.subject.trim()) throw new Error('邮件主题不能为空');
  if (!input.body.trim()) throw new Error('邮件正文不能为空');
  if (to.length === 0) throw new Error('收件人不能为空');
  if (attachments.length > 0) {
    throw new Error('当前宿主侧邮件发送暂不支持附件');
  }

  let socket = await connectSocket(profile);
  try {
    const initialReader = createLineReader(socket);
    let response = await readResponse(initialReader.nextLine);
    if (response.code !== 220) {
      throw new Error(`SMTP 握手失败: ${response.lines.join(' | ')}`);
    }

    response = await sendCommand({
      socket,
      nextLine: initialReader.nextLine,
      command: `EHLO ${os.hostname() || 'nanoclaw.local'}`,
      expectedCodes: [250],
    });

    let activeSocket = socket;
    let nextLine = initialReader.nextLine;
    if (!profile.smtp.secure && profile.smtp.port !== 465) {
      await sendCommand({
        socket: activeSocket,
        nextLine,
        command: 'STARTTLS',
        expectedCodes: [220],
      });
      activeSocket = await upgradeToTls(activeSocket as net.Socket, profile.smtp.host);
      const secureReader = createLineReader(activeSocket);
      nextLine = secureReader.nextLine;
      await sendCommand({
        socket: activeSocket,
        nextLine,
        command: `EHLO ${os.hostname() || 'nanoclaw.local'}`,
        expectedCodes: [250],
      });
    }

    await sendCommand({
      socket: activeSocket,
      nextLine,
      command: 'AUTH LOGIN',
      expectedCodes: [334],
    });
    await sendCommand({
      socket: activeSocket,
      nextLine,
      command: Buffer.from(profile.smtp.user, 'utf-8').toString('base64'),
      expectedCodes: [334],
    });
    await sendCommand({
      socket: activeSocket,
      nextLine,
      command: Buffer.from(profile.smtp.pass, 'utf-8').toString('base64'),
      expectedCodes: [235],
    });
    await sendCommand({
      socket: activeSocket,
      nextLine,
      command: `MAIL FROM:<${profile.from.address}>`,
      expectedCodes: [250],
    });
    for (const recipient of recipients) {
      await sendCommand({
        socket: activeSocket,
        nextLine,
        command: `RCPT TO:<${recipient}>`,
        expectedCodes: [250, 251],
      });
    }
    await sendCommand({
      socket: activeSocket,
      nextLine,
      command: 'DATA',
      expectedCodes: [354],
    });
    const message = buildPlainTextMessage({
      profile,
      to,
      cc,
      subject: input.subject.trim(),
      body: input.body,
    });
    await writeSocket(activeSocket, `${dotStuff(message)}\r\n.\r\n`);
    response = await readResponse(nextLine);
    if (response.code !== 250) {
      throw new Error(`SMTP 发送失败: ${response.lines.join(' | ')}`);
    }
    await sendCommand({
      socket: activeSocket,
      nextLine,
      command: 'QUIT',
      expectedCodes: [221],
    });
    activeSocket.end();
    return { recipients };
  } finally {
    socket.end();
  }
}
