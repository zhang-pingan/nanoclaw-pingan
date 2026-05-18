import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import {
  dispatchCurrentAskQuestion,
  handleAskQuestionResponse,
  parseAskAnswerCommand,
} from './ask-user-question.js';
import { createCardActionHandler } from './card-action-router.js';
import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  MYSQL_PROXY_PORT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import {
  resolveCredentialProxyExecutionModel,
  startCredentialProxy,
} from './credential-proxy.js';
import { loadMysqlConfigs, startMysqlProxy } from './mysql-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { agentQueryTraceManager } from './agent-query-trace.js';
import { ASSISTANT_MAIN_JID } from './assistant/assistant-channel-bridge.js';
import type { AssistantAgentPurpose } from './assistant/assistant-auto-flow.js';
import type { AgentInboxItemView } from './assistant/types.js';
import {
  ClassifiedFailure,
  classifyFailure,
  toAgentQueryFailurePatch,
  toFailureEventPayload,
} from './failure-taxonomy.js';
import {
  backfillMessageModel,
  clearAssistantChatMessages,
  clearMessages,
  clearSession,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getDelegationsByTarget,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  getWorkflow,
} from './db.js';
import { backfillWebMessageModel, clearWebMessages } from './web-db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { initWorkflow } from './workflow.js';
import { initWorkbenchEvents } from './workbench-events.js';
import { WorkbenchBroadcastService } from './workbench-broadcast.js';
import { resolveAskAnswerGroupFolder } from './workbench-broadcast-actions.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { isAllowedCrossChannelDelegationTargetFolder } from './delegation-policy.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import {
  bumpSessionResetEpoch,
  getSessionResetEpoch,
  isSessionResetEpochCurrent,
} from './session-reset-guard.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  buildOneShotEmptyOutputError,
  finalizeOneShotAgentResult,
  type OneShotAgentResult,
} from './one-shot-agent.js';
import { initAssistantEvents } from './assistant/assistant-events.js';
import { initAssistantAutoFlow } from './assistant/assistant-auto-flow.js';
import { startProactiveEngine } from './assistant/proactive-engine.js';
import {
  configureEvolutionEngine,
  startEvolutionEngine,
} from './assistant/evolution-engine.js';
import type { EvolutionAgentRunner } from './assistant/evolution-runner.js';
import {
  AgentQueryRecord,
  Channel,
  InteractiveCard,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';
import { buildMemoryPackForGroup } from './memory-pack.js';
import {
  clearModelResolutionsForRun,
  consumeModelResolution,
} from './model-resolution.js';
import { selectModel } from './model-selector.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

interface PendingQueryBatch {
  runId: string;
  queryId: string;
  chatJid: string;
  messageIds: string[];
  selectedModel: string;
  modelReason: string;
  channelName: string;
}

interface ActiveMessageQueryTraceState {
  runId: string;
  chatJid: string;
  executionStepId: string;
  resultDeliveryStepId: string | null;
  hadError: boolean;
  outputSent: boolean;
  finished: boolean;
  pipedIntoActiveSession: boolean;
  agentActivitySeen: boolean;
  failure: ClassifiedFailure | null;
  errorMessage: string | null;
  cursorBefore: string | null;
  messageCursor: string | null;
}

type AgentExecutionContext = {
  workflowId?: string;
  stageKey?: string;
  delegationId?: string;
};

const channels: Channel[] = [];
const queue = new GroupQueue();
const pendingSessionCleanup = new Set<string>();
const activeRunIds = new Map<string, string>();
const pendingQueryBatches = new Map<string, PendingQueryBatch>();
const activeMessageQueryTraces = new Map<
  string,
  ActiveMessageQueryTraceState
>();

function removeSessionDir(groupFolder: string): void {
  const sessionDir = path.join(DATA_DIR, 'sessions', groupFolder, '.claude');
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true });
  }
}

function resetGroupSession(
  groupJid: string,
  opts: {
    deleteSessionDir?: boolean;
  } = {},
): { reset: boolean } {
  const group = registeredGroups[groupJid];
  if (!group) return { reset: false };

  const hasActiveContainer = queue.hasActiveContainer(groupJid);

  clearSession(group.folder);
  delete sessions[group.folder];
  bumpSessionResetEpoch(group.folder);

  if (opts.deleteSessionDir) {
    if (hasActiveContainer) pendingSessionCleanup.add(group.folder);
    else removeSessionDir(group.folder);
  }

  return { reset: true };
}

async function resetSessionsForScope(opts: {
  all?: boolean;
  groupJid?: string;
  deleteSessionDir?: boolean;
}): Promise<{ resetCount: number }> {
  const targets = opts.all
    ? Object.keys(registeredGroups)
    : opts.groupJid
      ? [opts.groupJid]
      : [];

  let resetCount = 0;
  for (const groupJid of targets) {
    const result = resetGroupSession(groupJid, {
      deleteSessionDir: opts.deleteSessionDir,
    });
    if (result.reset) resetCount += 1;
  }

  return { resetCount };
}

function createExecutionId(): string {
  return crypto.randomUUID();
}

function fallbackAgentExecutionFailure(error: string): ClassifiedFailure {
  return classifyFailure(new Error(error), {
    module: 'index',
    action: 'run_agent',
    defaultType: 'container_runtime_error',
    defaultSubtype: 'agent_execution_failed',
    defaultOrigin: 'container',
    retryable: true,
  });
}

function recordInactiveMessageQueryFailure(
  queryId: string,
  error: string,
  failure: ClassifiedFailure,
): void {
  const query = agentQueryTraceManager.getQuery(queryId);
  if (!query) return;
  const patch = toAgentQueryFailurePatch(failure, error);
  if (query.status === 'running') {
    agentQueryTraceManager.finishQuery(queryId, 'error', patch);
    return;
  }
  agentQueryTraceManager.updateQuery(queryId, {
    status: 'error',
    ...patch,
  });
}

function rememberPendingQueryBatch(batch: PendingQueryBatch): void {
  pendingQueryBatches.set(batch.queryId, batch);
}

function forgetPendingQueryBatch(queryId: string | undefined): void {
  if (queryId) pendingQueryBatches.delete(queryId);
}

function forgetPendingQueryBatchesForRun(runId: string | undefined): void {
  if (!runId) return;
  for (const [queryId, batch] of pendingQueryBatches) {
    if (batch.runId === runId) {
      pendingQueryBatches.delete(queryId);
    }
  }
}

function isEarlierCursor(candidate: string, current: string | null): boolean {
  if (current === null) return true;
  const candidateNumber = Number(candidate || '0');
  const currentNumber = Number(current || '0');
  if (Number.isFinite(candidateNumber) && Number.isFinite(currentNumber)) {
    return candidateNumber < currentNumber;
  }
  return candidate < current;
}

function removeQueuedIpcMessagesForQuery(
  groupFolder: string,
  queryId: string,
): number {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  if (!fs.existsSync(inputDir)) return 0;

  let removed = 0;
  for (const file of fs.readdirSync(inputDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(inputDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        queryId?: unknown;
      };
      if (data.queryId !== queryId) continue;
      fs.unlinkSync(filePath);
      removed += 1;
    } catch (err) {
      logger.warn(
        { err, groupFolder, queryId, file },
        'Failed to inspect queued IPC message during retry recovery',
      );
    }
  }
  return removed;
}

function finalizePendingQueryBatch(result: ContainerOutput): {
  applied: boolean;
  batch?: PendingQueryBatch;
  actualModel?: string;
  updatedRows?: number;
  updatedWebRows?: number;
} {
  // Backfill as soon as the query succeeds once. Waiting for the trailing
  // null-result completion marker is fragile in streaming mode because the
  // user-visible text result may arrive even if that marker is never observed.
  if (result.status !== 'success' || !result.queryId) {
    return { applied: false };
  }

  const batch = pendingQueryBatches.get(result.queryId);
  if (!batch) {
    return { applied: false };
  }

  const resolution = consumeModelResolution(batch.runId, batch.queryId);
  const actualModel =
    resolution?.actualModel ||
    resolveCredentialProxyExecutionModel(batch.selectedModel);
  const updatedRows = backfillMessageModel(
    batch.chatJid,
    batch.messageIds,
    actualModel,
    batch.modelReason,
  );
  const updatedWebRows =
    batch.channelName === 'web'
      ? backfillWebMessageModel(
          batch.chatJid,
          batch.messageIds,
          actualModel,
          batch.modelReason,
        )
      : 0;

  pendingQueryBatches.delete(result.queryId);
  return { applied: true, batch, actualModel, updatedRows, updatedWebRows };
}

function isWorkflowDelegationExecutionContext(
  executionContext?: AgentExecutionContext,
): boolean {
  return Boolean(
    executionContext?.workflowId && executionContext?.delegationId,
  );
}

function isCompleteDelegationToolResult(output: ContainerOutput): boolean {
  return Boolean(
    output.status === 'success' &&
    output.event?.name === 'tool_result' &&
    output.event.payload?.toolName === 'complete_delegation',
  );
}

function createMessageQueryTrace(params: {
  queryId: string;
  runId: string;
  chatJid: string;
  groupFolder: string;
  workflowId?: string;
  stageKey?: string;
  delegationId?: string;
  sourceRefId?: string | null;
  selectedModel: string;
  selectedModelReason: string;
  promptSummary: string;
  promptHash: string;
  inputSummary: string;
  inputPayload: Record<string, unknown>;
  contextPayload?: Record<string, unknown> | null;
  pipedIntoActiveSession?: boolean;
  cursorBefore?: string | null;
  messageCursor?: string | null;
}): void {
  agentQueryTraceManager.startQuery({
    queryId: params.queryId,
    runId: params.runId,
    sourceType: 'message',
    sourceRefId: params.sourceRefId ?? null,
    chatJid: params.chatJid,
    groupFolder: params.groupFolder,
    workflowId: params.workflowId,
    stageKey: params.stageKey,
    delegationId: params.delegationId,
    selectedModel: params.selectedModel,
    selectedModelReason: params.selectedModelReason,
    promptSummary: params.promptSummary,
    promptHash: params.promptHash,
  });
  const inputStepId = agentQueryTraceManager.startStep({
    queryId: params.queryId,
    stepType: 'input',
    stepName: 'input_received',
    summary: params.inputSummary,
    payload: params.inputPayload,
  });
  agentQueryTraceManager.completeStep(params.queryId, inputStepId, 'success');
  if (params.contextPayload) {
    const contextStepId = agentQueryTraceManager.startStep({
      queryId: params.queryId,
      stepType: 'context_build',
      stepName: 'build_context',
      summary: 'Built prompt and memory pack',
      payload: params.contextPayload,
    });
    agentQueryTraceManager.completeStep(
      params.queryId,
      contextStepId,
      'success',
    );
  }
  const modelStepId = agentQueryTraceManager.startStep({
    queryId: params.queryId,
    stepType: 'model_select',
    stepName: 'select_model',
    summary: 'Selecting execution model',
  });
  agentQueryTraceManager.updateQuery(params.queryId, {
    selected_model: params.selectedModel,
    selected_model_reason: params.selectedModelReason,
    current_action: `Using ${params.selectedModel}`,
  });
  agentQueryTraceManager.completeStep(
    params.queryId,
    modelStepId,
    'success',
    `Selected ${params.selectedModel}`,
  );
  const executionStepId = agentQueryTraceManager.startStep({
    queryId: params.queryId,
    stepType: 'agent_execution',
    stepName: 'run_agent',
    summary: 'Starting agent execution',
    payload: { queryId: params.queryId },
  });
  agentQueryTraceManager.appendEvent({
    queryId: params.queryId,
    stepId: executionStepId,
    eventType: 'phase',
    eventName: 'phase_waiting_output',
    status: 'running',
    summary: 'Waiting for agent output',
  });
  activeMessageQueryTraces.set(params.queryId, {
    runId: params.runId,
    chatJid: params.chatJid,
    executionStepId,
    resultDeliveryStepId: null,
    hadError: false,
    outputSent: false,
    finished: false,
    pipedIntoActiveSession: params.pipedIntoActiveSession ?? false,
    agentActivitySeen: false,
    failure: null,
    errorMessage: null,
    cursorBefore: params.cursorBefore ?? null,
    messageCursor: params.messageCursor ?? null,
  });
}

function finishMessageQueryTrace(
  queryId: string,
  status: 'success' | 'error',
  patch?: Partial<AgentQueryRecord>,
): void {
  const state = activeMessageQueryTraces.get(queryId);
  if (!state || state.finished) return;
  const errorMessage =
    status === 'error'
      ? patch?.error_message || state.errorMessage || 'Agent execution failed'
      : null;
  const failurePatch =
    status === 'error'
      ? toAgentQueryFailurePatch(
          state.failure ?? fallbackAgentExecutionFailure(errorMessage!),
          errorMessage!,
        )
      : {};
  const activeStepId = state.resultDeliveryStepId || state.executionStepId;
  agentQueryTraceManager.completeStep(
    queryId,
    activeStepId,
    status,
    status === 'error'
      ? state.resultDeliveryStepId
        ? 'Result delivery encountered an error'
        : 'Agent execution finished with error'
      : state.resultDeliveryStepId
        ? 'Result delivery finished'
        : 'Agent execution finished',
  );
  const finalizeStepId = agentQueryTraceManager.startStep({
    queryId,
    stepType: 'finalize',
    stepName: 'finalize_query',
    summary: 'Finalizing query state',
  });
  agentQueryTraceManager.completeStep(queryId, finalizeStepId, status);
  const finishStepId = agentQueryTraceManager.startStep({
    queryId,
    stepType: 'finish',
    stepName: 'query_completed',
    summary: status === 'error' ? 'Query failed' : 'Query completed',
  });
  agentQueryTraceManager.completeStep(queryId, finishStepId, status);
  agentQueryTraceManager.finishQuery(queryId, status, {
    ...(patch || {}),
    ...failurePatch,
  });
  state.finished = true;
  activeMessageQueryTraces.delete(queryId);
}

function markMergedMessageQueryTrace(
  mergedQueryId: string,
  targetQueryId: string,
  payload: Record<string, unknown>,
): void {
  if (!mergedQueryId || mergedQueryId === targetQueryId) return;
  forgetPendingQueryBatch(mergedQueryId);

  const outputPreview = `Merged into active query ${targetQueryId}`;
  const patch = {
    current_phase: 'merged',
    current_action: outputPreview,
    output_preview: outputPreview,
  };
  const state = activeMessageQueryTraces.get(mergedQueryId);

  if (!state || state.finished) {
    const query = agentQueryTraceManager.getQuery(mergedQueryId);
    if (query?.status === 'running') {
      agentQueryTraceManager.finishQuery(mergedQueryId, 'success', patch);
    }
    activeMessageQueryTraces.delete(mergedQueryId);
    return;
  }

  try {
    state.agentActivitySeen = true;
    agentQueryTraceManager.appendEvent({
      queryId: mergedQueryId,
      stepId: state.executionStepId,
      eventType: 'lifecycle',
      eventName: 'query_merged_into_active_query',
      status: 'success',
      summary: outputPreview,
      payload: {
        ...payload,
        mergedQueryId,
        targetQueryId,
      },
    });
    finishMessageQueryTrace(mergedQueryId, 'success', patch);
  } catch (err) {
    logger.warn(
      { err, mergedQueryId, targetQueryId },
      'Failed to mark merged query trace',
    );
    activeMessageQueryTraces.delete(mergedQueryId);
    agentQueryTraceManager.finishQuery(mergedQueryId, 'success', patch);
  }
}

async function handleAskAnswerCommand(opts: {
  chatJid: string;
  group: RegisteredGroup;
  channel: Channel;
  messages: NewMessage[];
}): Promise<boolean> {
  const { chatJid, group, channel, messages } = opts;
  const cmdMsg = messages.find(
    (m) => parseAskAnswerCommand(m.content, TRIGGER_PATTERN) !== null,
  );
  if (!cmdMsg) return false;

  const parsed = parseAskAnswerCommand(cmdMsg.content, TRIGGER_PATTERN);
  if (!parsed) return false;

  // Consume the entire pending batch, matching /clear behavior.
  lastAgentTimestamp[chatJid] = messages[messages.length - 1].timestamp;
  saveState();

  if (!parsed.answer) {
    await channel.sendMessage(
      chatJid,
      '用法: /answer <requestId> <选项/自定义文本>；表单可用 JSON 或 key=value；跳过请用 /answer <requestId> skip',
    );
    return true;
  }

  const effectiveGroupFolder = resolveAskAnswerGroupFolder({
    requestId: parsed.requestId,
    currentGroupFolder: group.folder,
    registeredGroups,
  });

  const result = await handleAskQuestionResponse({
    requestId: parsed.requestId,
    groupFolder: effectiveGroupFolder,
    userId: cmdMsg.sender || 'unknown',
    answer: parsed.answer,
    skip: parsed.answer.toLowerCase() === 'skip',
    reject: parsed.answer.toLowerCase() === 'reject',
    registeredGroups,
    sendCard: async (jid, card) => {
      const ch = findChannel(channels, jid);
      return ch?.sendCard ? ch.sendCard(jid, card) : undefined;
    },
    sendMessage: async (jid, text) => {
      const ch = findChannel(channels, jid);
      if (!ch) return;
      await ch.sendMessage(jid, text);
    },
  });

  await channel.sendMessage(chatJid, result.userMessage);
  if (!result.ok && !result.completed) {
    await dispatchCurrentAskQuestion({
      requestId: parsed.requestId,
      groupFolder: effectiveGroupFolder,
      validationError: result.userMessage,
      validationErrors: result.validationErrors,
      registeredGroups,
      sendCard: async (jid, card) => {
        const ch = findChannel(channels, jid);
        return ch?.sendCard ? ch.sendCard(jid, card) : undefined;
      },
      sendMessage: async (jid, text) => {
        const ch = findChannel(channels, jid);
        if (!ch) return;
        await ch.sendMessage(jid, text);
      },
    });
  }
  return true;
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns registered groups, enriched with last-activity from chats table.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const chatMap = new Map(chats.map((c) => [c.jid, c]));

  return Object.entries(registeredGroups).map(([jid, g]) => ({
    jid,
    name: g.name,
    lastActivity: chatMap.get(jid)?.last_message_time || '',
    isRegistered: true,
    description: g.description || null,
  }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/** @internal - exported for testing */
export function _setSessionsForTest(
  nextSessions: Record<string, string>,
): void {
  sessions = { ...nextSessions };
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // --- /clear command: wipe conversation context for this group ---
  const clearMsg = missedMessages.find((m) => {
    const content = m.content.trim().replace(TRIGGER_PATTERN, '').trim();
    return content === '/clear';
  });

  if (clearMsg) {
    // Advance cursor to consume all messages including /clear
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();

    if (isSessionCommandAllowed(!!clearMsg.is_from_me)) {
      clearMessages(chatJid);
      if (channel.name === 'web') clearWebMessages(chatJid);
      if (channel.name === 'assistant') clearAssistantChatMessages(chatJid);
      resetGroupSession(chatJid, { deleteSessionDir: true });
      await channel.sendMessage(chatJid, '数据已清理完毕，可正常发送命令啦');
      logger.info({ group: group.name }, '/clear: context reset');
    } else {
      await channel.sendMessage(
        chatJid,
        'Permission denied: only admin can clear context.',
      );
      logger.info(
        { group: group.name, sender: clearMsg.sender },
        '/clear: permission denied',
      );
    }
    return true;
  }

  if (
    await handleAskAnswerCommand({
      chatJid,
      group,
      channel,
      messages: missedMessages,
    })
  ) {
    return true;
  }

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: TRIGGER_PATTERN,
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      resetSession: () => {
        resetGroupSession(chatJid);
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  let prompt = formatMessages(missedMessages, TIMEZONE);
  const memoryPack = buildMemoryPackForGroup(group.folder, prompt);
  if (memoryPack) {
    prompt = `${memoryPack}${prompt}`;
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Record agent info for status panel
  const lastMsg = missedMessages[missedMessages.length - 1];
  queue.setAgentInfo(chatJid, {
    promptSummary: prompt.slice(0, 100),
    groupName: group.name,
    lastSender: lastMsg.sender_name,
    lastContent: lastMsg.content.slice(0, 200),
    lastTime: lastMsg.timestamp,
  });

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let sessionHadError = false;
  let sessionOutputSent = false;
  const runId = createExecutionId();
  const initialQueryId = createExecutionId();
  const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
  const executionContext = resolveExecutionContext(group, missedMessages);
  const isWorkflowDelegationRun =
    isWorkflowDelegationExecutionContext(executionContext);
  const modelSelection = await selectModel({
    prompt,
    isMain: isMainGroup,
  });
  createMessageQueryTrace({
    queryId: initialQueryId,
    runId,
    chatJid,
    groupFolder: group.folder,
    workflowId: executionContext?.workflowId,
    stageKey: executionContext?.stageKey,
    delegationId: executionContext?.delegationId,
    sourceRefId: lastMsg.id,
    selectedModel: modelSelection.selectedModel,
    selectedModelReason: modelSelection.reason,
    promptSummary: prompt.slice(0, 140),
    promptHash,
    cursorBefore: previousCursor,
    messageCursor: lastMsg.timestamp,
    inputSummary: `Received ${missedMessages.length} pending messages`,
    inputPayload: {
      messageIds: missedMessages.map((m) => m.id),
      messageCount: missedMessages.length,
    },
    contextPayload: {
      promptLength: prompt.length,
      hasMemoryPack: Boolean(memoryPack),
    },
  });
  rememberPendingQueryBatch({
    runId,
    queryId: initialQueryId,
    chatJid,
    messageIds: missedMessages.map((m) => m.id),
    selectedModel: modelSelection.selectedModel,
    modelReason: modelSelection.reason,
    channelName: channel.name,
  });
  logger.info(
    {
      group: group.name,
      chatJid,
      runId,
      queryId: initialQueryId,
      selectedModel: modelSelection.selectedModel,
      reason: modelSelection.reason,
    },
    'Selected model for runAgent',
  );

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      const outputQueryId = result.queryId || initialQueryId;
      let queryId = outputQueryId;
      let traceState = activeMessageQueryTraces.get(queryId);
      if (!traceState && queryId !== initialQueryId) {
        const fallbackTraceState = activeMessageQueryTraces.get(initialQueryId);
        if (fallbackTraceState) {
          logger.warn(
            {
              group: group.name,
              chatJid,
              outputQueryId: queryId,
              fallbackQueryId: initialQueryId,
              runId,
            },
            'Received output for inactive query, attaching to active query',
          );
          queryId = initialQueryId;
          traceState = fallbackTraceState;
        }
      }
      if (traceState && traceState.runId !== runId && result.runId === runId) {
        traceState.runId = runId;
      }
      if (result.newSessionId) {
        agentQueryTraceManager.updateQuery(queryId, {
          session_id: result.newSessionId,
        });
      }
      if (result.selectedModel) {
        agentQueryTraceManager.updateQuery(queryId, {
          actual_model: result.selectedModel,
        });
      }
      if (result.newSessionId) {
        // keep query traces in sync with the latest resumed session id
      }
      if (result.event) {
        if (isWorkflowDelegationRun && isCompleteDelegationToolResult(result)) {
          queue.closeStdin(chatJid);
        }
        if (!traceState) {
          logger.warn(
            {
              group: group.name,
              chatJid,
              queryId,
              eventName: result.event.name,
              runId: result.runId,
            },
            'Skipping event for inactive query trace',
          );
          return;
        }
        traceState.agentActivitySeen = true;
        const payload = result.event.payload || {};
        const mergedQueryId =
          result.event.name === 'query_merged_into_active_query' &&
          typeof payload.mergedQueryId === 'string'
            ? payload.mergedQueryId
            : null;
        agentQueryTraceManager.appendEvent({
          queryId,
          stepId:
            traceState?.resultDeliveryStepId ||
            traceState?.executionStepId ||
            null,
          eventType: result.event.type,
          eventName: result.event.name,
          status: result.event.status ?? null,
          summary: result.event.summary ?? null,
          payload,
        });
        if (mergedQueryId) {
          markMergedMessageQueryTrace(mergedQueryId, queryId, payload);
        }
      }
      // Streaming output callback — called for each agent result
      if (result.result) {
        if (!traceState) {
          logger.warn(
            {
              group: group.name,
              chatJid,
              queryId,
              runId: result.runId,
            },
            'Skipping output for inactive query trace',
          );
          return;
        }
        traceState.agentActivitySeen = true;
        if (!traceState.resultDeliveryStepId) {
          agentQueryTraceManager.completeStep(
            queryId,
            traceState.executionStepId,
            'success',
            'Agent execution produced output',
          );
          traceState.resultDeliveryStepId = agentQueryTraceManager.startStep({
            queryId,
            stepType: 'result_delivery',
            stepName: 'deliver_result',
            summary: 'Delivering agent response',
          });
        }
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        agentQueryTraceManager.appendEvent({
          queryId,
          stepId: traceState.resultDeliveryStepId,
          eventType: 'output',
          eventName: 'assistant_output',
          status: 'success',
          summary: text
            ? `Output: ${text.slice(0, 120)}`
            : 'Received output chunk',
          payload: {
            text,
            rawLength: raw.length,
          },
        });
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          agentQueryTraceManager.appendEvent({
            queryId,
            stepId: traceState.resultDeliveryStepId,
            eventType: 'lifecycle',
            eventName: 'channel_send_started',
            status: 'running',
            summary: `Sending response to ${channel.name}`,
            payload: { channel: channel.name },
          });
          await channel.sendMessage(chatJid, text);
          agentQueryTraceManager.appendEvent({
            queryId,
            stepId: traceState.resultDeliveryStepId,
            eventType: 'lifecycle',
            eventName: 'channel_send_finished',
            status: 'success',
            summary: `Delivered response to ${channel.name}`,
            payload: { channel: channel.name },
          });
          traceState.outputSent = true;
          sessionOutputSent = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      const finalized = finalizePendingQueryBatch(result);
      if (finalized.applied) {
        logger.info(
          {
            group: group.name,
            chatJid,
            runId: finalized.batch?.runId,
            queryId: finalized.batch?.queryId,
            actualModel: finalized.actualModel,
            updatedRows: finalized.updatedRows,
            updatedWebRows: finalized.updatedWebRows,
            selectedModel: finalized.batch?.selectedModel,
            reason: finalized.batch?.modelReason,
          },
          'Backfilled actual model after query completion',
        );
        agentQueryTraceManager.updateQuery(finalized.batch!.queryId, {
          actual_model: finalized.actualModel,
        });
      }

      if (result.status === 'success' && !result.event && !result.result) {
        if (isWorkflowDelegationRun) {
          queue.closeStdin(chatJid);
        } else {
          queue.notifyIdle(chatJid);
        }
        if (traceState) {
          finishMessageQueryTrace(
            queryId,
            traceState.hadError ? 'error' : 'success',
            {
              output_preview: traceState.outputSent
                ? 'Output delivered to channel'
                : 'Completed without channel output',
            },
          );
        }
      }

      if (result.status === 'error') {
        if (isWorkflowDelegationRun) {
          queue.closeStdin(chatJid);
        }
        const error = result.error || 'Agent execution failed';
        const failure = result.failure ?? fallbackAgentExecutionFailure(error);
        if (!traceState) {
          logger.warn(
            {
              group: group.name,
              chatJid,
              queryId,
              runId: result.runId,
              error,
            },
            'Skipping error for inactive query trace',
          );
          recordInactiveMessageQueryFailure(queryId, error, failure);
          sessionHadError = true;
          return;
        }
        traceState.agentActivitySeen = true;
        agentQueryTraceManager.appendEvent({
          queryId,
          stepId: traceState.resultDeliveryStepId || traceState.executionStepId,
          eventType: 'error',
          eventName: 'query_failed',
          status: 'error',
          summary: error,
          payload: {
            error,
            ...toFailureEventPayload(failure),
          },
        });
        traceState.hadError = true;
        traceState.errorMessage = error;
        traceState.failure = failure;
        sessionHadError = true;
      }
    },
    modelSelection.selectedModel,
    runId,
    initialQueryId,
    executionContext,
    undefined,
    isWorkflowDelegationRun,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);
  if (isWorkflowDelegationRun) {
    queue.closeStdin(chatJid);
  }
  let shouldRetryUnconsumedPipedMessages = false;
  let retryCursor: string | null = null;
  for (const [queryId, state] of activeMessageQueryTraces) {
    if (state.runId !== runId) continue;
    if (
      state.pipedIntoActiveSession &&
      !state.agentActivitySeen &&
      output !== 'error' &&
      !state.hadError
    ) {
      agentQueryTraceManager.appendEvent({
        queryId,
        stepId: state.executionStepId,
        eventType: 'lifecycle',
        eventName: 'piped_message_waiting_for_handoff',
        status: 'running',
        summary:
          'Piped message was not consumed before the active container exited',
      });
      const removedIpcMessages = removeQueuedIpcMessagesForQuery(
        group.folder,
        queryId,
      );
      const errorMessage =
        'Piped message was not consumed before the active container exited; retrying from chat history';
      state.hadError = true;
      state.errorMessage = errorMessage;
      state.failure = classifyFailure(new Error(errorMessage), {
        module: 'index',
        action: 'retry_unconsumed_piped_message',
        defaultType: 'routing_error',
        defaultSubtype: 'piped_message_not_consumed',
        defaultOrigin: 'router',
        retryable: true,
      });
      if (
        state.cursorBefore !== null &&
        isEarlierCursor(state.cursorBefore, retryCursor)
      ) {
        retryCursor = state.cursorBefore;
      }
      shouldRetryUnconsumedPipedMessages = true;
      finishMessageQueryTrace(queryId, 'error', {
        error_message: errorMessage,
        output_preview:
          removedIpcMessages > 0
            ? `Removed ${removedIpcMessages} stale IPC message(s) before retry`
            : null,
      });
      logger.warn(
        {
          group: group.name,
          chatJid,
          queryId,
          runId,
          retryCursor: state.cursorBefore,
          removedIpcMessages,
        },
        'Retrying unconsumed piped message from chat history',
      );
      continue;
    }
    finishMessageQueryTrace(
      queryId,
      output === 'error' || state.hadError ? 'error' : 'success',
      {
        output_preview: state.outputSent
          ? 'Output delivered to channel'
          : output === 'error' || state.hadError
            ? null
            : 'Completed without channel output',
        error_message:
          output === 'error' || state.hadError
            ? state.errorMessage || 'Agent execution failed'
            : null,
      },
    );
  }
  if (shouldRetryUnconsumedPipedMessages) {
    if (retryCursor !== null) {
      lastAgentTimestamp[chatJid] = retryCursor;
      saveState();
    }
    queue.enqueueMessageCheck(chatJid);
  }

  // Deferred .claude/ cleanup: safe now that the container has exited
  if (pendingSessionCleanup.has(group.folder)) {
    pendingSessionCleanup.delete(group.folder);
    removeSessionDir(group.folder);
    await channel.sendMessage(chatJid, '数据已清理完毕，可正常发送命令啦');
    logger.info({ group: group.name }, '/clear: deferred cleanup completed');
  }

  if (output === 'error' || sessionHadError) {
    forgetPendingQueryBatch(initialQueryId);
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (sessionOutputSent) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  selectedModel?: string,
  runId?: string,
  initialQueryId?: string,
  executionContext?: AgentExecutionContext,
  requireResult?: boolean,
  isolatedSession?: boolean,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = isolatedSession ? undefined : sessions[group.folder];
  const sessionResetEpoch = getSessionResetEpoch(group.folder);
  const isSessionWriteCurrent = () =>
    isSessionResetEpochCurrent(group.folder, sessionResetEpoch);
  const writeSessionIfCurrent = (sessionIdToWrite: string): boolean => {
    if (!isSessionWriteCurrent()) {
      logger.info(
        {
          group: group.name,
          sessionId: sessionIdToWrite,
          runEpoch: sessionResetEpoch,
          currentEpoch: getSessionResetEpoch(group.folder),
        },
        'Skipping stale session update after reset',
      );
      return false;
    }
    if (pendingSessionCleanup.has(group.folder)) {
      logger.info(
        { group: group.name, sessionId: sessionIdToWrite },
        'Skipping session update while session cleanup is pending',
      );
      return false;
    }
    sessions[group.folder] = sessionIdToWrite;
    setSession(group.folder, sessionIdToWrite);
    return true;
  };
  const resolvedRunId = runId || createExecutionId();
  const resolvedInitialQueryId = initialQueryId || createExecutionId();
  const modelSelection = selectedModel
    ? { selectedModel, reason: 'preselected' }
    : await selectModel({ prompt, isMain });
  logger.info(
    {
      group: group.name,
      chatJid,
      runId: resolvedRunId,
      queryId: resolvedInitialQueryId,
      selectedModel: modelSelection.selectedModel,
      reason: modelSelection.reason,
    },
    'Selected model for container input',
  );

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  // For main group, filter to same-channel groups only
  let filteredGroups = availableGroups;
  if (isMain) {
    const mainCh = findChannel(channels, chatJid);
    if (mainCh) {
      filteredGroups = availableGroups.filter((g) => {
        const targetGroup = registeredGroups[g.jid];
        return (
          mainCh.ownsJid(g.jid) ||
          (targetGroup &&
            isAllowedCrossChannelDelegationTargetFolder(targetGroup.folder))
        );
      });
    }
  }
  writeGroupsSnapshot(
    group.folder,
    isMain,
    filteredGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  let streamedErrorOutputSeen = false;
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.status === 'error') {
          streamedErrorOutputSeen = true;
        }
        if (output.newSessionId && !isolatedSession) {
          const didWrite = writeSessionIfCurrent(output.newSessionId);
          if (!didWrite) {
            await onOutput({ ...output, newSessionId: undefined });
            return;
          }
        }
        await onOutput(output);
      }
    : undefined;

  try {
    activeRunIds.set(chatJid, resolvedRunId);
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        runId: resolvedRunId,
        queryId: resolvedInitialQueryId,
        requireResult,
        isolatedSession,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        selectedModel: modelSelection.selectedModel,
        executionContext,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    // Handle "No conversation found" error - session is invalid, clear it
    const isSessionInvalid =
      !isolatedSession &&
      output.status === 'error' &&
      output.error?.includes('No conversation found');

    if (isSessionInvalid) {
      logger.warn(
        { group: group.name, sessionId: output.newSessionId },
        'Session invalid, clearing for retry',
      );
      clearSession(group.folder);
      delete sessions[group.folder];
      bumpSessionResetEpoch(group.folder);
      // Don't save the invalid session ID - let retry create a new one
    } else if (output.newSessionId && !isolatedSession) {
      writeSessionIfCurrent(output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      if (wrappedOnOutput && !streamedErrorOutputSeen) {
        await wrappedOnOutput(output);
      }
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    if (wrappedOnOutput) {
      const error = err instanceof Error ? err.message : String(err);
      await wrappedOnOutput({
        status: 'error',
        result: null,
        error,
        failure: fallbackAgentExecutionFailure(error),
        runId: resolvedRunId,
        queryId: resolvedInitialQueryId,
      });
    }
    return 'error';
  } finally {
    clearModelResolutionsForRun(resolvedRunId);
    forgetPendingQueryBatchesForRun(resolvedRunId);
    activeRunIds.delete(chatJid);
  }
}

interface OneShotAgentInput {
  chatJid: string;
  prompt: string;
  status: {
    groupName?: string;
    promptSummary?: string;
    lastSender?: string;
    lastContent?: string;
    lastTime?: string;
    isTask?: boolean;
  };
  selectedModel?: string;
  runId?: string;
  initialQueryId?: string;
  closeOnFirstResult?: boolean;
  collect?: 'first_result' | 'all_until_exit';
  requireResult?: boolean;
  isolatedSession?: boolean;
  onOutput?: (output: ContainerOutput) => Promise<void>;
}

interface AssistantActionAgentInput {
  prompt: string;
  purpose: AssistantAgentPurpose;
  item: AgentInboxItemView;
  chatJid?: string;
}

function truncateStatusText(
  value: string | undefined,
  maxLength: number,
): string {
  if (!value) return '';
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function resolveAssistantActionJid(preferredJid?: string): string | null {
  if (preferredJid && registeredGroups[preferredJid]) return preferredJid;
  if (registeredGroups[ASSISTANT_MAIN_JID]?.isMain === true) {
    return ASSISTANT_MAIN_JID;
  }
  const fallback = Object.entries(registeredGroups).find(
    ([, group]) => group.isMain,
  );
  if (fallback) {
    logger.warn(
      { preferredJid, fallbackJid: fallback[0] },
      'Assistant main group not found, falling back to first main group',
    );
    return fallback[0];
  }
  return null;
}

function assistantActionPurposeLabel(
  purpose: AssistantActionAgentInput['purpose'],
): string {
  if (purpose === 'coding_anomaly_scan') return 'Coding 异常扫描';
  if (purpose === 'repair') return '修复';
  return '排查';
}

function assistantActionStepName(
  purpose: AssistantActionAgentInput['purpose'],
): string {
  if (purpose === 'coding_anomaly_scan') {
    return 'assistant_coding_anomaly_scan_request';
  }
  return purpose === 'repair'
    ? 'assistant_repair_request'
    : 'assistant_investigation_request';
}

function stripInternalBlocks(value: string): string {
  return value.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

async function runOneShotAgent(
  input: OneShotAgentInput,
): Promise<OneShotAgentResult> {
  const group = registeredGroups[input.chatJid];
  if (!group) {
    return {
      ok: false,
      text: '',
      outputs: [],
      error: `Registered group not found: ${input.chatJid}`,
    };
  }

  const outputs: string[] = [];
  let closeRequested = false;
  let resultMarkerCount = 0;
  let eventMarkerCount = 0;
  let sessionOnlyMarkerCount = 0;
  let errorMarkerCount = 0;
  let executionError: string | undefined;
  let executionFailure: ClassifiedFailure | undefined;
  const collect = input.collect || 'first_result';
  const forwardOutput = async (output: ContainerOutput) => {
    if (!input.onOutput) return;
    try {
      await input.onOutput(output);
    } catch (err) {
      logger.error(
        { err, chatJid: input.chatJid },
        'One-shot output hook failed',
      );
    }
  };

  const status = await queue.runOneShot(
    input.chatJid,
    {
      groupFolder: group.folder,
      groupName: input.status.groupName || group.name,
      promptSummary: truncateStatusText(
        input.status.promptSummary || input.prompt,
        100,
      ),
      lastSender: input.status.lastSender || '',
      lastContent: truncateStatusText(input.status.lastContent, 200),
      lastTime: input.status.lastTime || Date.now().toString(),
      isTask: input.status.isTask ?? false,
    },
    () =>
      runAgent(
        group,
        input.prompt,
        input.chatJid,
        async (output) => {
          if (output.event) eventMarkerCount += 1;
          if (output.status === 'error') {
            errorMarkerCount += 1;
            executionError = output.error || executionError;
            executionFailure = output.failure || executionFailure;
          }
          if (output.result) {
            resultMarkerCount += 1;
            outputs.push(String(output.result));
            await forwardOutput(output);
            if (input.closeOnFirstResult !== false && !closeRequested) {
              closeRequested = true;
              queue.closeStdin(input.chatJid);
            }
            if (collect === 'first_result') return;
          }
          if (output.status === 'success' && !output.event && !output.result) {
            sessionOnlyMarkerCount += 1;
          }
          await forwardOutput(output);
          if (
            output.status === 'success' &&
            !output.event &&
            !output.result &&
            (!input.requireResult || resultMarkerCount > 0) &&
            input.closeOnFirstResult !== false &&
            !closeRequested
          ) {
            closeRequested = true;
            queue.closeStdin(input.chatJid);
          }
        },
        input.selectedModel,
        input.runId,
        input.initialQueryId,
        undefined,
        input.requireResult,
        input.isolatedSession,
      ),
  );

  return finalizeOneShotAgentResult({
    status,
    outputs,
    executionError,
    failure: executionFailure,
    emptyOutputError: buildOneShotEmptyOutputError({
      resultMarkerCount,
      eventMarkerCount,
      sessionOnlyMarkerCount,
      errorMarkerCount,
    }),
  });
}

async function runAssistantActionAgent(
  input: AssistantActionAgentInput,
): Promise<{ ok: boolean; text: string; error?: string }> {
  const chatJid = resolveAssistantActionJid(input.chatJid);
  if (!chatJid) {
    return {
      ok: false,
      text: '',
      error: 'Assistant action group not found',
    };
  }

  const group = registeredGroups[chatJid];
  const runId = createExecutionId();
  const queryId = createExecutionId();
  const purposeLabel = assistantActionPurposeLabel(input.purpose);
  const promptSummary = `${purposeLabel}：${input.item.title}`;
  const selectedModel = await selectModel({
    prompt: input.prompt,
    isMain: group?.isMain === true,
  });
  agentQueryTraceManager.startQuery({
    queryId,
    runId,
    sourceType: 'assistant_action',
    sourceRefId: input.item.id,
    chatJid,
    groupFolder: group?.folder || null,
    selectedModel: selectedModel.selectedModel,
    selectedModelReason: selectedModel.reason,
    promptSummary,
    promptHash: crypto.createHash('sha256').update(input.prompt).digest('hex'),
  });
  const inputStepId = agentQueryTraceManager.startStep({
    queryId,
    stepType: 'input',
    stepName: assistantActionStepName(input.purpose),
    summary: promptSummary,
    payload: {
      itemId: input.item.id,
      purpose: input.purpose,
      sourceType: input.item.source_type,
      sourceRefId: input.item.source_ref_id,
      actionKind: input.item.action_kind,
      ruleKey: input.item.extra.ruleKey,
    },
  });
  agentQueryTraceManager.completeStep(queryId, inputStepId, 'success');
  const modelStepId = agentQueryTraceManager.startStep({
    queryId,
    stepType: 'model_select',
    stepName: 'select_model',
    summary: 'Selecting assistant action model',
  });
  agentQueryTraceManager.updateQuery(queryId, {
    selected_model: selectedModel.selectedModel,
    selected_model_reason: selectedModel.reason,
    current_action: `Using ${selectedModel.selectedModel}`,
  });
  agentQueryTraceManager.completeStep(
    queryId,
    modelStepId,
    'success',
    `Selected ${selectedModel.selectedModel}`,
  );
  const executionStepId = agentQueryTraceManager.startStep({
    queryId,
    stepType: 'agent_execution',
    stepName: 'run_assistant_action_agent',
    summary: 'Starting assistant action agent',
    payload: { queryId, purpose: input.purpose },
  });
  agentQueryTraceManager.appendEvent({
    queryId,
    stepId: executionStepId,
    eventType: 'phase',
    eventName: 'phase_waiting_output',
    status: 'running',
    summary: 'Waiting for assistant action output',
  });

  let executionStepCompleted = false;
  let resultDeliveryStepId: string | null = null;
  let resultDeliveryStepCompleted = false;
  let outputPreview = '';
  const ensureResultDeliveryStep = () => {
    if (!executionStepCompleted) {
      agentQueryTraceManager.completeStep(
        queryId,
        executionStepId,
        'success',
        'Assistant action agent produced output',
      );
      executionStepCompleted = true;
    }
    if (!resultDeliveryStepId) {
      resultDeliveryStepId = agentQueryTraceManager.startStep({
        queryId,
        stepType: 'result_delivery',
        stepName: 'collect_result',
        summary: 'Collecting assistant action result',
      });
    }
    return resultDeliveryStepId;
  };

  const completeOpenSteps = (status: 'success' | 'error') => {
    if (resultDeliveryStepId && !resultDeliveryStepCompleted) {
      agentQueryTraceManager.completeStep(
        queryId,
        resultDeliveryStepId,
        status,
        status === 'success'
          ? 'Assistant action result collected'
          : 'Assistant action result failed',
      );
      resultDeliveryStepCompleted = true;
    } else if (!executionStepCompleted) {
      agentQueryTraceManager.completeStep(
        queryId,
        executionStepId,
        status,
        status === 'success'
          ? 'Assistant action execution completed'
          : 'Assistant action execution failed',
      );
      executionStepCompleted = true;
    }
  };

  const handleTraceOutput = async (output: ContainerOutput) => {
    const outputQueryId = output.queryId || queryId;
    if (outputQueryId !== queryId) {
      logger.warn(
        { queryId, outputQueryId, runId: output.runId },
        'Assistant action output used unexpected query id',
      );
    }
    if (output.newSessionId) {
      agentQueryTraceManager.updateQuery(queryId, {
        session_id: output.newSessionId,
      });
    }
    if (output.selectedModel) {
      agentQueryTraceManager.updateQuery(queryId, {
        actual_model: output.selectedModel,
      });
    }
    if (output.event) {
      agentQueryTraceManager.appendEvent({
        queryId,
        stepId: resultDeliveryStepId || executionStepId,
        eventType: output.event.type,
        eventName: output.event.name,
        status: output.event.status ?? null,
        summary: output.event.summary ?? null,
        payload: output.event.payload || {},
      });
    }
    if (output.result) {
      const resultStepId = ensureResultDeliveryStep();
      const raw =
        typeof output.result === 'string'
          ? output.result
          : JSON.stringify(output.result);
      const text = stripInternalBlocks(raw);
      outputPreview = text.slice(0, 500);
      agentQueryTraceManager.appendEvent({
        queryId,
        stepId: resultStepId,
        eventType: 'output',
        eventName: 'assistant_action_output',
        status: 'success',
        summary: text
          ? `Output: ${text.slice(0, 120)}`
          : 'Received assistant action output',
        payload: {
          text,
          rawLength: raw.length,
        },
      });
    }
    if (output.status === 'error') {
      const error = output.error || 'Assistant action agent execution failed';
      const failure = output.failure ?? fallbackAgentExecutionFailure(error);
      agentQueryTraceManager.appendEvent({
        queryId,
        stepId: resultDeliveryStepId || executionStepId,
        eventType: 'error',
        eventName: 'query_failed',
        status: 'error',
        summary: error,
        payload: {
          error,
          ...toFailureEventPayload(failure),
        },
      });
    }
  };

  let result: OneShotAgentResult;
  try {
    result = await runOneShotAgent({
      chatJid,
      prompt: input.prompt,
      selectedModel: selectedModel.selectedModel,
      runId,
      initialQueryId: queryId,
      closeOnFirstResult: true,
      collect: 'first_result',
      requireResult: true,
      status: {
        groupName: '桌面个人助手',
        promptSummary,
        lastSender: 'assistant action',
        lastContent: input.item.body || input.item.title,
        lastTime: Date.now().toString(),
        isTask: true,
      },
      onOutput: handleTraceOutput,
    });
  } catch (err) {
    const error =
      err instanceof Error ? err.message : 'Assistant action agent failed';
    completeOpenSteps('error');
    agentQueryTraceManager.finishQuery(queryId, 'error', {
      error_message: error,
      output_preview: outputPreview || null,
    });
    return { ok: false, text: '', error };
  }

  if (!result.ok) {
    const error = result.error || 'Assistant action agent execution failed';
    completeOpenSteps('error');
    agentQueryTraceManager.finishQuery(queryId, 'error', {
      ...(result.failure
        ? toAgentQueryFailurePatch(result.failure, error)
        : { error_message: error }),
      output_preview: result.text.slice(0, 500) || outputPreview || null,
    });
    return {
      ok: false,
      text: result.text,
      error,
    };
  }
  completeOpenSteps('success');
  agentQueryTraceManager.finishQuery(queryId, 'success', {
    output_preview: result.text.slice(0, 500) || outputPreview,
  });
  return { ok: true, text: result.text };
}

const runEvolutionActionAgent: EvolutionAgentRunner = async (input) => {
  const chatJid = resolveAssistantActionJid();
  if (!chatJid) {
    return {
      ok: false,
      text: '',
      error: 'Assistant evolution group not found',
    };
  }
  const group = registeredGroups[chatJid];
  const runId = createExecutionId();
  const queryId = createExecutionId();
  const selectedModel = await selectModel({
    prompt: input.prompt,
    isMain: group?.isMain === true,
  });
  agentQueryTraceManager.startQuery({
    queryId,
    runId,
    sourceType: 'assistant_evolution',
    sourceRefId: input.item.id,
    chatJid,
    groupFolder: group?.folder || null,
    selectedModel: selectedModel.selectedModel,
    selectedModelReason: selectedModel.reason,
    promptSummary: `自我进化 ${input.phase}：${input.item.direction}`,
    promptHash: crypto.createHash('sha256').update(input.prompt).digest('hex'),
  });
  const inputStepId = agentQueryTraceManager.startStep({
    queryId,
    stepType: 'input',
    stepName: 'assistant_evolution_phase',
    summary: input.phase,
    payload: {
      itemId: input.item.id,
      status: input.item.status,
      direction: input.item.direction,
    },
  });
  agentQueryTraceManager.completeStep(queryId, inputStepId, 'success');
  const result = await runOneShotAgent({
    chatJid,
    prompt: input.prompt,
    selectedModel: selectedModel.selectedModel,
    runId,
    initialQueryId: queryId,
    closeOnFirstResult: true,
    collect: 'first_result',
    requireResult: true,
    isolatedSession: true,
    status: {
      groupName: '自我进化',
      promptSummary: `自我进化 ${input.phase}：${input.item.direction}`,
      lastSender: 'assistant evolution',
      lastContent: input.item.status,
      lastTime: Date.now().toString(),
      isTask: true,
    },
  });
  if (!result.ok) {
    const error = result.error || 'Assistant evolution agent execution failed';
    agentQueryTraceManager.finishQuery(queryId, 'error', {
      ...(result.failure
        ? toAgentQueryFailurePatch(result.failure, error)
        : { error_message: error }),
      output_preview: result.text.slice(0, 500),
    });
    return {
      ok: false,
      text: result.text,
      error,
    };
  }
  agentQueryTraceManager.finishQuery(queryId, 'success', {
    output_preview: result.text.slice(0, 500),
  });
  return { ok: true, text: result.text };
};

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          if (
            await handleAskAnswerCommand({
              chatJid,
              group,
              channel,
              messages: groupMessages,
            })
          ) {
            continue;
          }

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) => extractSessionCommand(m.content, TRIGGER_PATTERN) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending a slash command (DoS).
            // closeStdin no-ops internally when no container is active.
            const command = extractSessionCommand(
              loopCmdMsg.content,
              TRIGGER_PATTERN,
            );
            if (command && isSessionCommandAllowed(!!loopCmdMsg.is_from_me)) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // --- /clear intercept: handle even when a container is active ---
          const clearMsg = groupMessages.find((m) => {
            const content = m.content
              .trim()
              .replace(TRIGGER_PATTERN, '')
              .trim();
            return content === '/clear';
          });
          if (clearMsg) {
            if (isSessionCommandAllowed(!!clearMsg.is_from_me)) {
              queue.closeStdin(chatJid);
              clearMessages(chatJid);
              if (channel.name === 'web') clearWebMessages(chatJid);
              if (channel.name === 'assistant')
                clearAssistantChatMessages(chatJid);
              resetGroupSession(chatJid, {
                deleteSessionDir: true,
              });
              lastAgentTimestamp[chatJid] =
                groupMessages[groupMessages.length - 1].timestamp;
              saveState();

              if (pendingSessionCleanup.has(group.folder)) {
                // Container still running — defer .claude/ removal until exit
                await channel.sendMessage(chatJid, '数据清理中，请等待');
                logger.info(
                  { group: group.name },
                  '/clear: context reset (active container, deferred cleanup)',
                );
              } else {
                // No active container — safe to delete immediately
                await channel.sendMessage(
                  chatJid,
                  '数据已清理完毕，可正常发送命令啦',
                );
                logger.info(
                  { group: group.name },
                  '/clear: context reset (no active container)',
                );
              }
            } else {
              await channel.sendMessage(
                chatJid,
                'Permission denied: only admin can clear context.',
              );
              lastAgentTimestamp[chatJid] =
                groupMessages[groupMessages.length - 1].timestamp;
              saveState();
            }
            continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const loopExecutionContext = resolveExecutionContext(
            group,
            allPending,
          );
          const isWorkflowDelegationRun =
            isWorkflowDelegationExecutionContext(loopExecutionContext);
          if (allPending.length === 0) {
            logger.debug(
              {
                chatJid,
                count: groupMessages.length,
                lastAgentTimestamp: lastAgentTimestamp[chatJid] || '',
              },
              'Skipping already-consumed messages for active container',
            );
            continue;
          }
          const messagesToSend = allPending;
          const formatted = formatMessages(messagesToSend, TIMEZONE);
          const runId = activeRunIds.get(chatJid);
          if (
            isWorkflowDelegationRun ||
            !runId ||
            !queue.canPipeMessage(chatJid)
          ) {
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          const pipedCursorBefore = lastAgentTimestamp[chatJid] || '';
          const pipedMessageCursor =
            messagesToSend[messagesToSend.length - 1].timestamp;
          const pipedSelection = await selectModel({
            prompt: formatted,
            isMain: isMainGroup,
          });
          const queryId = createExecutionId();

          if (
            queue.sendMessage(
              chatJid,
              formatted,
              pipedSelection.selectedModel,
              queryId,
            )
          ) {
            createMessageQueryTrace({
              queryId,
              runId,
              chatJid,
              groupFolder: group.folder,
              sourceRefId:
                messagesToSend[messagesToSend.length - 1]?.id ?? null,
              selectedModel: pipedSelection.selectedModel,
              selectedModelReason: pipedSelection.reason,
              promptSummary: formatted.slice(0, 140),
              promptHash: crypto
                .createHash('sha256')
                .update(formatted)
                .digest('hex'),
              cursorBefore: pipedCursorBefore,
              messageCursor: pipedMessageCursor,
              inputSummary: `Queued ${messagesToSend.length} piped messages`,
              inputPayload: {
                messageIds: messagesToSend.map((m) => m.id),
                messageCount: messagesToSend.length,
                pipedIntoActiveSession: true,
              },
              pipedIntoActiveSession: true,
            });
            rememberPendingQueryBatch({
              runId,
              queryId,
              chatJid,
              messageIds: messagesToSend.map((m) => m.id),
              selectedModel: pipedSelection.selectedModel,
              modelReason: pipedSelection.reason,
              channelName: channel.name,
            });
            agentQueryTraceManager.appendEvent({
              queryId,
              eventType: 'input',
              eventName: 'piped_message',
              status: 'success',
              summary: `Piped ${messagesToSend.length} messages into active run`,
              payload: {
                messageIds: messagesToSend.map((m) => m.id),
                queryId,
              },
            });
            logger.debug(
              {
                chatJid,
                count: messagesToSend.length,
                runId,
                queryId,
                selectedModel: pipedSelection.selectedModel,
                reason: pipedSelection.reason,
              },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] = pipedMessageCursor;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            forgetPendingQueryBatch(queryId);
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

function resolveExecutionContext(
  group: RegisteredGroup,
  messages: NewMessage[],
): AgentExecutionContext | undefined {
  const workflowId = [...messages]
    .reverse()
    .find(
      (message) =>
        typeof message.workflow_id === 'string' && message.workflow_id.trim(),
    )
    ?.workflow_id?.trim();
  let workflow = workflowId ? getWorkflow(workflowId) : undefined;

  if (!workflow) {
    const pendingDelegations = getDelegationsByTarget(group.folder).filter(
      (delegation) => delegation.status === 'pending' && delegation.workflow_id,
    );
    if (pendingDelegations.length === 1) {
      workflow = getWorkflow(pendingDelegations[0].workflow_id || '');
    }
  }

  if (!workflow) return undefined;
  return {
    workflowId: workflow.id,
    stageKey: workflow.status,
    delegationId: workflow.current_delegation_id || undefined,
  };
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Load MySQL configs from services.json for proxy
  const servicesJsonPath = path.join(
    process.cwd(),
    'groups',
    'global',
    'services.json',
  );
  if (fs.existsSync(servicesJsonPath)) {
    try {
      const servicesConfig = JSON.parse(
        fs.readFileSync(servicesJsonPath, 'utf-8'),
      );
      loadMysqlConfigs(servicesConfig);
    } catch (err) {
      logger.warn({ err }, 'Failed to load MySQL configs from services.json');
    }
  }

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Start MySQL proxy (containers query MySQL through this)
  const mysqlProxyServer = await startMysqlProxy(
    MYSQL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    mysqlProxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts: {
    onMessage: (chatJid: string, msg: NewMessage) => void;
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => void;
    registeredGroups: () => Record<string, RegisteredGroup>;
    enqueueMessageCheck?: (groupJid: string) => void;
    getAgentStatus?: () => import('./types.js').AgentStatusInfo[];
    getActiveAgentQueryTraces?: () => import('./types.js').ActiveAgentQueryTrace[];
    stopAgent?: (
      groupJid: string,
    ) => Promise<import('./types.js').StopAgentResult>;
    resetSessions?: (scope: {
      all?: boolean;
      groupJid?: string;
    }) => Promise<{ resetCount: number }>;
    registerGroup?: (jid: string, group: RegisteredGroup) => void;
    onAgentStatusChange?: () => void;
    onAgentQueryTraceChange?: () => void;
  } = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    enqueueMessageCheck: (jid: string) => queue.enqueueMessageCheck(jid),
    getAgentStatus: () => queue.getActiveAgents(),
    getActiveAgentQueryTraces: () => agentQueryTraceManager.getActiveQueries(),
    stopAgent: (groupJid: string) => queue.stopAgent(groupJid),
    resetSessions: (scope) =>
      resetSessionsForScope({
        all: scope.all,
        groupJid: scope.groupJid,
      }),
    registerGroup,
    onAgentStatusChange: () => {
      for (const ch of channels) {
        if (ch.name === 'web' && 'broadcastAgentStatus' in ch) {
          (
            ch as typeof ch & { broadcastAgentStatus: () => void }
          ).broadcastAgentStatus();
        }
      }
    },
    onAgentQueryTraceChange: () => {
      for (const ch of channels) {
        if (ch.name === 'web' && 'broadcastAgentQueryTraces' in ch) {
          (
            ch as typeof ch & { broadcastAgentQueryTraces: () => void }
          ).broadcastAgentQueryTraces();
        }
      }
    },
  };

  // Wire up agent status change → web channel broadcast
  queue.onStatusChange(() => {
    channelOpts.onAgentStatusChange?.();
  });
  agentQueryTraceManager.onChange(() => {
    channelOpts.onAgentQueryTraceChange?.();
  });

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (!text) {
        logger.warn({ jid }, 'formatOutbound returned empty, skipping send');
        return;
      }
      await channel.sendMessage(jid, text);
    },
  });
  // Card support: route to whichever channel owns the JID
  const anySupportsCards = channels.some(
    (ch) => typeof ch.sendCard === 'function',
  );
  const sendCardFn = anySupportsCards
    ? (jid: string, card: InteractiveCard) => {
        const ch = findChannel(channels, jid);
        return ch?.sendCard
          ? ch.sendCard(jid, card)
          : Promise.resolve(undefined);
      }
    : undefined;

  // Wire up card action callback → workflow engine (all channels that support it)
  const cardActionHandler = createCardActionHandler({
    registeredGroups: () => registeredGroups,
    sendCard: sendCardFn,
    sendMessage: async (jid, text) => {
      const ch = findChannel(channels, jid);
      if (!ch) return;
      await ch.sendMessage(jid, text);
    },
  });
  for (const ch of channels) {
    if ('onCardAction' in ch) {
      ch.onCardAction = cardActionHandler;
    }
  }

  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => {
      // For main group, filter to same-channel groups only
      let filtered = ag;
      if (im) {
        const mainJid = Object.entries(registeredGroups).find(
          ([, g]) => g.folder === gf,
        )?.[0];
        if (mainJid) {
          const mainCh = findChannel(channels, mainJid);
          if (mainCh) {
            filtered = ag.filter((g) => {
              const targetGroup = registeredGroups[g.jid];
              return (
                mainCh.ownsJid(g.jid) ||
                (targetGroup &&
                  isAllowedCrossChannelDelegationTargetFolder(
                    targetGroup.folder,
                  ))
              );
            });
          }
        }
      }
      writeGroupsSnapshot(gf, im, filtered, rj);
    },
    enqueueMessageCheck: (jid) => queue.enqueueMessageCheck(jid),
    sendCard: sendCardFn,
    sendFile: (jid, filePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendFile) {
        return channel.sendMessage(
          jid,
          caption ||
            `[文件: ${path.basename(filePath)}] (该渠道不支持发送文件)`,
        );
      }
      return channel.sendFile(jid, filePath, caption);
    },
    reloadContainer: (jid) => {
      // closeStdin triggers container exit, enqueueMessageCheck ensures
      // a new container starts and resumes the session via sessionId.
      queue.closeStdin(jid);
      queue.enqueueMessageCheck(jid);
    },
    captureDesktop: (options) => {
      const channel = channels.find((ch) => ch.captureDesktop);
      if (!channel?.captureDesktop) {
        throw new Error('No connected channel supports desktop capture');
      }
      return channel.captureDesktop(options);
    },
  });
  initWorkflow({
    registeredGroups: () => registeredGroups,
    enqueueMessageCheck: (jid) => queue.enqueueMessageCheck(jid),
    sendCard: sendCardFn,
  });
  const workbenchBroadcast = new WorkbenchBroadcastService({
    registeredGroups: () => registeredGroups,
    sendCard: sendCardFn,
    sendMessage: async (jid, text) => {
      const ch = findChannel(channels, jid);
      if (!ch) return;
      await ch.sendMessage(jid, text);
    },
  });
  initWorkbenchEvents((event) => {
    for (const ch of channels) {
      if (ch.name === 'web' && 'broadcastWorkbenchEvent' in ch) {
        (
          ch as typeof ch & {
            broadcastWorkbenchEvent: (payload: typeof event) => void;
          }
        ).broadcastWorkbenchEvent(event);
      }
    }
    void workbenchBroadcast.handleEvent(event);
  });
  initAssistantEvents((event) => {
    for (const ch of channels) {
      if (ch.name === 'web' && 'broadcastAssistantEvent' in ch) {
        (
          ch as typeof ch & {
            broadcastAssistantEvent: (payload: typeof event) => void;
          }
        ).broadcastAssistantEvent(event);
      }
    }
  });
  initAssistantAutoFlow({
    agentRunner: async ({ prompt, purpose, item }) =>
      runAssistantActionAgent({
        prompt,
        purpose,
        item,
      }),
  });
  configureEvolutionEngine({
    agentRunner: runEvolutionActionAgent,
  });
  startProactiveEngine();
  startEvolutionEngine();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}

/** @internal - exported for testing */
export async function _runAgentForTest(input: {
  group: RegisteredGroup;
  prompt?: string;
  chatJid?: string;
  onOutput?: (output: ContainerOutput) => Promise<void>;
  executionContext?: AgentExecutionContext;
  isolatedSession?: boolean;
}): Promise<'success' | 'error'> {
  return runAgent(
    input.group,
    input.prompt || 'test prompt',
    input.chatJid || 'test@g.us',
    input.onOutput,
    'test-model',
    'test-run',
    'test-query',
    input.executionContext,
    undefined,
    input.isolatedSession,
  );
}
