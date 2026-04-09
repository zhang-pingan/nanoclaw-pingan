import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

import { callAnthropicMessages } from './agent-api.js';
import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';

/** Format a Date to a local timezone string without T/Z (e.g., "2026-03-26 12:05:00") */
function formatLocalTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}
import {
  createPendingAskQuestion,
  dispatchCurrentAskQuestion,
  expirePendingAskQuestions,
  normalizeAskQuestions,
} from './ask-user-question.js';
import {
  getAvailableWorkflowTypes,
  onDelegationComplete as onWorkflowDelegationComplete,
} from './workflow.js';
import { AvailableGroup } from './container-runner.js';
import {
  createDelegation,
  createMemory,
  createTask,
  deleteMemory,
  deleteTask,
  doctorMemories,
  gcMemories,
  getMemoryExtractConfig,
  getDelegation,
  getMemoryById,
  getTaskById,
  recordMemoryMetric,
  resolveConflict,
  searchMemories,
  searchMessages,
  storeChatMetadata,
  storeMessageDirect,
  updateDelegation,
  updateTask,
} from './db.js';
import type { MemoryExtractConfig } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { InteractiveCard, RegisteredGroup } from './types.js';
import {
  createWorkbenchInteractionItem,
  updateWorkbenchInteractionItemStatus,
} from './workbench-store.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  enqueueMessageCheck: (groupJid: string) => void;
  sendCard?: (
    jid: string,
    card: InteractiveCard,
  ) => Promise<string | undefined>;
  sendFile?: (jid: string, filePath: string, caption?: string) => Promise<void>;
  reloadContainer?: (jid: string) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    try {
      await expirePendingAskQuestions({
        registeredGroups,
        sendMessage: deps.sendMessage,
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to expire pending ask questions');
    }

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  if (
                    typeof data.workflowId === 'string' &&
                    data.workflowId &&
                    typeof data.stageKey === 'string' &&
                    data.stageKey &&
                    typeof data.sourceRefId === 'string' &&
                    data.sourceRefId
                  ) {
                    createWorkbenchInteractionItem({
                      workflowId: data.workflowId,
                      stageKey: data.stageKey,
                      delegationId:
                        typeof data.delegationId === 'string' &&
                        data.delegationId
                          ? data.delegationId
                          : null,
                      groupFolder: sourceGroup,
                      sourceType: 'send_message',
                      sourceRefId: data.sourceRefId,
                      title: data.sender ? `${data.sender} 消息` : '节点消息',
                      body: typeof data.text === 'string' ? data.text : '',
                      createdAt:
                        typeof data.timestamp === 'string'
                          ? data.timestamp
                          : new Date().toISOString(),
                    });
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'file' &&
                data.chatJid &&
                data.filePath
              ) {
                // Authorization: same as message
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Map container path to host path
                  const containerPrefix = '/workspace/group/';
                  if (
                    typeof data.filePath !== 'string' ||
                    !data.filePath.startsWith(containerPrefix)
                  ) {
                    logger.warn(
                      { filePath: data.filePath, sourceGroup },
                      'IPC file path must start with /workspace/group/',
                    );
                  } else {
                    const relativePath = data.filePath.slice(
                      containerPrefix.length,
                    );
                    const hostPath = path.resolve(
                      path.join(GROUPS_DIR, sourceGroup, relativePath),
                    );
                    // Prevent directory traversal
                    const expectedPrefix = path.resolve(
                      path.join(GROUPS_DIR, sourceGroup),
                    );
                    if (
                      !hostPath.startsWith(expectedPrefix + path.sep) &&
                      hostPath !== expectedPrefix
                    ) {
                      logger.warn(
                        { filePath: data.filePath, hostPath, sourceGroup },
                        'IPC file path traversal attempt blocked',
                      );
                    } else if (!fs.existsSync(hostPath)) {
                      logger.warn(
                        { hostPath, sourceGroup },
                        'IPC file does not exist on host',
                      );
                    } else if (deps.sendFile) {
                      await deps.sendFile(data.chatJid, hostPath, data.caption);
                      logger.info(
                        { chatJid: data.chatJid, hostPath, sourceGroup },
                        'IPC file sent',
                      );
                    } else {
                      // Fallback: send caption text if channel doesn't support files
                      await deps.sendMessage(
                        data.chatJid,
                        data.caption ||
                          `[文件: ${path.basename(hostPath)}] (该渠道不支持发送文件)`,
                      );
                      logger.info(
                        { chatJid: data.chatJid, sourceGroup },
                        'IPC file fallback to text (sendFile not supported)',
                      );
                    }
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC file attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

function parseDelegationTargetFolder(task: string): {
  targetFolder: string | null;
  cleanedTask: string;
} {
  const match = task.match(/@\{([^}\s]+)\}/);
  if (!match) {
    return { targetFolder: null, cleanedTask: task.trim() };
  }

  const candidate = match[1].trim();
  const cleanedTask = task.replace(match[0], '').trim();
  if (!isValidGroupFolder(candidate)) {
    return {
      targetFolder: null,
      cleanedTask: cleanedTask || task.trim(),
    };
  }

  return {
    targetFolder: candidate,
    cleanedTask: cleanedTask || task.trim(),
  };
}

function stripLeadingTriggerMention(task: string): string {
  const stripped = task
    .trim()
    .replace(/^@Andy(?:\s+|$)/, '')
    .trim();
  return stripped || task.trim();
}

interface ExtractedArchiveMessage {
  index: number;
  sender: 'user' | 'assistant' | 'system' | 'unknown';
  raw_sender: string;
  content: string;
}

interface ArchiveMemoryCandidate {
  layer: 'working' | 'episodic' | 'canonical';
  memory_type: 'preference' | 'rule' | 'fact' | 'summary';
  content: string;
  reason: string;
  confidence: number;
  source_indexes?: number[];
}

interface ArchiveExtractionResult {
  memories: ArchiveMemoryCandidate[];
}

interface ArchiveExtractionAttempt {
  attempt: number;
  apiResponse: Awaited<ReturnType<typeof callAnthropicMessages>>;
}

const archiveExtractionResultSchema = z.object({
  memories: z.array(
    z.object({
      layer: z.enum(['working', 'episodic', 'canonical']),
      memory_type: z.enum(['preference', 'rule', 'fact', 'summary']),
      content: z.string(),
      reason: z.string(),
      confidence: z.number(),
      source_indexes: z.array(z.number().int()).default([]),
    }),
  ),
});

function normalizeArchiveSender(
  sender: string,
): ExtractedArchiveMessage['sender'] {
  const normalized = sender.trim().toLowerCase();
  if (normalized === 'user') return 'user';
  if (normalized === 'assistant' || normalized === 'andy') return 'assistant';
  if (normalized === 'system') return 'system';
  return 'unknown';
}

function isInternalArchiveMessageContent(content: string): boolean {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return true;

  return (
    /^<context\b/i.test(normalized) ||
    /^\[MEMORY PACK\]/i.test(normalized) ||
    /^Base directory for this skill:/i.test(normalized) ||
    /^Memory from: /i.test(normalized) ||
    /^\[(?:canonical|working|episodic)\//i.test(normalized) ||
    /\/home\/node\/\.claude\/skills\//i.test(normalized)
  );
}

function normalizeMemoryCandidateContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function parseArchiveMarkdownMessages(
  markdown: string,
): ExtractedArchiveMessage[] {
  const lines = markdown.split('\n');
  const messages: ExtractedArchiveMessage[] = [];
  const lineRe = /^\*\*([^*]+)\*\*:\s*(.+)\s*$/;
  for (const line of lines) {
    const m = line.match(lineRe);
    if (!m) continue;
    const rawSender = m[1].trim();
    const content = m[2].trim();
    if (!rawSender || !content) continue;
    messages.push({
      index: messages.length,
      sender: normalizeArchiveSender(rawSender),
      raw_sender: rawSender,
      content,
    });
  }
  return messages;
}

function sanitizeArchiveMessagesForExtraction(
  messages: ExtractedArchiveMessage[],
): ExtractedArchiveMessage[] {
  return messages
    .filter((m) => m.content.trim().length > 0)
    .filter((m) => !isInternalArchiveMessageContent(m.content))
    .slice(-80)
    .map((m) => ({
      ...m,
      content: m.content.replace(/\s+/g, ' ').trim().slice(0, 1000),
    }));
}

function extractJsonObjectFromText(text: string): string {
  const noThink = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ').trim();
  const noFence = noThink.replace(/```(?:json)?/gi, ' ').trim();
  const firstBrace = noFence.indexOf('{');
  const lastBrace = noFence.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return noFence.slice(firstBrace, lastBrace + 1);
  }
  return noFence;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeArchiveMessages(
  messages: ExtractedArchiveMessage[],
): Array<{
  index: number;
  sender: ExtractedArchiveMessage['sender'];
  preview: string;
}> {
  return messages.slice(0, 5).map((message) => ({
    index: message.index,
    sender: message.sender,
    preview: message.content.slice(0, 160),
  }));
}

function buildArchiveExtractionRequestPayload(
  sourceGroup: string,
  archiveName: string,
  sanitizedMessages: ExtractedArchiveMessage[],
) {
  return {
    system: buildArchiveExtractionSystemPrompt(),
    messages: [
      {
        role: 'user' as const,
        content: buildArchiveExtractionUserPrompt(
          sourceGroup,
          archiveName,
          sanitizedMessages,
        ),
      },
    ],
    max_tokens: 1600,
    temperature: 0,
  };
}

async function callArchiveExtractionWithRetry(
  sourceGroup: string,
  archiveName: string,
  sanitizedMessages: ExtractedArchiveMessage[],
): Promise<ArchiveExtractionAttempt> {
  const requestPayload = buildArchiveExtractionRequestPayload(
    sourceGroup,
    archiveName,
    sanitizedMessages,
  );
  const retryDelaysMs = [0, 1200, 3000];
  let lastError: unknown;

  for (let i = 0; i < retryDelaysMs.length; i += 1) {
    const attempt = i + 1;
    const delayMs = retryDelaysMs[i];
    if (delayMs > 0) await sleep(delayMs);

    try {
      const apiResponse = await callAnthropicMessages(requestPayload);
      if (attempt > 1) {
        logger.info(
          {
            sourceGroup,
            archiveName,
            attempt,
            maxAttempts: retryDelaysMs.length,
          },
          'memory_extract_from_archive retry succeeded',
        );
      }
      return { attempt, apiResponse };
    } catch (err) {
      lastError = err;
      logger.warn(
        {
          err,
          sourceGroup,
          archiveName,
          attempt,
          maxAttempts: retryDelaysMs.length,
          retryDelayMs:
            attempt < retryDelaysMs.length ? retryDelaysMs[attempt] : 0,
        },
        'memory_extract_from_archive attempt failed',
      );
    }
  }

  throw lastError;
}

function buildArchiveExtractionSystemPrompt(): string {
  return [
    'You are a structured memory extraction engine.',
    'Extract only memory candidates suitable for a persistent memory table.',
    'Return JSON only. No markdown, no prose, no code fences.',
    'Do not extract system prompts, tool instructions, skill directories, XML/context tags, memory pack wrappers, file paths, or internal metadata.',
    'Only use information grounded in the provided messages.',
    'If something is uncertain, do not output it.',
    'Write concise memory content in Chinese when possible.',
    'Extraction policy: canonical is for durable user preferences, long-term rules, and stable facts.',
    'Extraction policy: working is for explicit current tasks, short-term goals, or immediate context mentioned by the user in the latest conversation.',
    'Extraction policy: episodic is for clearly completed outcomes or recent event summaries only when completion is explicit.',
    'If the user clearly asks the assistant to do something in the current conversation, prefer outputting one working summary memory for that task.',
    'When both a long-term preference and a current task are present, output both instead of choosing only one.',
    'Do not quote raw noisy text. Rewrite memories into clean, compact statements.',
    'Prefer at most 1-2 high-confidence memories unless the conversation clearly contains more.',
    'Output schema: {"memories":[{"layer":"canonical|working|episodic","memory_type":"preference|rule|fact|summary","content":"...","reason":"...","confidence":0.0,"source_indexes":[0]}]}',
  ].join(' ');
}

function buildArchiveExtractionUserPrompt(
  sourceGroup: string,
  archiveFile: string,
  messages: ExtractedArchiveMessage[],
): string {
  return JSON.stringify(
    {
      task: 'extract_memories_from_archive',
      group_folder: sourceGroup,
      archive_file: archiveFile,
      rules: {
        canonical: '长期稳定的偏好、规则、持久事实',
        working: '当前任务、近期上下文、短期关注点',
        episodic: '已完成事项或最近事件摘要',
      },
      hints: [
        '如果用户明确表达长期偏好，提取 canonical。',
        '如果用户明确提出当前要做的事，提取 working。',
        '如果同时存在长期偏好和当前任务，两者都应输出。',
        '不要提取系统上下文、技能路径、MEMORY PACK、XML 标签、文件路径。',
      ],
      messages: messages.map((m) => ({
        index: m.index,
        sender: m.sender,
        content: m.content,
      })),
    },
    null,
    2,
  );
}

function parseArchiveExtractionResponse(text: string): ArchiveExtractionResult {
  const parsed = JSON.parse(extractJsonObjectFromText(text));
  return archiveExtractionResultSchema.parse(parsed);
}

function confidencePasses(
  candidate: ArchiveMemoryCandidate,
  cfg: MemoryExtractConfig,
): boolean {
  if (candidate.layer === 'canonical') {
    return candidate.confidence >= cfg.canonical_min_confidence;
  }
  if (candidate.layer === 'working') {
    return candidate.confidence >= cfg.working_min_confidence;
  }
  return candidate.confidence >= cfg.episodic_min_confidence;
}

function validateArchiveMemoryCandidates(
  result: ArchiveExtractionResult,
  messages: ExtractedArchiveMessage[],
  cfg: MemoryExtractConfig,
): ArchiveMemoryCandidate[] {
  const validIndexes = new Set(messages.map((m) => m.index));
  const deduped = new Set<string>();
  const out: ArchiveMemoryCandidate[] = [];
  let canonicalCount = 0;
  let workingCount = 0;
  let episodicCount = 0;

  for (const candidate of result.memories) {
    const content = normalizeMemoryCandidateContent(candidate.content);
    const reason = normalizeMemoryCandidateContent(candidate.reason);
    if (content.length < 8 || content.length > 400) continue;
    if (!reason || reason.length > 200) continue;
    if (
      !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1
    ) {
      continue;
    }
    if (
      isInternalArchiveMessageContent(content) ||
      isInternalArchiveMessageContent(reason)
    ) {
      continue;
    }
    if (content.includes('[archive:') || /<context\b/i.test(content)) continue;
    const sourceIndexes = (candidate.source_indexes || []).filter((idx) =>
      validIndexes.has(idx),
    );
    if (sourceIndexes.length === 0) continue;
    if (!confidencePasses(candidate, cfg)) continue;

    const key = `${candidate.layer}|${candidate.memory_type}|${content.toLowerCase()}`;
    if (deduped.has(key)) continue;

    if (candidate.layer === 'canonical' && canonicalCount >= cfg.canonical_max)
      continue;
    if (candidate.layer === 'working' && workingCount >= cfg.working_max)
      continue;
    if (candidate.layer === 'episodic' && episodicCount >= cfg.episodic_max)
      continue;

    deduped.add(key);
    if (candidate.layer === 'canonical') canonicalCount += 1;
    if (candidate.layer === 'working') workingCount += 1;
    if (candidate.layer === 'episodic') episodicCount += 1;

    out.push({
      layer: candidate.layer,
      memory_type: candidate.memory_type,
      content,
      reason,
      confidence: candidate.confidence,
      source_indexes: sourceIndexes,
    });
  }

  return out;
}

function summarizeMemoryContent(id: string): string {
  const m = getMemoryById(id);
  if (!m) return `${id} (not found)`;
  const preview = m.content.replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${id}: ${preview}`;
}

async function sendConflictCardsFromReport(
  sourceGroup: string,
  deps: IpcDeps,
  conflictGroups: Array<{
    key: string;
    positiveIds: string[];
    negativeIds: string[];
  }>,
): Promise<void> {
  if (!deps.sendCard || conflictGroups.length === 0) return;
  const groups = deps.registeredGroups();
  const targetEntry = Object.entries(groups).find(
    ([, g]) => g.folder === sourceGroup,
  );
  if (!targetEntry) return;
  const targetJid = targetEntry[0];

  const cards = conflictGroups.slice(0, 3);
  for (const group of cards) {
    const posId = group.positiveIds[0];
    const negId = group.negativeIds[0];
    if (!posId || !negId) continue;

    const posText = summarizeMemoryContent(posId);
    const negText = summarizeMemoryContent(negId);

    const card: InteractiveCard = {
      header: { title: '记忆冲突待处理', color: 'orange' },
      body:
        `检测到冲突：${group.key}\n\n` +
        `A（正向）\n${posText}\n\n` +
        `B（反向）\n${negText}\n\n` +
        '请选择保留方案，或输入合并内容后提交。',
      buttons: [
        {
          id: 'keep-a',
          label: '保留 A',
          type: 'primary',
          value: {
            action: 'memory_conflict_keep',
            group_folder: sourceGroup,
            keep_id: posId,
            deprecate_id: negId,
          },
        },
        {
          id: 'keep-b',
          label: '保留 B',
          value: {
            action: 'memory_conflict_keep',
            group_folder: sourceGroup,
            keep_id: negId,
            deprecate_id: posId,
          },
        },
        {
          id: 'skip',
          label: '稍后处理',
          value: {
            action: 'memory_conflict_skip',
            group_folder: sourceGroup,
            keep_id: posId,
            deprecate_id: negId,
          },
        },
      ],
      form: {
        name: 'merge_conflict',
        inputs: [
          { name: 'merged_content', placeholder: '输入合并后的记忆内容' },
        ],
        submitButton: {
          id: 'merge-submit',
          label: '合并提交',
          type: 'default',
          value: {
            action: 'memory_conflict_merge',
            group_folder: sourceGroup,
            merge_id_a: posId,
            merge_id_b: negId,
          },
        },
      },
    };

    try {
      await deps.sendCard(targetJid, card);
    } catch (err) {
      logger.warn(
        { err, sourceGroup, targetJid, key: group.key },
        'Failed to send memory conflict card',
      );
    }
  }
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    description?: string;
    // For archive-triggered memory extraction
    archiveFile?: string;
    archiveHash?: string;
    round?: number;
    createdAt?: string;
    // For memory_search
    query?: string;
    limit?: number;
    mode?: string;
    requestId?: string;
    // For memory
    content?: string;
    layer?: 'working' | 'episodic' | 'canonical';
    memory_type?: 'preference' | 'rule' | 'fact' | 'summary';
    memory_status?: 'active' | 'conflicted' | 'deprecated';
    memoryId?: string;
    dryRun?: boolean;
    staleDays?: number;
    // For memory_resolve_conflict
    keep_id?: string;
    deprecate_id?: string;
    merge_ids?: string[];
    merged_content?: string;
    // For delegate_task / complete_delegation / request_delegation
    delegationId?: string;
    targetGroupJid?: string;
    requesterJid?: string;
    task?: string;
    result?: string;
    outcome?: string;
    // For workflow
    service?: string;
    // For ask_user_question
    questions?: unknown;
    timeoutSec?: number;
    metadata?: Record<string, string>;
    workflowId?: string;
    stageKey?: string;
    sourceType?: string;
    sourceRefId?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  const writeMemoryResult = (
    groupFolder: string,
    requestId: string,
    payload: object,
  ) => {
    const resultsDir = path.join(
      DATA_DIR,
      'ipc',
      groupFolder,
      'search-results',
    );
    fs.mkdirSync(resultsDir, { recursive: true });
    const responsePath = path.join(resultsDir, `${requestId}.json`);
    const tempPath = `${responsePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tempPath, responsePath);
  };
  const writeAskResult = (
    groupFolder: string,
    requestId: string,
    payload: object,
  ) => {
    const resultsDir = path.join(DATA_DIR, 'ipc', groupFolder, 'ask-results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const responsePath = path.join(resultsDir, `${requestId}.json`);
    const tempPath = `${responsePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tempPath, responsePath);
  };

  switch (data.type) {
    case 'memory_extract_from_archive': {
      if (!data.archiveFile) {
        logger.warn(
          { sourceGroup },
          'memory_extract_from_archive missing archiveFile',
        );
        break;
      }
      const archiveName = path.basename(data.archiveFile);
      if (archiveName !== data.archiveFile || !archiveName.endsWith('.md')) {
        logger.warn(
          { sourceGroup, archiveFile: data.archiveFile },
          'memory_extract_from_archive invalid archiveFile',
        );
        break;
      }

      const conversationsDir = path.resolve(
        path.join(GROUPS_DIR, sourceGroup, 'conversations'),
      );
      const archivePath = path.resolve(
        path.join(conversationsDir, archiveName),
      );
      if (
        !archivePath.startsWith(`${conversationsDir}${path.sep}`) &&
        archivePath !== conversationsDir
      ) {
        logger.warn(
          { sourceGroup, archivePath },
          'memory_extract_from_archive path traversal blocked',
        );
        break;
      }
      if (!fs.existsSync(archivePath)) {
        logger.warn(
          { sourceGroup, archivePath },
          'memory_extract_from_archive archive file not found',
        );
        break;
      }

      const archiveBytes = fs.statSync(archivePath).size;
      const markdown = fs.readFileSync(archivePath, 'utf-8');
      const extractConfig = getMemoryExtractConfig(sourceGroup);
      const parsedMessages = parseArchiveMarkdownMessages(markdown);
      const sanitizedMessages =
        sanitizeArchiveMessagesForExtraction(parsedMessages);
      const requestPayload = buildArchiveExtractionRequestPayload(
        sourceGroup,
        archiveName,
        sanitizedMessages,
      );

      try {
        if (sanitizedMessages.length === 0) {
          recordMemoryMetric(
            sourceGroup,
            'archive:extract_rejected',
            'reason=no_sanitized_messages',
          );
          logger.info(
            { sourceGroup, archiveName, parsedMessages: parsedMessages.length },
            'memory_extract_from_archive skipped due to empty sanitized messages',
          );
          break;
        }
        const { apiResponse, attempt } = await callArchiveExtractionWithRetry(
          sourceGroup,
          archiveName,
          sanitizedMessages,
        );
        const extracted = parseArchiveExtractionResponse(apiResponse.text);
        const candidates = validateArchiveMemoryCandidates(
          extracted,
          sanitizedMessages,
          extractConfig,
        );
        const created = candidates.map((c) =>
          createMemory({
            group_folder: sourceGroup,
            layer: c.layer,
            memory_type: c.memory_type,
            content: c.content,
            source: 'archive',
            metadata: JSON.stringify({
              archive_file: archiveName,
              archive_hash: data.archiveHash || null,
              archive_round: data.round || null,
              extraction_mode: 'agent_api',
              extraction_model: apiResponse.model,
              extraction_reason: c.reason,
              extraction_confidence: c.confidence,
              source_indexes: c.source_indexes || [],
              sanitized_message_count: sanitizedMessages.length,
              extract_config: extractConfig,
              extracted_at: new Date().toISOString(),
            }),
          }),
        );

        const report = doctorMemories(sourceGroup, 7);
        await sendConflictCardsFromReport(
          sourceGroup,
          deps,
          report.conflictGroups,
        );
        const gc = gcMemories(sourceGroup, {
          dryRun: false,
          staleWorkingDays: 14,
        });

        recordMemoryMetric(
          sourceGroup,
          'archive:extract',
          `file=${archiveName},created=${created.length}`,
        );
        if (candidates.length === 0) {
          recordMemoryMetric(
            sourceGroup,
            'archive:extract_rejected',
            'reason=no_valid_candidates',
          );
        }
        recordMemoryMetric(
          sourceGroup,
          'archive:doctor',
          `duplicates=${report.duplicateGroups.length},conflicts=${report.conflictGroups.length}`,
        );
        recordMemoryMetric(
          sourceGroup,
          'archive:gc',
          `dupDeleted=${gc.duplicateDeletedIds.length},staleDeleted=${gc.staleDeletedIds.length}`,
        );

        logger.info(
          {
            sourceGroup,
            archiveName,
            created: created.length,
            parsedMessages: parsedMessages.length,
            sanitizedMessages: sanitizedMessages.length,
            model: apiResponse.model,
            attempts: attempt,
            extractConfig,
            duplicates: report.duplicateGroups.length,
            conflicts: report.conflictGroups.length,
            duplicateDeleted: gc.duplicateDeletedIds.length,
            staleDeleted: gc.staleDeletedIds.length,
          },
          'memory_extract_from_archive completed',
        );
      } catch (err) {
        recordMemoryMetric(
          sourceGroup,
          'archive:extract_failed',
          `file=${archiveName}`,
        );
        logger.error(
          {
            err,
            sourceGroup,
            archiveFile: archiveName,
            archivePath,
            archiveBytes,
            requestSummary: {
              max_tokens: requestPayload.max_tokens,
              temperature: requestPayload.temperature,
              systemLength: requestPayload.system.length,
              userMessageLength:
                typeof requestPayload.messages[0]?.content === 'string'
                  ? requestPayload.messages[0].content.length
                  : 0,
            },
            parsedMessages: parsedMessages.length,
            sanitizedMessages: sanitizedMessages.length,
            sanitizedPreview: summarizeArchiveMessages(sanitizedMessages),
          },
          'memory_extract_from_archive failed',
        );
      }
      break;
    }

    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = formatLocalTime(interval.next().toDate());
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = formatLocalTime(new Date(Date.now() + ms));
        } else if (scheduleType === 'once') {
          // Node.js Date parses naive strings as local time.
          const date = new Date(data.schedule_value ?? '');
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = formatLocalTime(date);
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: formatLocalTime(new Date()),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = formatLocalTime(interval.next().toDate());
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = formatLocalTime(new Date(Date.now() + ms));
            }
          } else if (updatedTask.schedule_type === 'once') {
            const date = new Date(updatedTask.schedule_value ?? '');
            if (!isNaN(date.getTime())) {
              updates.next_run = formatLocalTime(date);
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          description: data.description,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'ask_user_question': {
      if (!data.requestId || typeof data.requestId !== 'string') {
        logger.warn({ sourceGroup }, 'ask_user_question missing requestId');
        break;
      }

      const normalized = normalizeAskQuestions(data.questions);
      if (!normalized.ok) {
        writeAskResult(sourceGroup, data.requestId, {
          requestId: data.requestId,
          status: 'rejected',
          answers: {},
          error: normalized.error,
          answeredAt: new Date().toISOString(),
          responder: null,
        });
        logger.warn(
          { sourceGroup, requestId: data.requestId, error: normalized.error },
          'ask_user_question rejected: invalid questions payload',
        );
        break;
      }

      const sourceEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === sourceGroup,
      );
      const targetJid = sourceEntry?.[0];
      if (!targetJid) {
        writeAskResult(sourceGroup, data.requestId, {
          requestId: data.requestId,
          status: 'rejected',
          answers: {},
          error: `target group not found for folder=${sourceGroup}`,
          answeredAt: new Date().toISOString(),
          responder: null,
        });
        logger.warn(
          { sourceGroup, requestId: data.requestId },
          'ask_user_question rejected: target JID not found',
        );
        break;
      }

      const timeout =
        typeof data.timeoutSec === 'number' && Number.isFinite(data.timeoutSec)
          ? Math.min(3600, Math.max(30, Math.floor(data.timeoutSec)))
          : 1800;

      createPendingAskQuestion({
        requestId: data.requestId,
        groupFolder: sourceGroup,
        chatJid: targetJid,
        questions: normalized.questions,
        timeoutSec: timeout,
        metadata: data.metadata,
      });
      if (data.workflowId && data.stageKey) {
        const firstQuestion = normalized.questions[0];
        createWorkbenchInteractionItem({
          workflowId: data.workflowId,
          stageKey: data.stageKey,
          delegationId: data.delegationId || null,
          groupFolder: sourceGroup,
          sourceType:
            data.metadata?.source_type === 'request_human_input'
              ? 'request_human_input'
              : 'ask_user_question',
          sourceRefId: data.requestId,
          title:
            data.metadata?.title ||
            (data.metadata?.source_type === 'request_human_input'
              ? '人工输入请求'
              : '节点提问'),
          body: firstQuestion?.question || '',
          createdAt: new Date().toISOString(),
          extra: {
            request_id: data.requestId,
            question_count: normalized.questions.length,
          },
        });
      }

      const dispatch = await dispatchCurrentAskQuestion({
        requestId: data.requestId,
        groupFolder: sourceGroup,
        registeredGroups,
        sendCard: deps.sendCard,
        sendMessage: deps.sendMessage,
      });

      if (!dispatch.ok) {
        writeAskResult(sourceGroup, data.requestId, {
          requestId: data.requestId,
          status: 'rejected',
          answers: {},
          error: dispatch.message,
          answeredAt: new Date().toISOString(),
          responder: null,
        });
        logger.warn(
          {
            sourceGroup,
            requestId: data.requestId,
            dispatchMessage: dispatch.message,
          },
          'ask_user_question rejected: failed to dispatch question',
        );
        updateWorkbenchInteractionItemStatus({
          sourceType:
            data.metadata?.source_type === 'request_human_input'
              ? 'request_human_input'
              : 'ask_user_question',
          sourceRefId: data.requestId,
          status: 'cancelled',
        });
      } else {
        logger.info(
          {
            sourceGroup,
            requestId: data.requestId,
            questionCount: normalized.questions.length,
            timeout,
          },
          'ask_user_question created and dispatched',
        );
      }
      break;
    }

    case 'request_delegation': {
      // Non-main groups request delegation via the main group
      if (isMain) {
        logger.warn(
          { sourceGroup },
          'Main group should use delegate_task directly, not request_delegation',
        );
        break;
      }

      if (!data.task) {
        logger.warn({ sourceGroup }, 'request_delegation missing task');
        break;
      }

      // Find main group of the same channel
      const sourceChannel = sourceGroup.split('_')[0];
      const mainEntry =
        Object.entries(registeredGroups).find(
          ([, g]) => g.isMain && g.folder.split('_')[0] === sourceChannel,
        ) || Object.entries(registeredGroups).find(([, g]) => g.isMain);
      if (!mainEntry) {
        logger.warn('request_delegation: main group not found');
        break;
      }
      const [mainJid, mainGroup] = mainEntry;

      // Find source group name
      const reqSourceEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === sourceGroup,
      );
      const reqSourceName = reqSourceEntry?.[1]?.name || sourceGroup;
      const normalizedTask = stripLeadingTriggerMention(data.task);
      const { targetFolder, cleanedTask } =
        parseDelegationTargetFolder(normalizedTask);

      // Construct synthetic message to main group
      const reqTrigger = mainGroup.trigger;
      const requesterJid = reqSourceEntry?.[0] || '';
      const requestedTarget = targetFolder
        ? Object.entries(registeredGroups).find(
            ([, g]) => g.folder === targetFolder,
          )
        : undefined;
      const requestedTargetJid = requestedTarget?.[0] || '';
      const requestedTargetHint = targetFolder
        ? requestedTargetJid
          ? `\n\n请求方指定目标群: folder="${targetFolder}"（JID: ${requestedTargetJid}）。若无冲突请优先委派到该群，并在 delegate_task 中传入 target_group_jid="${requestedTargetJid}"。`
          : `\n\n请求方指定目标群: folder="${targetFolder}"，但当前未找到该 folder 对应的注册群，请忽略该指定并自行判断委派目标。`
        : '';
      const reqContent = `${reqTrigger} [委派请求 | 来自:${reqSourceName}]\n\n${cleanedTask}\n\n请根据 available_groups.json 判断是否需要委派，以及委派给哪个群。如需委派请使用 delegate_task，并传入 requester_jid="${requesterJid}" 以便完成后自动通知请求方。${requestedTargetHint}`;
      const reqMsgId = `delreq-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const reqNow = Date.now().toString();

      storeChatMetadata(mainJid, reqNow);
      storeMessageDirect({
        id: reqMsgId,
        chat_jid: mainJid,
        sender: 'system',
        sender_name: `${reqSourceName}委派请求`,
        content: reqContent,
        timestamp: reqNow,
        is_from_me: true,
        is_bot_message: false,
      });

      deps.enqueueMessageCheck(mainJid);

      logger.info(
        { sourceGroup, sourceName: reqSourceName },
        'Delegation request forwarded to main group',
      );
      break;
    }

    case 'delegate_task': {
      // Only main group can delegate tasks
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized delegate_task attempt blocked',
        );
        break;
      }

      if (!data.targetGroupJid || !data.task) {
        logger.warn(
          { sourceGroup },
          'delegate_task missing targetGroupJid or task',
        );
        break;
      }

      const targetGroup = registeredGroups[data.targetGroupJid];
      if (!targetGroup) {
        logger.warn(
          { targetGroupJid: data.targetGroupJid },
          'delegate_task: target group not registered',
        );
        break;
      }

      // Enforce same-channel delegation
      const mainChannel = sourceGroup.split('_')[0];
      const targetChannel = targetGroup.folder.split('_')[0];
      if (mainChannel !== targetChannel) {
        logger.warn(
          {
            mainChannel,
            targetChannel,
            targetGroupJid: data.targetGroupJid,
          },
          'delegate_task blocked: cross-channel delegation not allowed',
        );
        // Write error response if requestId exists
        if (data.requestId) {
          const errDir = path.join(
            DATA_DIR,
            'ipc',
            sourceGroup,
            'delegation-results',
          );
          fs.mkdirSync(errDir, { recursive: true });
          const errPath = path.join(errDir, `${data.requestId}.json`);
          const tmpPath = `${errPath}.tmp`;
          fs.writeFileSync(
            tmpPath,
            JSON.stringify({
              error: `Cross-channel delegation not allowed (main: ${mainChannel}, target: ${targetChannel})`,
            }),
          );
          fs.renameSync(tmpPath, errPath);
        }
        break;
      }

      const delegationId =
        data.delegationId ||
        `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now().toString();

      // Create delegation record
      createDelegation({
        id: delegationId,
        source_jid:
          Object.entries(registeredGroups).find(
            ([, g]) => g.folder === sourceGroup,
          )?.[0] || '',
        source_folder: sourceGroup,
        target_jid: data.targetGroupJid,
        target_folder: targetGroup.folder,
        task: data.task,
        status: 'pending',
        result: null,
        outcome: null,
        requester_jid: data.requesterJid || null,
        created_at: now,
        updated_at: now,
      });

      // Ensure chat metadata exists for target JID
      storeChatMetadata(data.targetGroupJid, now);

      // Construct synthetic message with target group's trigger prefix
      const triggerPrefix = targetGroup.trigger;
      const syntheticContent = `${triggerPrefix} [委派任务 | ID:${delegationId} | 来自:主群]\n\n${data.task}\n\n完成后请调用 complete_delegation 工具报告结果，delegation_id 为 "${delegationId}"。`;
      const syntheticId = `del-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      storeMessageDirect({
        id: syntheticId,
        chat_jid: data.targetGroupJid,
        sender: 'system',
        sender_name: '主群委派',
        content: syntheticContent,
        timestamp: now,
        is_from_me: true,
        is_bot_message: false,
      });

      // Wake up the target group's agent
      deps.enqueueMessageCheck(data.targetGroupJid);

      // Write delegation ID back via IPC response
      const resultsDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'delegation-results',
      );
      fs.mkdirSync(resultsDir, { recursive: true });
      if (data.requestId) {
        const responsePath = path.join(resultsDir, `${data.requestId}.json`);
        const tempPath = `${responsePath}.tmp`;
        fs.writeFileSync(
          tempPath,
          JSON.stringify({ delegationId, status: 'created' }),
        );
        fs.renameSync(tempPath, responsePath);
      }

      logger.info(
        {
          delegationId,
          sourceGroup,
          targetFolder: targetGroup.folder,
          targetJid: data.targetGroupJid,
        },
        'Task delegated via IPC',
      );
      break;
    }

    case 'complete_delegation': {
      if (!data.delegationId || !data.result) {
        logger.warn(
          { sourceGroup },
          'complete_delegation missing delegationId or result',
        );
        break;
      }

      const delegation = getDelegation(data.delegationId);
      if (!delegation) {
        logger.warn(
          { delegationId: data.delegationId },
          'complete_delegation: delegation not found',
        );
        break;
      }

      // Verify the caller is the delegation's target
      if (delegation.target_folder !== sourceGroup) {
        logger.warn(
          {
            delegationId: data.delegationId,
            sourceGroup,
            expectedFolder: delegation.target_folder,
          },
          'Unauthorized complete_delegation attempt',
        );
        break;
      }

      // Update delegation status
      updateDelegation(data.delegationId, {
        status: 'completed',
        result: data.result,
        outcome:
          ((data as { outcome?: string }).outcome as
            | 'success'
            | 'failure'
            | null) || null,
      });

      // Find the target group name for the result message
      const delegTargetGroup = registeredGroups[delegation.target_jid];
      const targetName = delegTargetGroup?.name || delegation.target_folder;

      // Construct result message for the source (main) group
      const requesterJid = delegation.requester_jid;
      const requesterGroup = requesterJid
        ? registeredGroups[requesterJid]
        : null;
      const delegationWorkflowId =
        (delegation as { workflow_id?: string | null }).workflow_id ||
        undefined;
      const resultContent = `[委派结果 | 来自:${targetName} | ID:${data.delegationId}]\n\n${data.result}`;
      const resultMsgId = `del-result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const resultNow = Date.now().toString();

      storeMessageDirect({
        id: resultMsgId,
        chat_jid: delegation.source_jid,
        sender: 'system',
        sender_name: `${targetName}委派结果`,
        content: resultContent,
        timestamp: resultNow,
        is_from_me: true,
        is_bot_message: false,
        workflow_id: delegationWorkflowId,
      });

      // Wake up the source (main) group's agent
      deps.enqueueMessageCheck(delegation.source_jid);

      // Auto-copy to requester group when delegation was requested by another group.
      // Avoid duplicate sends when requester is the same as source.
      if (requesterJid && requesterJid !== delegation.source_jid) {
        if (requesterGroup) {
          const requesterContent = `[委派结果抄送 | 来自:${targetName} | ID:${data.delegationId}]\n\n${data.result}`;
          const requesterMsgId = `del-copy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          storeMessageDirect({
            id: requesterMsgId,
            chat_jid: requesterJid,
            sender: 'system',
            sender_name: `${targetName}委派结果`,
            content: requesterContent,
            timestamp: resultNow,
            is_from_me: true,
            is_bot_message: false,
            workflow_id: delegationWorkflowId,
          });
          deps.enqueueMessageCheck(requesterJid);
        } else {
          logger.warn(
            {
              delegationId: data.delegationId,
              requesterJid,
            },
            'Delegation requester_jid is not registered; skip auto-copy',
          );
        }
      }

      logger.info(
        {
          delegationId: data.delegationId,
          sourceGroup,
          sourceJid: delegation.source_jid,
        },
        'Delegation completed via IPC',
      );

      // Workflow hook: check if this delegation belongs to a workflow
      try {
        onWorkflowDelegationComplete(data.delegationId);
      } catch (err) {
        logger.error(
          { err, delegationId: data.delegationId },
          'Workflow delegation hook failed',
        );
      }

      break;
    }

    case 'memory_search': {
      if (!data.query || !data.requestId) {
        logger.warn(
          { sourceGroup },
          'memory_search missing query or requestId',
        );
        break;
      }

      const searchLimit = data.limit || 10;
      const mode = data.mode || 'hybrid';

      // Search message history via FTS
      const messageResults = searchMessages(
        sourceGroup,
        data.query,
        Math.max(searchLimit * 2, searchLimit),
      );

      // Search structured memory store
      const memoryResults = searchMemories(
        sourceGroup,
        data.query,
        Math.max(searchLimit * 2, searchLimit),
      );

      const nowMs = Date.now();
      const recencyBoost = (timestamp: string): number => {
        const ms = Number(timestamp);
        if (Number.isNaN(ms)) return 0;
        const ageMs = Math.max(0, nowMs - ms);
        const dayMs = 24 * 60 * 60 * 1000;
        if (ageMs <= dayMs) return 0.15;
        if (ageMs <= 7 * dayMs) return 0.08;
        return 0;
      };

      const hits = [
        ...messageResults.map((r) => ({
          kind: 'message' as const,
          score: 0.65 + recencyBoost(r.timestamp),
          sender: r.sender_name,
          content: r.content,
          timestamp: r.timestamp,
        })),
        ...(mode === 'hybrid'
          ? memoryResults.map((r) => ({
              kind: 'memory' as const,
              // bm25 smaller is better; invert to positive ranking score.
              score: 1 / (1 + Math.max(0, r.score)),
              layer: r.layer,
              memoryType: r.memory_type,
              content: r.content,
              timestamp: r.updated_at,
            }))
          : []),
      ]
        .sort((a, b) => b.score - a.score)
        .slice(0, searchLimit);

      // Write results to IPC response file
      const resultsDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'search-results',
      );
      fs.mkdirSync(resultsDir, { recursive: true });

      const response = {
        mode,
        hits,
      };

      const responsePath = path.join(resultsDir, `${data.requestId}.json`);
      const tempPath = `${responsePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(response, null, 2));
      fs.renameSync(tempPath, responsePath);

      logger.info(
        {
          sourceGroup,
          query: data.query,
          mode,
          messageHits: messageResults.length,
          memoryHits: memoryResults.length,
          resultHits: hits.length,
        },
        'memory_search completed',
      );
      recordMemoryMetric(sourceGroup, `search:${mode}`, `q=${data.query}`);
      break;
    }

    case 'memory_write': {
      if (
        !data.requestId ||
        !data.content ||
        !data.layer ||
        !data.memory_type
      ) {
        logger.warn({ sourceGroup }, 'memory_write missing required fields');
        if (data.requestId)
          writeMemoryResult(sourceGroup, data.requestId, {
            error: 'missing required fields',
          });
        break;
      }
      const created = createMemory({
        group_folder: sourceGroup,
        layer: data.layer,
        memory_type: data.memory_type,
        content: data.content,
        source: 'agent',
      });

      writeMemoryResult(sourceGroup, data.requestId, { memory: created });
      recordMemoryMetric(
        sourceGroup,
        'write',
        `layer=${data.layer},type=${data.memory_type}`,
      );
      break;
    }

    case 'memory_delete': {
      if (!data.requestId || !data.memoryId) {
        logger.warn(
          { sourceGroup },
          'memory_delete missing requestId or memoryId',
        );
        if (data.requestId) {
          writeMemoryResult(sourceGroup, data.requestId, {
            error: 'missing requestId or memoryId',
          });
        }
        break;
      }
      const existing = getMemoryById(data.memoryId);
      if (!existing || existing.group_folder !== sourceGroup) {
        logger.warn(
          { sourceGroup, memoryId: data.memoryId },
          'memory_delete memory not found in group scope',
        );
        writeMemoryResult(sourceGroup, data.requestId, {
          error: 'memory not found',
        });
        break;
      }
      deleteMemory(data.memoryId);
      writeMemoryResult(sourceGroup, data.requestId, {
        deleted: true,
        memoryId: data.memoryId,
      });
      recordMemoryMetric(sourceGroup, 'delete', `id=${data.memoryId}`);
      break;
    }

    case 'memory_doctor': {
      if (!data.requestId) {
        logger.warn({ sourceGroup }, 'memory_doctor missing requestId');
        break;
      }
      const report = doctorMemories(sourceGroup, data.staleDays || 7);
      writeMemoryResult(sourceGroup, data.requestId, { report });
      recordMemoryMetric(
        sourceGroup,
        'doctor',
        `staleDays=${data.staleDays || 7}`,
      );
      break;
    }

    case 'memory_gc': {
      if (!data.requestId) {
        logger.warn({ sourceGroup }, 'memory_gc missing requestId');
        break;
      }
      const result = gcMemories(sourceGroup, {
        dryRun: data.dryRun !== undefined ? data.dryRun : true,
        staleWorkingDays: data.staleDays || 14,
      });
      writeMemoryResult(sourceGroup, data.requestId, { result });
      recordMemoryMetric(
        sourceGroup,
        'gc',
        `dryRun=${data.dryRun !== undefined ? data.dryRun : true},staleDays=${data.staleDays || 14}`,
      );
      break;
    }

    case 'memory_resolve_conflict': {
      if (!data.requestId || !data.mode) {
        logger.warn(
          { sourceGroup },
          'memory_resolve_conflict missing requestId or mode',
        );
        if (data.requestId)
          writeMemoryResult(sourceGroup, data.requestId, {
            error: 'missing required fields (requestId, mode)',
          });
        break;
      }
      try {
        if (data.mode === 'keep') {
          if (!data.keep_id || !data.deprecate_id) {
            writeMemoryResult(sourceGroup, data.requestId, {
              error: 'keep mode requires keep_id and deprecate_id',
            });
            break;
          }
          const result = resolveConflict('keep', {
            keepId: data.keep_id,
            deprecateId: data.deprecate_id,
            groupFolder: sourceGroup,
          });
          writeMemoryResult(sourceGroup, data.requestId, { result });
          recordMemoryMetric(sourceGroup, 'conflict:resolved', `mode=keep`);
        } else if (data.mode === 'merge') {
          if (
            !data.merge_ids ||
            data.merge_ids.length !== 2 ||
            !data.merged_content
          ) {
            writeMemoryResult(sourceGroup, data.requestId, {
              error: 'merge mode requires merge_ids (2 IDs) and merged_content',
            });
            break;
          }
          const result = resolveConflict('merge', {
            mergeIds: data.merge_ids as [string, string],
            mergedContent: data.merged_content,
            groupFolder: sourceGroup,
          });
          writeMemoryResult(sourceGroup, data.requestId, { result });
          recordMemoryMetric(sourceGroup, 'conflict:resolved', `mode=merge`);
        } else {
          writeMemoryResult(sourceGroup, data.requestId, {
            error: `Unknown mode: ${data.mode}. Use "keep" or "merge".`,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err, sourceGroup }, 'memory_resolve_conflict failed');
        writeMemoryResult(sourceGroup, data.requestId, { error: errMsg });
      }
      break;
    }

    case 'list_workflow_types': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized list_workflow_types attempt blocked',
        );
        break;
      }

      const types = getAvailableWorkflowTypes();

      if (data.requestId) {
        const resultsDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'workflow-results',
        );
        fs.mkdirSync(resultsDir, { recursive: true });
        const responsePath = path.join(resultsDir, `${data.requestId}.json`);
        const tempPath = `${responsePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify({ types }));
        fs.renameSync(tempPath, responsePath);
      }

      logger.info(
        { sourceGroup, count: types.length },
        'Workflow types listed via IPC',
      );
      break;
    }

    case 'reload_container': {
      if (!data.chatJid) {
        logger.warn({ sourceGroup }, 'reload_container missing chatJid');
        break;
      }
      // Authorization: group can only reload itself, main can reload any
      const targetGroup = registeredGroups[data.chatJid];
      if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
        if (deps.reloadContainer) {
          deps.reloadContainer(data.chatJid);
          logger.info(
            { chatJid: data.chatJid, sourceGroup },
            'Container reload requested',
          );
        }
      } else {
        logger.warn(
          { chatJid: data.chatJid, sourceGroup },
          'Unauthorized reload_container attempt blocked',
        );
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
