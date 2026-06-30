import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const ENV_FILE = path.join(__dirname, '.env');
const ROOT_ENV_FILE = path.resolve(__dirname, '..', '.env');

function parseEnvValue(value) {
  let result = String(value || '').trim();
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    result = result.slice(1, -1);
  }
  return result.replace(/\\n/g, '\n');
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = parseEnvValue(rawValue);
  }
}

loadEnvFile(ENV_FILE);
loadEnvFile(ROOT_ENV_FILE);

const DATA_DIR = path.join(__dirname, '.data');
const STORE_DIR = process.env.DEEP_RESEARCH_STORE_DIR
  ? path.resolve(__dirname, process.env.DEEP_RESEARCH_STORE_DIR)
  : path.join(DATA_DIR, 'store');
const STORE_INDEX_FILE = path.join(STORE_DIR, 'index.json');
const LEGACY_TASK_STORE_FILE = path.join(DATA_DIR, 'tasks.json');
const AGENT_READABLE_DIR = path.join(DATA_DIR, 'agent-readable');
const STORE_VERSION = 3;
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL =
  process.env.DEEP_RESEARCH_DEFAULT_MODEL || 'o3-deep-research';
const OPENAI_MODELS = ['o3-deep-research', 'o4-mini-deep-research'];
const SUPPORTED_OPENAI_MODELS = new Set(OPENAI_MODELS);
const GPT_RESEARCHER_MODEL = 'gpt-researcher';
const GPT_RESEARCHER_BASE_URL = (
  process.env.GPT_RESEARCHER_BASE_URL || 'http://127.0.0.1:8000'
).replace(/\/+$/, '');
const DEFAULT_GPT_RESEARCHER_REPORT_TYPE = 'research_report';
const GPT_RESEARCHER_REPORT_TYPES = [
  { id: 'research_report', label: 'Research report' },
  { id: 'detailed_report', label: 'Detailed report' },
  { id: 'deep', label: 'Deep research' },
];
const SUPPORTED_GPT_RESEARCHER_REPORT_TYPES = new Set(
  GPT_RESEARCHER_REPORT_TYPES.map((type) => type.id),
);
const GPT_RESEARCHER_REPORT_TYPE = normalizeGptResearcherReportType(
  process.env.GPT_RESEARCHER_REPORT_TYPE,
);
const GPT_RESEARCHER_REPORT_SOURCE =
  process.env.GPT_RESEARCHER_REPORT_SOURCE || 'web';
const GPT_RESEARCHER_TONE = process.env.GPT_RESEARCHER_TONE || 'Objective';
const GPT_RESEARCHER_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.GPT_RESEARCHER_TIMEOUT_MS || 30 * 60_000),
);
const GPT_RESEARCHER_CONNECT_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.GPT_RESEARCHER_CONNECT_TIMEOUT_MS || 10_000),
);
const ICARUS_INTERNAL_API_BASE_URL = (
  process.env.ICARUS_INTERNAL_API_BASE_URL ||
  `http://${process.env.ICARUS_INTERNAL_API_HOST || '127.0.0.1'}:${
    process.env.ICARUS_INTERNAL_API_PORT || '3004'
  }`
).replace(/\/+$/, '');
const ICARUS_INTERNAL_API_TOKEN = process.env.ICARUS_INTERNAL_API_TOKEN || '';
const ICARUS_AGENT_CHAT_JID =
  process.env.ICARUS_DEEP_RESEARCH_AGENT_CHAT_JID ||
  'web:deep-research-analyst';
const ICARUS_AGENT_MOUNTED_ROOT = '/workspace/extra/deep-research';
const DEEP_RESEARCH_AGENT_SYSTEM = [
  'You are the Deep Research industry analyst agent for Icarus.',
  'You help inspect research reports, identify contradictions or gaps, propose follow-up research, and improve research prompts.',
  'Deep Research data is expected under the mounted_root provided in runtime context, normally /workspace/extra/deep-research.',
  'Use {conversation_id}/session.json to inspect the current conversation task index.',
  'Use {conversation_id}/{task_id}.json for task metadata and {conversation_id}/{task_id}.md for the full report when report_ready is true.',
  'Do not assume report contents you have not read. When task ids are referenced, read the referenced task files before making report-specific claims.',
  'Clearly separate facts read from reports from your analysis or recommendations.',
].join('\n');

const PROVIDERS = {
  openai: {
    id: 'openai',
    label: 'Deep Research',
    models: OPENAI_MODELS,
    defaultModel: DEFAULT_OPENAI_MODEL,
  },
  'gpt-researcher': {
    id: 'gpt-researcher',
    label: 'GPT Researcher API',
    models: [GPT_RESEARCHER_MODEL],
    defaultModel: GPT_RESEARCHER_MODEL,
  },
};
const DEFAULT_PROVIDER = Object.hasOwn(
  PROVIDERS,
  process.env.DEFAULT_RESEARCH_PROVIDER || '',
)
  ? process.env.DEFAULT_RESEARCH_PROVIDER
  : 'openai';
const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'incomplete',
]);
const POLL_THROTTLE_MS = 2500;
const PROCESS_STARTED_AT_MS = Date.now();

const conversations = new Map();
const tasks = new Map();
const messages = new Map();
const taskRuntime = new Map();

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 2_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function safeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clipText(value, maxChars) {
  const text = safeText(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto
    .randomBytes(4)
    .toString('hex')}`;
}

function createConversationId() {
  return createId('drs');
}

function createTaskId() {
  return createId('dr');
}

function createMessageId() {
  return createId('msg');
}

function makeTitle(prompt, outputText = '') {
  const heading = outputText.match(/^#\s+(.+)$/m);
  if (heading?.[1]) return clipText(heading[1], 80);
  return clipText(prompt.replace(/\s+/g, ' '), 80) || 'Deep Research Report';
}

function normalizeProvider(provider) {
  const value = safeText(provider) || DEFAULT_PROVIDER;
  return Object.hasOwn(PROVIDERS, value) ? value : DEFAULT_PROVIDER;
}

function providerLabel(provider) {
  return PROVIDERS[provider]?.label || provider;
}

function normalizeModel(provider, model) {
  const value = safeText(model);
  if (provider === 'gpt-researcher') return GPT_RESEARCHER_MODEL;
  return SUPPORTED_OPENAI_MODELS.has(value) ? value : DEFAULT_OPENAI_MODEL;
}

function normalizeGptResearcherReportType(reportType) {
  const value = safeText(reportType);
  return SUPPORTED_GPT_RESEARCHER_REPORT_TYPES.has(value)
    ? value
    : DEFAULT_GPT_RESEARCHER_REPORT_TYPE;
}

function isSupportedGptResearcherReportType(reportType) {
  return SUPPORTED_GPT_RESEARCHER_REPORT_TYPES.has(safeText(reportType));
}

function normalizeMaxToolCalls(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 80;
  return Math.max(10, Math.min(200, Math.floor(number)));
}

function createConversation(title = '') {
  const now = new Date().toISOString();
  const conversation = {
    id: createConversationId(),
    title: safeText(title) || '新研究对话',
    createdAt: now,
    updatedAt: now,
    agentSessionId: '',
    taskIds: [],
    messageIds: [],
  };
  conversations.set(conversation.id, conversation);
  return conversation;
}

function touchConversation(conversation) {
  conversation.updatedAt = new Date().toISOString();
}

function clearTaskRuntime(taskId) {
  const runtime = taskRuntime.get(taskId);
  if (runtime?.abortController) runtime.abortController.abort();
  if (runtime) runtime.cancelRequested = true;
  taskRuntime.delete(taskId);
}

function deleteConversation(conversationId) {
  loadStoreFromDiskQuietly({ initialize: true });
  const conversation = conversations.get(conversationId);
  if (!conversation) return false;

  for (const taskId of conversation.taskIds || []) {
    clearTaskRuntime(taskId);
    tasks.delete(taskId);
  }
  for (const messageId of conversation.messageIds || []) {
    messages.delete(messageId);
  }
  conversations.delete(conversation.id);
  persistStoreQuietly();
  return true;
}

function addMessage(conversation, input) {
  const now = new Date().toISOString();
  const message = {
    id: createMessageId(),
    conversationId: conversation.id,
    role: input.role,
    kind: input.kind,
    content: input.content || '',
    taskId: input.taskId || '',
    referencedTaskIds: Array.isArray(input.referencedTaskIds)
      ? input.referencedTaskIds
      : [],
    status: input.status || '',
    createdAt: now,
  };
  messages.set(message.id, message);
  conversation.messageIds.push(message.id);
  touchConversation(conversation);
  return message;
}

function persistableConversation(conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    agentSessionId: conversation.agentSessionId || '',
    taskIds: Array.isArray(conversation.taskIds) ? conversation.taskIds : [],
    messageIds: Array.isArray(conversation.messageIds)
      ? conversation.messageIds
      : [],
  };
}

function persistableMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    kind: message.kind,
    content: message.content || '',
    taskId: message.taskId || '',
    referencedTaskIds: Array.isArray(message.referencedTaskIds)
      ? message.referencedTaskIds
      : [],
    status: message.status || '',
    createdAt: message.createdAt,
  };
}

function persistableTask(task) {
  return {
    id: task.id,
    conversationId: task.conversationId,
    responseId: task.responseId || '',
    provider: task.provider,
    model: task.model,
    gptResearcherReportType: task.gptResearcherReportType || '',
    prompt: task.prompt,
    title: task.title,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    progress: Array.isArray(task.progress) ? task.progress : [],
    sources: Array.isArray(task.sources) ? task.sources : [],
    webCalls: Array.isArray(task.webCalls) ? task.webCalls : [],
    fileCalls: Array.isArray(task.fileCalls) ? task.fileCalls : [],
    mcpCalls: Array.isArray(task.mcpCalls) ? task.mcpCalls : [],
    codeCalls: Array.isArray(task.codeCalls) ? task.codeCalls : [],
    annotations: Array.isArray(task.annotations) ? task.annotations : [],
    usage: task.usage || null,
    error: task.error || null,
    incomplete_details: task.incomplete_details || null,
    rawResponse: task.rawResponse || null,
  };
}

function normalizeStoredConversation(value) {
  if (!value || typeof value !== 'object') return null;
  const id = safeText(value.id);
  if (!id) return null;
  return {
    id,
    title: safeText(value.title) || '研究对话',
    createdAt: safeText(value.createdAt) || new Date().toISOString(),
    updatedAt: safeText(value.updatedAt) || new Date().toISOString(),
    agentSessionId: safeText(value.agentSessionId),
    taskIds: Array.isArray(value.taskIds)
      ? value.taskIds.map(safeText).filter(Boolean)
      : [],
    messageIds: Array.isArray(value.messageIds)
      ? value.messageIds.map(safeText).filter(Boolean)
      : [],
  };
}

function normalizeStoredMessage(value) {
  if (!value || typeof value !== 'object') return null;
  const id = safeText(value.id);
  const conversationId = safeText(value.conversationId);
  if (!id || !conversationId) return null;
  const role = value.role === 'assistant' ? 'assistant' : 'user';
  return {
    id,
    conversationId,
    role,
    kind: safeText(value.kind) || 'message',
    content: typeof value.content === 'string' ? value.content : '',
    taskId: safeText(value.taskId),
    referencedTaskIds: Array.isArray(value.referencedTaskIds)
      ? value.referencedTaskIds.map(safeText).filter(Boolean)
      : [],
    status: safeText(value.status),
    createdAt: safeText(value.createdAt) || new Date().toISOString(),
  };
}

function normalizeStoredTask(value) {
  if (!value || typeof value !== 'object') return null;
  const id = safeText(value.id);
  const conversationId = safeText(value.conversationId);
  if (!id || !conversationId) return null;
  const provider = normalizeProvider(value.provider);
  const task = {
    id,
    conversationId,
    responseId: typeof value.responseId === 'string' ? value.responseId : '',
    provider,
    model: normalizeModel(provider, value.model),
    gptResearcherReportType:
      provider === 'gpt-researcher'
        ? normalizeGptResearcherReportType(value.gptResearcherReportType)
        : '',
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
    title: safeText(value.title) || makeTitle(value.prompt || ''),
    status: safeText(value.status) || 'queued',
    createdAt: safeText(value.createdAt) || new Date().toISOString(),
    updatedAt: safeText(value.updatedAt) || new Date().toISOString(),
    progress: Array.isArray(value.progress) ? value.progress : [],
    sources: Array.isArray(value.sources) ? value.sources : [],
    webCalls: Array.isArray(value.webCalls) ? value.webCalls : [],
    fileCalls: Array.isArray(value.fileCalls) ? value.fileCalls : [],
    mcpCalls: Array.isArray(value.mcpCalls) ? value.mcpCalls : [],
    codeCalls: Array.isArray(value.codeCalls) ? value.codeCalls : [],
    outputText: typeof value.outputText === 'string' ? value.outputText : '',
    annotations: Array.isArray(value.annotations) ? value.annotations : [],
    usage: value.usage || null,
    error: value.error || null,
    incomplete_details: value.incomplete_details || null,
    rawResponse: value.rawResponse || null,
  };
  task.progress = task.progress.length
    ? task.progress
    : buildProgress(task.rawResponse, task);
  return task;
}

function writeJsonFileAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempFile, filePath);
}

function writeTextFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, content, 'utf8');
  fs.renameSync(tempFile, filePath);
}

function runtimeForTask(taskId) {
  let runtime = taskRuntime.get(taskId);
  if (!runtime) {
    runtime = {};
    taskRuntime.set(taskId, runtime);
  }
  return runtime;
}

function conversationStoreDir(conversationId, rootDir = STORE_DIR) {
  return path.join(rootDir, 'conversations', conversationId);
}

function conversationStoreFile(conversationId, rootDir = STORE_DIR) {
  return path.join(
    conversationStoreDir(conversationId, rootDir),
    'conversation.json',
  );
}

function messagesStoreFile(conversationId, rootDir = STORE_DIR) {
  return path.join(
    conversationStoreDir(conversationId, rootDir),
    'messages.json',
  );
}

function tasksStoreFile(conversationId, rootDir = STORE_DIR) {
  return path.join(conversationStoreDir(conversationId, rootDir), 'tasks.json');
}

function reportStoreFile(task, rootDir = STORE_DIR) {
  return path.join(
    conversationStoreDir(task.conversationId, rootDir),
    'reports',
    `${task.id}.md`,
  );
}

function isReportReady(task) {
  return task.status === 'completed' && !!safeText(task.outputText);
}

function agentConversationRoot(conversationId) {
  return `${ICARUS_AGENT_MOUNTED_ROOT}/${conversationId}`;
}

function agentMetadataPath(task) {
  return `${agentConversationRoot(task.conversationId)}/${task.id}.json`;
}

function agentReportPath(task) {
  return `${agentConversationRoot(task.conversationId)}/${task.id}.md`;
}

function exportAgentReadable() {
  const tempDir = `${AGENT_READABLE_DIR}.${process.pid}.tmp`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  for (const conversation of conversations.values()) {
    const conversationDir = path.join(tempDir, conversation.id);
    fs.mkdirSync(conversationDir, { recursive: true });
    const conversationTasks = conversation.taskIds
      .map((taskId) => tasks.get(taskId))
      .filter(Boolean);
    const index = {
      id: conversation.id,
      title: conversation.title,
      created_at: conversation.createdAt,
      updated_at: conversation.updatedAt,
      task_ids: conversationTasks.map((task) => task.id),
      tasks: conversationTasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        provider: task.provider,
        model: task.model,
        prompt_preview: clipText(task.prompt.replace(/\s+/g, ' '), 240),
        metadata_path: agentMetadataPath(task),
        report_path: isReportReady(task) ? agentReportPath(task) : null,
        report_ready: isReportReady(task),
        source_count: task.sources?.length || 0,
      })),
    };
    fs.writeFileSync(
      path.join(conversationDir, 'session.json'),
      `${JSON.stringify(index, null, 2)}\n`,
      'utf8',
    );

    for (const task of conversationTasks) {
      const reportReady = isReportReady(task);
      const metadata = {
        id: task.id,
        conversation_id: task.conversationId,
        title: task.title,
        status: task.status,
        provider: task.provider,
        model: task.model,
        gpt_researcher_report_type: task.gptResearcherReportType || null,
        prompt: task.prompt,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
        metadata_path: agentMetadataPath(task),
        report_path: reportReady ? agentReportPath(task) : null,
        report_ready: reportReady,
        source_count: task.sources?.length || 0,
        sources: task.sources || [],
        error: task.error || null,
        incomplete_details: task.incomplete_details || null,
      };
      fs.writeFileSync(
        path.join(conversationDir, `${task.id}.json`),
        `${JSON.stringify(metadata, null, 2)}\n`,
        'utf8',
      );
      if (reportReady) {
        fs.writeFileSync(
          path.join(conversationDir, `${task.id}.md`),
          reportMarkdown(task),
          'utf8',
        );
      }
    }
  }

  fs.rmSync(AGENT_READABLE_DIR, { recursive: true, force: true });
  fs.renameSync(tempDir, AGENT_READABLE_DIR);
}

function persistStore() {
  const updatedAt = new Date().toISOString();
  const tempDir = `${STORE_DIR}.${process.pid}.tmp`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(tempDir, 'conversations'), { recursive: true });

  const conversationItems = [...conversations.values()].map(
    persistableConversation,
  );
  const payload = {
    version: STORE_VERSION,
    updated_at: updatedAt,
    conversation_ids: conversationItems.map((conversation) => conversation.id),
    conversations: conversationItems.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      taskIds: conversation.taskIds,
      messageIds: conversation.messageIds,
    })),
  };
  writeJsonFileAtomic(path.join(tempDir, 'index.json'), payload);

  for (const conversation of conversations.values()) {
    const conversationDir = conversationStoreDir(conversation.id, tempDir);
    fs.mkdirSync(path.join(conversationDir, 'reports'), { recursive: true });
    writeJsonFileAtomic(
      conversationStoreFile(conversation.id, tempDir),
      persistableConversation(conversation),
    );

    const conversationMessages = conversation.messageIds
      .map((messageId) => messages.get(messageId))
      .filter(Boolean)
      .map(persistableMessage);
    writeJsonFileAtomic(
      messagesStoreFile(conversation.id, tempDir),
      conversationMessages,
    );

    const conversationTasks = conversation.taskIds
      .map((taskId) => tasks.get(taskId))
      .filter(Boolean);
    writeJsonFileAtomic(
      tasksStoreFile(conversation.id, tempDir),
      conversationTasks.map(persistableTask),
    );

    for (const task of conversationTasks) {
      if (safeText(task.outputText)) {
        writeTextFileAtomic(reportStoreFile(task, tempDir), task.outputText);
      }
    }
  }

  fs.mkdirSync(path.dirname(STORE_DIR), { recursive: true });
  fs.rmSync(STORE_DIR, { recursive: true, force: true });
  fs.renameSync(tempDir, STORE_DIR);
  exportAgentReadable();
}

function persistStoreQuietly() {
  try {
    persistStore();
  } catch (error) {
    console.error(`Failed to persist Deep Research store: ${error.message}`);
  }
}

function resetStore(reason) {
  conversations.clear();
  tasks.clear();
  messages.clear();
  console.warn(`Resetting Deep Research store: ${reason}`);
  persistStoreQuietly();
}

function clearPersistentState() {
  conversations.clear();
  tasks.clear();
  messages.clear();
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonArrayFile(filePath) {
  const payload = readJsonFile(filePath);
  if (!Array.isArray(payload)) {
    throw new Error(`${path.basename(filePath)} must contain an array`);
  }
  return payload;
}

function removeLegacyTaskStoreQuietly() {
  if (!fs.existsSync(LEGACY_TASK_STORE_FILE)) return;
  try {
    fs.rmSync(LEGACY_TASK_STORE_FILE, { force: true });
    console.warn(
      'Removed legacy Deep Research tasks.json; v3 store does not migrate history',
    );
  } catch (error) {
    console.error(
      `Failed to remove legacy Deep Research tasks.json: ${error.message}`,
    );
  }
}

function backupCorruptStoreQuietly() {
  if (!fs.existsSync(STORE_DIR)) return;
  try {
    fs.renameSync(STORE_DIR, `${STORE_DIR}.corrupt-${Date.now()}`);
  } catch {
    /* ignore */
  }
}

function taskDateMs(value) {
  const timestamp = Date.parse(safeText(value));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function markTaskFailedAfterRestart(task, message) {
  task.status = 'failed';
  task.error = { message };
  task.updatedAt = new Date().toISOString();
  task.progress = buildProgress(null, task);
  const conversation = conversations.get(task.conversationId);
  if (conversation) touchConversation(conversation);
}

function markUnrecoverableTasksAfterRestart() {
  let changed = false;
  for (const task of tasks.values()) {
    if (TERMINAL_STATUSES.has(task.status)) continue;

    const existedBeforeCurrentProcess =
      taskDateMs(task.createdAt) < PROCESS_STARTED_AT_MS &&
      taskDateMs(task.updatedAt) < PROCESS_STARTED_AT_MS;
    if (!existedBeforeCurrentProcess) continue;

    if (task.provider === 'gpt-researcher') {
      markTaskFailedAfterRestart(
        task,
        'GPT Researcher task was interrupted by a Deep Research server restart and cannot be resumed.',
      );
      changed = true;
      continue;
    }

    if (!task.responseId) {
      markTaskFailedAfterRestart(
        task,
        'Deep Research task was interrupted before a response id was saved and cannot be resumed.',
      );
      changed = true;
    }
  }
  return changed;
}

function loadStoreFromDisk(options = {}) {
  const initialize = options.initialize === true;
  const exportReadable = options.exportReadable === true;
  const log = options.log === true;
  removeLegacyTaskStoreQuietly();
  clearPersistentState();

  if (!fs.existsSync(STORE_INDEX_FILE)) {
    if (initialize) persistStoreQuietly();
    return;
  }

  let payload;
  try {
    payload = readJsonFile(STORE_INDEX_FILE);
    if (
      payload?.version !== STORE_VERSION ||
      !Array.isArray(payload.conversation_ids)
    ) {
      throw new Error('invalid v3 store index');
    }
  } catch (error) {
    backupCorruptStoreQuietly();
    resetStore(`invalid store index (${error.message})`);
    return;
  }

  let shouldRewriteStore = false;
  try {
    for (const conversationId of payload.conversation_ids) {
      const id = safeText(conversationId);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new Error(`invalid conversation id in store index: ${id}`);
      }
      if (!fs.existsSync(conversationStoreFile(id))) {
        shouldRewriteStore = true;
        continue;
      }

      const conversation = normalizeStoredConversation(
        readJsonFile(conversationStoreFile(id)),
      );
      if (!conversation || conversation.id !== id) {
        throw new Error(`invalid conversation store: ${id}`);
      }
      conversations.set(conversation.id, conversation);

      const taskItems = fs.existsSync(tasksStoreFile(id))
        ? readJsonArrayFile(tasksStoreFile(id))
        : [];
      if (!fs.existsSync(tasksStoreFile(id))) shouldRewriteStore = true;
      for (const item of taskItems) {
        const task = normalizeStoredTask(item);
        if (!task || task.conversationId !== conversation.id) continue;
        const reportFile = reportStoreFile(task);
        if (fs.existsSync(reportFile)) {
          task.outputText = fs.readFileSync(reportFile, 'utf8');
        }
        tasks.set(task.id, task);
      }

      const messageItems = fs.existsSync(messagesStoreFile(id))
        ? readJsonArrayFile(messagesStoreFile(id))
        : [];
      if (!fs.existsSync(messagesStoreFile(id))) shouldRewriteStore = true;
      for (const item of messageItems) {
        const message = normalizeStoredMessage(item);
        if (message && message.conversationId === conversation.id) {
          messages.set(message.id, message);
        }
      }
    }
  } catch (error) {
    backupCorruptStoreQuietly();
    resetStore(`invalid conversation store (${error.message})`);
    return;
  }

  for (const conversation of conversations.values()) {
    conversation.taskIds = conversation.taskIds.filter((taskId) =>
      tasks.has(taskId),
    );
    conversation.messageIds = conversation.messageIds.filter((messageId) =>
      messages.has(messageId),
    );
  }
  if (markUnrecoverableTasksAfterRestart()) shouldRewriteStore = true;
  if (log) {
    console.log(
      `Loaded ${conversations.size} Deep Research conversation(s), ${tasks.size} task(s)`,
    );
  }
  if (shouldRewriteStore) persistStoreQuietly();
  if (exportReadable) exportAgentReadable();
}

function loadStoreFromDiskQuietly(options = {}) {
  try {
    loadStoreFromDisk(options);
  } catch (error) {
    console.error(`Failed to load Deep Research store: ${error.message}`);
    resetStore(`failed to load store (${error.message})`);
  }
}

function updateStoredTask(taskId, updater) {
  loadStoreFromDiskQuietly();
  const task = tasks.get(taskId);
  if (!task) return null;
  const result = updater(task) || task;
  persistStoreQuietly();
  return result;
}

async function openaiRequest(endpoint, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error('OPENAI_API_KEY is not configured');
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(`${OPENAI_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      body?.error?.message || body?.message || `OpenAI request failed`,
    );
    error.statusCode = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function gptResearcherRequest(endpoint, options = {}) {
  const url = `${GPT_RESEARCHER_BASE_URL}${
    endpoint.startsWith('/') ? endpoint : `/${endpoint}`
  }`;
  const urlObject = new URL(url);
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (process.env.GPT_RESEARCHER_API_KEY) {
    headers.Authorization = `Bearer ${process.env.GPT_RESEARCHER_API_KEY}`;
  }

  const requestBody = options.body || '';
  if (requestBody && !headers['Content-Length'] && !headers['content-length']) {
    headers['Content-Length'] = Buffer.byteLength(requestBody);
  }

  const transport = urlObject.protocol === 'https:' ? https : http;
  const { statusCode, text } = await new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let timedOut = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const request = transport.request(
      urlObject,
      {
        method: options.method || 'GET',
        headers,
        timeout: GPT_RESEARCHER_TIMEOUT_MS,
      },
      (response) => {
        connected = true;
        const chunks = [];
        response.setEncoding('utf8');
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            statusCode: response.statusCode || 0,
            text: chunks.join(''),
          });
        });
      },
    );

    const connectTimer = setTimeout(() => {
      if (connected || settled) return;
      timedOut = true;
      request.destroy(
        new Error(
          `Timed out connecting to GPT Researcher API at ${GPT_RESEARCHER_BASE_URL}`,
        ),
      );
    }, GPT_RESEARCHER_CONNECT_TIMEOUT_MS);

    request.on('socket', (socket) => {
      socket.on('connect', () => {
        connected = true;
        clearTimeout(connectTimer);
      });
      socket.on('secureConnect', () => {
        connected = true;
        clearTimeout(connectTimer);
      });
    });

    request.on('timeout', () => {
      timedOut = true;
      request.destroy(
        new Error(
          `Timed out waiting for GPT Researcher API after ${Math.round(
            GPT_RESEARCHER_TIMEOUT_MS / 1000,
          )}s`,
        ),
      );
    });

    request.on('error', (error) => {
      clearTimeout(connectTimer);
      if (options.signal?.aborted) {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        fail(abortError);
        return;
      }
      if (timedOut) {
        fail(error);
        return;
      }
      const nextError = new Error(
        `Cannot connect to GPT Researcher API at ${GPT_RESEARCHER_BASE_URL}: ${error.message}`,
      );
      nextError.cause = error;
      fail(nextError);
    });

    options.signal?.addEventListener(
      'abort',
      () => {
        request.destroy();
      },
      { once: true },
    );

    if (requestBody) request.write(requestBody);
    request.end();
  });

  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (statusCode < 200 || statusCode >= 300) {
    const error = new Error(
      body?.detail ||
        body?.error ||
        body?.message ||
        `GPT Researcher request failed`,
    );
    error.statusCode = statusCode;
    error.body = body;
    throw error;
  }

  return body;
}

async function icarusAgentChatRequest(payload) {
  if (!ICARUS_INTERNAL_API_TOKEN) {
    const error = new Error('ICARUS_INTERNAL_API_TOKEN is not configured');
    error.statusCode = 500;
    throw error;
  }
  const response = await fetch(
    `${ICARUS_INTERNAL_API_BASE_URL}/internal/agent/chat`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ICARUS_INTERNAL_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || 'Icarus agent chat failed');
    error.statusCode = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

function buildAgentRuntimePrompt(input) {
  const referencedTaskIds = Array.isArray(input.referencedTaskIds)
    ? input.referencedTaskIds
    : [];
  return [
    '[Deep Research Runtime Context]',
    `conversation_id: ${input.conversationId}`,
    `mounted_root: ${input.mountedRoot}`,
    'referenced_task_ids:',
    ...(referencedTaskIds.length > 0
      ? referencedTaskIds.map((taskId) => `- ${taskId}`)
      : ['- none']),
    '',
    'File structure:',
    '- {conversation_id}/session.json contains the task index for this conversation.',
    '- {conversation_id}/{task_id}.json contains task metadata, report_ready, and report_path.',
    '- {conversation_id}/{task_id}.md contains the full report only after report_ready is true.',
    '[/Deep Research Runtime Context]',
    '',
    `User request:\n${input.message}`,
  ].join('\n');
}

function normalizeUrlSources(values) {
  const byUrl = new Map();
  const queue = Array.isArray(values) ? [...values] : [];

  while (queue.length > 0) {
    const value = queue.shift();
    if (!value) continue;
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (typeof value === 'string') {
      const url = safeText(value);
      if (!url || byUrl.has(url)) continue;
      byUrl.set(url, {
        id: `SRC-${String(byUrl.size + 1).padStart(3, '0')}`,
        title: url,
        url,
        source_type: 'gpt_researcher',
      });
      continue;
    }
    if (typeof value !== 'object') continue;
    const url = safeText(
      value.url || value.href || value.link || value.source_url,
    );
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, {
      id: `SRC-${String(byUrl.size + 1).padStart(3, '0')}`,
      title: safeText(value.title) || url,
      url,
      source_type: value.source_type || 'gpt_researcher',
    });
  }

  return [...byUrl.values()];
}

function extractGptResearcherReport(response) {
  const research = response?.research_information || {};
  const outputText =
    safeText(response?.report) ||
    safeText(response?.answer) ||
    safeText(response?.output_text) ||
    safeText(response?.output?.report) ||
    safeText(response?.raw);
  const sources = normalizeUrlSources([
    research.source_urls,
    research.visited_urls,
    response?.sources,
    response?.source_urls,
  ]);

  return { outputText, sources, research };
}

function extractOutput(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const textParts = [];
  const annotations = [];
  const webCalls = [];
  const fileCalls = [];
  const mcpCalls = [];
  const codeCalls = [];

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'web_search_call') webCalls.push(item);
    if (item.type === 'file_search_call') fileCalls.push(item);
    if (item.type === 'mcp_tool_call') mcpCalls.push(item);
    if (item.type === 'code_interpreter_call') codeCalls.push(item);
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!part || part.type !== 'output_text') continue;
      if (typeof part.text === 'string') textParts.push(part.text);
      if (Array.isArray(part.annotations))
        annotations.push(...part.annotations);
    }
  }

  return {
    outputText:
      safeText(response?.output_text) || textParts.join('\n\n').trim(),
    annotations,
    webCalls,
    fileCalls,
    mcpCalls,
    codeCalls,
  };
}

function extractSources(response, extracted) {
  const byUrl = new Map();
  for (const annotation of extracted.annotations) {
    const url = safeText(annotation?.url);
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, {
      id: `SRC-${String(byUrl.size + 1).padStart(3, '0')}`,
      title: safeText(annotation?.title) || url,
      url,
      source_type: annotation?.type || 'url_citation',
    });
  }

  for (const call of extracted.webCalls) {
    const sources = Array.isArray(call?.action?.sources)
      ? call.action.sources
      : Array.isArray(call?.results)
        ? call.results
        : [];
    for (const source of sources) {
      const url = safeText(source?.url);
      if (!url || byUrl.has(url)) continue;
      byUrl.set(url, {
        id: `SRC-${String(byUrl.size + 1).padStart(3, '0')}`,
        title: safeText(source?.title) || url,
        url,
        source_type: 'web_search',
      });
    }
  }

  return [...byUrl.values()];
}

function buildGptResearcherProgress(task) {
  const terminal = TERMINAL_STATUSES.has(task.status);
  const endedUnfinished = terminal && task.status !== 'completed';
  const hasText = !!safeText(task.outputText);
  const sourceCount = task.sources?.length || 0;

  return [
    {
      key: 'created',
      label: '提交 GPT Researcher 任务',
      detail: GPT_RESEARCHER_BASE_URL,
      status: endedUnfinished ? 'failed' : 'completed',
    },
    {
      key: 'search',
      label: '检索公开网页来源',
      detail:
        sourceCount > 0
          ? `${sourceCount} 个引用来源`
          : 'GPT Researcher 正在检索资料',
      status:
        sourceCount > 0 ? 'completed' : endedUnfinished ? 'failed' : 'active',
    },
    {
      key: 'analyze',
      label: '分析来源并组织报告',
      detail: hasText ? '研究内容已返回' : '等待 GPT Researcher 返回报告',
      status: hasText ? 'completed' : endedUnfinished ? 'failed' : 'active',
    },
    {
      key: 'report',
      label: '生成研究报告文档',
      detail: hasText ? '报告已生成' : '等待最终输出',
      status:
        task.status === 'completed'
          ? 'completed'
          : endedUnfinished
            ? 'failed'
            : 'pending',
    },
  ];
}

function buildProgress(response, task) {
  if (task.provider === 'gpt-researcher')
    return buildGptResearcherProgress(task);

  const extracted = response ? extractOutput(response) : null;
  const status = response?.status || task.status || 'queued';
  const searchCount = extracted?.webCalls.length || 0;
  const sourceCount = task.sources?.length || 0;
  const hasText = !!safeText(extracted?.outputText);
  const terminal = TERMINAL_STATUSES.has(status);
  const endedUnfinished = terminal && status !== 'completed';

  return [
    {
      key: 'created',
      label: '提交 Deep Research 任务',
      detail: task.responseId || '等待 OpenAI 响应',
      status: task.responseId
        ? 'completed'
        : endedUnfinished
          ? 'failed'
          : 'active',
    },
    {
      key: 'search',
      label: '检索公开网页来源',
      detail:
        searchCount > 0
          ? `${searchCount} 个搜索活动，${sourceCount} 个引用来源`
          : status === 'queued'
            ? '等待调度'
            : '等待搜索活动',
      status:
        searchCount > 0
          ? terminal
            ? 'completed'
            : 'active'
          : endedUnfinished
            ? 'failed'
            : status === 'queued'
              ? 'pending'
              : 'active',
    },
    {
      key: 'analyze',
      label: '分析来源并综合结论',
      detail:
        extracted?.codeCalls.length > 0
          ? `${extracted.codeCalls.length} 个代码分析活动`
          : '模型正在整理证据',
      status: hasText
        ? 'completed'
        : endedUnfinished
          ? 'failed'
          : searchCount > 0
            ? 'active'
            : 'pending',
    },
    {
      key: 'report',
      label: '生成研究报告文档',
      detail: hasText ? '报告已生成' : '等待最终输出',
      status:
        status === 'completed'
          ? 'completed'
          : endedUnfinished
            ? 'failed'
            : hasText
              ? 'active'
              : 'pending',
    },
  ];
}

function updateTaskFromResponse(task, response, options = {}) {
  const extracted = extractOutput(response);
  const sources = extractSources(response, extracted);
  task.status = response.status || task.status;
  task.error = response.error || null;
  task.incomplete_details = response.incomplete_details || null;
  task.updatedAt = new Date().toISOString();
  task.outputText = extracted.outputText || task.outputText || '';
  task.annotations = extracted.annotations;
  task.sources = sources;
  task.webCalls = extracted.webCalls;
  task.fileCalls = extracted.fileCalls;
  task.mcpCalls = extracted.mcpCalls;
  task.codeCalls = extracted.codeCalls;
  task.usage = response.usage || null;
  task.rawResponse = response;
  task.title = makeTitle(task.prompt, task.outputText);
  task.progress = buildProgress(response, task);
  const conversation = conversations.get(task.conversationId);
  if (conversation) {
    if (conversation.title === '新研究对话') {
      conversation.title = task.title;
    }
    touchConversation(conversation);
  }
  if (options.persist !== false) persistStoreQuietly();
}

function publicTask(task, options = {}) {
  return {
    id: task.id,
    conversation_id: task.conversationId,
    response_id: task.responseId,
    provider: task.provider,
    provider_label: providerLabel(task.provider),
    model: task.model,
    gpt_researcher_report_type: task.gptResearcherReportType || null,
    prompt: task.prompt,
    title: task.title,
    status: task.status,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    progress: task.progress || buildProgress(task.rawResponse, task),
    stats: {
      search_count: task.webCalls?.length || 0,
      source_count: task.sources?.length || 0,
      file_search_count: task.fileCalls?.length || 0,
      mcp_call_count: task.mcpCalls?.length || 0,
      code_call_count: task.codeCalls?.length || 0,
    },
    usage: task.usage || null,
    error: task.error,
    incomplete_details: task.incomplete_details,
    sources: task.sources || [],
    output_text: options.full ? task.outputText || '' : undefined,
  };
}

function publicMessage(message) {
  return {
    id: message.id,
    conversation_id: message.conversationId,
    role: message.role,
    kind: message.kind,
    content: message.content || '',
    task_id: message.taskId || null,
    referenced_task_ids: message.referencedTaskIds || [],
    status: message.status || null,
    created_at: message.createdAt,
  };
}

function publicConversation(conversation, options = {}) {
  const conversationTasks = conversation.taskIds
    .map((taskId) => tasks.get(taskId))
    .filter(Boolean);
  const conversationMessages = conversation.messageIds
    .map((messageId) => messages.get(messageId))
    .filter(Boolean);
  return {
    id: conversation.id,
    title: conversation.title,
    created_at: conversation.createdAt,
    updated_at: conversation.updatedAt,
    agent_session_id: conversation.agentSessionId || null,
    task_count: conversationTasks.length,
    running_task_count: conversationTasks.filter(
      (task) => !TERMINAL_STATUSES.has(task.status),
    ).length,
    tasks: options.full
      ? conversationTasks.map((task) => publicTask(task, { full: true }))
      : undefined,
    messages: options.full
      ? conversationMessages.map(publicMessage)
      : undefined,
  };
}

async function refreshTask(task) {
  if (task.provider !== 'openai') return task;
  if (!task.responseId || TERMINAL_STATUSES.has(task.status)) return task;
  const now = Date.now();
  const runtime = runtimeForTask(task.id);
  if (runtime.pollPromise) return runtime.pollPromise;
  if (runtime.lastPollAt && now - runtime.lastPollAt < POLL_THROTTLE_MS)
    return task;

  runtime.lastPollAt = now;
  runtime.pollPromise = openaiRequest(
    `/responses/${encodeURIComponent(task.responseId)}`,
  )
    .then((response) => {
      const updatedTask = updateStoredTask(task.id, (storedTask) => {
        storedTask.responseId = storedTask.responseId || task.responseId;
        updateTaskFromResponse(storedTask, response, { persist: false });
      });
      return updatedTask || task;
    })
    .catch((error) => {
      updateStoredTask(task.id, (storedTask) => {
        storedTask.error = {
          message: error.message,
          body: error.body || null,
        };
        storedTask.updatedAt = new Date().toISOString();
      });
      return task;
    })
    .finally(() => {
      runtime.pollPromise = null;
    });

  return runtime.pollPromise;
}

async function refreshConversationTasks(conversation) {
  await Promise.all(
    conversation.taskIds
      .map((taskId) => tasks.get(taskId))
      .filter(Boolean)
      .map((task) => refreshTask(task)),
  );
}

function createResearchTask(
  conversation,
  provider,
  model,
  prompt,
  options = {},
) {
  const now = new Date().toISOString();
  const task = {
    id: createTaskId(),
    conversationId: conversation.id,
    responseId: '',
    provider,
    model,
    gptResearcherReportType:
      provider === 'gpt-researcher'
        ? normalizeGptResearcherReportType(options.gptResearcherReportType)
        : '',
    prompt,
    title: makeTitle(prompt),
    status: 'creating',
    createdAt: now,
    updatedAt: now,
    progress: [],
    sources: [],
    webCalls: [],
    fileCalls: [],
    mcpCalls: [],
    codeCalls: [],
    outputText: '',
  };
  tasks.set(task.id, task);
  conversation.taskIds.push(task.id);
  if (conversation.title === '新研究对话') {
    conversation.title = makeTitle(prompt);
  }
  return task;
}

function buildGptResearcherPayload(task) {
  return {
    task: task.prompt,
    report_type: task.gptResearcherReportType || GPT_RESEARCHER_REPORT_TYPE,
    report_source: GPT_RESEARCHER_REPORT_SOURCE,
    tone: GPT_RESEARCHER_TONE,
    headers: {},
    repo_name: '',
    branch_name: '',
    generate_in_background: false,
  };
}

async function runGptResearcherTask(task) {
  const abortController = new AbortController();
  const runtime = runtimeForTask(task.id);
  runtime.abortController = abortController;
  runtime.cancelRequested = false;
  const runningTask = updateStoredTask(task.id, (storedTask) => {
    storedTask.status = 'running';
    storedTask.updatedAt = new Date().toISOString();
    storedTask.progress = buildProgress(null, storedTask);
  });
  if (!runningTask) {
    runtime.abortController = null;
    return;
  }

  try {
    const response = await gptResearcherRequest('/report/', {
      method: 'POST',
      body: JSON.stringify(buildGptResearcherPayload(runningTask)),
      signal: abortController.signal,
    });

    const extracted = extractGptResearcherReport(response);
    if (!safeText(extracted.outputText)) {
      const error = new Error('GPT Researcher did not return report content');
      error.body = response;
      throw error;
    }

    updateStoredTask(task.id, (storedTask) => {
      if (storedTask.status === 'cancelled' || runtime.cancelRequested) return;
      storedTask.responseId = safeText(response?.research_id) || storedTask.id;
      storedTask.status = 'completed';
      storedTask.outputText = extracted.outputText;
      storedTask.sources = extracted.sources;
      storedTask.webCalls = extracted.sources.map((source) => ({
        type: 'gpt_researcher_source',
        source,
      }));
      storedTask.rawResponse = response;
      storedTask.usage = response?.research_costs
        ? { research_costs: response.research_costs }
        : null;
      storedTask.title = makeTitle(storedTask.prompt, storedTask.outputText);
      storedTask.updatedAt = new Date().toISOString();
      storedTask.progress = buildProgress(null, storedTask);
      const conversation = conversations.get(storedTask.conversationId);
      if (conversation) {
        if (conversation.title === '新研究对话') {
          conversation.title = storedTask.title;
        }
        touchConversation(conversation);
      }
    });
  } catch (error) {
    updateStoredTask(task.id, (storedTask) => {
      if (
        error.name === 'AbortError' ||
        storedTask.status === 'cancelled' ||
        runtime.cancelRequested
      ) {
        storedTask.status = 'cancelled';
        storedTask.error = null;
      } else {
        storedTask.status = 'failed';
        storedTask.error = {
          message: error.message,
          body: error.body || null,
        };
      }
      storedTask.updatedAt = new Date().toISOString();
      storedTask.progress = buildProgress(null, storedTask);
    });
  } finally {
    runtime.abortController = null;
    runtime.cancelRequested = false;
  }
}

async function handleCreateConversation(req, res) {
  const body = await readJsonBody(req);
  const conversation = createConversation(body.title);
  persistStoreQuietly();
  sendJson(res, 200, {
    conversation: publicConversation(conversation, { full: true }),
  });
}

async function handleCreateResearch(conversation, req, res) {
  const body = await readJsonBody(req);
  const prompt = safeText(body.prompt);
  if (!prompt) {
    sendJson(res, 400, { error: 'prompt required' });
    return;
  }
  loadStoreFromDiskQuietly();
  conversation = conversations.get(conversation.id);
  if (!conversation) {
    sendJson(res, 404, { error: 'conversation not found' });
    return;
  }

  const provider = normalizeProvider(body.provider);
  const model = normalizeModel(provider, body.model);
  const maxToolCalls = normalizeMaxToolCalls(body.max_tool_calls);
  const requestedReportType = safeText(
    body.gpt_researcher_report_type || body.report_type,
  );
  if (
    provider === 'gpt-researcher' &&
    requestedReportType &&
    !isSupportedGptResearcherReportType(requestedReportType)
  ) {
    sendJson(res, 400, { error: 'unsupported GPT Researcher report type' });
    return;
  }

  addMessage(conversation, {
    role: 'user',
    kind: 'research_prompt',
    content: prompt,
  });
  const task = createResearchTask(conversation, provider, model, prompt, {
    gptResearcherReportType: requestedReportType || GPT_RESEARCHER_REPORT_TYPE,
  });
  addMessage(conversation, {
    role: 'assistant',
    kind: 'research_task',
    content: task.title,
    taskId: task.id,
  });
  persistStoreQuietly();

  if (provider === 'gpt-researcher') {
    task.status = 'queued';
    task.progress = buildProgress(null, task);
    persistStoreQuietly();
    setTimeout(() => {
      runGptResearcherTask(task);
    }, 0);
    sendJson(res, 200, {
      conversation: publicConversation(conversation, { full: true }),
      task: publicTask(task),
    });
    return;
  }

  const payload = {
    model,
    input: prompt,
    background: true,
    store: true,
    tools: [{ type: 'web_search_preview' }],
    max_tool_calls: maxToolCalls,
    include: ['web_search_call.action.sources'],
    metadata: {
      app: 'deep-research-web',
      local_task_id: task.id,
      local_conversation_id: conversation.id,
    },
  };

  let response;
  try {
    response = await openaiRequest('/responses', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (error) {
    updateStoredTask(task.id, (storedTask) => {
      storedTask.status = 'failed';
      storedTask.error = {
        message: error.message,
        body: error.body || null,
      };
      storedTask.updatedAt = new Date().toISOString();
      storedTask.progress = buildProgress(null, storedTask);
    });
    throw error;
  }

  const updatedTask = updateStoredTask(task.id, (storedTask) => {
    storedTask.responseId = response.id;
    updateTaskFromResponse(storedTask, response, { persist: false });
  });
  const updatedConversation = conversations.get(conversation.id);
  if (!updatedTask || !updatedConversation) {
    sendJson(res, 404, { error: 'task no longer exists' });
    return;
  }
  sendJson(res, 200, {
    conversation: publicConversation(updatedConversation, { full: true }),
    task: publicTask(updatedTask),
  });
}

function normalizeReferencedTaskIds(conversation, value) {
  const input = Array.isArray(value) ? value : [];
  const unique = [...new Set(input.map(safeText).filter(Boolean))];
  const allowed = new Set(conversation.taskIds);
  const invalid = unique.filter((taskId) => !allowed.has(taskId));
  if (invalid.length > 0) {
    const error = new Error(
      `referenced task not in conversation: ${invalid.join(', ')}`,
    );
    error.statusCode = 400;
    throw error;
  }
  return unique;
}

function stripAgentPrefix(value) {
  return safeText(value)
    .replace(/^@agent\b\s*/i, '')
    .trim();
}

async function handleAgentChat(conversation, req, res) {
  const body = await readJsonBody(req);
  const userText = stripAgentPrefix(body.content || body.message);
  if (!userText) {
    sendJson(res, 400, { error: 'agent message required' });
    return;
  }
  loadStoreFromDiskQuietly();
  conversation = conversations.get(conversation.id);
  if (!conversation) {
    sendJson(res, 404, { error: 'conversation not found' });
    return;
  }
  const referencedTaskIds = normalizeReferencedTaskIds(
    conversation,
    body.referenced_task_ids,
  );

  const userMessage = addMessage(conversation, {
    role: 'user',
    kind: 'agent_prompt',
    content: userText,
    referencedTaskIds,
  });
  persistStoreQuietly();

  try {
    const result = await icarusAgentChatRequest({
      chat_jid: ICARUS_AGENT_CHAT_JID,
      session_id: conversation.agentSessionId || undefined,
      system: DEEP_RESEARCH_AGENT_SYSTEM,
      message: buildAgentRuntimePrompt({
        conversationId: conversation.id,
        mountedRoot: ICARUS_AGENT_MOUNTED_ROOT,
        referencedTaskIds,
        message: userText,
      }),
      metadata: {
        source: 'deep-research',
        trace_id: userMessage.id,
        conversation_id: conversation.id,
        referenced_task_ids: referencedTaskIds,
      },
    });
    loadStoreFromDiskQuietly();
    const currentConversation = conversations.get(conversation.id);
    if (!currentConversation) {
      sendJson(res, 404, { error: 'conversation no longer exists' });
      return;
    }
    currentConversation.agentSessionId =
      result.session_id || currentConversation.agentSessionId;
    addMessage(currentConversation, {
      role: 'assistant',
      kind: 'agent_reply',
      content: result.text || '',
      referencedTaskIds,
    });
    persistStoreQuietly();
    sendJson(res, 200, {
      conversation: publicConversation(currentConversation, { full: true }),
      agent: result,
    });
  } catch (error) {
    loadStoreFromDiskQuietly();
    const currentConversation = conversations.get(conversation.id);
    if (currentConversation) {
      addMessage(currentConversation, {
        role: 'assistant',
        kind: 'agent_error',
        content: error.message || 'Agent request failed',
        referencedTaskIds,
        status: 'error',
      });
      persistStoreQuietly();
    }
    sendJson(res, error.statusCode || 502, {
      error: error.message || 'Agent request failed',
      detail: error.body || null,
      conversation: currentConversation
        ? publicConversation(currentConversation, { full: true })
        : null,
    });
  }
}

async function handleCancelTask(task, res) {
  if (task.provider === 'gpt-researcher') {
    const runtime = runtimeForTask(task.id);
    runtime.cancelRequested = true;
    if (runtime.abortController) runtime.abortController.abort();
    const updatedTask = updateStoredTask(task.id, (storedTask) => {
      storedTask.status = 'cancelled';
      storedTask.updatedAt = new Date().toISOString();
      storedTask.progress = buildProgress(null, storedTask);
    });
    sendJson(res, 200, {
      task: publicTask(updatedTask || task, { full: true }),
    });
    return;
  }

  if (!task.responseId) {
    sendJson(res, 400, { error: 'response id unavailable' });
    return;
  }
  const response = await openaiRequest(
    `/responses/${encodeURIComponent(task.responseId)}/cancel`,
    { method: 'POST', body: '{}' },
  );
  const updatedTask = updateStoredTask(task.id, (storedTask) => {
    updateTaskFromResponse(storedTask, response, { persist: false });
  });
  sendJson(res, 200, { task: publicTask(updatedTask || task, { full: true }) });
}

function reportMarkdown(task) {
  const body =
    safeText(task.outputText) ||
    `# ${task.title || 'Deep Research Report'}\n\nStatus: ${task.status}\n\nNo report content available.\n`;
  const sources = Array.isArray(task.sources) ? task.sources : [];
  if (sources.length === 0) return `${body.trim()}\n`;
  const hasSourcesHeading = /^##\s+(Sources|References|资料来源|来源)/im.test(
    body,
  );
  if (hasSourcesHeading) return `${body.trim()}\n`;
  return `${body.trim()}\n\n## Sources\n\n${sources
    .map((source, index) => {
      const title = source.title || source.url;
      return `${index + 1}. [${title}](${source.url})`;
    })
    .join('\n')}\n`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => {
      const safeUrl = escapeHtml(url);
      return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${label}</a>`;
    });
}

function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let listOpen = false;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listOpen) return;
    html.push('</ul>');
    listOpen = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph();
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(
        `<li>${renderInlineMarkdown(trimmed.replace(/^[-*]\s+/, ''))}</li>`,
      );
      continue;
    }
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  return html.join('\n');
}

function printableHtml(task) {
  const markdown = reportMarkdown(task);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(task.title || 'Deep Research Report')}</title>
  <style>
    body { color: #111827; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.62; margin: 42px auto; max-width: 960px; padding: 0 36px; }
    h1 { font-size: 30px; line-height: 1.2; margin: 0 0 18px; }
    h2 { border-top: 1px solid #e5e7eb; font-size: 21px; margin: 34px 0 12px; padding-top: 18px; }
    h3 { font-size: 17px; margin: 24px 0 8px; }
    p, li { font-size: 14px; }
    a { color: #2563eb; overflow-wrap: anywhere; }
    @media print { body { margin: 18mm auto; max-width: none; padding: 0; } }
  </style>
</head>
<body>
${markdownToHtml(markdown)}
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));</script>
</body>
</html>`;
}

async function handleExport(task, type, res) {
  const targetTask = !TERMINAL_STATUSES.has(task.status)
    ? await refreshTask(task)
    : task;
  if (!safeText(targetTask.outputText)) {
    sendJson(res, 400, { error: 'report is not ready' });
    return;
  }
  if (type === 'markdown') {
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="deep-research-report.md"',
      'Cache-Control': 'no-store',
    });
    res.end(reportMarkdown(targetTask));
    return;
  }
  if (type === 'pdf') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'inline; filename="deep-research-report.html"',
      'Cache-Control': 'no-store',
    });
    res.end(printableHtml(targetTask));
    return;
  }
  sendJson(res, 404, { error: 'export type not found' });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const relative =
    pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  if (target !== PUBLIC_DIR && !target.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const ext = path.extname(target).toLowerCase();
  const contentType =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(target).pipe(res);
}

function findConversationOr404(id, res) {
  const conversation = conversations.get(id);
  if (!conversation) {
    sendJson(res, 404, { error: 'conversation not found' });
    return null;
  }
  return conversation;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith('/api/')) {
      loadStoreFromDiskQuietly({ initialize: true });
    }

    if (pathname === '/api/config' && req.method === 'GET') {
      sendJson(res, 200, {
        providers: [
          {
            id: 'openai',
            label: PROVIDERS.openai.label,
            models: PROVIDERS.openai.models,
            default_model: PROVIDERS.openai.defaultModel,
            configured: !!process.env.OPENAI_API_KEY,
          },
          {
            id: 'gpt-researcher',
            label: PROVIDERS['gpt-researcher'].label,
            models: PROVIDERS['gpt-researcher'].models,
            default_model: PROVIDERS['gpt-researcher'].defaultModel,
            report_types: GPT_RESEARCHER_REPORT_TYPES,
            default_report_type: GPT_RESEARCHER_REPORT_TYPE,
            configured: !!GPT_RESEARCHER_BASE_URL,
          },
        ],
        default_provider: DEFAULT_PROVIDER,
        models: PROVIDERS[DEFAULT_PROVIDER].models,
        default_model: PROVIDERS[DEFAULT_PROVIDER].defaultModel,
        api_configured: !!process.env.OPENAI_API_KEY,
        agent_configured: !!ICARUS_INTERNAL_API_TOKEN,
        agent_chat_jid: ICARUS_AGENT_CHAT_JID,
        agents: [
          {
            id: 'agent',
            mention: '@agent',
            label: '行业分析师',
            description: '检查报告矛盾、补充调研方向、优化下一轮提示词',
            chat_jid: ICARUS_AGENT_CHAT_JID,
            configured: !!ICARUS_INTERNAL_API_TOKEN,
          },
        ],
      });
      return;
    }

    if (pathname === '/api/conversations' && req.method === 'GET') {
      const items = [...conversations.values()]
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map((conversation) => publicConversation(conversation));
      sendJson(res, 200, { conversations: items });
      return;
    }

    if (pathname === '/api/conversations' && req.method === 'POST') {
      await handleCreateConversation(req, res);
      return;
    }

    const conversationMatch = pathname.match(
      /^\/api\/conversations\/([^/]+)(?:\/(.+))?$/,
    );
    if (conversationMatch) {
      const conversationId = decodeURIComponent(conversationMatch[1]);
      const suffix = conversationMatch[2] || '';
      if (!suffix && req.method === 'DELETE') {
        if (!deleteConversation(conversationId)) {
          sendJson(res, 404, { error: 'conversation not found' });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      const conversation = findConversationOr404(conversationId, res);
      if (!conversation) return;
      if (!suffix && req.method === 'GET') {
        await refreshConversationTasks(conversation);
        const currentConversation =
          conversations.get(conversation.id) || conversation;
        sendJson(res, 200, {
          conversation: publicConversation(currentConversation, { full: true }),
        });
        return;
      }
      if (suffix === 'research' && req.method === 'POST') {
        await handleCreateResearch(conversation, req, res);
        return;
      }
      if (suffix === 'agent' && req.method === 'POST') {
        await handleAgentChat(conversation, req, res);
        return;
      }
      sendJson(res, 404, { error: 'route not found' });
      return;
    }

    const researchMatch = pathname.match(
      /^\/api\/research\/([^/]+)(?:\/(.+))?$/,
    );
    if (researchMatch) {
      const task = tasks.get(decodeURIComponent(researchMatch[1]));
      if (!task) {
        sendJson(res, 404, { error: 'task not found' });
        return;
      }
      const suffix = researchMatch[2] || '';
      if (!suffix && req.method === 'GET') {
        const refreshedTask = await refreshTask(task);
        sendJson(res, 200, { task: publicTask(refreshedTask, { full: true }) });
        return;
      }
      if (suffix === 'cancel' && req.method === 'POST') {
        await handleCancelTask(task, res);
        return;
      }
      if (suffix === 'export/markdown' && req.method === 'GET') {
        await handleExport(task, 'markdown', res);
        return;
      }
      if (suffix === 'export/pdf' && req.method === 'GET') {
        await handleExport(task, 'pdf', res);
        return;
      }
      sendJson(res, 404, { error: 'route not found' });
      return;
    }

    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: error.message || 'server error',
      detail: error.body || null,
    });
  }
}

const server = http.createServer((req, res) => {
  route(req, res);
});

server.on('error', (error) => {
  console.error(`Failed to start Deep Research web app: ${error.message}`);
  process.exitCode = 1;
});

loadStoreFromDiskQuietly({ initialize: true, exportReadable: true, log: true });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Deep Research web app listening on http://${HOST}:${PORT}`);
});
