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
  writeDelegationSnapshot,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { agentQueryTraceManager } from './agent-query-trace.js';
import {
  backfillMessageModel,
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
import { startSchedulerLoop } from './task-scheduler.js';
import { initAssistantEvents } from './assistant/assistant-events.js';
import { startProactiveEngine } from './assistant/proactive-engine.js';
import {
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
}

const channels: Channel[] = [];
const queue = new GroupQueue();
const pendingSessionCleanup = new Set<string>();
const activeRunIds = new Map<string, string>();
const pendingQueryBatches = new Map<string, PendingQueryBatch>();
const activeMessageQueryTraces = new Map<string, ActiveMessageQueryTraceState>();

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

  const isActive = queue.isActive(groupJid);

  clearSession(group.folder);
  delete sessions[group.folder];

  if (opts.deleteSessionDir) {
    if (isActive) pendingSessionCleanup.add(group.folder);
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
    agentQueryTraceManager.completeStep(params.queryId, contextStepId, 'success');
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
  });
}

function finishMessageQueryTrace(
  queryId: string,
  status: 'success' | 'error',
  patch?: Record<string, unknown>,
): void {
  const state = activeMessageQueryTraces.get(queryId);
  if (!state || state.finished) return;
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
  agentQueryTraceManager.finishQuery(queryId, status, patch as never);
  state.finished = true;
  activeMessageQueryTraces.delete(queryId);
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
      const queryId = result.queryId || initialQueryId;
      const traceState = activeMessageQueryTraces.get(queryId);
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
        const payload = result.event.payload || {};
        const mergedQueryId =
          result.event.name === 'query_merged_into_active_query' &&
          typeof payload.mergedQueryId === 'string'
            ? payload.mergedQueryId
            : null;
        agentQueryTraceManager.appendEvent({
          queryId,
          stepId:
            traceState?.resultDeliveryStepId || traceState?.executionStepId || null,
          eventType: result.event.type,
          eventName: result.event.name,
          status: result.event.status ?? null,
          summary: result.event.summary ?? null,
          payload,
        });
        if (mergedQueryId) {
          forgetPendingQueryBatch(mergedQueryId);
          activeMessageQueryTraces.delete(mergedQueryId);
          agentQueryTraceManager.deleteQuery(mergedQueryId);
        }
      }
      // Streaming output callback — called for each agent result
      if (result.result) {
        if (!traceState) {
          throw new Error(`Missing active query trace for ${queryId}`);
        }
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
          summary: text ? `Output: ${text.slice(0, 120)}` : 'Received output chunk',
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
        queue.notifyIdle(chatJid);
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
        if (!traceState) {
          throw new Error(`Missing active query trace for ${queryId}`);
        }
        agentQueryTraceManager.appendEvent({
          queryId,
          stepId: traceState.resultDeliveryStepId || traceState.executionStepId,
          eventType: 'error',
          eventName: 'query_failed',
          status: 'error',
          summary: result.error || 'Agent execution failed',
          payload: {
            error: result.error || 'Agent execution failed',
          },
        });
        traceState.hadError = true;
        sessionHadError = true;
      }
    },
    modelSelection.selectedModel,
    runId,
    initialQueryId,
    executionContext,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);
  for (const [queryId, state] of activeMessageQueryTraces) {
    if (state.runId !== runId) continue;
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
          output === 'error' || state.hadError ? 'Agent execution failed' : null,
      },
    );
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
  executionContext?: {
    workflowId?: string;
    stageKey?: string;
    delegationId?: string;
  },
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];
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
      filteredGroups = availableGroups.filter((g) => mainCh.ownsJid(g.jid));
    }
  }
  writeGroupsSnapshot(
    group.folder,
    isMain,
    filteredGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Update delegation snapshot for container to read
  writeDelegationSnapshot(group.folder, isMain, registeredGroups);

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
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
      output.status === 'error' &&
      output.error?.includes('No conversation found');

    if (isSessionInvalid) {
      logger.warn(
        { group: group.name, sessionId: output.newSessionId },
        'Session invalid, clearing for retry',
      );
      clearSession(group.folder);
      delete sessions[group.folder];
      // Don't save the invalid session ID - let retry create a new one
    } else if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  } finally {
    clearModelResolutionsForRun(resolvedRunId);
    forgetPendingQueryBatchesForRun(resolvedRunId);
    activeRunIds.delete(chatJid);
  }
}

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
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            const command = extractSessionCommand(
              loopCmdMsg.content,
              TRIGGER_PATTERN,
            );
            if (
              command === '/compact' &&
              isSessionCommandAllowed(!!loopCmdMsg.is_from_me)
            ) {
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
              resetGroupSession(chatJid, {
                deleteSessionDir: true,
              });
              lastAgentTimestamp[chatJid] =
                groupMessages[groupMessages.length - 1].timestamp;
              saveState();

              if (queue.isActive(chatJid)) {
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
          const pipedSelection = await selectModel({
            prompt: formatted,
            isMain: isMainGroup,
          });
          const runId = activeRunIds.get(chatJid);
          const queryId = createExecutionId();

          if (
            runId &&
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
              sourceRefId: messagesToSend[messagesToSend.length - 1]?.id ?? null,
              selectedModel: pipedSelection.selectedModel,
              selectedModelReason: pipedSelection.reason,
              promptSummary: formatted.slice(0, 140),
              promptHash: crypto.createHash('sha256').update(formatted).digest('hex'),
              inputSummary: `Queued ${messagesToSend.length} piped messages`,
              inputPayload: {
                messageIds: messagesToSend.map((m) => m.id),
                messageCount: messagesToSend.length,
                pipedIntoActiveSession: true,
              },
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
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else if (runId) {
            forgetPendingQueryBatch(queryId);
          } else {
            // No active container — enqueue for a new one
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
):
  | { workflowId?: string; stageKey?: string; delegationId?: string }
  | undefined {
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
            filtered = ag.filter((g) => mainCh.ownsJid(g.jid));
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
  startProactiveEngine();
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
