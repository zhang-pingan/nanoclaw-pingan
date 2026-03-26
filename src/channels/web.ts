import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';

import { AgentStatusInfo } from '../types.js';
import { registerChannel, ChannelFactory, ChannelOpts } from './registry.js';
import { GROUPS_DIR, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { CardActionHandler, InteractiveCard, NewMessage } from '../types.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { ASSISTANT_NAME } from '../config.js';
import { initWebDb, storeWebMessage, getWebMessages, getWebMessagesBefore } from '../web-db.js';

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
  type: 'message' | 'select_group' | 'card_action';
  chatJid?: string;
  content?: string;
  token?: string;
  replyToId?: string;
  // card_action fields
  cardId?: string;
  value?: Record<string, string>;
  formValue?: Record<string, string>;
}

interface OutgoingMsg {
  type: 'message' | 'typing' | 'groups' | 'error' | 'connected' | 'card' | 'agent_status' | 'file';
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
  onCardAction: CardActionHandler | null = null;

  connect(): Promise<void> {
    initWebDb();
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
    const timestamp = Date.now().toString();
    const id = `web_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;

    // Always persist bot reply to web message DB, even if no WS clients
    // are connected. This ensures delegation responses from sub-groups
    // (e.g., web:ops) are preserved for when the user views that chat.
    storeWebMessage({
      id,
      chat_jid: jid,
      sender: ASSISTANT_NAME,
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: true,
    });

    // Deliver via WebSocket to any connected clients
    const clients = this.clients.get(jid);
    if (!clients || clients.size === 0) return;

    const payload = JSON.stringify({
      type: 'message',
      id,
      chatJid: jid,
      content: text,
      sender: ASSISTANT_NAME,
      timestamp,
    } satisfies OutgoingMsg);

    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  async sendFile(jid: string, filePath: string, caption?: string): Promise<void> {
    const timestamp = Date.now().toString();

    // Always persist to web message DB
    const content = caption || `文件: ${path.basename(filePath)}`;
    storeWebMessage({
      id: `web_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: jid,
      sender: ASSISTANT_NAME,
      sender_name: ASSISTANT_NAME,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: true,
    });

    // Deliver via WebSocket to any connected clients
    const clients = this.clients.get(jid);
    if (!clients || clients.size === 0) return;

    const payload = JSON.stringify({
      type: 'file',
      chatJid: jid,
      filePath,
      caption: caption || undefined,
      sender: ASSISTANT_NAME,
      timestamp,
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

  async sendCard(jid: string, card: InteractiveCard): Promise<string | undefined> {
    const clients = this.clients.get(jid);
    const timestamp = Date.now().toString();
    const cardId = `card_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;

    const payload = JSON.stringify({
      type: 'card',
      chatJid: jid,
      cardId,
      card,
      timestamp,
    } satisfies OutgoingMsg);

    if (clients && clients.size > 0) {
      for (const client of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(payload);
        }
      }
    }

    // Persist card to web-db for history
    storeWebMessage({
      id: cardId,
      chat_jid: jid,
      sender: ASSISTANT_NAME,
      sender_name: ASSISTANT_NAME,
      content: JSON.stringify({ _type: 'card', card }),
      timestamp,
      is_from_me: false,
      is_bot_message: true,
    });

    return cardId;
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
      if (pathname === '/api/task' && req.method === 'DELETE') {
        return this.apiDeleteTask(reqUrl, res);
      }
      if (pathname === '/api/agent-status') {
        return this.apiGetAgentStatus(res);
      }
      if (pathname === '/api/tasks' && req.method === 'DELETE') {
        return this.apiDeleteAllTasks(res);
      }
      if (pathname.startsWith('/api/tasks')) {
        return this.apiGetTasks(reqUrl, res);
      }
      if (pathname === '/api/workflows') {
        if (req.method === 'DELETE') {
          return this.apiDeleteAllWorkflows(res);
        }
        return this.apiGetWorkflows(res);
      }
      if (pathname === '/api/workflow' && req.method === 'DELETE') {
        return this.apiDeleteWorkflow(reqUrl, res);
      }
      if (pathname === '/api/workflow/stop' && req.method === 'POST') {
        return this.apiStopWorkflow(req, res);
      }
      if (pathname === '/api/card-action' && req.method === 'POST') {
        return this.apiCardAction(req, res);
      }
      if (pathname === '/api/upload' && req.method === 'POST') {
        return this.apiUpload(req, reqUrl, res);
      }
      if (pathname.startsWith('/api/uploads/')) {
        return this.apiServeUpload(pathname, res);
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
    const groups = Object.entries(registered)
      .filter(([jid]) => jid.startsWith('web:'))
      .map(([jid, g]) => ({
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
    const before = reqUrl.searchParams.get('before') || '';
    const limit = parseInt(reqUrl.searchParams.get('limit') || '200', 10);
    if (!jid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'jid required' }));
      return;
    }

    // Pagination: if 'before' is set, load older messages
    const rawMessages = before
      ? getWebMessagesBefore(jid, before, limit)
      : getWebMessages(jid, since, limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        messages: rawMessages.map((m) => ({
          id: m.id,
          chat_jid: m.chat_jid,
          sender: m.sender,
          sender_name: m.sender_name,
          content: m.content,
          timestamp: m.timestamp,
          is_from_me: Boolean(m.is_from_me),
          is_bot_message: Boolean(m.is_bot_message),
          reply_to_id: m.reply_to_id || null,
        })),
      }),
    );
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

  private apiDeleteTask(reqUrl: URL, res: http.ServerResponse): void {
    const taskId = reqUrl.searchParams.get('id');
    if (!taskId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing task id' }));
      return;
    }
    import('../db.js').then(({ deleteTask }) => {
      deleteTask(taskId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  }

  private apiDeleteAllTasks(res: http.ServerResponse): void {
    import('../db.js').then(({ getAllTasks, deleteTask }) => {
      const tasks = getAllTasks();
      for (const t of tasks) {
        deleteTask(t.id);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted: tasks.length }));
    });
  }

  private apiGetAgentStatus(res: http.ServerResponse): void {
    const agents = this.opts.getAgentStatus?.() ?? [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents }));
  }

  /**
   * Broadcast current agent status to all connected WS clients.
   */
  broadcastAgentStatus(): void {
    const agents = this.opts.getAgentStatus?.() ?? [];
    const payload = JSON.stringify({
      type: 'agent_status',
      agents,
    } satisfies OutgoingMsg);

    for (const clients of this.clients.values()) {
      for (const client of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(payload);
        }
      }
    }
  }

  private async apiGetWorkflows(res: http.ServerResponse): Promise<void> {
    const { getAllWorkflows } = await import('../db.js');
    const workflows = getAllWorkflows();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ workflows }));
  }

  private async apiDeleteWorkflow(reqUrl: URL, res: http.ServerResponse): Promise<void> {
    const id = reqUrl.searchParams.get('id');
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing workflow id' }));
      return;
    }
    const { deleteWorkflow } = await import('../db.js');
    deleteWorkflow(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private async apiDeleteAllWorkflows(res: http.ServerResponse): Promise<void> {
    const { deleteAllWorkflows } = await import('../db.js');
    deleteAllWorkflows();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private async apiStopWorkflow(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    const { id } = body as { id?: string };
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing workflow id' }));
      return;
    }
    const { cancelWorkflow } = await import('../workflow.js');
    const result = cancelWorkflow(id);
    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private async apiCardAction(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    const { value, cardId, formValue } = body as {
      value?: Record<string, string>;
      cardId?: string;
      formValue?: Record<string, string>;
    };

    if (!value?.action) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'value.action required' }));
      return;
    }

    if (this.onCardAction) {
      this.onCardAction({
        action: value.action,
        user_id: 'web_user',
        message_id: cardId || '',
        workflow_id: value.workflow_id,
        group_folder: value.group_folder,
        form_value: formValue,
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
    const uploadBase = UPLOADS_DIR;
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
    const uploadedFiles: { name: string; hostPath: string }[] = [];

    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const header = part.slice(0, headerEnd);
      const data = part.slice(headerEnd + 4, part.endsWith('\r\n') ? -2 : undefined);

      const filenameMatch = header.match(/filename="([^"]+)"/);
      if (!filenameMatch) continue;
      const filename = filenameMatch[1].replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(uploadBase, filename);

      // Decode URL-encoded data if present
      let fileData: Buffer;
      if (data.includes('%')) {
        fileData = Buffer.from(decodeURIComponent(data), 'utf-8');
      } else {
        fileData = Buffer.from(data.trim(), 'utf-8');
      }

      fs.writeFileSync(filePath, fileData);
      uploadedFiles.push({ name: filename, hostPath: filePath });
      logger.info({ filename, size: fileData.length, jid, hostPath: filePath }, 'Web channel file uploaded');
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, files: uploadedFiles }));
  }

  // Serve uploaded files from web-uploads directory
  private apiServeUpload(pathname: string, res: http.ServerResponse): void {
    // pathname: /api/uploads/{filename}
    const parts = pathname.split('/');
    // parts[0]='', parts[1]='api', parts[2]='uploads', parts[3]=filename
    if (parts.length < 4) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid path' }));
      return;
    }
    const filename = decodeURIComponent(parts.slice(3).join('/'));

    const uploadBase = UPLOADS_DIR;
    const filePath = path.resolve(path.join(uploadBase, filename));

    // Security: ensure resolved path is within uploads dir
    if (!filePath.startsWith(path.resolve(uploadBase))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
      '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
      '.json': 'application/json', '.js': 'application/javascript',
      '.html': 'text/html', '.css': 'text/css', '.zip': 'application/zip',
    };
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(data);
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

        // Handle reply reference
        const replyToId = msg.replyToId || null;
        let enrichedContent = content;
        if (replyToId) {
          // Look up quoted message for agent context
          const allMsgs = getWebMessages(chatJid, '0', 500);
          const quoted = allMsgs.find((m) => m.id === replyToId);
          if (quoted) {
            enrichedContent = `[Replying to ${quoted.sender_name}: "${quoted.content.slice(0, 100)}"]\n\n${content}`;
          }
        }

        // Store sender as 'web_user' for web channel
        const now = Date.now();
        const newMsg: NewMessage = {
          id: `web_${now}_${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: chatJid,
          sender: 'web_user',
          sender_name: 'Web User',
          content: enrichedContent,
          timestamp: now.toString(),
          is_from_me: true,
          is_bot_message: false,
        };
        // Create chat record first (required for foreign key in messages table)
        const groups = this.opts.registeredGroups();
        const chatName = groups[chatJid]?.name || chatJid;
        this.opts.onChatMetadata(chatJid, now.toString(), chatName, 'web', true);
        this.opts.onMessage(chatJid, newMsg);
        // Also persist to web message DB for UI history (with original content)
        storeWebMessage({
          ...newMsg,
          content,
          reply_to_id: replyToId,
        });
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
          groups: Object.entries(registered)
            .filter(([jid]) => jid.startsWith('web:'))
            .map(([jid, g]) => ({
              jid, name: g.name, folder: g.folder, isMain: g.isMain ?? false,
            })),
          selectedJid: chatJid,
        });
        break;
      }
      case 'card_action': {
        const { value, cardId, formValue } = msg as IncomingMsg;
        if (!value?.action) {
          send({ type: 'error', message: 'value.action required for card_action' });
          return;
        }
        if (this.onCardAction) {
          this.onCardAction({
            action: value.action,
            user_id: 'web_user',
            message_id: cardId || '',
            workflow_id: value.workflow_id,
            group_folder: value.group_folder,
            form_value: formValue,
          });
        }
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
