import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';

import { AgentStatusInfo } from '../types.js';
import type { WorkbenchRealtimeEvent } from '../workbench-events.js';
import { validateCardConfig } from '../card-config.js';
import type { CardConfig } from '../card-config.js';
import type { WorkflowDefinition } from '../workflow-definition.js';
import { registerChannel, ChannelFactory, ChannelOpts } from './registry.js';
import { GROUPS_DIR, DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { CardActionHandler, InteractiveCard, NewMessage } from '../types.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { ASSISTANT_NAME } from '../config.js';
import {
  initWebDb,
  storeWebMessage,
  getWebMessages,
  getWebMessagesBefore,
  deleteWebMessagesByIds,
} from '../web-db.js';
import {
  addWorkbenchAsset,
  addWorkbenchComment,
  createWorkbenchTask,
  getWorkbenchTaskDetail,
  listWorkbenchTasks,
  retryWorkbenchSubtask,
  runWorkbenchActionItemAction,
  runWorkbenchTaskAction,
} from '../workbench.js';
import {
  deleteWorkbenchTaskData,
  deleteHistoricalAgentQueries,
  getAgentQuery,
  getWikiJob,
  listAgentQueryEvents,
  listAgentQuerySteps,
  listAgentQueries,
  listWikiDrafts,
  listWikiJobs,
  searchWikiPages,
} from '../db.js';
import {
  deleteWorkflowDefinitionVersion,
  getPublishedWorkflowDefinition,
  getWorkflowDefinitionBundle,
  listWorkflowDefinitionBundles,
  publishWorkflowDefinitionVersion,
  readCardRegistry,
  saveWorkflowDefinitionDraft,
  writeCardRegistry,
} from '../workflow-definition-store.js';
import {
  compileWorkflowDefinition,
  validateWorkflowDefinition,
} from '../workflow-compiler.js';
import { loadWorkflowConfigs } from '../workflow-config.js';
import {
  completeTodayPlan,
  createOrContinueTodayPlan,
  createTodayPlanItemForPlan,
  getTodayPlanDetail,
  getTodayPlanOverview,
  getTodayPlanServiceCommitDiff,
  getTodayPlanDateKey,
  listTodayPlanChatMessages,
  listTodayPlanServiceBranches,
  listTodayPlanServices,
  patchTodayPlanItem,
  removeTodayPlanItem,
} from '../today-plan.js';
import {
  confirmTodayPlanMailDraft,
  prepareTodayPlanMailDraft,
} from '../today-plan-mail.js';
import {
  dispatchCurrentAskQuestion,
  handleAskQuestionResponse,
} from '../ask-user-question.js';
import {
  bulkDeleteWikiDrafts,
  deleteWikiDraft,
  deleteWikiMaterial,
  deleteWikiPage,
  ensureWikiDirs,
  getWikiDraftDetail,
  getWikiMaterialDetail,
  getWikiPageDetail,
  importWikiMaterialFromText,
  importWikiMaterialFromUpload,
  listWikiMaterialSummaries,
  listWikiPageSummaries,
  publishWikiDraft,
  queueWikiDraftGenerationJob,
  resumePendingWikiJobs,
} from '../wiki.js';

// --- Config ---
const webEnv = readEnvFile(['WEB_PORT', 'WEB_TOKEN']);
const WEB_PORT = parseInt(
  process.env.WEB_PORT || webEnv.WEB_PORT || '3000',
  10,
);
const WEB_TOKEN = process.env.WEB_TOKEN || webEnv.WEB_TOKEN;
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
  model?: string;
  token?: string;
  replyToId?: string;
  // card_action fields
  cardId?: string;
  value?: Record<string, string>;
  formValue?: Record<string, string>;
}

interface OutgoingMsg {
  type:
    | 'message'
    | 'typing'
    | 'groups'
    | 'error'
    | 'connected'
    | 'card'
    | 'agent_status'
    | 'agent_query_trace'
    | 'file'
    | 'workbench_event';
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
    ensureWikiDirs();
    resumePendingWikiJobs();
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

  async sendFile(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
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
      file_path: filePath,
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

  async sendCard(
    jid: string,
    card: InteractiveCard,
  ): Promise<string | undefined> {
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
  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // CORS for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization',
    );

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
      if (pathname === '/api/memories' && req.method === 'GET') {
        return this.apiGetMemories(reqUrl, res);
      }
      if (pathname === '/api/memory' && req.method === 'POST') {
        return this.apiCreateMemory(req, res);
      }
      if (pathname === '/api/memory' && req.method === 'PATCH') {
        return this.apiUpdateMemory(req, res);
      }
      if (pathname === '/api/memory' && req.method === 'DELETE') {
        return this.apiDeleteMemory(reqUrl, res);
      }
      if (pathname === '/api/memory/doctor' && req.method === 'POST') {
        return this.apiMemoryDoctor(req, res);
      }
      if (pathname === '/api/memory/gc' && req.method === 'POST') {
        return this.apiMemoryGc(req, res);
      }
      if (pathname === '/api/memory/metrics' && req.method === 'POST') {
        return this.apiMemoryMetrics(req, res);
      }
      if (pathname === '/api/memory/conflict/keep' && req.method === 'POST') {
        return this.apiMemoryConflictKeep(req, res);
      }
      if (pathname === '/api/memory/conflict/merge' && req.method === 'POST') {
        return this.apiMemoryConflictMerge(req, res);
      }
      if (pathname === '/api/messages' && req.method === 'DELETE') {
        return this.apiDeleteMessages(req, res);
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
      if (pathname === '/api/agent-status/stop' && req.method === 'POST') {
        return this.apiStopAgent(req, res);
      }
      if (pathname === '/api/sessions/reset' && req.method === 'POST') {
        return this.apiResetSessions(req, res);
      }
      if (pathname === '/api/agent-queries/active') {
        return this.apiGetActiveAgentQueries(res);
      }
      if (pathname === '/api/agent-queries') {
        if (req.method === 'DELETE') {
          return this.apiDeleteAgentQueryHistory(res);
        }
        return this.apiListAgentQueries(reqUrl, res);
      }
      if (pathname.startsWith('/api/agent-queries/')) {
        return this.apiGetAgentQuery(pathname, res);
      }
      if (pathname === '/api/tasks' && req.method === 'DELETE') {
        return this.apiDeleteAllTasks(res);
      }
      if (pathname.startsWith('/api/tasks')) {
        return this.apiGetTasks(reqUrl, res);
      }
      if (pathname === '/api/workflow/create-options') {
        return this.apiGetWorkflowCreateOptions(res);
      }
      if (pathname === '/api/workflow-definitions' && req.method === 'GET') {
        return this.apiListWorkflowDefinitions(res);
      }
      if (pathname === '/api/cards' && req.method === 'GET') {
        return this.apiGetCards(res);
      }
      if (pathname === '/api/cards' && req.method === 'POST') {
        return this.apiSaveCards(req, res);
      }
      if (pathname.startsWith('/api/cards/')) {
        const suffix = pathname.slice('/api/cards/'.length);
        if (req.method === 'GET') {
          return this.apiGetCardByPath(suffix, res);
        }
        if (req.method === 'POST') {
          return this.apiSaveSingleCard(suffix, req, res);
        }
      }
      if (pathname.startsWith('/api/workflow-definitions/')) {
        const suffix = pathname.slice('/api/workflow-definitions/'.length);
        if (suffix.endsWith('/publish') && req.method === 'POST') {
          const key = suffix.slice(0, -'/publish'.length);
          return this.apiPublishWorkflowDefinition(key, req, res);
        }
        if (suffix.endsWith('/version') && req.method === 'DELETE') {
          const key = suffix.slice(0, -'/version'.length);
          return this.apiDeleteWorkflowDefinitionVersion(key, req, res);
        }
        if (req.method === 'GET') {
          return this.apiGetWorkflowDefinition(suffix, res);
        }
        if (req.method === 'POST') {
          return this.apiSaveWorkflowDefinitionDraft(suffix, req, res);
        }
      }
      if (pathname === '/api/workbench/tasks') {
        if (req.method === 'DELETE') {
          return this.apiDeleteAllWorkbenchTaskData(res);
        }
        return this.apiGetWorkbenchTasks(res);
      }
      if (pathname === '/api/workbench/task' && req.method === 'GET') {
        return this.apiGetWorkbenchTask(reqUrl, res);
      }
      if (pathname === '/api/workbench/task' && req.method === 'DELETE') {
        return this.apiDeleteWorkbenchTask(reqUrl, res);
      }
      if (pathname === '/api/workbench/task' && req.method === 'POST') {
        return this.apiCreateWorkbenchTask(req, res);
      }
      if (pathname === '/api/workbench/task/action' && req.method === 'POST') {
        return this.apiWorkbenchTaskAction(req, res);
      }
      if (pathname === '/api/workbench/action-item' && req.method === 'POST') {
        return this.apiWorkbenchActionItem(req, res);
      }
      if (pathname === '/api/workbench/task/comment' && req.method === 'POST') {
        return this.apiWorkbenchTaskComment(req, res);
      }
      if (pathname === '/api/workbench/task/asset' && req.method === 'POST') {
        return this.apiWorkbenchTaskAsset(req, res);
      }
      if (
        pathname === '/api/workbench/subtask/retry' &&
        req.method === 'POST'
      ) {
        return this.apiWorkbenchSubtaskRetry(req, res);
      }
      if (pathname === '/api/today-plans/overview' && req.method === 'GET') {
        return this.apiGetTodayPlanOverview(reqUrl, res);
      }
      if (pathname === '/api/today-plan' && req.method === 'GET') {
        return this.apiGetTodayPlan(reqUrl, res);
      }
      if (pathname === '/api/today-plan' && req.method === 'POST') {
        return this.apiCreateTodayPlan(req, res);
      }
      if (
        pathname === '/api/today-plan/complete' &&
        req.method === 'POST'
      ) {
        return this.apiCompleteTodayPlan(req, res);
      }
      if (pathname === '/api/today-plan/item' && req.method === 'POST') {
        return this.apiCreateTodayPlanItem(req, res);
      }
      if (pathname === '/api/today-plan/item' && req.method === 'PATCH') {
        return this.apiPatchTodayPlanItem(req, res);
      }
      if (pathname === '/api/today-plan/item' && req.method === 'DELETE') {
        return this.apiDeleteTodayPlanItem(req, res);
      }
      if (pathname === '/api/today-plan/chat/options' && req.method === 'GET') {
        return this.apiGetTodayPlanChatOptions(reqUrl, res);
      }
      if (pathname === '/api/today-plan/services' && req.method === 'GET') {
        return this.apiGetTodayPlanServices(res);
      }
      if (
        pathname === '/api/today-plan/service/branches' &&
        req.method === 'GET'
      ) {
        return this.apiGetTodayPlanServiceBranches(reqUrl, res);
      }
      if (
        pathname === '/api/today-plan/service/commit' &&
        req.method === 'GET'
      ) {
        return this.apiGetTodayPlanServiceCommit(reqUrl, res);
      }
      if (
        pathname === '/api/today-plan/mail/prepare' &&
        req.method === 'POST'
      ) {
        return this.apiPrepareTodayPlanMailDraft(req, res);
      }
      if (
        pathname === '/api/today-plan/mail/confirm' &&
        req.method === 'POST'
      ) {
        return this.apiConfirmTodayPlanMailDraft(req, res);
      }
      if (pathname === '/api/card-action' && req.method === 'POST') {
        return this.apiCardAction(req, res);
      }
      if (pathname === '/api/upload' && req.method === 'POST') {
        return this.apiUpload(req, reqUrl, res);
      }
      if (pathname === '/api/wiki/materials' && req.method === 'GET') {
        return this.apiListWikiMaterials(res);
      }
      if (pathname === '/api/wiki/materials/import' && req.method === 'POST') {
        return this.apiImportWikiMaterial(req, res);
      }
      if (pathname === '/api/wiki/material' && req.method === 'GET') {
        return this.apiGetWikiMaterial(reqUrl, res);
      }
      if (pathname === '/api/wiki/material' && req.method === 'DELETE') {
        return this.apiDeleteWikiMaterial(reqUrl, res);
      }
      if (pathname === '/api/wiki/drafts' && req.method === 'GET') {
        return this.apiListWikiDrafts(res);
      }
      if (
        pathname === '/api/wiki/drafts/bulk-delete' &&
        req.method === 'POST'
      ) {
        return this.apiBulkDeleteWikiDrafts(req, res);
      }
      if (pathname === '/api/wiki/draft' && req.method === 'GET') {
        return this.apiGetWikiDraft(reqUrl, res);
      }
      if (pathname === '/api/wiki/draft' && req.method === 'DELETE') {
        return this.apiDeleteWikiDraft(reqUrl, res);
      }
      if (pathname === '/api/wiki/draft/generate' && req.method === 'POST') {
        return this.apiGenerateWikiDraft(req, res);
      }
      if (pathname === '/api/wiki/draft/publish' && req.method === 'POST') {
        return this.apiPublishWikiDraft(req, res);
      }
      if (pathname === '/api/wiki/pages' && req.method === 'GET') {
        return this.apiListWikiPages(res);
      }
      if (pathname === '/api/wiki/page' && req.method === 'GET') {
        return this.apiGetWikiPage(reqUrl, res);
      }
      if (pathname === '/api/wiki/page' && req.method === 'DELETE') {
        return this.apiDeleteWikiPage(reqUrl, res);
      }
      if (pathname === '/api/wiki/search' && req.method === 'GET') {
        return this.apiSearchWikiPages(reqUrl, res);
      }
      if (pathname === '/api/wiki/jobs' && req.method === 'GET') {
        return this.apiListWikiJobs(res);
      }
      if (pathname === '/api/wiki/job' && req.method === 'GET') {
        return this.apiGetWikiJob(reqUrl, res);
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

  private serveFile(
    relPath: string,
    contentType: string,
    res: http.ServerResponse,
  ): void {
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

  private serveRendererStatic(
    pathname: string,
    res: http.ServerResponse,
  ): void {
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
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
    });
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

  private apiGetMemories(reqUrl: URL, res: http.ServerResponse): void {
    const requestedJid = reqUrl.searchParams.get('jid') || '';
    const requestedFolder = reqUrl.searchParams.get('folder') || '';
    const query = (reqUrl.searchParams.get('query') || '').trim();
    const rawLimit = parseInt(reqUrl.searchParams.get('limit') || '200', 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), 1000)
      : 200;

    const registered = this.opts.registeredGroups();
    const webGroups = Object.entries(registered).filter(([jid]) =>
      jid.startsWith('web:'),
    );

    let groupFolder = '';
    if (requestedJid) {
      const group = registered[requestedJid];
      if (!group || !requestedJid.startsWith('web:')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid web group jid' }));
        return;
      }
      groupFolder = group.folder;
    } else if (requestedFolder) {
      const matched = webGroups.find(
        ([, group]) => group.folder === requestedFolder,
      );
      if (!matched) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'group not found' }));
        return;
      }
      groupFolder = matched[1].folder;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'jid or folder required' }));
      return;
    }

    import('../db.js')
      .then(({ listMemories, searchMemories, getMemoryById }) => {
        const memories = query
          ? searchMemories(groupFolder, query, limit)
              .map((item) => getMemoryById(item.id))
              .filter((item): item is NonNullable<typeof item> => Boolean(item))
          : listMemories(groupFolder, limit);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            group_folder: groupFolder,
            query,
            memories,
          }),
        );
      })
      .catch((err: unknown) => {
        logger.error(
          { err, groupFolder, query },
          'Failed to query memories for web API',
        );
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to query memories' }));
      });
  }

  private resolveWebGroupFolder(input: {
    jid?: string;
    folder?: string;
  }): string | null {
    const requestedJid = input.jid || '';
    const requestedFolder = input.folder || '';
    const registered = this.opts.registeredGroups();
    const webGroups = Object.entries(registered).filter(([jid]) =>
      jid.startsWith('web:'),
    );

    if (requestedJid) {
      const group = registered[requestedJid];
      if (!group || !requestedJid.startsWith('web:')) return null;
      return group.folder;
    }

    if (requestedFolder) {
      const matched = webGroups.find(([, g]) => g.folder === requestedFolder);
      return matched ? matched[1].folder : null;
    }

    return null;
  }

  private async parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf-8') || '{}';
    return JSON.parse(raw);
  }

  private async apiCreateMemory(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      jid?: string;
      folder?: string;
      layer?: 'working' | 'episodic' | 'canonical';
      memory_type?: 'preference' | 'rule' | 'fact' | 'summary';
      content?: string;
      source?: string;
      metadata?: string;
    };

    const groupFolder = this.resolveWebGroupFolder({
      jid: data.jid,
      folder: data.folder,
    });
    if (!groupFolder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid group scope' }));
      return;
    }
    if (!data.content || !data.layer || !data.memory_type) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'content, layer, memory_type required' }),
      );
      return;
    }

    const { createMemory } = await import('../db.js');
    const created = createMemory({
      group_folder: groupFolder,
      layer: data.layer,
      memory_type: data.memory_type,
      content: data.content,
      source: data.source,
      metadata: data.metadata,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, memory: created }));
  }

  private async apiUpdateMemory(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      memoryId?: string;
      jid?: string;
      folder?: string;
      content?: string;
      layer?: 'working' | 'episodic' | 'canonical';
      memory_type?: 'preference' | 'rule' | 'fact' | 'summary';
      memory_status?: 'active' | 'conflicted' | 'deprecated';
      source?: string;
      metadata?: string;
    };

    if (!data.memoryId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'memoryId required' }));
      return;
    }

    const groupFolder = this.resolveWebGroupFolder({
      jid: data.jid,
      folder: data.folder,
    });
    if (!groupFolder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid group scope' }));
      return;
    }

    const { getMemoryById, updateMemory } = await import('../db.js');
    const existing = getMemoryById(data.memoryId);
    if (!existing || existing.group_folder !== groupFolder) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'memory not found in group scope' }));
      return;
    }

    updateMemory(data.memoryId, {
      content: data.content,
      layer: data.layer,
      memory_type: data.memory_type,
      status: data.memory_status,
      source: data.source,
      metadata: data.metadata,
    });
    const updated = getMemoryById(data.memoryId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, memory: updated }));
  }

  private async apiDeleteMemory(
    reqUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const memoryId = reqUrl.searchParams.get('id') || '';
    const jid = reqUrl.searchParams.get('jid') || '';
    const folder = reqUrl.searchParams.get('folder') || '';
    if (!memoryId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'id required' }));
      return;
    }

    const groupFolder = this.resolveWebGroupFolder({ jid, folder });
    if (!groupFolder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid group scope' }));
      return;
    }

    const { getMemoryById, deleteMemory } = await import('../db.js');
    const existing = getMemoryById(memoryId);
    if (!existing || existing.group_folder !== groupFolder) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'memory not found in group scope' }));
      return;
    }
    deleteMemory(memoryId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deleted: true, memoryId }));
  }

  private async apiMemoryDoctor(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as { jid?: string; folder?: string; staleDays?: number };
    const groupFolder = this.resolveWebGroupFolder({
      jid: data.jid,
      folder: data.folder,
    });
    if (!groupFolder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid group scope' }));
      return;
    }
    const staleDays = Number.isFinite(Number(data.staleDays))
      ? Number(data.staleDays)
      : 7;

    const { doctorMemories, getMemoryById, recordMemoryMetric } =
      await import('../db.js');
    const report = doctorMemories(groupFolder, staleDays);
    const idSet = new Set<string>();
    for (const g of report.duplicateGroups)
      for (const id of g.ids) idSet.add(id);
    for (const g of report.conflictGroups) {
      for (const id of g.positiveIds) idSet.add(id);
      for (const id of g.negativeIds) idSet.add(id);
    }
    for (const id of report.staleWorkingIds) idSet.add(id);

    const memoryMap: Record<string, unknown> = {};
    for (const id of idSet) {
      const mem = getMemoryById(id);
      if (mem) memoryMap[id] = mem;
    }
    recordMemoryMetric(groupFolder, 'doctor', `staleDays=${staleDays}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        group_folder: groupFolder,
        report,
        memoryMap,
      }),
    );
  }

  private async apiMemoryGc(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      jid?: string;
      folder?: string;
      staleDays?: number;
      dryRun?: boolean;
      mode?: 'duplicates' | 'stale' | 'all';
    };
    const groupFolder = this.resolveWebGroupFolder({
      jid: data.jid,
      folder: data.folder,
    });
    if (!groupFolder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid group scope' }));
      return;
    }

    const staleDays = Number.isFinite(Number(data.staleDays))
      ? Number(data.staleDays)
      : 14;
    const dryRun = data.dryRun !== undefined ? data.dryRun : true;
    const mode = data.mode || 'all';

    const { gcMemories, deleteMemory, recordMemoryMetric } =
      await import('../db.js');
    const base = gcMemories(groupFolder, {
      dryRun: true,
      staleWorkingDays: staleDays,
    });
    const duplicateDeletedIds =
      mode === 'stale' ? [] : base.duplicateDeletedIds;
    const staleDeletedIds = mode === 'duplicates' ? [] : base.staleDeletedIds;
    const executeIds = Array.from(
      new Set([...duplicateDeletedIds, ...staleDeletedIds]),
    );

    if (!dryRun) {
      for (const id of executeIds) deleteMemory(id);
    }
    recordMemoryMetric(
      groupFolder,
      `gc:${mode}`,
      `dryRun=${dryRun},staleDays=${staleDays},count=${executeIds.length}`,
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        group_folder: groupFolder,
        result: {
          dryRun,
          mode,
          staleDays,
          duplicateDeletedIds,
          staleDeletedIds,
          totalCandidates: executeIds.length,
        },
      }),
    );
  }

  private async apiMemoryMetrics(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      jid?: string;
      folder?: string;
      hours?: number;
    };
    const groupFolder = this.resolveWebGroupFolder({
      jid: data.jid,
      folder: data.folder,
    });
    if (!groupFolder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid group scope' }));
      return;
    }
    const hours = Number.isFinite(Number(data.hours)) ? Number(data.hours) : 24;

    const { getMemoryMetricSummary } = await import('../db.js');
    const summary = getMemoryMetricSummary(groupFolder, hours);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        group_folder: groupFolder,
        summary,
      }),
    );
  }

  private async apiMemoryConflictKeep(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      jid?: string;
      folder?: string;
      keep_id?: string;
      deprecate_id?: string;
    };
    const groupFolder = this.resolveWebGroupFolder({
      jid: data.jid,
      folder: data.folder,
    });
    if (!groupFolder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid group scope' }));
      return;
    }
    if (!data.keep_id || !data.deprecate_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'keep_id and deprecate_id required' }));
      return;
    }

    try {
      const { resolveConflict, recordMemoryMetric } = await import('../db.js');
      const result = resolveConflict('keep', {
        keepId: data.keep_id,
        deprecateId: data.deprecate_id,
        groupFolder,
      });
      recordMemoryMetric(
        groupFolder,
        'conflict:resolved:keep',
        `${data.keep_id}->${data.deprecate_id}`,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private async apiMemoryConflictMerge(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      jid?: string;
      folder?: string;
      merge_ids?: string[];
      merged_content?: string;
    };
    const groupFolder = this.resolveWebGroupFolder({
      jid: data.jid,
      folder: data.folder,
    });
    if (!groupFolder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid group scope' }));
      return;
    }
    if (
      !Array.isArray(data.merge_ids) ||
      data.merge_ids.length !== 2 ||
      !data.merged_content
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'merge_ids(2) and merged_content required' }),
      );
      return;
    }

    try {
      const { resolveConflict, recordMemoryMetric } = await import('../db.js');
      const result = resolveConflict('merge', {
        mergeIds: [data.merge_ids[0], data.merge_ids[1]],
        mergedContent: data.merged_content,
        groupFolder,
      });
      recordMemoryMetric(
        groupFolder,
        'conflict:resolved:merge',
        data.merge_ids.join(','),
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private apiGetMessages(reqUrl: URL, res: http.ServerResponse): void {
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
          model: m.model || null,
          file_path: m.file_path || null,
        })),
      }),
    );
  }

  private async apiDeleteMessages(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { jid, ids } = body as { jid?: string; ids?: unknown };
    if (!jid || !this.ownsJid(jid)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'valid jid required' }));
      return;
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ids must be a non-empty array' }));
      return;
    }

    const uniqIds = Array.from(
      new Set(
        ids.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      ),
    );
    if (uniqIds.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ids must contain valid message ids' }));
      return;
    }

    const deletedWeb = deleteWebMessagesByIds(jid, uniqIds);
    const { deleteMessagesByIds } = await import('../db.js');
    const deletedMessages = deleteMessagesByIds(jid, uniqIds);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        deleted: deletedWeb,
        deleted_web_messages: deletedWeb,
        deleted_messages: deletedMessages,
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
            last_query_id: t.last_query_id ?? null,
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

  private async apiResetSessions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    if (!this.opts.resetSessions) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session reset is not available' }));
      return;
    }

    const data = body as { scope?: 'all'; jid?: string };
    if (data.scope === 'all') {
      const result = await this.opts.resetSessions({ all: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (typeof data.jid === 'string' && data.jid) {
      const registered = this.opts.registeredGroups();
      if (!registered[data.jid]) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'group not found' }));
        return;
      }
      const result = await this.opts.resetSessions({ groupJid: data.jid });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'scope=all or jid required' }));
  }

  private async apiStopAgent(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (!this.opts.stopAgent) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Stopping agents is not supported' }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    let body: { groupJid?: string };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    if (!body.groupJid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing groupJid' }));
      return;
    }

    const result = await this.opts.stopAgent(body.groupJid);
    if (!result.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: result.error || 'Failed to stop agent' }),
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private apiGetActiveAgentQueries(res: http.ServerResponse): void {
    const queries = this.opts.getActiveAgentQueryTraces?.() ?? [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ queries }));
  }

  private apiListAgentQueries(
    reqUrl: URL,
    res: http.ServerResponse,
  ): void {
    const limitRaw = parseInt(reqUrl.searchParams.get('limit') || '50', 10);
    const offsetRaw = parseInt(reqUrl.searchParams.get('offset') || '0', 10);
    const sourceType = reqUrl.searchParams.get('sourceType') || undefined;
    const sourceRefIdParam = reqUrl.searchParams.get('sourceRefId');
    const sourceRefId = sourceRefIdParam === null ? undefined : sourceRefIdParam;
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 200)
      : 50;
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
    const queries = listAgentQueries(limit, offset, {
      sourceType: sourceType as
        | 'message'
        | 'scheduled_task'
        | 'workflow_delegation'
        | 'web_action'
        | undefined,
      sourceRefId,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        queries,
        limit,
        offset,
        sourceType: sourceType ?? null,
        sourceRefId: sourceRefId ?? null,
        hasMore: queries.length === limit,
      }),
    );
  }

  private apiGetAgentQuery(
    pathname: string,
    res: http.ServerResponse,
  ): void {
    const match = pathname.match(/^\/api\/agent-queries\/([^/]+)(?:\/(steps|events))?$/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const [, queryId, suffix] = match;
    if (suffix === 'steps') {
      const steps = listAgentQuerySteps(queryId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ steps }));
      return;
    }
    if (suffix === 'events') {
      const events = listAgentQueryEvents(queryId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events }));
      return;
    }

    const query = getAgentQuery(queryId);
    if (!query) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Query not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ query }));
  }

  private apiDeleteAgentQueryHistory(res: http.ServerResponse): void {
    const activeQueryIds = (this.opts.getActiveAgentQueryTraces?.() ?? []).map(
      (query) => query.queryId,
    );
    const deleted = deleteHistoricalAgentQueries(activeQueryIds);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted }));
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

  broadcastAgentQueryTraces(): void {
    const queries = this.opts.getActiveAgentQueryTraces?.() ?? [];
    const payload = JSON.stringify({
      type: 'agent_query_trace',
      queries,
    } satisfies OutgoingMsg);

    for (const clients of this.clients.values()) {
      for (const client of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(payload);
        }
      }
    }
  }

  broadcastWorkbenchEvent(event: WorkbenchRealtimeEvent): void {
    const payload = JSON.stringify({
      type: 'workbench_event',
      event,
    } satisfies OutgoingMsg);

    for (const clients of this.clients.values()) {
      for (const client of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(payload);
        }
      }
    }
  }

  private async apiGetWorkflowCreateOptions(
    res: http.ServerResponse,
  ): Promise<void> {
    const { getAvailableWorkflowTypes } = await import('../workflow.js');
    const workflowTypes = getAvailableWorkflowTypes();

    const servicesPath = path.join(GROUPS_DIR, 'global', 'services.json');
    let services: string[] = [];
    if (fs.existsSync(servicesPath)) {
      try {
        const raw = JSON.parse(
          fs.readFileSync(servicesPath, 'utf-8'),
        ) as Record<string, unknown>;
        services = Object.keys(raw).sort((a, b) => a.localeCompare(b, 'zh-CN'));
      } catch (err) {
        logger.warn(
          { err, servicesPath },
          'Failed to parse services.json for task create options',
        );
      }
    }

    const requirementsByService: Record<
      string,
      Array<{ requirement_name: string; deliverables: string[] }>
    > = {};

    for (const service of services) {
      const iterationDir = path.join(
        process.cwd(),
        'projects',
        service,
        'iteration',
      );
      if (!fs.existsSync(iterationDir)) {
        requirementsByService[service] = [];
        continue;
      }

      const requirements = fs
        .readdirSync(iterationDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const reqDir = path.join(iterationDir, d.name);
          const deliverables = fs
            .readdirSync(reqDir, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b, 'zh-CN'));

          return {
            requirement_name: d.name,
            deliverables,
          };
        })
        .sort((a, b) =>
          b.requirement_name.localeCompare(a.requirement_name, 'zh-CN'),
        );

      requirementsByService[service] = requirements;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        services,
        workflow_types: workflowTypes,
        requirements_by_service: requirementsByService,
      }),
    );
  }

  private async apiListWorkflowDefinitions(
    res: http.ServerResponse,
  ): Promise<void> {
    const bundles = listWorkflowDefinitionBundles();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ definitions: bundles }));
  }

  private async apiGetWorkflowDefinition(
    key: string,
    res: http.ServerResponse,
  ): Promise<void> {
    const bundle = getWorkflowDefinitionBundle(key);
    if (!bundle) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Workflow definition not found' }));
      return;
    }

    const published = getPublishedWorkflowDefinition(key);
    const draft =
      [...bundle.versions]
        .sort((a, b) => b.version - a.version)
        .find((version) => version.status === 'draft') || null;
    const previewSource = draft || published;
    const preview = previewSource
      ? {
          compiled: compileWorkflowDefinition(previewSource),
          errors: validateWorkflowDefinition(previewSource),
        }
      : null;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        bundle,
        published_definition: published,
        draft_definition: draft,
        preview,
      }),
    );
  }

  private async apiSaveWorkflowDefinitionDraft(
    key: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      label?: string;
      description?: string;
      definition?: Omit<WorkflowDefinition, 'key' | 'status' | 'version'> & {
        version?: number;
      };
    };

    if (!data.definition) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'definition required' }));
      return;
    }

    const result = saveWorkflowDefinitionDraft({
      key,
      label: data.label,
      description: data.description,
      definition: data.definition,
    });
    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, definition: result.definition }));
  }

  private async apiPublishWorkflowDefinition(
    key: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown = {};
    try {
      body = await this.parseJsonBody(req);
    } catch {
      // Allow empty body.
    }

    const data = body as { version?: number };
    const result = publishWorkflowDefinitionVersion({
      key,
      version: data.version,
    });
    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    loadWorkflowConfigs();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, definition: result.definition }));
  }

  private async apiDeleteWorkflowDefinitionVersion(
    key: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown = {};
    try {
      body = await this.parseJsonBody(req);
    } catch {
      // Allow empty body fallback to fail validation below.
    }

    const data = body as { version?: number };
    if (!Number.isInteger(data.version) || Number(data.version) <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'version required' }));
      return;
    }

    const result = deleteWorkflowDefinitionVersion({
      key,
      version: Number(data.version),
    });
    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    loadWorkflowConfigs();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private async apiGetCards(res: http.ServerResponse): Promise<void> {
    const cards = readCardRegistry();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cards }));
  }

  private async apiSaveCards(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as { cards?: Record<string, Record<string, unknown>> };
    if (!data.cards || typeof data.cards !== 'object') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cards object required' }));
      return;
    }

    const cards = data.cards as Record<string, Record<string, CardConfig>>;
    const errors = this.validateCardRegistry(cards);
    if (errors.length > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: errors.join('; ') }));
      return;
    }

    writeCardRegistry(cards);
    loadWorkflowConfigs();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private parseCardRouteSuffix(suffix: string): {
    workflowType: string;
    cardKey: string;
  } | null {
    const segments = suffix
      .split('/')
      .map((part) => decodeURIComponent(part).trim())
      .filter(Boolean);
    if (segments.length !== 2) {
      return null;
    }
    return {
      workflowType: segments[0],
      cardKey: segments[1],
    };
  }

  private validateCardRegistry(
    cards: Record<string, Record<string, CardConfig>>,
  ): string[] {
    const errors: string[] = [];
    for (const [workflowType, cardGroup] of Object.entries(cards)) {
      for (const [cardKey, cardConfig] of Object.entries(cardGroup || {})) {
        errors.push(
          ...validateCardConfig(`${workflowType}.${cardKey}`, cardConfig),
        );
      }
    }
    return errors;
  }

  private async apiGetCardByPath(
    suffix: string,
    res: http.ServerResponse,
  ): Promise<void> {
    const parsed = this.parseCardRouteSuffix(suffix);
    if (!parsed) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid card route' }));
      return;
    }

    const cards = readCardRegistry();
    const card = cards[parsed.workflowType]?.[parsed.cardKey];
    if (!card) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'card not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        workflow_type: parsed.workflowType,
        card_key: parsed.cardKey,
        card,
      }),
    );
  }

  private async apiSaveSingleCard(
    suffix: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const parsed = this.parseCardRouteSuffix(suffix);
    if (!parsed) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid card route' }));
      return;
    }

    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      workflow_type?: string;
      card_key?: string;
      card?: CardConfig;
    };
    const workflowType = (data.workflow_type || parsed.workflowType || '').trim();
    const cardKey = (data.card_key || parsed.cardKey || '').trim();
    if (!workflowType || !cardKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'workflow_type and card_key are required' }),
      );
      return;
    }
    if (!data.card || typeof data.card !== 'object') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'card object required' }));
      return;
    }

    const cards = readCardRegistry();
    const nextCards = {
      ...cards,
      [workflowType]: {
        ...(cards[workflowType] || {}),
        [cardKey]: data.card,
      },
    };

    const errors = this.validateCardRegistry(nextCards);
    if (errors.length > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: errors.join('; ') }));
      return;
    }

    writeCardRegistry(nextCards);
    loadWorkflowConfigs();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        workflow_type: workflowType,
        card_key: cardKey,
        card: data.card,
      }),
    );
  }

  private async apiGetWorkbenchTasks(res: http.ServerResponse): Promise<void> {
    const tasks = listWorkbenchTasks();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks }));
  }

  private async apiDeleteAllWorkbenchTaskData(
    res: http.ServerResponse,
  ): Promise<void> {
    const { deleteAllWorkbenchTaskData } = await import('../db.js');
    const deleted = deleteAllWorkbenchTaskData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deleted }));
  }

  private async apiDeleteWorkbenchTask(
    reqUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const id = reqUrl.searchParams.get('id') || '';
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing task id' }));
      return;
    }

    const deleted = deleteWorkbenchTaskData(id);
    if (!deleted) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Task not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deleted }));
  }

  private async apiGetWorkbenchTask(
    reqUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const id = reqUrl.searchParams.get('id') || '';
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing task id' }));
      return;
    }

    const detail = getWorkbenchTaskDetail(id);
    if (!detail) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Task not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(detail));
  }

  private async apiCreateWorkbenchTask(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      title?: string;
      name?: string;
      service?: string;
      source_jid?: string;
      start_from?: string;
      workflow_type?: string;
      context?: Record<string, unknown>;
    };
    const title = data.title?.trim() || data.name?.trim();

    if (
      !title ||
      !data.service ||
      !data.source_jid ||
      !data.start_from ||
      !data.workflow_type
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            'title, service, source_jid, start_from, workflow_type required',
        }),
      );
      return;
    }

    const result = createWorkbenchTask({
      title,
      service: data.service,
      sourceJid: data.source_jid,
      startFrom: data.start_from,
      workflowType: data.workflow_type,
      context: data.context,
    });

    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    const detail = getWorkbenchTaskDetail(result.workflowId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        workflow_id: result.workflowId,
        task_id: detail?.task.id || null,
        task: detail?.task || null,
        detail,
      }),
    );
  }

  private async apiWorkbenchTaskAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      task_id?: string;
      subtask_id?: string;
      action?:
        | 'approve'
        | 'revise'
        | 'pause'
        | 'resume'
        | 'cancel'
        | 'skip'
        | 'submit_access_token';
      revision_text?: string;
      context?: Record<string, unknown>;
    };

    if (!data.task_id || !data.action) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'task_id and action required' }));
      return;
    }

    const result = runWorkbenchTaskAction({
      taskId: data.task_id,
      action: data.action,
      subtaskId: data.subtask_id,
      revisionText: data.revision_text,
      context: data.context,
    });
    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    const detail = getWorkbenchTaskDetail(data.task_id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, task: detail?.task || null }));
  }

  private findPreferredMainGroupJid(): string | null {
    const groups = this.opts.registeredGroups();
    const webMain = Object.entries(groups).find(
      ([jid, group]) => jid.startsWith('web:') && group.isMain,
    );
    if (webMain) return webMain[0];

    const anyMain = Object.entries(groups).find(([, group]) => group.isMain);
    return anyMain ? anyMain[0] : null;
  }

  private async apiGetTodayPlanOverview(
    reqUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const planDate = reqUrl.searchParams.get('date') || getTodayPlanDateKey();
    const overview = getTodayPlanOverview(planDate);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(overview));
  }

  private async apiGetTodayPlan(
    reqUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const planId = reqUrl.searchParams.get('id') || '';
    const planDate = reqUrl.searchParams.get('date') || '';
    const detail = getTodayPlanDetail({
      planId: planId || undefined,
      planDate: !planId ? planDate || getTodayPlanDateKey() : undefined,
      groups: this.opts.registeredGroups(),
    });
    if (!detail) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Today plan not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(detail));
  }

  private async apiCreateTodayPlan(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      plan_date?: string;
      continue_from_plan_id?: string;
    };
    try {
      const plan = createOrContinueTodayPlan({
        planDate: data.plan_date || getTodayPlanDateKey(),
        continueFromPlanId: data.continue_from_plan_id || undefined,
      });
      const detail = getTodayPlanDetail({
        planId: plan.id,
        groups: this.opts.registeredGroups(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, plan, detail }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private async apiCompleteTodayPlan(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as { plan_id?: string };
    if (!data.plan_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'plan_id required' }));
      return;
    }

    const plan = completeTodayPlan(data.plan_id);
    if (!plan) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Today plan not found' }));
      return;
    }

    const detail = getTodayPlanDetail({
      planId: plan.id,
      groups: this.opts.registeredGroups(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, plan, detail }));
  }

  private async apiCreateTodayPlanItem(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as { plan_id?: string };
    if (!data.plan_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'plan_id required' }));
      return;
    }

    try {
      const item = createTodayPlanItemForPlan(data.plan_id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, item }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private async apiPatchTodayPlanItem(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      item_id?: string;
      title?: string;
      detail?: string;
      order_index?: number;
      associations?: {
        workbench_task_ids?: string[];
        chat_selections?: Array<{
          group_jid: string;
          message_ids?: string[];
        }>;
        services?: Array<{
          service: string;
          branches: string[];
        }>;
      };
    };
    if (!data.item_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'item_id required' }));
      return;
    }

    try {
      const item = patchTodayPlanItem({
        itemId: data.item_id,
        title: data.title,
        detail: data.detail,
        order_index: data.order_index,
        associations: data.associations
          ? {
              workbench_task_ids: Array.isArray(data.associations.workbench_task_ids)
                ? data.associations.workbench_task_ids
                : [],
              chat_selections: Array.isArray(data.associations.chat_selections)
                ? data.associations.chat_selections.map((selection) => ({
                    group_jid: selection.group_jid,
                    message_ids: Array.isArray(selection.message_ids)
                      ? selection.message_ids
                      : [],
                  }))
                : [],
              services: Array.isArray(data.associations.services)
                ? data.associations.services
                : [],
            }
          : undefined,
      });
      if (!item) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Today plan item not found' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, item }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private async apiDeleteTodayPlanItem(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as { item_id?: string };
    if (!data.item_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'item_id required' }));
      return;
    }

    try {
      const deleted = removeTodayPlanItem(data.item_id);
      if (!deleted) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Today plan item not found' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, deleted }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private async apiGetTodayPlanChatOptions(
    reqUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const jid = reqUrl.searchParams.get('jid') || '';
    if (!jid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'jid required' }));
      return;
    }

    const messages = listTodayPlanChatMessages(jid);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jid, messages }));
  }

  private async apiGetTodayPlanServices(
    res: http.ServerResponse,
  ): Promise<void> {
    const services = listTodayPlanServices();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ services }));
  }

  private async apiGetTodayPlanServiceBranches(
    reqUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const service = reqUrl.searchParams.get('service') || '';
    if (!service) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'service required' }));
      return;
    }

    const branches = listTodayPlanServiceBranches(service);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service, branches }));
  }

  private async apiGetTodayPlanServiceCommit(
    reqUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
    const service = reqUrl.searchParams.get('service') || '';
    const commit = reqUrl.searchParams.get('commit') || '';
    if (!service || !commit) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'service and commit required' }));
      return;
    }

    const detail = getTodayPlanServiceCommitDiff({ service, commit });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(detail));
  }

  private async apiPrepareTodayPlanMailDraft(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as { plan_id?: string; name?: string; to?: string[]; cc?: string[] };
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!data.plan_id || !name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'plan_id and name required' }));
      return;
    }

    try {
      const draft = await prepareTodayPlanMailDraft({
        planId: data.plan_id,
        groups: this.opts.registeredGroups(),
        name,
        to: Array.isArray(data.to) ? data.to : [],
        cc: Array.isArray(data.cc) ? data.cc : [],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, draft }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /not found/i.test(message) ? 404 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  }

  private async apiConfirmTodayPlanMailDraft(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      draft_id?: string;
      subject?: string;
      body?: string;
      to?: string[];
      cc?: string[];
      bcc?: string[];
    };
    if (!data.draft_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'draft_id required' }));
      return;
    }

    try {
      const draft = await confirmTodayPlanMailDraft({
        draftId: data.draft_id,
        subject: typeof data.subject === 'string' ? data.subject : undefined,
        body: typeof data.body === 'string' ? data.body : undefined,
        to: Array.isArray(data.to) ? data.to : undefined,
        cc: Array.isArray(data.cc) ? data.cc : undefined,
        bcc: Array.isArray(data.bcc) ? data.bcc : undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, draft }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /not found/i.test(message) ? 404 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  }

  private injectWorkbenchReply(chatJid: string, content: string): void {
    const now = Date.now();
    const groups = this.opts.registeredGroups();
    const chatName = groups[chatJid]?.name || chatJid;
    this.opts.onChatMetadata(chatJid, now.toString(), chatName, 'web', true);
    const msg: NewMessage = {
      id: `wb_${now}_${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Web User',
      content,
      timestamp: now.toString(),
      is_from_me: true,
      is_bot_message: false,
      model: null,
    };
    this.opts.onMessage(chatJid, msg);
    if (this.ownsJid(chatJid)) {
      storeWebMessage({
        ...msg,
        content,
        model: null,
      });
    }
  }

  private async apiWorkbenchActionItem(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      task_id?: string;
      action_item_id?: string;
      action?: 'confirm' | 'skip' | 'cancel' | 'reply';
      reply_text?: string;
    };
    if (!data.task_id || !data.action_item_id || !data.action) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'task_id, action_item_id and action required',
        }),
      );
      return;
    }

    const detail = getWorkbenchTaskDetail(data.task_id);
    const item = detail?.action_items?.find(
      (entry) => entry.id === data.action_item_id,
    );
    if (!detail || !item) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Action item not found' }));
      return;
    }

    if (data.action === 'reply') {
      const replyText = data.reply_text?.trim();
      if (!replyText) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'reply_text required' }));
        return;
      }
      const groups = this.opts.registeredGroups();
      const targetEntry = Object.entries(groups).find(
        ([, group]) => group.folder === item.group_folder,
      );
      if (!targetEntry) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Target group not found' }));
        return;
      }
      const [chatJid] = targetEntry;

      if (
        (item.source_type === 'ask_user_question' ||
          item.source_type === 'request_human_input') &&
        item.source_ref_id &&
        item.group_folder
      ) {
        const groups = this.opts.registeredGroups();
        const result = await handleAskQuestionResponse({
          requestId: item.source_ref_id,
          groupFolder: item.group_folder,
          userId: 'web_user',
          answer: replyText,
          registeredGroups: groups,
          sendMessage: async () => {},
        });

        if (!result.ok && !result.completed) {
          await dispatchCurrentAskQuestion({
            requestId: item.source_ref_id,
            groupFolder: item.group_folder,
            validationError: result.userMessage,
            validationErrors: result.validationErrors,
            registeredGroups: groups,
            sendMessage: async () => {},
          });
        }

        if (!result.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.userMessage }));
          return;
        }
      } else {
        this.injectWorkbenchReply(chatJid, replyText);
        this.opts.enqueueMessageCheck?.(chatJid);
      }

      if (item.source_type === 'send_message') {
        runWorkbenchActionItemAction({
          taskId: data.task_id,
          actionItemId: data.action_item_id,
          action: 'confirm',
        });
      }
    } else {
      if (
        (data.action === 'confirm' || data.action === 'skip' || data.action === 'cancel') &&
        item.source_ref_id &&
        item.group_folder
      ) {
        const groups = this.opts.registeredGroups();
        const targetEntry = Object.entries(groups).find(
          ([, group]) => group.folder === item.group_folder,
        );
        if (targetEntry) {
          const [chatJid] = targetEntry;
          const signal =
            data.action === 'confirm'
              ? 'confirmed'
              : data.action === 'skip'
                ? 'skip'
                : 'cancel';
          this.injectWorkbenchReply(
            chatJid,
            `/answer ${item.source_ref_id} ${signal}`,
          );
          this.opts.enqueueMessageCheck?.(chatJid);
        }
      }
      const result = runWorkbenchActionItemAction({
        taskId: data.task_id,
        actionItemId: data.action_item_id,
        action: data.action,
      });
      if (result.error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error }));
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private async apiWorkbenchTaskComment(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    const data = body as {
      task_id?: string;
      author?: string;
      content?: string;
    };
    if (!data.task_id || !data.content?.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'task_id and content required' }));
      return;
    }
    const result = addWorkbenchComment({
      taskId: data.task_id,
      author: data.author?.trim() || 'Web User',
      content: data.content,
    });
    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private async apiWorkbenchTaskAsset(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    const data = body as {
      task_id?: string;
      title?: string;
      asset_type?: string;
      path?: string;
      url?: string;
      note?: string;
    };
    if (!data.task_id || !data.title?.trim() || !data.asset_type?.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'task_id, title, asset_type required' }));
      return;
    }
    const result = addWorkbenchAsset({
      taskId: data.task_id,
      title: data.title.trim(),
      assetType: data.asset_type.trim(),
      path: data.path,
      url: data.url,
      note: data.note,
    });
    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private async apiWorkbenchSubtaskRetry(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    const data = body as {
      task_id?: string;
      subtask_id?: string;
      retry_note?: string;
    };
    if (!data.task_id || !data.subtask_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'task_id and subtask_id required' }));
      return;
    }
    const result = retryWorkbenchSubtask({
      taskId: data.task_id,
      subtaskId: data.subtask_id,
      retryNote: data.retry_note,
    });
    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private async apiCardAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
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
      const mergedFormValue = {
        ...(value || {}),
        ...(formValue || {}),
      };
      this.onCardAction({
        action: value.action,
        user_id: 'web_user',
        message_id: cardId || '',
        workflow_id: value.workflow_id,
        group_folder: value.group_folder,
        form_value: mergedFormValue,
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private apiListWikiMaterials(res: http.ServerResponse): void {
    const materials = listWikiMaterialSummaries(200);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ materials }));
  }

  private apiGetWikiMaterial(reqUrl: URL, res: http.ServerResponse): void {
    const id = (reqUrl.searchParams.get('id') || '').trim();
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'id required' }));
      return;
    }
    const detail = getWikiMaterialDetail(id);
    if (!detail) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'material not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(detail));
  }

  private apiDeleteWikiMaterial(reqUrl: URL, res: http.ServerResponse): void {
    const id = (reqUrl.searchParams.get('id') || '').trim();
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'id required' }));
      return;
    }
    try {
      const result = deleteWikiMaterial(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private async apiImportWikiMaterial(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      title?: string;
      note?: string;
      text?: string;
      hostPath?: string;
    };

    try {
      const material =
        typeof data.text === 'string' && data.text.trim()
          ? importWikiMaterialFromText({
              title: data.title?.trim() || '未命名资料',
              note: data.note,
              text: data.text,
            })
          : data.hostPath
            ? importWikiMaterialFromUpload({
                title: data.title,
                note: data.note,
                hostPath: data.hostPath,
              })
            : null;

      if (!material) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'text or hostPath required' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, material }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private apiListWikiDrafts(res: http.ServerResponse): void {
    const drafts = listWikiDrafts(200).map((draft) => {
      let materialCount = 0;
      try {
        materialCount = JSON.parse(draft.material_ids_json).length;
      } catch {
        materialCount = 0;
      }
      const detail = getWikiDraftDetail(draft.id);
      return {
        ...draft,
        material_count: materialCount,
        publish_preview_summary: detail?.publish_preview_summary || null,
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ drafts }));
  }

  private async apiBulkDeleteWikiDrafts(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      draft_ids?: string[];
    };
    if (!Array.isArray(data.draft_ids) || data.draft_ids.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'draft_ids required' }));
      return;
    }

    try {
      const result = bulkDeleteWikiDrafts(data.draft_ids);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private apiGetWikiDraft(reqUrl: URL, res: http.ServerResponse): void {
    const id = (reqUrl.searchParams.get('id') || '').trim();
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'id required' }));
      return;
    }
    const detail = getWikiDraftDetail(id);
    if (!detail) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'draft not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(detail));
  }

  private apiDeleteWikiDraft(reqUrl: URL, res: http.ServerResponse): void {
    const id = (reqUrl.searchParams.get('id') || '').trim();
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'id required' }));
      return;
    }
    try {
      const result = deleteWikiDraft(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private async apiGenerateWikiDraft(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as {
      material_ids?: string[];
      target_slug?: string;
      title?: string;
      page_kind?: string;
      instruction?: string;
    };
    if (!Array.isArray(data.material_ids) || data.material_ids.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'material_ids required' }));
      return;
    }

    const job = queueWikiDraftGenerationJob({
      materialIds: data.material_ids,
      targetSlug: data.target_slug,
      title: data.title,
      pageKind: data.page_kind,
      instruction: data.instruction,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, job }));
  }

  private async apiPublishWikiDraft(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const data = body as { draft_id?: string };
    if (!data.draft_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'draft_id required' }));
      return;
    }

    try {
      const result = publishWikiDraft(data.draft_id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private apiListWikiPages(res: http.ServerResponse): void {
    const pages = listWikiPageSummaries(200);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pages }));
  }

  private apiGetWikiPage(reqUrl: URL, res: http.ServerResponse): void {
    const slug = (reqUrl.searchParams.get('slug') || '').trim();
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'slug required' }));
      return;
    }
    const detail = getWikiPageDetail(slug);
    if (!detail) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'page not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(detail));
  }

  private apiDeleteWikiPage(reqUrl: URL, res: http.ServerResponse): void {
    const slug = (reqUrl.searchParams.get('slug') || '').trim();
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'slug required' }));
      return;
    }
    try {
      const result = deleteWikiPage(slug);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private apiSearchWikiPages(reqUrl: URL, res: http.ServerResponse): void {
    const query = (reqUrl.searchParams.get('q') || '').trim();
    const limit = Math.max(
      1,
      Math.min(20, Number.parseInt(reqUrl.searchParams.get('limit') || '10', 10) || 10),
    );
    const results = query ? searchWikiPages(query, limit) : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results }));
  }

  private apiListWikiJobs(res: http.ServerResponse): void {
    const jobs = listWikiJobs(100);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jobs }));
  }

  private apiGetWikiJob(reqUrl: URL, res: http.ServerResponse): void {
    const id = (reqUrl.searchParams.get('id') || '').trim();
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'id required' }));
      return;
    }
    const job = getWikiJob(id);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'job not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ job }));
  }

  private async apiUpload(
    req: http.IncomingMessage,
    reqUrl: URL,
    res: http.ServerResponse,
  ): Promise<void> {
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
    const parts = text
      .split(boundary)
      .filter((p) => p.trim() && !p.startsWith('--'));
    const uploadedFiles: { name: string; hostPath: string }[] = [];

    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const header = part.slice(0, headerEnd);
      const data = part.slice(
        headerEnd + 4,
        part.endsWith('\r\n') ? -2 : undefined,
      );

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
      logger.info(
        { filename, size: fileData.length, jid, hostPath: filePath },
        'Web channel file uploaded',
      );
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
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
      '.js': 'application/javascript',
      '.html': 'text/html',
      '.css': 'text/css',
      '.zip': 'application/zip',
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
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
      '.js': 'application/javascript',
      '.ts': 'application/typescript',
      '.py': 'text/x-python',
      '.html': 'text/html',
      '.css': 'text/css',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
    };
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
    });
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
    send({
      type: 'agent_status',
      agents: this.opts.getAgentStatus?.() ?? [],
    });
    send({
      type: 'agent_query_trace',
      queries: this.opts.getActiveAgentQueryTraces?.() ?? [],
    });

    // Register this client for ALL web groups so it receives messages
    // from every group in real-time (frontend shows unread badge for non-active groups)
    const registered = this.opts.registeredGroups();
    for (const [jid] of Object.entries(registered)) {
      if (!this.ownsJid(jid)) continue;
      let clients = this.clients.get(jid);
      if (!clients) {
        clients = new Set();
        this.clients.set(jid, clients);
      }
      clients.add({ ws, groupFolder: jid.replace('web:', '') });
    }

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
          model: null,
        };
        // Create chat record first (required for foreign key in messages table)
        const groups = this.opts.registeredGroups();
        const chatName = groups[chatJid]?.name || chatJid;
        this.opts.onChatMetadata(
          chatJid,
          now.toString(),
          chatName,
          'web',
          true,
        );
        this.opts.onMessage(chatJid, newMsg);
        // Also persist to web message DB for UI history (with original content)
        storeWebMessage({
          ...newMsg,
          content,
          reply_to_id: replyToId,
          model: newMsg.model ?? null,
        });
        break;
      }
      case 'select_group': {
        const chatJid = msg.chatJid;
        if (!chatJid || !this.ownsJid(chatJid)) {
          send({ type: 'error', message: 'Invalid chat JID' });
          return;
        }
        // Send current groups list
        const registered = this.opts.registeredGroups();
        send({
          type: 'groups',
          groups: Object.entries(registered)
            .filter(([jid]) => jid.startsWith('web:'))
            .map(([jid, g]) => ({
              jid,
              name: g.name,
              folder: g.folder,
              isMain: g.isMain ?? false,
            })),
          selectedJid: chatJid,
        });
        break;
      }
      case 'card_action': {
        const { value, cardId, formValue } = msg as IncomingMsg;
        if (!value?.action) {
          send({
            type: 'error',
            message: 'value.action required for card_action',
          });
          return;
        }
        if (this.onCardAction) {
          const mergedFormValue = {
            ...(value || {}),
            ...(formValue || {}),
          };
          this.onCardAction({
            action: value.action,
            user_id: 'web_user',
            message_id: cardId || '',
            workflow_id: value.workflow_id,
            group_folder: value.group_folder,
            form_value: mergedFormValue,
          });
        }
        break;
      }
      default:
        send({
          type: 'error',
          message: `Unknown message type: ${(msg as any).type}`,
        });
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
