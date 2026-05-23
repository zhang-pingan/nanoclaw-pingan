import http from 'http';
import path from 'path';
import fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';

import {
  adoptAssistantEvolutionItemForApi,
  approveAssistantEvolutionImplementationForApi,
  cancelAssistantEvolutionItemForApi,
  clearAssistantDataForApi,
  getAssistantEvolutionItemForApi,
  getAssistantEvolutionStateForApi,
  getAssistantState,
  listAssistantEvolutionItemsForApi,
  listAssistantChatForApi,
  listAgentInboxForApi,
  pauseAssistantEvolutionItemForApi,
  runAgentInboxActionForApi,
  runAssistantEvolutionTickForApi,
  runAssistantScanForApi,
  resumeAssistantEvolutionItemForApi,
  sendAssistantChatMessageForApi,
  updateAssistantSettingsForApi,
} from '../assistant/assistant-api.js';
import { resolveTodayPlanInboxItemsForDate } from '../assistant/today-plan-inbox.js';
import type { AssistantRealtimeEvent } from '../assistant/assistant-events.js';
import { buildAgentQueryTraceDetail } from '../agent-query-trace-detail.js';
import {
  AgentStatusInfo,
  DesktopCaptureOptions,
  DesktopCaptureResult,
} from '../types.js';
import type { WorkbenchRealtimeEvent } from '../workbench-events.js';
import {
  buildCardActionPayload,
  buildCardStringFormValues,
} from '../card-action-payload.js';
import { validateCardConfig } from '../card-config.js';
import type { CardConfig } from '../card-config.js';
import { validateCardRegistryKey } from '../card-files.js';
import { WORKFLOW_CREATE_FIELD_TYPES } from '../workflow-definition.js';
import type { WorkflowDefinition } from '../workflow-definition.js';
import { registerChannel, ChannelFactory, ChannelOpts } from './registry.js';
import {
  AI_IMAGES_DIR,
  ASSISTANT_NAME,
  ATTACHMENTS_DIR,
  DESKTOP_CAPTURES_DIR,
  GROUPS_DIR,
  DATA_DIR,
  PROJECT_ROOT,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  CardActionHandler,
  CardActionResult,
  InteractiveCard,
  NewMessage,
} from '../types.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import {
  initWebDb,
  storeWebMessage,
  getWebMessageById,
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
  getAgentQueriesOverview,
  getAssistantChatMessageById,
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
import {
  getWorkflowTypeConfig,
  loadWorkflowConfigs,
} from '../workflow-config.js';
import {
  listWorkflowArtifactContracts,
  saveWorkflowArtifactContract,
} from '../workflow-artifact-contract.js';
import { listWorkflowActionHandlerDetails } from '../workflow-actions/index.js';
import {
  cancelWorkflow,
  pauseWorkflow,
  resumeWorkflowInterrupt,
  retryWorkflowStage,
  returnWorkflowToInterruptStage,
} from '../workflow.js';
import { loadMysqlConfigs } from '../mysql-proxy.js';
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
import { buildHumanInputCard } from '../human-input-card.js';
import {
  bulkDeleteWikiDrafts,
  clearWikiData,
  deleteFinishedWikiJobs,
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
  stopWikiJob,
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
const DESKTOP_CAPTURE_DIR = DESKTOP_CAPTURES_DIR;
const DESKTOP_CAPTURE_TIMEOUT_MS = 30_000;
const DESKTOP_CAPTURE_MAX_BASE64_BYTES = 64 * 1024 * 1024;

const LOCAL_FILE_ROOTS: Record<string, string> = {
  uploads: UPLOADS_DIR,
  groups: GROUPS_DIR,
  attachments: ATTACHMENTS_DIR,
  'desktop-captures': DESKTOP_CAPTURES_DIR,
  'ai-images': AI_IMAGES_DIR,
};

function isPathInsideBase(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(
    path.resolve(baseDir),
    path.resolve(targetPath),
  );
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function resolveServableLocalFilePath(
  filePath: string | null | undefined,
): string | null {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  for (const rootDir of Object.values(LOCAL_FILE_ROOTS)) {
    if (isPathInsideBase(rootDir, resolved)) return resolved;
  }
  return null;
}

function getMessageFileUrl(
  chatJid: string,
  messageId: string,
  filePath: string | null | undefined,
): string | null {
  if (!chatJid || !messageId || !resolveServableLocalFilePath(filePath)) {
    return null;
  }
  return `/api/message-files/${encodeURIComponent(chatJid)}/${encodeURIComponent(
    messageId,
  )}`;
}

function getServicesConfigPath(): string {
  return path.join(GROUPS_DIR, 'global', 'services.json');
}

function getContainerSkillsDir(): string {
  return path.join(PROJECT_ROOT, 'container', 'skills');
}

function listContainerSkillNames(): string[] {
  const skillsDir = getContainerSkillsDir();
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(skillsDir, name, 'SKILL.md')))
    .sort((a, b) => a.localeCompare(b));
}

function sortServiceNames(services: ServiceConfigRegistry): string[] {
  return Object.keys(services).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function readServiceConfigRegistry(): {
  services: ServiceConfigRegistry;
  exists: boolean;
  path: string;
} {
  const servicesPath = getServicesConfigPath();
  if (!fs.existsSync(servicesPath)) {
    return { services: {}, exists: false, path: servicesPath };
  }

  const parsed = JSON.parse(fs.readFileSync(servicesPath, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('services.json must be a JSON object');
  }

  return {
    services: parsed as ServiceConfigRegistry,
    exists: true,
    path: servicesPath,
  };
}

function validateServiceConfigRegistry(
  services: unknown,
): ServiceConfigRegistry {
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new Error('services object required');
  }

  const registry = services as Record<string, unknown>;
  const normalized: ServiceConfigRegistry = {};
  for (const [serviceName, config] of Object.entries(registry)) {
    const name = serviceName.trim();
    if (!name) {
      throw new Error('service name cannot be empty');
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`service "${name}" config must be an object`);
    }
    normalized[name] = config as Record<string, unknown>;
  }
  return normalized;
}

function writeServiceConfigRegistry(services: ServiceConfigRegistry): void {
  const servicesPath = getServicesConfigPath();
  fs.mkdirSync(path.dirname(servicesPath), { recursive: true });
  fs.writeFileSync(
    `${servicesPath}.tmp`,
    `${JSON.stringify(services, null, 2)}\n`,
  );
  fs.renameSync(`${servicesPath}.tmp`, servicesPath);
}

type MultipartFilePart = {
  name: string;
  filename: string;
  data: Buffer;
};

type MultipartPart = {
  name: string;
  filename?: string;
  data: Buffer;
};

export function parseMultipartBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (match?.[1] || match?.[2] || '').trim() || null;
}

export function parseMultipartFileParts(
  body: Buffer,
  boundary: string,
): MultipartFilePart[] {
  return parseMultipartParts(body, boundary)
    .filter((part) => part.filename)
    .map((part) => ({
      name: part.name,
      filename: part.filename || '',
      data: part.data,
    }));
}

export function parseMultipartParts(
  body: Buffer,
  boundary: string,
): MultipartPart[] {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const parts: MultipartPart[] = [];
  let searchIndex = 0;

  while (searchIndex < body.length) {
    const boundaryIndex = body.indexOf(boundaryBuffer, searchIndex);
    if (boundaryIndex === -1) break;

    let cursor = boundaryIndex + boundaryBuffer.length;
    if (body[cursor] === 45 && body[cursor + 1] === 45) {
      break;
    }
    if (body[cursor] === 13 && body[cursor + 1] === 10) {
      cursor += 2;
    }

    const headerEnd = body.indexOf(headerSeparator, cursor);
    if (headerEnd === -1) break;
    const headerText = body.slice(cursor, headerEnd).toString('utf-8');
    const nameMatch = headerText.match(/name="([^"]+)"/i);
    const filenameMatch =
      headerText.match(/filename\*=UTF-8''([^\r\n;]+)/i) ||
      headerText.match(/filename="([^"]+)"/i);

    const contentStart = headerEnd + headerSeparator.length;
    const nextBoundaryIndex = body.indexOf(boundaryBuffer, contentStart);
    if (nextBoundaryIndex === -1) break;

    let contentEnd = nextBoundaryIndex;
    if (body[contentEnd - 2] === 13 && body[contentEnd - 1] === 10) {
      contentEnd -= 2;
    }

    if (nameMatch?.[1]) {
      const part: MultipartPart = {
        name: nameMatch[1],
        data: body.slice(contentStart, contentEnd),
      };
      if (filenameMatch?.[1]) {
        let rawFilename = filenameMatch[1];
        try {
          rawFilename = decodeURIComponent(rawFilename);
        } catch {}
        part.filename = rawFilename;
      }
      parts.push(part);
    }

    searchIndex = nextBoundaryIndex;
  }

  return parts;
}

export function sanitizeUploadFilename(rawFilename: string): string {
  const trimmed = path.basename(String(rawFilename || '').trim());
  const ext = path.extname(trimmed);
  const name = path.basename(trimmed, ext);
  const safeName = name
    .replace(/[\u0000-\u001f\u007f/\\?%*:|"<>]/g, '_')
    .trim();
  const safeExt = ext.replace(/[\u0000-\u001f\u007f/\\?%*:|"<>]/g, '_').trim();
  const base = safeName || `upload-${Date.now()}`;
  return `${base}${safeExt}`;
}

function ensureUniqueUploadPath(baseDir: string, filename: string): string {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(baseDir, filename);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseDir, `${stem}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

function getMultipartTextField(parts: MultipartPart[], name: string): string {
  const part = parts.find((item) => item.name === name && !item.filename);
  return part ? part.data.toString('utf-8').trim() : '';
}

function sanitizeRequirementDirName(rawName: string): string {
  const name = String(rawName || '').trim();
  if (!name || name === '.' || name === '..' || /[\u0000/\\]/.test(name)) {
    throw new Error('需求名称不能为空，且不能包含路径分隔符');
  }
  return name;
}

function normalizeManualRequirementFilename(rawFilename: string): string {
  const filename = String(rawFilename || '').trim();
  if (!filename || filename !== path.basename(filename)) {
    throw new Error('交付物文件名必须是不含路径的文件名');
  }
  if (path.extname(filename).toLowerCase() !== '.md') {
    throw new Error('交付物文件名必须是 .md 文件');
  }
  return filename;
}

function sanitizeDesktopCaptureRequestId(requestId: string): string {
  return requestId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function desktopCaptureExtensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return '.jpg';
  return '.png';
}

function clampDesktopCaptureMaxWidth(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1920;
  return Math.min(Math.max(Math.round(numeric), 320), 4096);
}

// --- Types ---
interface WsClient {
  ws: WebSocket;
  groupFolder: string;
}

interface DesktopCaptureClient {
  id: string;
  supported: boolean;
  platform?: string;
  updatedAt: number;
}

interface PendingDesktopCapture {
  requestId: string;
  startedAt: number;
  includeImage: boolean;
  expectedResponses: number;
  responseCount: number;
  errors: string[];
  timeout: NodeJS.Timeout;
  resolve: (result: DesktopCaptureResult) => void;
}

interface IncomingMsg {
  type:
    | 'message'
    | 'select_group'
    | 'card_action'
    | 'desktop_capture_capabilities'
    | 'desktop_capture_result';
  chatJid?: string;
  content?: string;
  model?: string;
  token?: string;
  replyToId?: string;
  // card_action fields
  cardId?: string;
  requestId?: string;
  value?: Record<string, string>;
  formValue?: Record<string, string>;
  payload?: Record<string, string>;
  supported?: boolean;
  platform?: string;
  ok?: boolean;
  error?: string;
  details?: string;
  capturedAt?: string;
  displays?: unknown[];
  windows?: unknown[];
  imageBase64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  displayId?: string;
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
    | 'workbench_event'
    | 'assistant_state'
    | 'assistant_event'
    | 'config_event'
    | 'desktop_capture_request'
    | 'card_action_result';
  [key: string]: unknown;
}

type ServiceConfigRegistry = Record<string, Record<string, unknown>>;

interface ConfigRealtimeEvent {
  type: 'services_updated';
  updatedAt: string;
  path: string;
  serviceCount: number;
  services: string[];
}

// --- WebChannel ---
class WebChannel {
  name = 'web' as const;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Map<string, Set<WsClient>> = new Map();
  private wsClientIds: Map<WebSocket, string> = new Map();
  private desktopCaptureClients: Map<WebSocket, DesktopCaptureClient> =
    new Map();
  private pendingDesktopCaptures: Map<string, PendingDesktopCapture> =
    new Map();
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

  private canUploadForJid(jid: string): boolean {
    if (!jid) return false;
    if (this.ownsJid(jid)) return true;
    return Boolean(this.opts.registeredGroups()[jid]);
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
    const id = `web_${timestamp}_${Math.random().toString(36).slice(2, 8)}`;
    const fileUrl = getMessageFileUrl(jid, id, filePath);

    // Always persist to web message DB
    const content = caption || `文件: ${path.basename(filePath)}`;
    storeWebMessage({
      id,
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
      id,
      chatJid: jid,
      filePath,
      fileUrl,
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

  async captureDesktop(
    options: DesktopCaptureOptions = {},
  ): Promise<DesktopCaptureResult> {
    const requestId = `desktop-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const includeImage = options.includeImage !== false;
    const includeWindows = options.includeWindows === true;
    const maxWidth = clampDesktopCaptureMaxWidth(options.maxWidth);
    const waitMs =
      typeof options.waitMs === 'number' && Number.isFinite(options.waitMs)
        ? Math.min(Math.max(Math.round(options.waitMs), 1000), 60_000)
        : DESKTOP_CAPTURE_TIMEOUT_MS;

    const targets = [...this.desktopCaptureClients.entries()].filter(
      ([ws, client]) => client.supported && ws.readyState === WebSocket.OPEN,
    );

    if (targets.length === 0) {
      return {
        status: 'error',
        requestId,
        error:
          'No connected Electron web client with desktop capture support. Open the Icarus desktop app and keep it connected.',
      };
    }

    const payload: OutgoingMsg = {
      type: 'desktop_capture_request',
      requestId,
      displayId: options.displayId,
      includeImage,
      includeWindows,
      maxWidth,
    };

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingDesktopCaptures.get(requestId);
        if (!pending) return;
        this.pendingDesktopCaptures.delete(requestId);
        resolve({
          status: 'error',
          requestId,
          error: `Timed out waiting for desktop capture response after ${waitMs}ms.`,
          details:
            pending.errors.length > 0 ? pending.errors.join('\n') : undefined,
        });
      }, waitMs);

      this.pendingDesktopCaptures.set(requestId, {
        requestId,
        startedAt: Date.now(),
        includeImage,
        expectedResponses: targets.length,
        responseCount: 0,
        errors: [],
        timeout,
        resolve,
      });

      for (const [ws] of targets) {
        ws.send(JSON.stringify(payload));
      }
    });
  }

  private completeDesktopCapture(
    requestId: string,
    result: DesktopCaptureResult,
  ): void {
    const pending = this.pendingDesktopCaptures.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingDesktopCaptures.delete(requestId);
    pending.resolve(result);
  }

  private handleDesktopCaptureError(ws: WebSocket, msg: IncomingMsg): void {
    const requestId = msg.requestId || '';
    const pending = this.pendingDesktopCaptures.get(requestId);
    if (!pending) return;

    pending.responseCount += 1;
    const client = this.desktopCaptureClients.get(ws);
    const prefix = client ? `client=${client.id}` : 'client=unknown';
    pending.errors.push(
      `${prefix}: ${msg.error || 'desktop capture failed'}${
        msg.details ? ` (${msg.details})` : ''
      }`,
    );

    if (pending.responseCount >= pending.expectedResponses) {
      this.completeDesktopCapture(requestId, {
        status: 'error',
        requestId,
        error: 'All connected desktop capture clients failed.',
        details: pending.errors.join('\n'),
      });
    }
  }

  private handleDesktopCaptureSuccess(ws: WebSocket, msg: IncomingMsg): void {
    const requestId = msg.requestId || '';
    const pending = this.pendingDesktopCaptures.get(requestId);
    if (!pending) return;

    pending.responseCount += 1;
    const client = this.desktopCaptureClients.get(ws);
    const displays = Array.isArray(msg.displays) ? msg.displays : [];
    const windows = Array.isArray(msg.windows) ? msg.windows : undefined;
    const capturedAt =
      typeof msg.capturedAt === 'string'
        ? msg.capturedAt
        : new Date().toISOString();

    let image: DesktopCaptureResult['image'] | undefined;
    if (pending.includeImage) {
      const imageBase64 =
        typeof msg.imageBase64 === 'string' ? msg.imageBase64 : '';
      if (!imageBase64) {
        pending.errors.push(
          `${client ? `client=${client.id}` : 'client=unknown'}: response did not include image data`,
        );
        if (pending.responseCount >= pending.expectedResponses) {
          this.completeDesktopCapture(requestId, {
            status: 'error',
            requestId,
            error: 'Desktop capture response did not include image data.',
            details: pending.errors.join('\n'),
          });
        }
        return;
      }

      if (
        Buffer.byteLength(imageBase64, 'utf8') >
        DESKTOP_CAPTURE_MAX_BASE64_BYTES
      ) {
        pending.errors.push(
          `${client ? `client=${client.id}` : 'client=unknown'}: image exceeded size limit`,
        );
        if (pending.responseCount >= pending.expectedResponses) {
          this.completeDesktopCapture(requestId, {
            status: 'error',
            requestId,
            error: 'Desktop capture image exceeded size limit.',
            details: pending.errors.join('\n'),
          });
        }
        return;
      }

      const mimeType =
        msg.mimeType === 'image/jpeg' || msg.mimeType === 'image/png'
          ? msg.mimeType
          : 'image/png';
      const imageBuffer = Buffer.from(imageBase64, 'base64');
      const safeRequestId = sanitizeDesktopCaptureRequestId(requestId);
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .replace('Z', '');
      const filename = `${timestamp}-${safeRequestId}${desktopCaptureExtensionForMime(
        mimeType,
      )}`;
      fs.mkdirSync(DESKTOP_CAPTURE_DIR, { recursive: true });
      const hostPath = path.join(DESKTOP_CAPTURE_DIR, filename);
      fs.writeFileSync(hostPath, imageBuffer);

      image = {
        path: hostPath,
        containerPath: `/workspace/desktop-captures/${filename}`,
        mimeType,
        width:
          typeof msg.width === 'number' && Number.isFinite(msg.width)
            ? msg.width
            : 0,
        height:
          typeof msg.height === 'number' && Number.isFinite(msg.height)
            ? msg.height
            : 0,
        byteLength: imageBuffer.length,
        displayId:
          typeof msg.displayId === 'string' && msg.displayId
            ? msg.displayId
            : undefined,
        data: imageBase64,
      };
    }

    this.completeDesktopCapture(requestId, {
      status: 'success',
      requestId,
      source: 'web-client',
      capturedAt,
      displays: displays as DesktopCaptureResult['displays'],
      windows: windows as DesktopCaptureResult['windows'],
      image,
      client: client
        ? {
            id: client.id,
            platform: client.platform,
          }
        : undefined,
      details:
        typeof msg.details === 'string' && msg.details
          ? msg.details
          : undefined,
    });
  }

  async disconnect(): Promise<void> {
    for (const pending of this.pendingDesktopCaptures.values()) {
      clearTimeout(pending.timeout);
      pending.resolve({
        status: 'error',
        requestId: pending.requestId,
        error: 'Web channel disconnected before desktop capture completed.',
      });
    }
    this.pendingDesktopCaptures.clear();
    for (const clients of this.clients.values()) {
      for (const client of clients) {
        client.ws.close();
      }
    }
    this.clients.clear();
    this.wsClientIds.clear();
    this.desktopCaptureClients.clear();
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
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PATCH, DELETE, OPTIONS',
    );
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
        return this.apiGetGroups(reqUrl, res);
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
      if (pathname === '/api/assistant/state' && req.method === 'GET') {
        return this.apiGetAssistantState(res);
      }
      if (pathname === '/api/assistant/settings' && req.method === 'GET') {
        return this.apiGetAssistantSettings(res);
      }
      if (
        pathname === '/api/assistant/settings' &&
        (req.method === 'POST' || req.method === 'PATCH')
      ) {
        return this.apiUpdateAssistantSettings(req, res);
      }
      if (pathname === '/api/assistant/scan' && req.method === 'POST') {
        return void this.apiRunAssistantScan(res);
      }
      if (
        pathname === '/api/assistant/evolution/state' &&
        req.method === 'GET'
      ) {
        return this.apiGetAssistantEvolutionState(res);
      }
      if (
        pathname === '/api/assistant/evolution/items' &&
        req.method === 'GET'
      ) {
        return this.apiListAssistantEvolutionItems(reqUrl, res);
      }
      if (
        pathname === '/api/assistant/evolution/settings' &&
        req.method === 'POST'
      ) {
        return this.apiUpdateAssistantSettings(req, res);
      }
      if (
        pathname === '/api/assistant/evolution/tick' &&
        req.method === 'POST'
      ) {
        return this.apiRunAssistantEvolutionTick(res);
      }
      const evolutionItemActionMatch = pathname.match(
        /^\/api\/assistant\/evolution\/items\/([^/]+)\/(approve-implementation|pause|resume|adopt|cancel)$/,
      );
      if (evolutionItemActionMatch && req.method === 'POST') {
        return this.apiAssistantEvolutionItemAction(
          decodeURIComponent(evolutionItemActionMatch[1]),
          evolutionItemActionMatch[2],
          res,
        );
      }
      const evolutionItemMatch = pathname.match(
        /^\/api\/assistant\/evolution\/items\/([^/]+)$/,
      );
      if (evolutionItemMatch && req.method === 'GET') {
        return this.apiGetAssistantEvolutionItem(
          decodeURIComponent(evolutionItemMatch[1]),
          res,
        );
      }
      if (pathname === '/api/assistant/data' && req.method === 'DELETE') {
        return this.apiClearAssistantData(res);
      }
      if (pathname === '/api/assistant/chat' && req.method === 'GET') {
        return this.apiListAssistantChat(reqUrl, res);
      }
      if (pathname === '/api/assistant/chat/message' && req.method === 'POST') {
        return this.apiSendAssistantChatMessage(req, res);
      }
      if (pathname === '/api/agent-inbox' && req.method === 'GET') {
        return this.apiListAgentInbox(reqUrl, res);
      }
      if (pathname === '/api/agent-inbox/action' && req.method === 'POST') {
        return this.apiAgentInboxAction(req, res);
      }
      if (pathname === '/api/sessions/reset' && req.method === 'POST') {
        return this.apiResetSessions(req, res);
      }
      if (pathname === '/api/agent-queries/active') {
        return this.apiGetActiveAgentQueries(res);
      }
      if (pathname === '/api/agent-queries/overview') {
        return this.apiGetAgentQueriesOverview(res);
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
      if (pathname === '/api/workflow/requirement' && req.method === 'POST') {
        return this.apiCreateWorkflowRequirement(req, res);
      }
      if (pathname === '/api/config/services' && req.method === 'GET') {
        return this.apiGetServiceConfigs(res);
      }
      if (pathname === '/api/config/services' && req.method === 'POST') {
        return this.apiSaveServiceConfigs(req, res);
      }
      if (pathname === '/api/workflow-definitions' && req.method === 'GET') {
        return this.apiListWorkflowDefinitions(res);
      }
      if (
        pathname === '/api/workflow-artifact-contracts' &&
        req.method === 'GET'
      ) {
        return this.apiListWorkflowArtifactContracts(res);
      }
      if (pathname.startsWith('/api/workflow-artifact-contracts/')) {
        const suffix = pathname.slice(
          '/api/workflow-artifact-contracts/'.length,
        );
        if (req.method === 'POST') {
          return this.apiSaveWorkflowArtifactContract(suffix, req, res);
        }
      }
      if (pathname === '/api/workflow-actions' && req.method === 'GET') {
        return this.apiListWorkflowActions(res);
      }
      if (pathname === '/api/skills' && req.method === 'GET') {
        return this.apiGetSkills(res);
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
      const workflowInterruptResumeMatch = pathname.match(
        /^\/api\/workflow-interrupts\/([^/]+)\/resume$/,
      );
      if (workflowInterruptResumeMatch && req.method === 'POST') {
        return this.apiResumeWorkflowInterrupt(
          workflowInterruptResumeMatch[1],
          req,
          res,
        );
      }
      const workflowControlMatch = pathname.match(
        /^\/api\/workflows\/([^/]+)\/(pause|cancel|retry-stage|return-to-stage)$/,
      );
      if (workflowControlMatch && req.method === 'POST') {
        return this.apiWorkflowControl(
          workflowControlMatch[1],
          workflowControlMatch[2],
          req,
          res,
        );
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
      if (pathname === '/api/today-plan/complete' && req.method === 'POST') {
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
      if (pathname === '/api/wiki/jobs/finished' && req.method === 'DELETE') {
        return this.apiDeleteFinishedWikiJobs(res);
      }
      if (pathname === '/api/wiki/job' && req.method === 'GET') {
        return this.apiGetWikiJob(reqUrl, res);
      }
      if (pathname === '/api/wiki/job/stop' && req.method === 'POST') {
        return this.apiStopWikiJob(req, res);
      }
      if (pathname === '/api/wiki/all' && req.method === 'DELETE') {
        return this.apiClearWikiData(res);
      }
      if (pathname.startsWith('/api/uploads/')) {
        return this.apiServeUpload(pathname, res);
      }
      if (pathname.startsWith('/api/message-files/')) {
        return this.apiServeMessageFile(pathname, res);
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

  private getRegisteredGroupChannel(jid: string, folder: string): string {
    const folderChannel = folder.includes('_') ? folder.split('_')[0] : '';
    if (folderChannel) return folderChannel;
    return jid.includes(':') ? jid.split(':')[0] : '';
  }

  private apiGetGroups(reqUrl: URL, res: http.ServerResponse): void {
    const registered = this.opts.registeredGroups();
    const includeAll = reqUrl.searchParams.get('scope') === 'all';
    const groups = Object.entries(registered)
      .filter(([jid]) => includeAll || jid.startsWith('web:'))
      .map(([jid, g]) => ({
        jid,
        name: g.name,
        folder: g.folder,
        channel: this.getRegisteredGroupChannel(jid, g.folder),
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

  private apiGetAssistantState(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getAssistantState()));
  }

  private apiGetAssistantSettings(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ settings: getAssistantState().settings }));
  }

  private async apiUpdateAssistantSettings(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
      const settings = updateAssistantSettingsForApi(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, settings }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Invalid settings body',
        }),
      );
    }
  }

  private async apiRunAssistantScan(res: http.ServerResponse): Promise<void> {
    try {
      const result = await runAssistantScanForApi();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Assistant scan failed',
        }),
      );
    }
  }

  private apiGetAssistantEvolutionState(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getAssistantEvolutionStateForApi()));
  }

  private apiListAssistantEvolutionItems(
    reqUrl: URL,
    res: http.ServerResponse,
  ): void {
    const result = listAssistantEvolutionItemsForApi({
      limit: reqUrl.searchParams.get('limit'),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private apiGetAssistantEvolutionItem(
    id: string,
    res: http.ServerResponse,
  ): void {
    try {
      const result = getAssistantEvolutionItemForApi(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            err instanceof Error ? err.message : 'Evolution item not found',
        }),
      );
    }
  }

  private async apiRunAssistantEvolutionTick(
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const result = await runAssistantEvolutionTickForApi();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Evolution tick failed',
        }),
      );
    }
  }

  private async apiAssistantEvolutionItemAction(
    id: string,
    action: string,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const result =
        action === 'approve-implementation'
          ? approveAssistantEvolutionImplementationForApi(id)
          : action === 'pause'
            ? pauseAssistantEvolutionItemForApi(id)
            : action === 'resume'
              ? resumeAssistantEvolutionItemForApi(id)
              : action === 'cancel'
                ? cancelAssistantEvolutionItemForApi(id)
                : action === 'adopt'
                  ? await adoptAssistantEvolutionItemForApi(id)
                  : null;
      if (!result) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown evolution action' }));
        return;
      }
      res.writeHead(result.ok ? 200 : 409, {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : 'Evolution action failed',
        }),
      );
    }
  }

  private apiClearAssistantData(res: http.ServerResponse): void {
    try {
      const result = clearAssistantDataForApi();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            err instanceof Error ? err.message : 'Assistant data clear failed',
        }),
      );
    }
  }

  private apiListAssistantChat(reqUrl: URL, res: http.ServerResponse): void {
    const result = listAssistantChatForApi({
      limit: reqUrl.searchParams.get('limit') || '80',
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private async apiSendAssistantChatMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
      const message = sendAssistantChatMessageForApi(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            err instanceof Error
              ? err.message
              : 'Assistant chat message failed',
        }),
      );
    }
  }

  private apiListAgentInbox(reqUrl: URL, res: http.ServerResponse): void {
    const result = listAgentInboxForApi({
      status: reqUrl.searchParams.get('status') || 'active',
      limit: reqUrl.searchParams.get('limit') || '100',
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private async apiAgentInboxAction(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown;
    try {
      body = await this.parseJsonBody(req);
      const result = await runAgentInboxActionForApi(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            err instanceof Error ? err.message : 'Agent inbox action failed',
        }),
      );
    }
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
          file_url: getMessageFileUrl(m.chat_jid, m.id, m.file_path),
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

  private apiGetAgentQueriesOverview(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getAgentQueriesOverview()));
  }

  private apiListAgentQueries(reqUrl: URL, res: http.ServerResponse): void {
    const limitRaw = parseInt(reqUrl.searchParams.get('limit') || '50', 10);
    const offsetRaw = parseInt(reqUrl.searchParams.get('offset') || '0', 10);
    const sourceType = reqUrl.searchParams.get('sourceType') || undefined;
    const sourceRefIdParam = reqUrl.searchParams.get('sourceRefId');
    const sourceRefId =
      sourceRefIdParam === null ? undefined : sourceRefIdParam;
    const status = reqUrl.searchParams.get('status') || undefined;
    const failureType = reqUrl.searchParams.get('failureType') || undefined;
    const service = reqUrl.searchParams.get('service') || undefined;
    const workflowType = reqUrl.searchParams.get('workflowType') || undefined;
    const stageKey = reqUrl.searchParams.get('stageKey') || undefined;
    const role = reqUrl.searchParams.get('role') || undefined;
    const hasFileChanges =
      reqUrl.searchParams.get('hasFileChanges') === 'true' || undefined;
    const hasErrors =
      reqUrl.searchParams.get('hasErrors') === 'true' || undefined;
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
        | 'assistant_evolution'
        | 'assistant_action'
        | undefined,
      sourceRefId,
      status,
      failureType,
      service,
      workflowType,
      stageKey,
      role,
      hasFileChanges,
      hasErrors,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        queries,
        limit,
        offset,
        sourceType: sourceType ?? null,
        sourceRefId: sourceRefId ?? null,
        status: status ?? null,
        failureType: failureType ?? null,
        service: service ?? null,
        workflowType: workflowType ?? null,
        stageKey: stageKey ?? null,
        role: role ?? null,
        hasFileChanges: hasFileChanges ? true : null,
        hasErrors: hasErrors ? true : null,
        hasMore: queries.length === limit,
      }),
    );
  }

  private apiGetAgentQuery(pathname: string, res: http.ServerResponse): void {
    const match = pathname.match(
      /^\/api\/agent-queries\/([^/]+)(?:\/(steps|events|detail))?$/,
    );
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const [, queryId, suffix] = match;
    const decodedQueryId = decodeURIComponent(queryId);
    if (suffix === 'steps') {
      const steps = listAgentQuerySteps(decodedQueryId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ steps }));
      return;
    }
    if (suffix === 'events') {
      const events = listAgentQueryEvents(decodedQueryId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events }));
      return;
    }
    if (suffix === 'detail') {
      const detail = buildAgentQueryTraceDetail(decodedQueryId);
      if (!detail) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Query not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(detail));
      return;
    }

    const query = getAgentQuery(decodedQueryId);
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

  broadcastAssistantEvent(event: AssistantRealtimeEvent): void {
    const payload = JSON.stringify({
      type: 'assistant_event',
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

  broadcastConfigEvent(event: ConfigRealtimeEvent): void {
    const payload = JSON.stringify({
      type: 'config_event',
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

  private async apiCreateWorkflowRequirement(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'multipart/form-data required' }));
      return;
    }

    const boundary = parseMultipartBoundary(contentType);
    if (!boundary) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing boundary' }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const parts = parseMultipartParts(Buffer.concat(chunks), boundary);

    try {
      const workflowType = getMultipartTextField(parts, 'workflow_type');
      const entryPoint = getMultipartTextField(parts, 'entry_point');
      const service = getMultipartTextField(parts, 'service');
      const requirementName = sanitizeRequirementDirName(
        getMultipartTextField(parts, 'requirement_name'),
      );

      if (!workflowType || !entryPoint || !service) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error:
              'workflow_type, entry_point, service, requirement_name required',
          }),
        );
        return;
      }

      const services = readServiceConfigRegistry().services;
      if (!Object.prototype.hasOwnProperty.call(services, service)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `未知服务: ${service}` }));
        return;
      }

      const workflowConfig = getWorkflowTypeConfig(workflowType);
      const entryConfig = workflowConfig?.entry_points[entryPoint];
      const manualCreate = entryConfig?.manual_requirement_create;
      if (!manualCreate?.enabled) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '当前入口点不允许手动创建需求' }));
        return;
      }

      const fileConfigs = (manualCreate.files || []).map((file) => ({
        filename: normalizeManualRequirementFilename(file.filename),
        required: file.required !== false,
      }));
      if (fileConfigs.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '当前入口点未配置交付物上传规则' }));
        return;
      }

      const filePartsByName = new Map(
        parts
          .filter((part) => part.filename)
          .map((part) => [part.name, part] as const),
      );
      const writes: Array<{ filename: string; data: Buffer }> = [];
      for (const [index, fileConfig] of fileConfigs.entries()) {
        const part = filePartsByName.get(`file_${index}`);
        if (!part) {
          if (fileConfig.required) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: `缺少必需交付物 ${fileConfig.filename}`,
              }),
            );
            return;
          }
          continue;
        }
        if (path.extname(part.filename || '').toLowerCase() !== '.md') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `仅支持上传 .md 文件: ${part.filename || fileConfig.filename}`,
            }),
          );
          return;
        }
        writes.push({ filename: fileConfig.filename, data: part.data });
      }

      const iterationDir = path.resolve(
        PROJECT_ROOT,
        'projects',
        service,
        'iteration',
      );
      const requirementDir = path.resolve(iterationDir, requirementName);
      if (!isPathInsideBase(iterationDir, requirementDir)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '需求名称非法' }));
        return;
      }
      if (fs.existsSync(requirementDir)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '需求目录已存在' }));
        return;
      }

      fs.mkdirSync(iterationDir, { recursive: true });
      fs.mkdirSync(requirementDir);
      try {
        for (const item of writes) {
          fs.writeFileSync(path.join(requirementDir, item.filename), item.data);
        }
      } catch (err) {
        fs.rmSync(requirementDir, { recursive: true, force: true });
        throw err;
      }

      const deliverables = writes
        .map((item) => item.filename)
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
      logger.info(
        {
          workflowType,
          entryPoint,
          service,
          requirementName,
          deliverables,
          requirementDir,
        },
        'Workbench requirement created from web client',
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          requirement: {
            requirement_name: requirementName,
            deliverables,
          },
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  }

  private async apiGetServiceConfigs(res: http.ServerResponse): Promise<void> {
    try {
      const registry = readServiceConfigRegistry();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          services: registry.services,
          service_names: sortServiceNames(registry.services),
          path: registry.path,
          exists: registry.exists,
        }),
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to read services config');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to read services config',
        }),
      );
    }
  }

  private async apiSaveServiceConfigs(
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

    let services: ServiceConfigRegistry;
    try {
      services = validateServiceConfigRegistry(
        (body as { services?: unknown })?.services,
      );
      writeServiceConfigRegistry(services);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to save services config',
        }),
      );
      return;
    }

    loadWorkflowConfigs();
    loadMysqlConfigs(services);

    const serviceNames = sortServiceNames(services);
    const event: ConfigRealtimeEvent = {
      type: 'services_updated',
      updatedAt: new Date().toISOString(),
      path: getServicesConfigPath(),
      serviceCount: serviceNames.length,
      services: serviceNames,
    };
    this.broadcastConfigEvent(event);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        services,
        service_names: serviceNames,
        path: getServicesConfigPath(),
        updated_at: event.updatedAt,
      }),
    );
  }

  private async apiListWorkflowDefinitions(
    res: http.ServerResponse,
  ): Promise<void> {
    const bundles = listWorkflowDefinitionBundles();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        definitions: bundles,
        workflow_create_field_types: WORKFLOW_CREATE_FIELD_TYPES,
      }),
    );
  }

  private apiListWorkflowArtifactContracts(res: http.ServerResponse): void {
    const contracts = listWorkflowArtifactContracts().map((entry) => ({
      ...entry.contract,
      source_file: entry.source_file
        ? path.relative(PROJECT_ROOT, entry.source_file)
        : null,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ contracts }));
  }

  private async apiSaveWorkflowArtifactContract(
    encodedRef: string,
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

    const data = body as { contract?: unknown };
    const ref = decodeURIComponent(encodedRef || '');
    const result = saveWorkflowArtifactContract({
      ref,
      contract: data.contract ?? body,
    });
    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        contract: result.contract,
        source_file: result.source_file
          ? path.relative(PROJECT_ROOT, result.source_file)
          : null,
      }),
    );
  }

  private async apiGetSkills(res: http.ServerResponse): Promise<void> {
    const skills = listContainerSkillNames();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ skills }));
  }

  private async apiListWorkflowActions(
    res: http.ServerResponse,
  ): Promise<void> {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ actions: listWorkflowActionHandlerDetails() }));
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
        workflow_create_field_types: WORKFLOW_CREATE_FIELD_TYPES,
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
      const workflowTypeError = validateCardRegistryKey(workflowType);
      if (workflowTypeError) {
        errors.push(workflowTypeError);
        continue;
      }
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
    const workflowType = (
      data.workflow_type ||
      parsed.workflowType ||
      ''
    ).trim();
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

    const detail = this.withWorkbenchActionItemCards(
      getWorkbenchTaskDetail(id),
    );
    if (!detail) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Task not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(detail));
  }

  private withWorkbenchActionItemCards<
    T extends NonNullable<ReturnType<typeof getWorkbenchTaskDetail>> | null,
  >(detail: T): T {
    if (!detail) return detail;
    return {
      ...detail,
      action_items: detail.action_items.map((item) => ({
        ...item,
        card: buildHumanInputCard(item, detail.task),
      })),
    };
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

    const detail = this.withWorkbenchActionItemCards(
      getWorkbenchTaskDetail(result.workflowId),
    );
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
      action?: 'pause' | 'resume' | 'cancel' | 'skip';
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
    });
    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    const detail = this.withWorkbenchActionItemCards(
      getWorkbenchTaskDetail(data.task_id),
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, task: detail?.task || null }));
  }

  private async apiResumeWorkflowInterrupt(
    interruptId: string,
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
      action?: string;
      payload?: Record<string, unknown>;
      idempotency_key?: string;
      actor?: {
        userId?: string;
        displayName?: string;
      };
    };
    if (!data.action) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'action required' }));
      return;
    }

    const result = resumeWorkflowInterrupt({
      interruptId,
      action: data.action,
      payload: data.payload || {},
      actor: {
        channel: 'web',
        userId: data.actor?.userId || 'web',
        displayName: data.actor?.displayName,
      },
      idempotencyKey: data.idempotency_key,
    });
    if (!result.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: result.error }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, workflow_id: result.workflowId }));
  }

  private async apiWorkflowControl(
    workflowId: string,
    action: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: unknown = {};
    try {
      body = await this.parseJsonBody(req);
    } catch {
      body = {};
    }
    const data = body as {
      stage_key?: string;
      retry_note?: string;
    };

    const result =
      action === 'pause'
        ? pauseWorkflow(workflowId)
        : action === 'cancel'
          ? cancelWorkflow(workflowId)
          : action === 'retry-stage'
            ? retryWorkflowStage(workflowId, data.stage_key || '', {
                retryNote: data.retry_note,
              })
            : returnWorkflowToInterruptStage(workflowId, data.stage_key || '');

    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: result.error }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, workflow_id: workflowId }));
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
      resolveTodayPlanInboxItemsForDate(plan.plan_date);
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
              workbench_task_ids: Array.isArray(
                data.associations.workbench_task_ids,
              )
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

    const data = body as {
      plan_id?: string;
      name?: string;
      to?: string[];
      cc?: string[];
    };
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
      value?: Record<string, string>;
      formValue?: Record<string, string>;
      form_value?: Record<string, string>;
      payload?: Record<string, unknown>;
      task_id?: string;
      action_item_id?: string;
      action?:
        | 'confirm'
        | 'approve'
        | 'reject'
        | 'revise'
        | 'submit'
        | 'skip'
        | 'cancel'
        | 'reply';
      reply_text?: string;
    };
    if (data.value?.action) {
      const result = await this.apiWorkbenchCardAction({
        value: data.value,
        payload: data.payload,
        formValue: data.formValue || data.form_value,
      });
      if (result.error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const legacyValue = this.buildLegacyWorkbenchActionItemCardValue(data);
    if (legacyValue) {
      const result = await this.apiWorkbenchCardAction({
        value: legacyValue,
        payload: data.payload,
        formValue: data.formValue || data.form_value,
      });
      if (result.error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

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
    res.writeHead(item ? 400 : 404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: item
          ? `Unsupported legacy action: ${data.action}`
          : 'Action item not found',
      }),
    );
  }

  private buildLegacyWorkbenchActionItemCardValue(data: {
    task_id?: string;
    action_item_id?: string;
    action?: string;
    reply_text?: string;
  }): Record<string, string> | null {
    if (!data.task_id || !data.action_item_id || !data.action) return null;
    const detail = getWorkbenchTaskDetail(data.task_id);
    const item = detail?.action_items?.find(
      (entry) => entry.id === data.action_item_id,
    );
    if (!detail || !item) return null;
    const card = buildHumanInputCard(item, detail.task);
    if (data.action === 'reply') {
      const submitValue = card.form?.submitButton.value;
      return {
        ...(submitValue ||
          card.buttons?.[0]?.value || {
            action: 'workbench_action_item',
          }),
        task_id: data.task_id,
        action_item_id: data.action_item_id,
        ...(data.reply_text ? { answer: data.reply_text } : {}),
      };
    }
    if (
      data.action === 'skip' &&
      (item.source_type === 'ask_user_question' ||
        item.source_type === 'request_human_input')
    ) {
      const skipButton = card.buttons?.find(
        (button) => button.value.action === 'ask_question_skip',
      );
      return skipButton
        ? {
            ...skipButton.value,
            task_id: data.task_id,
            action_item_id: data.action_item_id,
          }
        : null;
    }
    if (
      data.action === 'confirm' ||
      data.action === 'approve' ||
      data.action === 'reject' ||
      data.action === 'revise' ||
      data.action === 'submit' ||
      data.action === 'skip' ||
      data.action === 'cancel'
    ) {
      const resumeAction = data.action === 'confirm' ? 'approve' : data.action;
      const actionButton = [
        ...(card.buttons || []),
        ...(card.sections || []).flatMap((section) => section.buttons || []),
        ...(card.form ? [card.form.submitButton] : []),
      ].find((button) => {
        if (button.value.resume_action === resumeAction) return true;
        if (
          button.value.workbench_action === data.action ||
          button.value.workbench_action === resumeAction
        ) {
          return true;
        }
        return (
          data.action === 'confirm' &&
          button.value.workbench_action === 'resolve'
        );
      });
      return {
        ...(actionButton?.value || {
          action:
            item.source_type === 'workflow_interrupt'
              ? 'workflow_interrupt_resume'
              : 'workbench_action_item',
          ...(item.source_ref_id ? { interrupt_id: item.source_ref_id } : {}),
          resume_action: resumeAction,
        }),
        task_id: data.task_id,
        action_item_id: data.action_item_id,
      };
    }
    return null;
  }

  private async apiWorkbenchCardAction(input: {
    value: Record<string, string>;
    payload?: Record<string, unknown>;
    formValue?: Record<string, string>;
  }): Promise<{ error?: string }> {
    const legacyFormValue = input.formValue || {};
    const merged = {
      ...legacyFormValue,
      ...(input.value || {}),
    };
    const payloadSource =
      input.payload ||
      buildCardActionPayload(legacyFormValue, [
        'action',
        'workbench_action',
        'task_id',
        'action_item_id',
        'workflow_id',
        'interrupt_id',
        'resume_action',
        'resume_payload_schema',
        'group_folder',
        'source_type',
        'source_ref_id',
        'request_id',
        'question_id',
        'payload',
      ]);
    const actionFormValue = {
      ...merged,
      payload: JSON.stringify(payloadSource),
    };
    const payload = buildCardActionPayload(actionFormValue);
    const taskId = merged.task_id;
    const actionItemId = merged.action_item_id;
    if (!taskId || !actionItemId) {
      return { error: 'task_id and action_item_id required' };
    }

    const detail = getWorkbenchTaskDetail(taskId);
    const item = detail?.action_items?.find(
      (entry) => entry.id === actionItemId,
    );
    if (!detail || !item) {
      return { error: 'Action item not found' };
    }

    if (merged.action === 'ask_question_answer') {
      const requestId = merged.request_id || item.source_ref_id;
      const groupFolder = merged.group_folder || item.group_folder;
      if (!requestId || !groupFolder) {
        return { error: 'request_id and group_folder required' };
      }
      const result = await handleAskQuestionResponse({
        requestId,
        groupFolder,
        userId: 'web_user',
        answer:
          typeof payload.answer === 'string'
            ? payload.answer
            : merged.answer || merged.reply_text,
        formValues: buildCardStringFormValues(actionFormValue, [
          'action',
          'task_id',
          'action_item_id',
          'request_id',
          'group_folder',
          'question_id',
          'answer',
          'reply_text',
        ]),
        registeredGroups: this.opts.registeredGroups(),
        sendMessage: async () => {},
      });
      if (!result.ok && !result.completed) {
        await dispatchCurrentAskQuestion({
          requestId,
          groupFolder,
          validationError: result.userMessage,
          validationErrors: result.validationErrors,
          registeredGroups: this.opts.registeredGroups(),
          sendMessage: async () => {},
        });
      }
      return result.ok ? {} : { error: result.userMessage };
    }

    if (merged.action === 'ask_question_skip') {
      const requestId = merged.request_id || item.source_ref_id;
      const groupFolder = merged.group_folder || item.group_folder;
      if (!requestId || !groupFolder) {
        return { error: 'request_id and group_folder required' };
      }
      const result = await handleAskQuestionResponse({
        requestId,
        groupFolder,
        userId: 'web_user',
        skip: true,
        registeredGroups: this.opts.registeredGroups(),
        sendMessage: async () => {},
      });
      return result.ok ? {} : { error: result.userMessage };
    }

    if (merged.action === 'cancel_workflow') {
      return runWorkbenchTaskAction({ taskId, action: 'cancel' });
    }
    if (merged.action === 'pause_workflow') {
      return runWorkbenchTaskAction({ taskId, action: 'pause' });
    }
    if (merged.action === 'workflow_interrupt_resume') {
      merged.workbench_action = merged.resume_action;
    }

    const action =
      merged.workbench_action ||
      (merged.action === 'workbench_action_item'
        ? 'resolve'
        : merged.resume_action || merged.action);
    if (
      action !== 'confirm' &&
      action !== 'approve' &&
      action !== 'reject' &&
      action !== 'revise' &&
      action !== 'submit' &&
      action !== 'skip' &&
      action !== 'cancel' &&
      action !== 'resolve'
    ) {
      return { error: `Unsupported action: ${action}` };
    }
    const resumePayload = buildCardActionPayload(actionFormValue, [
      'action',
      'workbench_action',
      'task_id',
      'action_item_id',
      'workflow_id',
      'interrupt_id',
      'resume_action',
      'resume_payload_schema',
      'group_folder',
    ]);
    const result = runWorkbenchActionItemAction({
      taskId,
      actionItemId,
      action,
      payload: resumePayload,
      actor: { channel: 'web', userId: 'workbench' },
    });
    return result.error ? { error: result.error } : {};
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
    const { value, cardId, formValue, payload } = body as {
      value?: Record<string, string>;
      cardId?: string;
      formValue?: Record<string, string>;
      payload?: Record<string, string>;
    };

    if (!value?.action) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'value.action required' }));
      return;
    }

    if (this.onCardAction) {
      const mergedFormValue = {
        ...(formValue || {}),
        ...(value || {}),
      };
      const actionPayload = payload || buildCardActionPayload(formValue);
      const result = await this.onCardAction({
        action: value.action,
        user_id: 'web_user',
        message_id: cardId || '',
        actor_channel: 'web',
        group_jid: value.group_jid,
        workflow_id: value.workflow_id,
        group_folder: value.group_folder,
        form_value: {
          ...mergedFormValue,
          payload: JSON.stringify(actionPayload),
        },
      });
      if (result?.toast?.type === 'error' || result?.ok === false) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: result.toast?.content || 'Card action failed',
            toast: result.toast,
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
      return;
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
      Math.min(
        20,
        Number.parseInt(reqUrl.searchParams.get('limit') || '10', 10) || 10,
      ),
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

  private apiDeleteFinishedWikiJobs(res: http.ServerResponse): void {
    try {
      const result = deleteFinishedWikiJobs();
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

  private async apiStopWikiJob(
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
      job_id?: string;
    };
    if (!data.job_id || !String(data.job_id).trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'job_id required' }));
      return;
    }

    try {
      const result = stopWikiJob(String(data.job_id).trim());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode =
        message === 'Job not found'
          ? 404
          : message.includes('运行中')
            ? 409
            : 400;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  }

  private apiClearWikiData(res: http.ServerResponse): void {
    try {
      const result = clearWikiData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = message.includes('正在运行') ? 409 : 400;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
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
    const boundary = parseMultipartBoundary(contentType);
    if (!boundary) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing boundary' }));
      return;
    }

    // Extract target JID from URL
    // URL is /api/upload?jid=web:main or another registered chat jid.
    const jid = reqUrl.searchParams.get('jid') || '';
    if (!this.canUploadForJid(jid)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid jid' }));
      return;
    }

    const uploadBase = UPLOADS_DIR;
    fs.mkdirSync(uploadBase, { recursive: true });

    // Collect body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    const parts = parseMultipartFileParts(body, boundary);
    const uploadedFiles: {
      name: string;
      hostPath: string;
      agentPath: string;
    }[] = [];

    for (const part of parts) {
      const filename = sanitizeUploadFilename(part.filename);
      const filePath = ensureUniqueUploadPath(uploadBase, filename);
      fs.writeFileSync(filePath, part.data);
      const storedName = path.basename(filePath);
      uploadedFiles.push({
        name: storedName,
        hostPath: filePath,
        agentPath: `/workspace/uploads/${storedName}`,
      });
      logger.info(
        {
          filename: storedName,
          originalFilename: part.filename,
          size: part.data.length,
          jid,
          hostPath: filePath,
        },
        'Web channel file uploaded',
      );
    }

    if (uploadedFiles.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no files found in multipart body' }));
      return;
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

  private apiServeMessageFile(
    pathname: string,
    res: http.ServerResponse,
  ): void {
    // pathname: /api/message-files/{chatJid}/{messageId}
    const parts = pathname.split('/');
    if (parts.length !== 5) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid path' }));
      return;
    }

    const chatJid = decodeURIComponent(parts[3]);
    const messageId = decodeURIComponent(parts[4]);
    const webMessage = getWebMessageById(chatJid, messageId);
    const assistantMessage = webMessage
      ? null
      : getAssistantChatMessageById(chatJid, messageId);
    const filePath = resolveServableLocalFilePath(
      webMessage?.file_path || assistantMessage?.file_path,
    );
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'file not found' }));
      return;
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
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
      '.ts': 'application/typescript',
      '.py': 'text/x-python',
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
    const clientId = `webclient-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    this.wsClientIds.set(ws, clientId);

    const send = (payload: OutgoingMsg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    send({ type: 'connected', message: 'Connected to Icarus' });
    send({
      type: 'agent_status',
      agents: this.opts.getAgentStatus?.() ?? [],
    });
    send({
      type: 'agent_query_trace',
      queries: this.opts.getActiveAgentQueryTraces?.() ?? [],
    });
    send({
      type: 'assistant_state',
      state: getAssistantState(),
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
        void this.handleWsMessage(ws, msg, send).catch((err) => {
          logger.warn({ err, type: msg.type }, 'Web channel WS handler error');
          send({
            type: 'error',
            message: err instanceof Error ? err.message : 'WebSocket error',
          });
        });
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
      this.desktopCaptureClients.delete(ws);
      this.wsClientIds.delete(ws);
    });

    ws.on('error', (err: unknown) => {
      logger.warn({ err }, 'Web channel WS error');
    });
  }

  private async handleWsMessage(
    ws: WebSocket,
    msg: IncomingMsg,
    send: (p: OutgoingMsg) => void,
  ): Promise<void> {
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
              channel: this.getRegisteredGroupChannel(jid, g.folder),
              isMain: g.isMain ?? false,
            })),
          selectedJid: chatJid,
        });
        break;
      }
      case 'card_action': {
        const { value, cardId, formValue, payload, requestId } =
          msg as IncomingMsg;
        if (!value?.action) {
          const error = 'value.action required for card_action';
          send(
            requestId
              ? {
                  type: 'card_action_result',
                  requestId,
                  cardId,
                  ok: false,
                  error,
                  toast: { type: 'error', content: error },
                }
              : {
                  type: 'error',
                  message: error,
                },
          );
          return;
        }
        let result: void | CardActionResult = undefined;
        if (this.onCardAction) {
          const mergedFormValue = {
            ...(formValue || {}),
            ...(value || {}),
          };
          const actionPayload = payload || buildCardActionPayload(formValue);
          result = await this.onCardAction({
            action: value.action,
            user_id: 'web_user',
            message_id: cardId || '',
            actor_channel: 'web',
            group_jid: value.group_jid,
            workflow_id: value.workflow_id,
            group_folder: value.group_folder,
            form_value: {
              ...mergedFormValue,
              payload: JSON.stringify(actionPayload),
            },
          });
        }
        if (requestId) {
          const ok = result?.ok !== false && result?.toast?.type !== 'error';
          send({
            type: 'card_action_result',
            requestId,
            cardId,
            ok,
            error: ok
              ? undefined
              : result?.toast?.content || 'Card action failed',
            toast: result?.toast,
            replacementCard: result?.replacementCard,
          });
        }
        break;
      }
      case 'desktop_capture_capabilities': {
        const clientId =
          this.wsClientIds.get(ws) ||
          `webclient-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.wsClientIds.set(ws, clientId);
        this.desktopCaptureClients.set(ws, {
          id: clientId,
          supported: msg.supported === true,
          platform:
            typeof msg.platform === 'string' && msg.platform
              ? msg.platform
              : undefined,
          updatedAt: Date.now(),
        });
        logger.debug(
          {
            clientId,
            supported: msg.supported === true,
            platform: msg.platform,
          },
          'Web client desktop capture capabilities updated',
        );
        break;
      }
      case 'desktop_capture_result': {
        if (!msg.requestId) {
          send({
            type: 'error',
            message: 'requestId required for desktop_capture_result',
          });
          return;
        }
        if (msg.ok === true) {
          this.handleDesktopCaptureSuccess(ws, msg);
        } else {
          this.handleDesktopCaptureError(ws, msg);
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
