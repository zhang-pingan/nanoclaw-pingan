/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"...", selectedModel:"...", queryId:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  query,
  HookCallback,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreCompactHookInput,
  PreToolUseHookInput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  selectedModel?: string;
  runId?: string;
  queryId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  executionContext?: {
    workflowId?: string;
    stageKey?: string;
    delegationId?: string;
  };
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  selectedModel?: string;
  runId?: string;
  queryId?: string;
  event?: {
    type: string;
    name: string;
    status?: string;
    summary?: string;
    payload?: Record<string, unknown>;
  };
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_TASKS_DIR = '/workspace/ipc/tasks';
const IPC_POLL_MS = 500;
const MODEL_DEFAULT = process.env.NANOCLAW_MODEL_DEFAULT || 'claude-4-6-sonnet-latest';


/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  get ended(): boolean { return this.done; }

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function writeEvent(output: NonNullable<ContainerOutput['event']>, meta: {
  status?: 'success' | 'error';
  newSessionId?: string;
  selectedModel?: string;
  runId?: string;
  queryId?: string;
}): void {
  writeOutput({
    status: meta.status || 'success',
    result: null,
    newSessionId: meta.newSessionId,
    selectedModel: meta.selectedModel,
    runId: meta.runId,
    queryId: meta.queryId,
    event: output,
  });
}

function okHookOutput(): SyncHookJSONOutput {
  return { continue: true };
}

function normalizeDisplayPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'unknown';
  return value
    .replace(/^\/workspace\/group\//, '')
    .replace(/^\/workspace\/project\//, '')
    .replace(/^\/workspace\//, '');
}

function summarizeCommand(command: unknown): string {
  if (typeof command !== 'string' || command.trim().length === 0) return 'command';
  const trimmed = command.trim().replace(/\s+/g, ' ');
  return trimmed.length > 100 ? `${trimmed.slice(0, 97)}...` : trimmed;
}

function buildStructuredPatchPreview(value: unknown): string[] | undefined {
  const limit = 40;
  if (typeof value === 'string') {
    const lines = value
      .split('\n')
      .filter((line) => /^[+-]/.test(line) && !/^\+\+\+|^---/.test(line))
      .slice(0, limit);
    return lines.length > 0 ? lines : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const preview = value
    .flatMap((chunk) => {
      if (!chunk || typeof chunk !== 'object') return [];
      const lines = (chunk as { lines?: unknown }).lines;
      return Array.isArray(lines) ? lines.filter((line): line is string => typeof line === 'string') : [];
    })
    .filter((line) => /^[+-]/.test(line) && !/^\+\+\+|^---/.test(line))
    .slice(0, limit);
  return preview.length > 0 ? preview : undefined;
}

function buildSearchMatchPreview(response: Record<string, unknown>): {
  contentPreview?: string;
  filenames?: string[];
} {
  const contentPreview =
    typeof response.content === 'string' && response.content.trim().length > 0
      ? response.content.slice(0, 1600)
      : undefined;
  const filenames = Array.isArray(response.filenames)
    ? response.filenames
        .filter((value): value is string => typeof value === 'string')
        .slice(0, 8)
    : undefined;
  return { contentPreview, filenames };
}

function emitToolLifecycleEvent(
  event: NonNullable<ContainerOutput['event']>,
  meta: {
    newSessionId?: string;
    selectedModel?: string;
    runId?: string;
    queryId?: string;
  },
): void {
  writeEvent(event, {
    newSessionId: meta.newSessionId,
    selectedModel: meta.selectedModel,
    runId: meta.runId,
    queryId: meta.queryId,
  });
}

function createPreToolHook(meta: {
  getSessionId: () => string | undefined;
  getSelectedModel: () => string | undefined;
  runId?: string;
  queryId?: string;
}): HookCallback {
  return async (input): Promise<SyncHookJSONOutput> => {
    const hook = input as PreToolUseHookInput;
    const commonMeta = {
      newSessionId: meta.getSessionId(),
      selectedModel: meta.getSelectedModel(),
      runId: meta.runId,
      queryId: meta.queryId,
    };
    emitToolLifecycleEvent(
      {
        type: 'tool',
        name: 'tool_call',
        status: 'running',
        summary: `Calling ${hook.tool_name}`,
        payload: {
          toolName: hook.tool_name,
          toolUseId: hook.tool_use_id,
          input: hook.tool_input as Record<string, unknown>,
        },
      },
      commonMeta,
    );

    const toolInput = (hook.tool_input || {}) as Record<string, unknown>;
    if (hook.tool_name === 'Bash') {
      emitToolLifecycleEvent(
        {
          type: 'command',
          name: 'command_started',
          status: 'running',
          summary: `Running ${summarizeCommand(toolInput.command)}`,
          payload: {
            command: toolInput.command,
            description: toolInput.description,
            timeout: toolInput.timeout,
            background: toolInput.run_in_background,
          },
        },
        commonMeta,
      );
    } else if (hook.tool_name === 'Read') {
      emitToolLifecycleEvent(
        {
          type: 'file',
          name: 'file_read',
          status: 'running',
          summary: `Reading ${normalizeDisplayPath(toolInput.file_path)}`,
          payload: {
            path: toolInput.file_path,
            offset: toolInput.offset,
            limit: toolInput.limit,
            pages: toolInput.pages,
          },
        },
        commonMeta,
      );
    } else if (hook.tool_name === 'Write') {
      emitToolLifecycleEvent(
        {
          type: 'file',
          name: 'file_write',
          status: 'running',
          summary: `Writing ${normalizeDisplayPath(toolInput.file_path)}`,
          payload: {
            path: toolInput.file_path,
            contentLength:
              typeof toolInput.content === 'string' ? toolInput.content.length : undefined,
          },
        },
        commonMeta,
      );
    } else if (hook.tool_name === 'Edit') {
      emitToolLifecycleEvent(
        {
          type: 'file',
          name: 'file_edit',
          status: 'running',
          summary: `Editing ${normalizeDisplayPath(toolInput.file_path)}`,
          payload: {
            path: toolInput.file_path,
            replaceAll: toolInput.replace_all,
          },
        },
        commonMeta,
      );
    } else if (hook.tool_name === 'Glob' || hook.tool_name === 'Grep') {
      const target = hook.tool_name === 'Glob'
        ? toolInput.pattern
        : toolInput.pattern || toolInput.query;
      emitToolLifecycleEvent(
        {
          type: 'file',
          name: 'file_search',
          status: 'running',
          summary: `${hook.tool_name === 'Glob' ? 'Globbing' : 'Searching'} ${String(target || '')}`.trim(),
          payload: {
            toolName: hook.tool_name,
            pattern: toolInput.pattern,
            path: toolInput.path,
            query: toolInput.query,
          },
        },
        commonMeta,
      );
    }

    return okHookOutput();
  };
}

function createPostToolHook(meta: {
  getSessionId: () => string | undefined;
  getSelectedModel: () => string | undefined;
  runId?: string;
  queryId?: string;
}): HookCallback {
  return async (input): Promise<SyncHookJSONOutput> => {
    const hook = input as PostToolUseHookInput;
    const commonMeta = {
      newSessionId: meta.getSessionId(),
      selectedModel: meta.getSelectedModel(),
      runId: meta.runId,
      queryId: meta.queryId,
    };
    const toolInput = (hook.tool_input || {}) as Record<string, unknown>;
    const response = (hook.tool_response || {}) as Record<string, unknown>;
    emitToolLifecycleEvent(
      {
        type: 'tool',
        name: 'tool_result',
        status: 'success',
        summary: `${hook.tool_name} completed`,
        payload: {
          toolName: hook.tool_name,
          toolUseId: hook.tool_use_id,
        },
      },
      commonMeta,
    );

    if (hook.tool_name === 'Bash') {
      emitToolLifecycleEvent(
        {
          type: 'command',
          name: 'command_finished',
          status: 'success',
          summary: `Finished ${summarizeCommand(toolInput.command)}`,
          payload: {
            command: toolInput.command,
            interrupted: response.interrupted,
            backgroundTaskId: response.backgroundTaskId,
            stdoutPreview:
              typeof response.stdout === 'string'
                ? response.stdout.slice(0, 240)
                : undefined,
            stderrPreview:
              typeof response.stderr === 'string'
                ? response.stderr.slice(0, 240)
                : undefined,
          },
        },
        commonMeta,
      );
    } else if (hook.tool_name === 'Read') {
      emitToolLifecycleEvent(
        {
          type: 'file',
          name: 'file_read_complete',
          status: 'success',
          summary: `Read ${normalizeDisplayPath(toolInput.file_path)}`,
          payload: {
            path: toolInput.file_path,
            numLines:
              typeof response?.file === 'object' &&
              response.file &&
              'numLines' in (response.file as Record<string, unknown>)
                ? (response.file as Record<string, unknown>).numLines
                : undefined,
          },
        },
        commonMeta,
      );
    } else if (hook.tool_name === 'Write' || hook.tool_name === 'Edit') {
      const patchPreview =
        buildStructuredPatchPreview(response.structuredPatch) ||
        buildStructuredPatchPreview(response.gitDiff && (response.gitDiff as Record<string, unknown>).patch);
      emitToolLifecycleEvent(
        {
          type: 'file',
          name: hook.tool_name === 'Write' ? 'file_write_complete' : 'file_edit_complete',
          status: 'success',
          summary: `${hook.tool_name === 'Write' ? 'Wrote' : 'Edited'} ${normalizeDisplayPath(toolInput.file_path || response.filePath)}`,
          payload: {
            path: toolInput.file_path || response.filePath,
            editKind: hook.tool_name === 'Write' ? response.type : 'edit',
            patchPreview,
            additions:
              typeof response.gitDiff === 'object' && response.gitDiff
                ? (response.gitDiff as Record<string, unknown>).additions
                : undefined,
            deletions:
              typeof response.gitDiff === 'object' && response.gitDiff
                ? (response.gitDiff as Record<string, unknown>).deletions
                : undefined,
          },
        },
        commonMeta,
      );
    } else if (hook.tool_name === 'Glob' || hook.tool_name === 'Grep') {
      const { contentPreview, filenames } = buildSearchMatchPreview(response);
      emitToolLifecycleEvent(
        {
          type: 'file',
          name: 'file_search_complete',
          status: 'success',
          summary: `${hook.tool_name} found ${String(response.numFiles ?? response.numMatches ?? 0)} result(s)`,
          payload: {
            toolName: hook.tool_name,
            numFiles: response.numFiles,
            numMatches: response.numMatches,
            truncated: response.truncated,
            filenames,
            contentPreview,
          },
        },
        commonMeta,
      );
    }

    return okHookOutput();
  };
}

function createPostToolFailureHook(meta: {
  getSessionId: () => string | undefined;
  getSelectedModel: () => string | undefined;
  runId?: string;
  queryId?: string;
}): HookCallback {
  return async (input): Promise<SyncHookJSONOutput> => {
    const hook = input as PostToolUseFailureHookInput;
    emitToolLifecycleEvent(
      {
        type: hook.tool_name === 'Bash' ? 'command' : hook.tool_name === 'Read' || hook.tool_name === 'Write' || hook.tool_name === 'Edit' ? 'file' : 'tool',
        name: hook.tool_name === 'Bash' ? 'command_failed' : 'tool_failed',
        status: 'error',
        summary: `${hook.tool_name} failed: ${hook.error}`,
        payload: {
          toolName: hook.tool_name,
          toolUseId: hook.tool_use_id,
          input: hook.tool_input as Record<string, unknown>,
          error: hook.error,
          isInterrupt: hook.is_interrupt,
        },
      },
      {
        newSessionId: meta.getSessionId(),
        selectedModel: meta.getSelectedModel(),
        runId: meta.runId,
        queryId: meta.queryId,
      },
    );
    return okHookOutput();
  };
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Find the transcript JSONL path for a given session ID.
 * The Agent SDK stores transcripts as {sessionId}.jsonl under /home/node/.claude/projects/.
 * Falls back to sessions-index.json lookup if direct file match isn't found.
 */
function findTranscriptPath(sessionId: string): string | null {
  const claudeDir = '/home/node/.claude/projects';
  if (!fs.existsSync(claudeDir)) return null;

  const targetFile = `${sessionId}.jsonl`;

  try {
    const walkDir = (dir: string): string | null => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip subagents directory — only archive the main session transcript
          if (entry.name === 'subagents') continue;
          const found = walkDir(fullPath);
          if (found) return found;
        } else if (entry.name === targetFile) {
          return fullPath;
        } else if (entry.name === 'sessions-index.json') {
          try {
            const index: SessionsIndex = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
            const match = index.entries.find(e => e.sessionId === sessionId);
            if (match?.fullPath && fs.existsSync(match.fullPath)) {
              return match.fullPath;
            }
          } catch { /* ignore parse errors */ }
        }
      }
      return null;
    };
    return walkDir(claudeDir);
  } catch {
    return null;
  }
}

/**
 * Extract hash from an archive file's YAML front matter.
 * Reads only the first 512 bytes for efficiency.
 * Returns null if no front matter or no hash line found.
 */
function extractHashFromArchive(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf-8', 0, bytesRead);
    if (!head.startsWith('---')) return null;
    const match = head.match(/^hash:\s*(\S+)/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Archive transcript to conversations/ on container exit.
 * Uses sessionId prefix in filename so the same session overwrites its own archive.
 * Includes YAML front matter with metadata and hash-based deduplication.
 */
function archiveOnExit(sessionId: string | undefined, input: ContainerInput): void {
  if (!sessionId) return;

  const transcriptPath = findTranscriptPath(sessionId);
  if (!transcriptPath) {
    log('Exit archive: no transcript found');
    return;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    if (messages.length === 0) {
      log('Exit archive: no messages to archive');
      return;
    }

    const summary = getSessionSummary(sessionId, transcriptPath);
    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${sessionId.slice(0, 8)}.md`;

    const conversationsDir = '/workspace/group/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });

    // Generate markdown body (without metadata) to compute hash
    const bodyMarkdown = formatTranscriptMarkdown(messages, summary, input.assistantName);
    const hash = crypto.createHash('sha256').update(bodyMarkdown).digest('hex').slice(0, 16);

    // Hash dedup: scan existing archives
    try {
      const existingFiles = fs.readdirSync(conversationsDir).filter(f => f.endsWith('.md'));
      for (const file of existingFiles) {
        const existingHash = extractHashFromArchive(path.join(conversationsDir, file));
        if (existingHash === hash) {
          log(`Exit archive: skipped (duplicate hash ${hash} in ${file})`);
          return;
        }
      }
    } catch {
      // If scan fails, proceed with writing
    }

    // Build metadata
    const round = messages.filter(m => m.role === 'user').length;
    const metadata: ArchiveMetadata = {
      session: sessionId,
      round,
      hash,
      source: 'exit',
      created_at: new Date().toISOString(),
    };

    const markdown = formatTranscriptMarkdown(messages, summary, input.assistantName, metadata);
    fs.writeFileSync(path.join(conversationsDir, filename), markdown);
    log(`Exit archive: ${filename} (hash=${hash}, round=${round})`);
    enqueueMemoryExtractTask(filename, metadata);
  } catch (err) {
    log(`Exit archive failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * PreCompact hook — archiving moved to archiveOnExit(), this is now a no-op placeholder.
 */
function createPreCompactHook(_assistantName?: string): HookCallback {
  return async (_input, _toolUseId, _context) => {
    log('PreCompact hook fired (archive deferred to exit)');
    return {};
  };
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

interface ArchiveMetadata {
  session: string;
  round: number;
  hash: string;
  source: string;
  created_at: string;
}

function enqueueMemoryExtractTask(
  archiveFile: string,
  metadata: ArchiveMetadata,
): void {
  try {
    fs.mkdirSync(IPC_TASKS_DIR, { recursive: true });
    const requestId = `memext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
      type: 'memory_extract_from_archive',
      requestId,
      archiveFile,
      archiveHash: metadata.hash,
      round: metadata.round,
      createdAt: metadata.created_at,
      timestamp: new Date().toISOString(),
    };
    const taskPath = path.join(IPC_TASKS_DIR, `${requestId}.json`);
    const tempPath = `${taskPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tempPath, taskPath);
    log(`Queued memory extract task: ${requestId} (${archiveFile})`);
  } catch (err) {
    log(
      `Queue memory extract task failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string, metadata?: ArchiveMetadata): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];

  if (metadata) {
    lines.push('---');
    lines.push(`session: ${metadata.session}`);
    lines.push(`round: ${metadata.round}`);
    lines.push(`hash: ${metadata.hash}`);
    lines.push(`source: ${metadata.source}`);
    lines.push(`created_at: ${metadata.created_at}`);
    lines.push('---');
    lines.push('');
  }

  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
interface IpcInputMessage {
  text: string;
  selectedModel?: string;
  queryId?: string;
}

function drainIpcInput(): IpcInputMessage[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: IpcInputMessage[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push({
            text: String(data.text),
            selectedModel:
              typeof data.selectedModel === 'string'
                ? data.selectedModel
                : undefined,
            queryId:
              typeof data.queryId === 'string' ? data.queryId : undefined,
          });
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns merged prompt text plus selectedModel, or null if _close.
 */
function waitForIpcMessage(): Promise<{
  prompt: string;
  selectedModel: string;
  queryId?: string;
} | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        const prompt = messages.map((m) => m.text).join('\n');
        const selectedModel = messages[messages.length - 1].selectedModel || MODEL_DEFAULT;
        const queryId = messages[messages.length - 1].queryId;
        resolve({ prompt, selectedModel, queryId });
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function withQueryScopedEnv(
  env: Record<string, string | undefined>,
  runId: string | undefined,
  queryId: string | undefined,
): Record<string, string | undefined> {
  if (!runId || !queryId || !env.ANTHROPIC_BASE_URL) {
    return env;
  }

  const baseUrl = env.ANTHROPIC_BASE_URL.replace(/\/+$/, '');
  return {
    ...env,
    ANTHROPIC_BASE_URL: `${baseUrl}/__nanoclaw__/${encodeURIComponent(runId)}/${encodeURIComponent(queryId)}`,
  };
}

/** Build shared query options. */
function buildQueryOptions(
  containerInput: ContainerInput,
  selectedModel: string,
  queryId: string | undefined,
  mcpServerPath: string,
  sdkEnv: Record<string, string | undefined>,
  overrides: {
    sessionId?: string;
    resumeAt?: string;
  },
) {
  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  const resolvedModel = selectedModel || MODEL_DEFAULT;
  log(`Model from host: model=${resolvedModel}`);

  return {
    cwd: '/workspace/group',
    additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
    resume: overrides.sessionId,
    resumeSessionAt: overrides.resumeAt,
    systemPrompt: globalClaudeMd
      ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
      : undefined,
    allowedTools: [
      'Bash',
      'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Task', 'TaskOutput', 'TaskStop',
      'TeamCreate', 'TeamDelete', 'SendMessage',
      'TodoWrite', 'ToolSearch', 'Skill',
      'NotebookEdit',
      'mcp__nanoclaw__*'
    ],
    env: withQueryScopedEnv(sdkEnv, containerInput.runId, queryId),
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    settingSources: ['project', 'user'] as Array<'project' | 'user'>,
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          NANOCLAW_WORKFLOW_ID: containerInput.executionContext?.workflowId || '',
          NANOCLAW_STAGE_KEY: containerInput.executionContext?.stageKey || '',
          NANOCLAW_DELEGATION_ID: containerInput.executionContext?.delegationId || '',
        },
      },
    },
    hooks: {
      PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
      PreToolUse: [{
        hooks: [createPreToolHook({
          getSessionId: () => overrides.sessionId,
          getSelectedModel: () => resolvedModel,
          runId: containerInput.runId,
          queryId,
        })],
      }],
      PostToolUse: [{
        hooks: [createPostToolHook({
          getSessionId: () => overrides.sessionId,
          getSelectedModel: () => resolvedModel,
          runId: containerInput.runId,
          queryId,
        })],
      }],
      PostToolUseFailure: [{
        hooks: [createPostToolFailureHook({
          getSessionId: () => overrides.sessionId,
          getSelectedModel: () => resolvedModel,
          runId: containerInput.runId,
          queryId,
        })],
      }],
    },
    model: resolvedModel,
  };
}

/** Iterate a single SDK query, streaming results via writeOutput. */
async function iterateQuery(
  stream: MessageStream,
  options: ReturnType<typeof buildQueryOptions>,
  identifiers: { runId?: string; queryId?: string },
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; planResult?: string }> {
  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let planResult: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  for await (const message of query({ prompt: stream, options })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
      writeEvent(
        {
          type: 'lifecycle',
          name: 'sdk_init',
          status: 'success',
          summary: 'Claude SDK session initialized',
          payload: {
            sessionId: newSessionId,
          },
        },
        {
          newSessionId,
          selectedModel: options.model,
          runId: identifiers.runId,
          queryId: identifiers.queryId,
        },
      );
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
      writeEvent(
        {
          type: 'task',
          name: 'task_notification',
          status: tn.status,
          summary: tn.summary,
          payload: {
            taskId: tn.task_id,
            status: tn.status,
            summary: tn.summary,
          },
        },
        {
          newSessionId,
          selectedModel: options.model,
          runId: identifiers.runId,
          queryId: identifiers.queryId,
        },
      );
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      if (message.subtype?.startsWith('error')) {
        writeOutput({
          status: 'error',
          result: null,
          error: textResult || 'Agent query failed.',
          newSessionId,
          selectedModel: options.model,
          runId: identifiers.runId,
          queryId: identifiers.queryId,
        });
      } else {
        planResult = textResult || undefined;
        writeOutput({
          status: 'success',
          result: textResult || null,
          newSessionId,
          selectedModel: options.model,
          runId: identifiers.runId,
          queryId: identifiers.queryId,
        });
      }
      // Result received — end the stream so the query exits naturally
      // and the null completion marker can be emitted by the main loop.
      stream.end();
    }
  }

  log(`Query phase done. Messages: ${messageCount}, results: ${resultCount}`);
  return { newSessionId, lastAssistantUuid, planResult };
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Stream is ended when a result is received, causing the query
 * to exit naturally and the null completion marker to be emitted.
 */
async function runQuery(
  prompt: string,
  selectedModel: string,
  queryId: string | undefined,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  selectedModel: string;
  queryId?: string;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    if (stream.ended) return;
    const messages = drainIpcInput();
    for (const message of messages) {
      writeEvent(
        {
          type: 'lifecycle',
          name: 'query_merged_into_active_query',
          status: 'success',
          summary: 'Merged incoming message into active query stream',
          payload: {
            mergedQueryId: message.queryId,
            targetQueryId: queryId,
            textLength: message.text.length,
          },
        },
        {
          newSessionId,
          selectedModel: options.model,
          runId: containerInput.runId,
          queryId,
        },
      );
      log(`Piping IPC message into active query (${message.text.length} chars)`);
      stream.push(message.text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;

  const options = buildQueryOptions(
    containerInput,
    selectedModel,
    queryId,
    mcpServerPath,
    sdkEnv,
    {
      sessionId,
      resumeAt,
    },
  );
  const result = await iterateQuery(stream, options, {
    runId: containerInput.runId,
    queryId,
  });
  newSessionId = result.newSessionId || newSessionId;
  lastAssistantUuid = result.lastAssistantUuid;

  ipcPolling = false;
  log(`Query done. newSessionId: ${newSessionId || 'none'}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return {
    newSessionId,
    lastAssistantUuid,
    closedDuringQuery,
    selectedModel: options.model,
    queryId,
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  let confirmedSessionId: string | undefined;
  let selectedModel = containerInput.selectedModel || MODEL_DEFAULT;
  let currentQueryId = containerInput.queryId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK — this is an automated trigger, not a user message]\nExecute the task below and reply with the result. Be concise and direct.\nRules:\n- Stay focused on the task only. Do NOT do anything unrelated.\n- Do NOT modify, delete, or create scheduled tasks.\n- Do NOT read or modify project source code.\n- Do NOT call send_message. Your output will be sent to the user automatically. Calling send_message causes duplicate messages.\n- If the task is a simple reminder/notification, just output the message text directly without using any tools.\n- If the task requires fetching information (e.g. weather, data lookup), use tools as needed, then output the result.\n\nTask: ${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.map((m) => m.text).join('\n');
    selectedModel = pending[pending.length - 1].selectedModel || MODEL_DEFAULT;
    currentQueryId = pending[pending.length - 1].queryId || currentQueryId;
  }

  // --- Slash command handling ---
  // Only known session slash commands are handled here. This prevents
  // accidental interception of user prompts that happen to start with '/'.
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const trimmedPrompt = prompt.trim();
  const isSessionSlashCommand = KNOWN_SESSION_COMMANDS.has(trimmedPrompt);

  if (isSessionSlashCommand) {
    log(`Handling session command: ${trimmedPrompt}`);
    let slashSessionId: string | undefined;
    let compactBoundarySeen = false;
    let hadError = false;
    let resultEmitted = false;

    try {
      for await (const message of query({
        prompt: trimmedPrompt,
        options: {
          cwd: '/workspace/group',
          resume: sessionId,
          systemPrompt: undefined,
          allowedTools: [],
          env: sdkEnv,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'] as Array<'project' | 'user'>,
          hooks: {
            PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
          },
        },
      })) {
        const msgType = message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
        log(`[slash-cmd] type=${msgType}`);

        if (message.type === 'system' && message.subtype === 'init') {
          slashSessionId = message.session_id;
          log(`Session after slash command: ${slashSessionId}`);
        }

        // Observe compact_boundary to confirm compaction completed
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          compactBoundarySeen = true;
          log('Compact boundary observed — compaction completed');
        }

        if (message.type === 'result') {
          const resultSubtype = (message as { subtype?: string }).subtype;
          const textResult = 'result' in message ? (message as { result?: string }).result : null;

          if (resultSubtype?.startsWith('error')) {
            hadError = true;
            writeOutput({
              status: 'error',
              result: null,
              error: textResult || 'Session command failed.',
              newSessionId: slashSessionId,
            });
          } else {
            writeOutput({
              status: 'success',
              result: textResult || 'Conversation compacted.',
              newSessionId: slashSessionId,
            });
          }
          resultEmitted = true;
        }
      }
    } catch (err) {
      hadError = true;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Slash command error: ${errorMsg}`);
      writeOutput({ status: 'error', result: null, error: errorMsg });
    }

    log(`Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}`);

    // Warn if compact_boundary was never observed — compaction may not have occurred
    if (!hadError && !compactBoundarySeen) {
      log('WARNING: compact_boundary was not observed. Compaction may not have completed.');
    }

    // Only emit final session marker if no result was emitted yet and no error occurred
    if (!resultEmitted && !hadError) {
      writeOutput({
        status: 'success',
        result: compactBoundarySeen
          ? 'Conversation compacted.'
          : 'Compaction requested but compact_boundary was not observed.',
        newSessionId: slashSessionId,
      });
    } else if (!hadError) {
      // Emit session-only marker so host updates session tracking
      writeOutput({ status: 'success', result: null, newSessionId: slashSessionId });
    }
    return;
  }
  // --- End slash command handling ---

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(
        prompt,
        selectedModel,
        currentQueryId,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
        confirmedSessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
        selectedModel: queryResult.selectedModel,
        runId: containerInput.runId,
        queryId: queryResult.queryId,
      });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.prompt.length} chars), starting new query`);
      prompt = nextMessage.prompt;
      selectedModel = nextMessage.selectedModel || MODEL_DEFAULT;
      currentQueryId = nextMessage.queryId;
    }

    // Archive transcript on normal exit
    archiveOnExit(confirmedSessionId || sessionId, containerInput);
  } catch (err) {
    // Archive transcript on error exit
    archiveOnExit(confirmedSessionId || sessionId, containerInput);

    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: confirmedSessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
