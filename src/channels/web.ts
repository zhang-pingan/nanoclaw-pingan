import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';

import { registerChannel, ChannelFactory, ChannelOpts } from './registry.js';
import { GROUPS_DIR, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { NewMessage } from '../types.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { ASSISTANT_NAME } from '../config.js';

// --- Config ---
const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);
const WEB_TOKEN = process.env.WEB_TOKEN;
const RENDERER_DIR = path.resolve(process.cwd(), 'electron', 'renderer');
const UPLOADS_DIR = path.resolve(DATA_DIR, 'web-uploads');

// --- Types ---
interface WsClient {
  ws: WebSocket;
  groupFolder: string;
}

interface IncomingMsg {
  type: 'message' | 'select_group';
  chatJid?: string;
  content?: string;
  token?: string;
}

interface OutgoingMsg {
  type: 'message' | 'typing' | 'groups' | 'error' | 'connected';
  [key: string]: unknown;
}

// --- WebChannel ---
class WebChannel {
  name = 'web' as const;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Map<string, Set<WsClient>> = new Map();
  opts!: ChannelOpts;
  private connected = false;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttp(req, res));
      this.wss = new WebSocketServer({ noServer: true });

      this.server.on('upgrade', (req, socket, head) => {
        const parsedUrl = new URL(req.url || '/', 'http://localhost');
        if (parsedUrl.pathname === '/ws') {
          const token = parsedUrl.searchParams.get('token');
          if (WEB_TOKEN && token !== WEB_TOKEN) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          this.wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
            this.wss!.emit('connection', ws, req);
          });
        } else {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
        }
      });

      this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
        this.handleWsConnect(ws, req);
      });

      this.server.listen(WEB_PORT, '127.0.0.1', () => {
        logger.info({ port: WEB_PORT }, 'Web channel HTTP server started');
        this.connected = true;
        resolve();
      });

      this.server.on('error', (err) => {
        if (!this.connected) reject(err);
        else logger.error({ err }, 'Web channel server error');
      });
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const clients = this.clients.get(jid);
    if (!clients || clients.size === 0) return;

    const payload = JSON.stringify({
      type: 'message',
      chatJid: jid,
      content: text,
      sender: ASSISTANT_NAME,
      timestamp: Date.now().toString(),
    } satisfies OutgoingMsg);

    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const clients = this.clients.get(jid);
    if (!clients || clients.size === 0) return;

    const payload = JSON.stringify({
      type: 'typing',
      chatJid: jid,
      isTyping,
    } satisfies OutgoingMsg);

    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  async disconnect(): Promise<void> {
    for (const clients of this.clients.values()) {
      for (const client of clients) {
        client.ws.close();
      }
    }
    this.clients.clear();
    this.wss?.close();
    this.server?.close();
    this.connected = false;
    logger.info('Web channel disconnected');
  }

  // --- HTTP Handler ---
  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = reqUrl.pathname;

    // Auth guard for API routes
    if (pathname.startsWith('/api/')) {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      if (WEB_TOKEN && token !== WEB_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    try {
      if (pathname === '/' || pathname === '/index.html') {
        return this.serveFile('/index.html', 'text/html', res);
      }
      if (pathname.startsWith('/api/groups')) {
        return this.apiGetGroups(res);
      }
      if (pathname.startsWith('/api/messages')) {
        return this.apiGetMessages(reqUrl, res);
      }
      if (pathname.startsWith('/api/tasks')) {
        return this.apiGetTasks(reqUrl, res);
      }
      if (pathname === '/api/upload' && req.method === 'POST') {
        return this.apiUpload(req, reqUrl, res);
      }
      if (pathname.startsWith('/api/files/')) {
        return this.apiServeFile(pathname, res);
      }
      // Shutdown endpoint — only POST, no auth (localhost only via 127.0.0.1 binding)
      if (pathname === '/api/shutdown' && req.method === 'POST') {
        logger.info('Shutdown requested via web channel API');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => process.exit(0), 100);
        return;
      }
      // Static assets
      if (pathname.startsWith('/assets/') || pathname.startsWith('/styles/')) {
        return this.serveStaticFile(pathname, res);
      }
      // WebSocket handshake health check
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, port: WEB_PORT }));
        return;
      }
      // Try to serve from renderer dir
      return this.serveRendererStatic(pathname, res);
    } catch (err) {
      logger.error({ err, pathname }, 'Web channel HTTP error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  private serveFile(relPath: string, contentType: string, res: http.ServerResponse): void {
    const filePath = path.join(RENDERER_DIR, relPath.replace(/^\//, ''));
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  }

  private serveStaticFile(pathname: string, res: http.ServerResponse): void {
    const filePath = path.join(RENDERER_DIR, pathname.replace(/^\//, ''));
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const mime: Record<string, string> = {
      '.js': 'application/javascript',
      '.ts': 'application/typescript',
      '.css': 'text/css',
      '.html': 'text/html',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    };
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  }

  private serveRendererStatic(pathname: string, res: http.ServerResponse): void {
    const filePath = path.join(RENDERER_DIR, pathname.replace(/^\//, ''));
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // Fall back to index.html (SPA)
      const indexPath = path.join(RENDERER_DIR, 'index.html');
      if (fs.existsSync(indexPath)) {
        const data = fs.readFileSync(indexPath);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const mime: Record<string, string> = {
      '.js': 'application/javascript',
      '.ts': 'application/typescript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    };
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  }

  private apiGetGroups(res: http.ServerResponse): void {
    const registered = this.opts.registeredGroups();
    const groups = Object.entries(registered).map(([jid, g]) => ({
      jid,
      name: g.name,
      folder: g.folder,
      isMain: g.isMain ?? false,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ groups }));
  }

  private apiGetMessages(
    reqUrl: URL,
    res: http.ServerResponse,
  ): void {
    const jid = reqUrl.searchParams.get('jid') || '';
    const since = reqUrl.searchParams.get('since') || '0';
    if (!jid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'jid required' }));
      return;
    }
    // Import lazily to avoid circular issues
    import('../db.js').then(({ getMessagesSince }) => {
      const messages = getMessagesSince(jid, since, ASSISTANT_NAME);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          messages: messages.map((m) => ({
            id: m.id,
            chat_jid: m.chat_jid,
            sender: m.sender,
            sender_name: m.sender_name,
            content: m.content,
            timestamp: m.timestamp,
            is_from_me: m.is_from_me ?? false,
            is_bot_message: m.is_bot_message ?? false,
          })),
        }),
      );
    });
  }

  private apiGetTasks(reqUrl: URL, res: http.ServerResponse): void {
    const folder = reqUrl.searchParams.get('folder') || '';
    import('../db.js').then(({ getTasksForGroup, getAllTasks }) => {
      const tasks = folder ? getTasksForGroup(folder) : getAllTasks();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tasks: tasks.map((t) => ({
            id: t.id,
            group_folder: t.group_folder,
            prompt: t.prompt,
            schedule_type: t.schedule_type,
            schedule_value: t.schedule_value,
            status: t.status,
            next_run: t.next_run,
            last_run: t.last_run,
            last_result: t.last_result,
          })),
        }),
      );
    });
  }

  private async apiUpload(req: http.IncomingMessage, reqUrl: URL, res: http.ServerResponse): Promise<void> {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'multipart/form-data required' }));
      return;
    }

    // Parse boundary
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing boundary' }));
      return;
    }
    const boundary = '--' + boundaryMatch[1];

    // Extract target JID from URL
    // URL is /api/upload?jid=web:main
    const jid = reqUrl.searchParams.get('jid') || '';
    if (!jid || !this.ownsJid(jid)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid jid' }));
      return;
    }

    // Extract group folder from JID
    const groupFolder = jid.replace('web:', '');
    const groupDir = resolveGroupFolderPath(groupFolder);
    const uploadBase = path.join(UPLOADS_DIR, groupFolder);
    fs.mkdirSync(uploadBase, { recursive: true });

    // Collect body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    const text = body.toString('utf-8');

    // Parse multipart (simple approach: find filename and data sections)
    const parts = text.split(boundary).filter((p) => p.trim() && !p.startsWith('--'));
    const uploadedFiles: { name: string; path: string }[] = [];

    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const header = part.slice(0, headerEnd);
      const data = part.slice(headerEnd + 4, part.endsWith('\r\n') ? -2 : undefined);

      const filenameMatch = header.match(/filename="([^"]+)"/);
      if (!filenameMatch) continue;
      const filename = filenameMatch[1].replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(uploadBase, `${Date.now()}_${filename}`);

      // Decode URL-encoded data if present
      let fileData: Buffer;
      if (data.includes('%')) {
        fileData = Buffer.from(decodeURIComponent(data), 'utf-8');
      } else {
        fileData = Buffer.from(data.trim(), 'utf-8');
      }

      fs.writeFileSync(filePath, fileData);
      uploadedFiles.push({ name: filename, path: filePath });
      logger.info({ filename, size: fileData.length, jid }, 'Web channel file uploaded');
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, files: uploadedFiles }));
  }

  private apiServeFile(pathname: string, res: http.ServerResponse): void {
    // pathname: /api/files/{groupFolder}/...
    const parts = pathname.split('/');
    // parts[0]='', parts[1]='api', parts[2]='files', parts[3]=groupFolder, rest=...
    if (parts.length < 5) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid path' }));
      return;
    }
    const groupFolder = parts[3];
    const relativePath = parts.slice(4).join('/');

    // Security: ensure resolved path is within groups dir
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(groupFolder);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'group not found' }));
      return;
    }

    const filePath = path.resolve(path.join(groupDir, relativePath));
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(groupDir)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    if (!fs.existsSync(resolved)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const data = fs.readFileSync(resolved);
    const ext = path.extname(resolved);
    const mime: Record<string, string> = {
      '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
      '.js': 'application/javascript', '.ts': 'application/typescript', '.py': 'text/x-python',
      '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
      '.zip': 'application/zip',
    };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  }

  // --- WebSocket ---
  private handleWsConnect(ws: WebSocket, req: http.IncomingMessage): void {
    logger.debug('Web channel WS client connected');

    const send = (payload: OutgoingMsg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    send({ type: 'connected', message: 'Connected to NanoClaw' });

    ws.on('message', (data: unknown) => {
      try {
        const msg = JSON.parse(String(data)) as IncomingMsg;
        this.handleWsMessage(ws, msg, send);
      } catch (err) {
        logger.warn({ err }, 'Web channel WS parse error');
        send({ type: 'error', message: 'Invalid JSON' });
      }
    });

    ws.on('close', () => {
      // Remove from all client sets
      for (const clients of this.clients.values()) {
        for (const client of clients) {
          if (client.ws === ws) {
            clients.delete(client);
            break;
          }
        }
      }
    });

    ws.on('error', (err: unknown) => {
      logger.warn({ err }, 'Web channel WS error');
    });
  }

  private handleWsMessage(
    ws: WebSocket,
    msg: IncomingMsg,
    send: (p: OutgoingMsg) => void,
  ): void {
    switch (msg.type) {
      case 'message': {
        const chatJid = msg.chatJid;
        const content = msg.content;
        if (!chatJid || !content) {
          send({ type: 'error', message: 'chatJid and content required' });
          return;
        }
        if (!this.ownsJid(chatJid)) {
          send({ type: 'error', message: 'Unknown chat JID' });
          return;
        }
        // Store sender as 'web_user' for web channel
        const newMsg: NewMessage = {
          id: `web_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: chatJid,
          sender: 'web_user',
          sender_name: 'Web User',
          content,
          timestamp: Date.now().toString(),
          is_from_me: false,
          is_bot_message: false,
        };
        this.opts.onMessage(chatJid, newMsg);
        break;
      }
      case 'select_group': {
        const chatJid = msg.chatJid;
        if (!chatJid || !this.ownsJid(chatJid)) {
          send({ type: 'error', message: 'Invalid chat JID' });
          return;
        }
        // Register client for this group
        let clients = this.clients.get(chatJid);
        if (!clients) {
          clients = new Set();
          this.clients.set(chatJid, clients);
        }
        // Remove from old group (if any)
        for (const cs of this.clients.values()) {
          for (const c of cs) {
            if (c.ws === ws) cs.delete(c);
          }
        }
        clients.add({ ws, groupFolder: chatJid.replace('web:', '') });
        // Send current groups list
        const registered = this.opts.registeredGroups();
        send({
          type: 'groups',
          groups: Object.entries(registered).map(([jid, g]) => ({
            jid, name: g.name, folder: g.folder, isMain: g.isMain ?? false,
          })),
          selectedJid: chatJid,
        });
        break;
      }
      default:
        send({ type: 'error', message: `Unknown message type: ${(msg as any).type}` });
    }
  }
}

// --- Register ---
const factory: ChannelFactory = (opts: ChannelOpts) => {
  // Skip if WEB_TOKEN is set and doesn't match (security)
  // We allow no-token mode for local dev convenience
  const channel = new WebChannel();
  channel.opts = opts;
  return channel;
};

registerChannel('web', factory);
