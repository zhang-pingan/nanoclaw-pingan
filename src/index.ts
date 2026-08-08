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
  COLLABORATION_CODEX_BINARY,
  COLLABORATION_CODEX_CWD,
  COLLABORATION_CODEX_DESKTOP_VISIBILITY_CONFIRMED,
  COLLABORATION_CODEX_MODEL,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  ICARUS_INTERNAL_AGENT_MAX_INPUT_CHARS,
  ICARUS_INTERNAL_API_HOST,
  ICARUS_INTERNAL_API_MAX_BODY_BYTES,
  ICARUS_INTERNAL_API_PORT,
  ICARUS_INTERNAL_API_TOKEN,
  MYSQL_PROXY_PORT,
  POLL_INTERVAL,
  SSH_KEY_PATH,
  STORE_DIR,
  TIMEZONE,
  TRIGGER_PATTERN,
  WORKFLOW_CODEX_APPROVAL_POLICY,
  WORKFLOW_CODEX_BINARY,
  WORKFLOW_CODEX_CWD,
  WORKFLOW_CODEX_DESKTOP_VISIBILITY_CONFIRMED,
  WORKFLOW_CODEX_MODEL,
  WORKFLOW_CODEX_SANDBOX,
  WORKFLOW_CONTAINER_AGENT_JID,
  WORKFLOW_EXECUTION_ENABLED,
  WORKFLOW_EXECUTION_POLL_MS,
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
  writeAgentsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { agentQueryTraceManager } from './agent-query-trace.js';
import { queryPatchFromTraceEvent } from './agent-query-trace-utils.js';
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
  getAllRegisteredAgents,
  getAllSessions,
  getAllTasks,
  getDelegationsByTarget,
  getMessagesSince,
  getNewMessages,
  getRegisteredAgent,
  getRouterState,
  initDatabase,
  setRegisteredAgent,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  activateConfiguredFeatures,
  configureFeatureManagementHostHooks,
  type FeatureDeletionSummary,
} from './features/index.js';
import { backfillWebMessageModel, clearWebMessages } from './web-db.js';
import { AgentQueue, OneShotAgentSlotEvent } from './agent-queue.js';
import { resolveAgentFolderPath } from './agent-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  stripInternalTags,
} from './router.js';
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
import { AssistantInboxBroadcastService } from './assistant/assistant-inbox-broadcast.js';
import { initAssistantAutoFlow } from './assistant/assistant-auto-flow.js';
import { startProactiveEngine } from './assistant/proactive-engine.js';
import {
  AgentQueryRecord,
  Channel,
  InteractiveCard,
  NewMessage,
  RegisteredAgent,
} from './types.js';
import { logger } from './logger.js';
import {
  HOST_CORE_STARTUP_SMOKE_ENV,
  HOST_CORE_STARTUP_SMOKE_MARKER,
} from './host-core/startup-smoke.js';
import { buildMemoryPackForAgent } from './memory-pack.js';
import {
  clearModelResolutionsForRun,
  consumeModelResolution,
} from './model-resolution.js';
import { selectModel } from './model-selector.js';
import { InternalAgentRunOnceService } from './internal-agent-run-once/service.js';
import { InternalAgentChatService } from './internal-agent-run-once/chat-service.js';
import { startInternalAgentRunOnceServer } from './internal-agent-run-once/server.js';
import { WorkflowRuntimeConnectionFactory } from './workflow-runtime/gateway/connection.js';
import { RuntimeWorkspaceGateway } from './workflow-runtime/gateway/workspace.js';
import {
  ensureTaskWorkspaceCore,
  WorkflowRuntimeService,
  WorkflowRuntimeTransactionAuthority,
} from './workflow-runtime/gateway/host-core.js';
import { WorkflowExecutionAdapterRegistry } from './workflow-execution/adapter-registry.js';
import { ContainerAgentAdapter } from './workflow-execution/container-agent-adapter.js';
import { CodexTaskAdapter } from './workflow-execution/codex-task-adapter.js';
import { WorkflowAdapterExecutionStore } from './workflow-execution/execution-store.js';
import { WorkflowExecutionWorker } from './workflow-execution/worker.js';
import { WorkflowExecutionHostService } from './workflow-execution/host-service.js';
import { CollaborationRuntime } from './collaboration/runtime.js';
import { CollaborationWebApi } from './collaboration/web-api.js';
import { RuntimeEventHub } from './task-workspace/runtime-event-hub.js';
import { TaskWorkspaceStore } from './task-workspace/store.js';
import { TaskWorkspaceService } from './task-workspace/service.js';
import { TaskWorkspaceWebApi } from './task-workspace/web-api.js';
import type { TaskWorkspaceTimelineDeltaV1 } from './task-workspace/contracts.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredAgents: Record<string, RegisteredAgent> = {};
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

interface RetryLink {
  queryId: string;
  cursorBefore: string | null;
  messageCursor: string | null;
}

interface OneShotTraceContext {
  queryId: string;
  stepId: string;
  runId?: string;
  traceKey?: string;
  dedupeKey?: string;
}

type AgentExecutionContext = {
  delegationId?: string;
};

const channels: Channel[] = [];
const queue = new AgentQueue();
const pendingSessionCleanup = new Set<string>();
const activeRunIds = new Map<string, string>();
const pendingQueryBatches = new Map<string, PendingQueryBatch>();
const activeMessageQueryTraces = new Map<
  string,
  ActiveMessageQueryTraceState
>();
const pendingRetryLinksByChat = new Map<string, RetryLink[]>();
const oneShotTraceContexts = new Map<string, OneShotTraceContext[]>();

function removeSessionDir(agentFolder: string): void {
  const sessionDir = path.join(DATA_DIR, 'sessions', agentFolder, '.claude');
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true });
  }
}

function resetAgentSession(
  agentJid: string,
  opts: {
    deleteSessionDir?: boolean;
  } = {},
): { reset: boolean } {
  const agent = registeredAgents[agentJid];
  if (!agent) return { reset: false };

  const hasActiveContainer = queue.hasActiveContainer(agentJid);

  clearSession(agent.folder);
  delete sessions[agent.folder];
  bumpSessionResetEpoch(agent.folder);

  if (opts.deleteSessionDir) {
    if (hasActiveContainer) pendingSessionCleanup.add(agent.folder);
    else removeSessionDir(agent.folder);
  }

  return { reset: true };
}

async function resetSessionsForScope(opts: {
  all?: boolean;
  agentJid?: string;
  deleteSessionDir?: boolean;
}): Promise<{ resetCount: number }> {
  const targets = opts.all
    ? Object.keys(registeredAgents)
    : opts.agentJid
      ? [opts.agentJid]
      : [];

  let resetCount = 0;
  for (const agentJid of targets) {
    const result = resetAgentSession(agentJid, {
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

function oneShotAgentSlotTimeoutFailure(
  error: string,
  details: Record<string, unknown> = {},
): ClassifiedFailure {
  return {
    failureType: 'timeout',
    failureSubtype: 'one_shot_agent_slot_timeout',
    failureOrigin: 'scheduler',
    retryable: true,
    details: {
      module: 'index',
      action: 'run_one_shot_agent',
      ...details,
    },
  };
}

export function addOneShotTraceContext(
  chatJid: string,
  context: OneShotTraceContext,
): void {
  const contexts = oneShotTraceContexts.get(chatJid) || [];
  contexts.push(context);
  oneShotTraceContexts.set(chatJid, contexts);
}

export function removeOneShotTraceContext(
  chatJid: string,
  queryId: string,
): void {
  const contexts = oneShotTraceContexts.get(chatJid);
  if (!contexts) return;
  const remaining = contexts.filter((context) => context.queryId !== queryId);
  if (remaining.length > 0) {
    oneShotTraceContexts.set(chatJid, remaining);
  } else {
    oneShotTraceContexts.delete(chatJid);
  }
}

function handleOneShotSlotTraceEvent(event: OneShotAgentSlotEvent): void {
  const contexts = oneShotTraceContexts.get(event.agentJid);
  if (!contexts?.length) return;

  for (const context of contexts) {
    if (
      event.traceKey &&
      context.traceKey &&
      event.traceKey !== context.traceKey
    ) {
      continue;
    }
    try {
      const isTimeout = event.eventName === 'agent_slot_timeout';
      const isAcquired = event.eventName === 'agent_slot_acquired';
      agentQueryTraceManager.appendStructuredEvent({
        queryId: context.queryId,
        stepId: context.stepId,
        category: 'queue',
        eventName: isTimeout
          ? 'queue_wait_timeout'
          : isAcquired
            ? 'queue_dequeued'
            : 'queue_entered',
        status: isTimeout ? 'error' : isAcquired ? 'success' : 'running',
        severity: isTimeout ? 'error' : 'info',
        summary: isTimeout
          ? `Agent busy timeout for ${event.agentJid}`
          : isAcquired
            ? 'One-shot agent slot acquired'
            : 'Waiting for one-shot agent slot',
        payload: {
          originalEventName: event.eventName,
          agentJid: event.agentJid,
          runId: context.runId ?? null,
          oneShotId: event.oneShotId,
          queueName: 'one-shot-agent-slot',
          queueLatencyMs: isAcquired || isTimeout ? event.waitMs : undefined,
          waitMs: event.waitMs,
          idleWaiting: event.idleWaiting,
          pendingQueueLength: event.pendingQueueLength,
          activeCount: event.activeCount,
          timeoutMs: event.timeoutMs,
        },
      });
      if (isAcquired || isTimeout) {
        agentQueryTraceManager.updateQuery(context.queryId, {
          queue_latency_ms: event.waitMs,
        });
      }
    } catch (err) {
      logger.warn(
        {
          err,
          agentJid: event.agentJid,
          queryId: context.queryId,
          eventName: event.eventName,
        },
        'Failed to append one-shot slot trace event',
      );
    }
  }
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
  agentFolder: string,
  queryId: string,
): number {
  const inputDir = path.join(DATA_DIR, 'ipc', agentFolder, 'input');
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
        { err, agentFolder, queryId, file },
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
  confirmedActualModel?: string;
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
  return {
    applied: true,
    batch,
    actualModel,
    confirmedActualModel: resolution?.actualModel,
    updatedRows,
    updatedWebRows,
  };
}

function isDelegationExecutionContext(
  executionContext?: AgentExecutionContext,
): boolean {
  return Boolean(executionContext?.delegationId);
}

function isCompleteDelegationToolResult(output: ContainerOutput): boolean {
  const toolName = output.event?.payload?.toolName;
  return Boolean(
    output.status === 'success' &&
    (output.event?.name === 'tool_result' ||
      output.event?.name === 'tool_completed' ||
      output.event?.name === 'ipc_request_completed') &&
    toolName === 'complete_delegation',
  );
}

function isSendMessageToolResult(output: ContainerOutput): boolean {
  const toolName = output.event?.payload?.toolName;
  return Boolean(
    output.status === 'success' &&
    (output.event?.name === 'tool_result' ||
      output.event?.name === 'tool_completed' ||
      output.event?.name === 'ipc_request_completed') &&
    (toolName === 'mcp__icarus__send_message' || toolName === 'send_message'),
  );
}

function isNaturalConfirmationText(text: string): boolean {
  const normalized = text.replace(/\s+/g, '').trim();
  return (
    normalized.length > 0 &&
    normalized.length < 30 &&
    /(转告|反馈|回复|通知|发送|告知|完成)/.test(normalized)
  );
}

function createMessageQueryTrace(params: {
  queryId: string;
  runId: string;
  chatJid: string;
  agentFolder: string;
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
  retryOfQueryId?: string | null;
  retryAttempt?: number | null;
}): void {
  const sourceType = params.delegationId ? 'delegation' : 'message';
  agentQueryTraceManager.startQuery({
    queryId: params.queryId,
    runId: params.runId,
    sourceType,
    sourceRefId:
      sourceType === 'delegation'
        ? (params.delegationId ?? null)
        : (params.sourceRefId ?? null),
    chatJid: params.chatJid,
    agentFolder: params.agentFolder,
    delegationId: params.delegationId,
    selectedModel: params.selectedModel,
    selectedModelReason: params.selectedModelReason,
    promptSummary: params.promptSummary,
    promptHash: params.promptHash,
  });
  if (params.retryOfQueryId || params.retryAttempt) {
    agentQueryTraceManager.updateQuery(params.queryId, {
      retry_of_query_id: params.retryOfQueryId ?? null,
      retry_attempt: params.retryAttempt ?? null,
    });
  }
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
  if (params.delegationId) {
    agentQueryTraceManager.appendStructuredEvent({
      queryId: params.queryId,
      stepId: executionStepId,
      category: 'delegation',
      eventName: 'delegation_started',
      status: 'running',
      summary: 'Delegation started',
      payload: {
        delegationId: params.delegationId ?? null,
      },
    });
  }
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

function rememberRetryLink(chatJid: string, link: RetryLink): void {
  const links = pendingRetryLinksByChat.get(chatJid) ?? [];
  pendingRetryLinksByChat.set(chatJid, [...links, link].slice(-20));
}

function consumeRetryLink(
  chatJid: string,
  cursorBefore: string,
  messageCursor: string,
): RetryLink | null {
  const links = pendingRetryLinksByChat.get(chatJid);
  if (!links?.length) return null;
  const index = links.findIndex(
    (link) =>
      link.cursorBefore === cursorBefore &&
      link.messageCursor === messageCursor,
  );
  if (index === -1) return null;
  const [link] = links.splice(index, 1);
  if (links.length === 0) {
    pendingRetryLinksByChat.delete(chatJid);
  }
  return link;
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
  const record = agentQueryTraceManager.getQuery(queryId);
  if (record?.delegation_id) {
    agentQueryTraceManager.appendStructuredEvent({
      queryId,
      stepId: activeStepId,
      category: 'delegation',
      eventName: 'delegation_completed',
      status,
      severity: status === 'error' ? 'error' : 'info',
      summary:
        status === 'error' ? 'Delegation failed' : 'Delegation completed',
      payload: {
        delegationId: record.delegation_id,
      },
    });
  }
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
  agent: RegisteredAgent;
  channel: Channel;
  messages: NewMessage[];
}): Promise<boolean> {
  const { chatJid, agent, channel, messages } = opts;
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

  const effectiveAgentFolder = agent.folder;

  const result = await handleAskQuestionResponse({
    requestId: parsed.requestId,
    agentFolder: effectiveAgentFolder,
    userId: cmdMsg.sender || 'unknown',
    answer: parsed.answer,
    skip: parsed.answer.toLowerCase() === 'skip',
    reject: parsed.answer.toLowerCase() === 'reject',
    registeredAgents,
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
      agentFolder: effectiveAgentFolder,
      validationError: result.userMessage,
      validationErrors: result.validationErrors,
      registeredAgents,
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
  registeredAgents = getAllRegisteredAgents();
  logger.info(
    { agentCount: Object.keys(registeredAgents).length },
    'State loaded',
  );
}

function reloadRegisteredAgentsFromDb(): void {
  registeredAgents = getAllRegisteredAgents();
  logger.info(
    { agentCount: Object.keys(registeredAgents).length },
    'Registered agents reloaded',
  );
}

async function stopFeatureAgentsForDeletion(
  agents: FeatureDeletionSummary['agents'],
): Promise<void> {
  for (const agent of agents) {
    const stopResult = await queue.stopAgent(agent.jid);
    if (!stopResult.ok && stopResult.error !== 'Agent is not active') {
      logger.warn(
        { agentJid: agent.jid, featureAgent: agent, error: stopResult.error },
        'Failed to stop feature agent before deletion',
      );
      throw new Error(
        `Failed to stop feature agent ${agent.jid}: ${stopResult.error}`,
      );
    }
    queue.purgeAgentState(agent.jid, 'feature_delete_data');
  }
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerAgent(jid: string, agent: RegisteredAgent): void {
  let agentDir: string;
  try {
    agentDir = resolveAgentFolderPath(agent.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: agent.folder, err },
      'Rejecting agent registration with invalid folder',
    );
    return;
  }

  registeredAgents[jid] = agent;
  setRegisteredAgent(jid, agent);

  // Create agent folder
  fs.mkdirSync(path.join(agentDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: agent.name, folder: agent.folder },
    'Agent registered',
  );
}

/**
 * Get available agents list for the agent.
 * Returns registered agents, enriched with last-activity from chats table.
 */
export function getAvailableAgents(): import('./container-runner.js').AvailableAgent[] {
  const chats = getAllChats();
  const chatMap = new Map(chats.map((c) => [c.jid, c]));

  return Object.entries(registeredAgents).map(([jid, g]) => ({
    jid,
    name: g.name,
    lastActivity: chatMap.get(jid)?.last_message_time || '',
    isRegistered: true,
    description: g.description || null,
  }));
}

/** @internal - exported for testing */
export function _setRegisteredAgents(
  agents: Record<string, RegisteredAgent>,
): void {
  registeredAgents = agents;
}

/** @internal - exported for testing */
export function _setSessionsForTest(
  nextSessions: Record<string, string>,
): void {
  sessions = { ...nextSessions };
}

/**
 * Process all pending messages for an Agent.
 * Called by the AgentQueue when it's this agent's turn.
 */
async function processAgentMessages(chatJid: string): Promise<boolean> {
  const agent = registeredAgents[chatJid];
  if (!agent) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainAgent = agent.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // --- /clear command: wipe conversation context for this agent ---
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
      resetAgentSession(chatJid, { deleteSessionDir: true });
      await channel.sendMessage(chatJid, '数据已清理完毕，可正常发送命令啦');
      logger.info({ agent: agent.name }, '/clear: context reset');
    } else {
      await channel.sendMessage(
        chatJid,
        'Permission denied: only admin can clear context.',
      );
      logger.info(
        { agent: agent.name, sender: clearMsg.sender },
        '/clear: permission denied',
      );
    }
    return true;
  }

  if (
    await handleAskAnswerCommand({
      chatJid,
      agent,
      channel,
      messages: missedMessages,
    })
  ) {
    return true;
  }

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainAgent,
    agentName: agent.name,
    triggerPattern: TRIGGER_PATTERN,
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(agent, prompt, chatJid, onOutput),
      closeStdin: () =>
        queue.closeStdin(chatJid, {
          reason: 'session_command_handler',
          details: { agentName: agent.name },
        }),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      resetSession: () => {
        resetAgentSession(chatJid);
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
        const reqTrigger = !isMainAgent && agent.requiresTrigger !== false;
        return (
          isMainAgent ||
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

  // For non-main agents, check if trigger is required and present
  if (!isMainAgent && agent.requiresTrigger !== false) {
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
  const memoryPack = buildMemoryPackForAgent(agent.folder, prompt);
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
    { agent: agent.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Record agent info for status panel
  const lastMsg = missedMessages[missedMessages.length - 1];
  queue.setAgentInfo(chatJid, {
    promptSummary: prompt.slice(0, 100),
    agentName: agent.name,
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
        { agent: agent.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid, {
        reason: 'idle_timeout',
        details: {
          agentName: agent.name,
          idleTimeoutMs: IDLE_TIMEOUT,
          runId,
          initialQueryId,
        },
      });
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let sessionHadError = false;
  let sessionOutputSent = false;
  const runId = createExecutionId();
  const initialQueryId = createExecutionId();
  const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
  const executionContext = resolveExecutionContext(agent, missedMessages);
  const isDelegationRun = isDelegationExecutionContext(executionContext);
  const isWecomDelegationRun =
    channel.name === 'wecom' &&
    missedMessages.some((message) =>
      /\[委派任务\s*\|\s*ID:/.test(message.content),
    );
  let sentMessageInWecomDelegationRun = false;
  const modelSelection = await selectModel({
    prompt,
    isMain: isMainAgent,
  });
  const retryLink = consumeRetryLink(
    chatJid,
    previousCursor,
    lastMsg.timestamp,
  );
  createMessageQueryTrace({
    queryId: initialQueryId,
    runId,
    chatJid,
    agentFolder: agent.folder,
    delegationId: executionContext?.delegationId,
    sourceRefId: lastMsg.id,
    selectedModel: modelSelection.selectedModel,
    selectedModelReason: modelSelection.reason,
    promptSummary: prompt.slice(0, 140),
    promptHash,
    cursorBefore: previousCursor,
    messageCursor: lastMsg.timestamp,
    retryOfQueryId: retryLink?.queryId ?? null,
    retryAttempt: retryLink ? 1 : null,
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
      agent: agent.name,
      chatJid,
      runId,
      queryId: initialQueryId,
      selectedModel: modelSelection.selectedModel,
      reason: modelSelection.reason,
    },
    'Selected model for runAgent',
  );

  const output = await runAgent(
    agent,
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
              agent: agent.name,
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
      if (result.newSessionId) {
        // keep query traces in sync with the latest resumed session id
      }
      if (result.event) {
        if (isDelegationRun && isCompleteDelegationToolResult(result)) {
          queue.closeStdin(chatJid, {
            reason: 'delegation_complete_tool_result',
            details: { agentName: agent.name, runId, queryId },
          });
        }
        if (isWecomDelegationRun && isSendMessageToolResult(result)) {
          sentMessageInWecomDelegationRun = true;
        }
        if (!traceState) {
          logger.warn(
            {
              agent: agent.name,
              chatJid,
              queryId,
              eventName: result.event.name,
              runId: result.runId,
            },
            'Skipping event for inactive query trace',
          );
          return;
        }
        const eventQueryPatch = queryPatchFromTraceEvent(result.event);
        if (Object.keys(eventQueryPatch).length > 0) {
          agentQueryTraceManager.updateQuery(queryId, eventQueryPatch);
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
              agent: agent.name,
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
        const text = stripInternalTags(raw);
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
          { agent: agent.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          const suppressFinalOutput =
            isWecomDelegationRun &&
            sentMessageInWecomDelegationRun &&
            isNaturalConfirmationText(text);
          if (suppressFinalOutput) {
            agentQueryTraceManager.appendEvent({
              queryId,
              stepId: traceState.resultDeliveryStepId,
              eventType: 'lifecycle',
              eventName: 'channel_send_suppressed',
              status: 'success',
              summary: 'Suppressed duplicate WeCom delegation confirmation',
              payload: {
                channel: channel.name,
                reason: 'wecom_delegation_send_message_confirmation',
                text,
              },
            });
          } else {
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
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      const finalized = finalizePendingQueryBatch(result);
      if (finalized.applied) {
        logger.info(
          {
            agent: agent.name,
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
        if (finalized.confirmedActualModel) {
          agentQueryTraceManager.updateQuery(finalized.batch!.queryId, {
            actual_model: finalized.confirmedActualModel,
          });
        }
      }

      if (
        result.status === 'success' &&
        !result.event &&
        !result.result &&
        result.final !== false
      ) {
        if (isDelegationRun) {
          queue.closeStdin(chatJid, {
            reason: 'delegation_session_update',
            details: { agentName: agent.name, runId, queryId },
          });
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
      } else if (
        result.status === 'success' &&
        !result.event &&
        !result.result
      ) {
        if (isDelegationRun) {
          queue.closeStdin(chatJid, {
            reason: 'delegation_session_update',
            details: { agentName: agent.name, runId, queryId },
          });
        } else {
          queue.notifyIdle(chatJid);
        }
      }

      if (result.status === 'error') {
        if (isDelegationRun) {
          queue.closeStdin(chatJid, {
            reason: 'delegation_error',
            details: { agentName: agent.name, runId, queryId },
          });
        }
        const error = result.error || 'Agent execution failed';
        const failure = result.failure ?? fallbackAgentExecutionFailure(error);
        if (!traceState) {
          logger.warn(
            {
              agent: agent.name,
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
    isDelegationRun,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);
  if (isDelegationRun) {
    queue.closeStdin(chatJid, {
      reason: 'delegation_run_finished',
      details: { agentName: agent.name, runId, initialQueryId },
    });
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
        payload: {
          retryMode: 'chat_history',
          cursorBefore: state.cursorBefore,
          messageCursor: state.messageCursor,
        },
      });
      const removedIpcMessages = removeQueuedIpcMessagesForQuery(
        agent.folder,
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
      rememberRetryLink(chatJid, {
        queryId,
        cursorBefore: state.cursorBefore,
        messageCursor: state.messageCursor,
      });
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
          agent: agent.name,
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
  if (pendingSessionCleanup.has(agent.folder)) {
    pendingSessionCleanup.delete(agent.folder);
    removeSessionDir(agent.folder);
    await channel.sendMessage(chatJid, '数据已清理完毕，可正常发送命令啦');
    logger.info({ agent: agent.name }, '/clear: deferred cleanup completed');
  }

  if (output === 'error' || sessionHadError) {
    forgetPendingQueryBatch(initialQueryId);
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (sessionOutputSent) {
      logger.warn(
        { agent: agent.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { agent: agent.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  agent: RegisteredAgent,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  selectedModel?: string,
  runId?: string,
  initialQueryId?: string,
  executionContext?: AgentExecutionContext,
  requireResult?: boolean,
  isolatedSession?: boolean,
  isOneShot?: boolean,
): Promise<'success' | 'error'> {
  const isMain = agent.isMain === true;
  const sessionId = isolatedSession ? undefined : sessions[agent.folder];
  const sessionResetEpoch = getSessionResetEpoch(agent.folder);
  const isSessionWriteCurrent = () =>
    isSessionResetEpochCurrent(agent.folder, sessionResetEpoch);
  const writeSessionIfCurrent = (sessionIdToWrite: string): boolean => {
    if (!isSessionWriteCurrent()) {
      logger.info(
        {
          agent: agent.name,
          sessionId: sessionIdToWrite,
          runEpoch: sessionResetEpoch,
          currentEpoch: getSessionResetEpoch(agent.folder),
        },
        'Skipping stale session update after reset',
      );
      return false;
    }
    if (pendingSessionCleanup.has(agent.folder)) {
      logger.info(
        { agent: agent.name, sessionId: sessionIdToWrite },
        'Skipping session update while session cleanup is pending',
      );
      return false;
    }
    sessions[agent.folder] = sessionIdToWrite;
    setSession(agent.folder, sessionIdToWrite);
    return true;
  };
  const resolvedRunId = runId || createExecutionId();
  const resolvedInitialQueryId = initialQueryId || createExecutionId();
  const modelSelection = selectedModel
    ? { selectedModel, reason: 'preselected' }
    : await selectModel({ prompt, isMain });
  logger.info(
    {
      agent: agent.name,
      chatJid,
      runId: resolvedRunId,
      queryId: resolvedInitialQueryId,
      selectedModel: modelSelection.selectedModel,
      reason: modelSelection.reason,
    },
    'Selected model for container input',
  );

  // Update tasks snapshot for container to read (filtered by agent)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    agent.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      agentFolder: t.agent_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available agents snapshot (main agent only can see all agents)
  const availableAgents = getAvailableAgents();
  // For main agent, filter to same-channel agents only
  let filteredAgents = availableAgents;
  if (isMain) {
    const mainCh = findChannel(channels, chatJid);
    if (mainCh) {
      filteredAgents = availableAgents.filter((availableAgent) => {
        const targetAgent = registeredAgents[availableAgent.jid];
        return (
          mainCh.ownsJid(availableAgent.jid) ||
          (targetAgent &&
            isAllowedCrossChannelDelegationTargetFolder(targetAgent.folder))
        );
      });
    }
  }
  writeAgentsSnapshot(
    agent.folder,
    isMain,
    filteredAgents,
    new Set(Object.keys(registeredAgents)),
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
      agent,
      {
        prompt,
        sessionId,
        runId: resolvedRunId,
        queryId: resolvedInitialQueryId,
        requireResult,
        isolatedSession,
        isOneShot,
        agentFolder: agent.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        selectedModel: modelSelection.selectedModel,
        executionContext,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, agent.folder),
      wrappedOnOutput,
    );

    // Handle "No conversation found" error - session is invalid, clear it
    const isSessionInvalid =
      !isolatedSession &&
      output.status === 'error' &&
      output.error?.includes('No conversation found');

    if (isSessionInvalid) {
      logger.warn(
        { agent: agent.name, sessionId: output.newSessionId },
        'Session invalid, clearing for retry',
      );
      clearSession(agent.folder);
      delete sessions[agent.folder];
      bumpSessionResetEpoch(agent.folder);
      // Don't save the invalid session ID - let retry create a new one
    } else if (output.newSessionId && !isolatedSession) {
      writeSessionIfCurrent(output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { agent: agent.name, error: output.error },
        'Container agent error',
      );
      if (wrappedOnOutput && !streamedErrorOutputSeen) {
        await wrappedOnOutput(output);
      }
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ agent: agent.name, err }, 'Agent error');
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
    agentName?: string;
    promptSummary?: string;
    lastSender?: string;
    lastContent?: string;
    lastTime?: string;
    isTask?: boolean;
    dedupeKey?: string;
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
  if (preferredJid && registeredAgents[preferredJid]) return preferredJid;
  if (registeredAgents[ASSISTANT_MAIN_JID]?.isMain === true) {
    return ASSISTANT_MAIN_JID;
  }
  const fallback = Object.entries(registeredAgents).find(
    ([, agent]) => agent.isMain,
  );
  if (fallback) {
    logger.warn(
      { preferredJid, fallbackJid: fallback[0] },
      'Assistant main agent not found, falling back to first main agent',
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
  return stripInternalTags(value);
}

async function runOneShotAgent(
  input: OneShotAgentInput,
): Promise<OneShotAgentResult> {
  const agent = registeredAgents[input.chatJid];
  if (!agent) {
    return {
      ok: false,
      text: '',
      outputs: [],
      error: `Registered agent not found: ${input.chatJid}`,
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

  let status: 'success' | 'error';
  try {
    status = await queue.runOneShot(
      input.chatJid,
      {
        agentFolder: agent.folder,
        agentName: input.status.agentName || agent.name,
        promptSummary: truncateStatusText(
          input.status.promptSummary || input.prompt,
          100,
        ),
        lastSender: input.status.lastSender || '',
        lastContent: truncateStatusText(input.status.lastContent, 200),
        lastTime: input.status.lastTime || Date.now().toString(),
        isTask: input.status.isTask ?? false,
        traceKey: input.initialQueryId,
        dedupeKey: input.status.dedupeKey,
      },
      () =>
        runAgent(
          agent,
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
                queue.closeStdin(input.chatJid, {
                  reason: 'one_shot_first_result',
                  details: {
                    runId: input.runId,
                    initialQueryId: input.initialQueryId,
                  },
                });
              }
              if (collect === 'first_result') return;
            }
            if (
              output.status === 'success' &&
              !output.event &&
              !output.result
            ) {
              sessionOnlyMarkerCount += 1;
            }
            await forwardOutput(output);
            if (
              output.status === 'success' &&
              !output.event &&
              !output.result &&
              output.final !== false &&
              (!input.requireResult || resultMarkerCount > 0) &&
              input.closeOnFirstResult !== false &&
              !closeRequested
            ) {
              closeRequested = true;
              queue.closeStdin(input.chatJid, {
                reason: 'one_shot_session_update_after_result',
                details: {
                  runId: input.runId,
                  initialQueryId: input.initialQueryId,
                  requireResult: input.requireResult,
                },
              });
            }
          },
          input.selectedModel,
          input.runId,
          input.initialQueryId,
          undefined,
          input.requireResult,
          input.isolatedSession,
          true,
        ),
    );
  } catch (err) {
    status = 'error';
    executionError =
      err instanceof Error ? err.message : 'One-shot agent execution failed';
    if (executionError.includes('Agent busy timeout')) {
      executionFailure = oneShotAgentSlotTimeoutFailure(executionError, {
        chatJid: input.chatJid,
        runId: input.runId,
        queryId: input.initialQueryId,
      });
    } else {
      executionFailure = classifyFailure(new Error(executionError), {
        module: 'index',
        action: 'run_one_shot_agent',
        defaultType: 'container_runtime_error',
        defaultSubtype: 'one_shot_agent_failed',
        defaultOrigin: 'container',
        retryable: true,
      });
    }
  }

  const result = finalizeOneShotAgentResult({
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

  if (
    !result.ok &&
    !result.failure &&
    result.error?.includes('Agent busy timeout')
  ) {
    result.failure = oneShotAgentSlotTimeoutFailure(result.error, {
      chatJid: input.chatJid,
      runId: input.runId,
      queryId: input.initialQueryId,
    });
  }

  return result;
}

async function runAssistantActionAgent(
  input: AssistantActionAgentInput,
): Promise<{ ok: boolean; text: string; error?: string }> {
  const chatJid = resolveAssistantActionJid(input.chatJid);
  if (!chatJid) {
    return {
      ok: false,
      text: '',
      error: 'Assistant action agent not found',
    };
  }

  const agent = registeredAgents[chatJid];
  const runId = createExecutionId();
  const queryId = createExecutionId();
  const purposeLabel = assistantActionPurposeLabel(input.purpose);
  const promptSummary = `${purposeLabel}：${input.item.title}`;
  const selectedModel = await selectModel({
    prompt: input.prompt,
    isMain: agent?.isMain === true,
  });
  agentQueryTraceManager.startQuery({
    queryId,
    runId,
    sourceType: 'assistant_action',
    sourceRefId: input.item.id,
    chatJid,
    agentFolder: agent?.folder || null,
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
    if (output.event) {
      const eventQueryPatch = queryPatchFromTraceEvent(output.event);
      if (Object.keys(eventQueryPatch).length > 0) {
        agentQueryTraceManager.updateQuery(queryId, eventQueryPatch);
      }
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
  addOneShotTraceContext(chatJid, {
    queryId,
    stepId: executionStepId,
    runId,
    traceKey: queryId,
  });
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
        agentName: '桌面个人助手',
        promptSummary,
        lastSender: 'assistant action',
        lastContent: input.item.body || input.item.title,
        lastTime: Date.now().toString(),
        isTask: true,
        dedupeKey: `assistant-action:${input.purpose}:${input.item.id}`,
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
  } finally {
    removeOneShotTraceContext(chatJid, queryId);
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

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`Icarus running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredAgents);
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

        // Deduplicate by agent
        const messagesByAgent = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByAgent.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByAgent.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, agentMessages] of messagesByAgent) {
          const agent = registeredAgents[chatJid];
          if (!agent) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainAgent = agent.isMain === true;

          if (
            await handleAskAnswerCommand({
              chatJid,
              agent,
              channel,
              messages: agentMessages,
            })
          ) {
            continue;
          }

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = agentMessages.find(
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
              queue.closeStdin(chatJid, {
                reason: 'loop_session_command',
                details: { command, messageId: loopCmdMsg.id },
              });
            }
            // Enqueue so processAgentMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainAgent && agent.requiresTrigger !== false;

          // For non-main agents, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = agentMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // --- /clear intercept: handle even when a container is active ---
          const clearMsg = agentMessages.find((m) => {
            const content = m.content
              .trim()
              .replace(TRIGGER_PATTERN, '')
              .trim();
            return content === '/clear';
          });
          if (clearMsg) {
            if (isSessionCommandAllowed(!!clearMsg.is_from_me)) {
              queue.closeStdin(chatJid, {
                reason: 'loop_clear_command',
                details: { messageId: clearMsg.id },
              });
              clearMessages(chatJid);
              if (channel.name === 'web') clearWebMessages(chatJid);
              if (channel.name === 'assistant')
                clearAssistantChatMessages(chatJid);
              resetAgentSession(chatJid, {
                deleteSessionDir: true,
              });
              lastAgentTimestamp[chatJid] =
                agentMessages[agentMessages.length - 1].timestamp;
              saveState();

              if (pendingSessionCleanup.has(agent.folder)) {
                // Container still running — defer .claude/ removal until exit
                await channel.sendMessage(chatJid, '数据清理中，请等待');
                logger.info(
                  { agent: agent.name },
                  '/clear: context reset (active container, deferred cleanup)',
                );
              } else {
                // No active container — safe to delete immediately
                await channel.sendMessage(
                  chatJid,
                  '数据已清理完毕，可正常发送命令啦',
                );
                logger.info(
                  { agent: agent.name },
                  '/clear: context reset (no active container)',
                );
              }
            } else {
              await channel.sendMessage(
                chatJid,
                'Permission denied: only admin can clear context.',
              );
              lastAgentTimestamp[chatJid] =
                agentMessages[agentMessages.length - 1].timestamp;
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
            agent,
            allPending,
          );
          const isDelegationRun =
            isDelegationExecutionContext(loopExecutionContext);
          if (allPending.length === 0) {
            logger.debug(
              {
                chatJid,
                count: agentMessages.length,
                lastAgentTimestamp: lastAgentTimestamp[chatJid] || '',
              },
              'Skipping already-consumed messages for active container',
            );
            continue;
          }
          const messagesToSend = allPending;
          const formatted = formatMessages(messagesToSend, TIMEZONE);
          const runId = activeRunIds.get(chatJid);
          if (isDelegationRun || !runId || !queue.canPipeMessage(chatJid)) {
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          const pipedCursorBefore = lastAgentTimestamp[chatJid] || '';
          const pipedMessageCursor =
            messagesToSend[messagesToSend.length - 1].timestamp;
          const pipedSelection = await selectModel({
            prompt: formatted,
            isMain: isMainAgent,
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
              agentFolder: agent.folder,
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
 * Startup recovery: check for unprocessed messages in registered agents.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, agent] of Object.entries(registeredAgents)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { agent: agent.name, pendingCount: pending.length },
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
  agent: RegisteredAgent,
  _messages: NewMessage[],
): AgentExecutionContext | undefined {
  const pendingDelegations = getDelegationsByTarget(agent.folder).filter(
    (delegation) => delegation.status === 'pending',
  );
  if (pendingDelegations.length !== 1) return undefined;
  return { delegationId: pendingDelegations[0].id };
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  configureFeatureManagementHostHooks({
    reloadRegisteredAgents: reloadRegisteredAgentsFromDb,
    stopFeatureAgents: (agents) => stopFeatureAgentsForDeletion(agents),
  });
  await activateConfiguredFeatures();
  loadState();
  restoreRemoteControl();

  // Load MySQL configs from services.json for proxy
  const servicesJsonPath = path.join(
    process.cwd(),
    'agents',
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
  const internalRunOnceService = new InternalAgentRunOnceService({
    registeredAgents: () => registeredAgents,
    queue,
    addOneShotTraceContext,
    removeOneShotTraceContext,
    onProcess: (agentJid, proc, containerName, agentFolder) =>
      queue.registerProcess(agentJid, proc, containerName, agentFolder),
    maxInputChars: ICARUS_INTERNAL_AGENT_MAX_INPUT_CHARS,
  });
  const internalAgentChatService = new InternalAgentChatService({
    registeredAgents: () => registeredAgents,
    queue,
    onProcess: (agentJid, proc, containerName, agentFolder) =>
      queue.registerProcess(agentJid, proc, containerName, agentFolder),
    maxInputChars: ICARUS_INTERNAL_AGENT_MAX_INPUT_CHARS,
  });
  const internalRunOnceServer = startInternalAgentRunOnceServer({
    host: ICARUS_INTERNAL_API_HOST,
    port: ICARUS_INTERNAL_API_PORT,
    token: ICARUS_INTERNAL_API_TOKEN,
    maxBodyBytes: ICARUS_INTERNAL_API_MAX_BODY_BYTES,
    service: internalRunOnceService,
    chatService: internalAgentChatService,
  });

  const runtimeEventHub = new RuntimeEventHub();
  const taskWorkspaceStore = new TaskWorkspaceStore(
    path.join(STORE_DIR, 'task-workspace.db'),
  );
  let workflowExecutionWorker: WorkflowExecutionWorker | null = null;
  let workflowRuntimeService: WorkflowRuntimeService | null = null;
  let runtimeWorkspaceGateway: RuntimeWorkspaceGateway | null = null;
  let workflowRuntimeStore: ReturnType<
    typeof WorkflowRuntimeConnectionFactory.openStore
  > | null = null;
  let workflowAdapterExecutionStore: WorkflowAdapterExecutionStore | null =
    null;
  if (WORKFLOW_EXECUTION_ENABLED) {
    const runtimeDatabasePath = path.join(STORE_DIR, 'workflow-runtime.db');
    workflowRuntimeStore = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: runtimeDatabasePath,
      databaseMode: fs.existsSync(runtimeDatabasePath)
        ? 'open_existing'
        : 'create',
    });
    ensureTaskWorkspaceCore(workflowRuntimeStore);
    workflowRuntimeService = new WorkflowRuntimeService({
      authority: new WorkflowRuntimeTransactionAuthority(workflowRuntimeStore),
      logger,
      on_commit: () => runtimeEventHub.notify({ reason: 'runtime_service' }),
    });
    runtimeWorkspaceGateway = new RuntimeWorkspaceGateway(
      workflowRuntimeStore,
      crypto.randomBytes(32),
      {
        on_runtime_commit: (hint) => {
          workflowRuntimeService?.wake('workspace_gateway_commit');
          runtimeEventHub.notify({
            workflow_id: hint.workflow_id,
            run_id: hint.run_id,
            reason: 'workspace_gateway_commit',
          });
        },
      },
    );
    workflowAdapterExecutionStore = new WorkflowAdapterExecutionStore(
      path.join(STORE_DIR, 'workflow-adapter-executions.db'),
    );
    const workflowAdapters = new WorkflowExecutionAdapterRegistry();
    const containerAgentJid =
      WORKFLOW_CONTAINER_AGENT_JID || resolveAssistantActionJid() || '';
    workflowAdapters.register(
      new ContainerAgentAdapter({
        service: internalRunOnceService,
        agentJid: containerAgentJid,
        agentExists: (agentJid) => Boolean(registeredAgents[agentJid]),
      }),
    );
    workflowAdapters.register(
      new CodexTaskAdapter({
        binary: WORKFLOW_CODEX_BINARY,
        cwd: WORKFLOW_CODEX_CWD,
        model: WORKFLOW_CODEX_MODEL || undefined,
        sandbox: WORKFLOW_CODEX_SANDBOX,
        approvalPolicy: WORKFLOW_CODEX_APPROVAL_POLICY,
        desktopVisibilityConfirmed: WORKFLOW_CODEX_DESKTOP_VISIBILITY_CONFIRMED,
      }),
    );
    workflowExecutionWorker = new WorkflowExecutionWorker({
      runtimeStore: workflowRuntimeStore,
      executionStore: workflowAdapterExecutionStore,
      registry: workflowAdapters,
      pollIntervalMs: WORKFLOW_EXECUTION_POLL_MS,
      leaseOwner: `icarus-host:${process.pid}`,
      logger,
      onRuntimeCommit: (hint) => {
        workflowRuntimeService?.wake('execution_result_commit');
        runtimeEventHub.notify({
          workflow_id: hint.workflowId,
          run_id: hint.graphRunId,
          reason: 'execution_result_commit',
        });
      },
    });
    await workflowRuntimeService.start();
    await workflowExecutionWorker.start();
    logger.info(
      {
        runtimeDatabasePath,
        adapterExecutionDatabasePath:
          workflowAdapterExecutionStore.databasePath,
        containerAgentJid,
      },
      'Experimental Workflow execution Adapters started',
    );
  }

  const broadcastTaskWorkspaceDelta = (
    delta: TaskWorkspaceTimelineDeltaV1,
  ): void => {
    for (const channel of channels) {
      if (
        channel.name === 'web' &&
        'broadcastTaskWorkspaceTimelineDelta' in channel
      ) {
        (
          channel as typeof channel & {
            broadcastTaskWorkspaceTimelineDelta: (
              value: TaskWorkspaceTimelineDeltaV1,
            ) => void;
          }
        ).broadcastTaskWorkspaceTimelineDelta(delta);
      }
    }
  };
  const taskWorkspaceService = new TaskWorkspaceService({
    store: taskWorkspaceStore,
    runtimeGateway: runtimeWorkspaceGateway,
    runtimeEventHub,
    coordinator: internalAgentChatService,
    coordinatorAgentJid: () => resolveAssistantActionJid(),
    onTimelineDelta: broadcastTaskWorkspaceDelta,
  });
  await taskWorkspaceService.start();
  const taskWorkspaceApi = new TaskWorkspaceWebApi(taskWorkspaceService);

  const collaborationRuntime = new CollaborationRuntime({
    storeDir: STORE_DIR,
    defaultGitSshKeyPath: SSH_KEY_PATH ?? undefined,
    runOnceService: internalRunOnceService,
    workflowHost: workflowRuntimeStore
      ? new WorkflowExecutionHostService(workflowRuntimeStore)
      : null,
    codex: {
      binary: COLLABORATION_CODEX_BINARY,
      cwd: COLLABORATION_CODEX_CWD,
      model: COLLABORATION_CODEX_MODEL || undefined,
      desktopVisibilityConfirmed:
        COLLABORATION_CODEX_DESKTOP_VISIBILITY_CONFIRMED,
    },
    logger,
  });
  collaborationRuntime.start();
  const collaborationApi = new CollaborationWebApi(collaborationRuntime);

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    mysqlProxyServer.close();
    internalRunOnceServer?.close();
    await taskWorkspaceService.stop();
    await collaborationRuntime.stop();
    await workflowRuntimeService?.stop();
    await workflowExecutionWorker?.stop();
    await queue.shutdown(10000);
    workflowAdapterExecutionStore?.close();
    workflowRuntimeStore?.close();
    taskWorkspaceStore.close();
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
    const agent = registeredAgents[chatJid];
    if (!agent?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main agent',
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
    ) => void;
    registeredAgents: () => Record<string, RegisteredAgent>;
    enqueueMessageCheck?: (agentJid: string) => void;
    getAgentStatus?: () => import('./types.js').AgentStatusInfo[];
    getActiveAgentQueryTraces?: () => import('./types.js').ActiveAgentQueryTrace[];
    stopAgent?: (
      agentJid: string,
    ) => Promise<import('./types.js').StopAgentResult>;
    resetSessions?: (scope: {
      all?: boolean;
      agentJid?: string;
    }) => Promise<{ resetCount: number }>;
    registerAgent?: (jid: string, agent: RegisteredAgent) => void;
    collaborationApi?: CollaborationWebApi;
    taskWorkspaceApi?: TaskWorkspaceWebApi;
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
      if (!msg.is_from_me && !msg.is_bot_message && registeredAgents[chatJid]) {
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
    collaborationApi,
    taskWorkspaceApi,
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
    ) => storeChatMetadata(chatJid, timestamp, name, channel),
    registeredAgents: () => registeredAgents,
    enqueueMessageCheck: (jid: string) => queue.enqueueMessageCheck(jid),
    getAgentStatus: () => queue.getActiveAgents(),
    getActiveAgentQueryTraces: () => agentQueryTraceManager.getActiveQueries(),
    stopAgent: (agentJid: string) => queue.stopAgent(agentJid),
    resetSessions: (scope) =>
      resetSessionsForScope({
        all: scope.all,
        agentJid: scope.agentJid,
      }),
    registerAgent,
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
  queue.onOneShotSlotEvent((event) => {
    handleOneShotSlotTraceEvent(event);
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
    registeredAgents: () => registeredAgents,
    getSessions: () => sessions,
    queue,
    onProcess: (agentJid, proc, containerName, agentFolder) =>
      queue.registerProcess(agentJid, proc, containerName, agentFolder),
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
        if (!ch) {
          return Promise.reject(new Error(`No channel for JID: ${jid}`));
        }
        if (!ch.sendCard) {
          return Promise.reject(
            new Error(`Channel ${ch.name} does not support cards for ${jid}`),
          );
        }
        return ch.sendCard(jid, card);
      }
    : undefined;

  // Wire up card actions for channels that support interactive cards.
  const cardActionHandler = createCardActionHandler({
    registeredAgents: () => registeredAgents,
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
    registeredAgents: () => registeredAgents,
    registerAgent,
    getAvailableAgents,
    writeAgentsSnapshot: (gf, im, ag, rj) => {
      // For main agent, filter to same-channel agents only
      let filtered = ag;
      if (im) {
        const mainJid = Object.entries(registeredAgents).find(
          ([, g]) => g.folder === gf,
        )?.[0];
        if (mainJid) {
          const mainCh = findChannel(channels, mainJid);
          if (mainCh) {
            filtered = ag.filter((g) => {
              const targetAgent = registeredAgents[g.jid];
              return (
                mainCh.ownsJid(g.jid) ||
                (targetAgent &&
                  isAllowedCrossChannelDelegationTargetFolder(
                    targetAgent.folder,
                  ))
              );
            });
          }
        }
      }
      writeAgentsSnapshot(gf, im, filtered, rj);
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
      queue.closeStdin(jid, { reason: 'mcp_reload_container' });
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
  const assistantInboxBroadcast = new AssistantInboxBroadcastService({
    registeredAgents: () => registeredAgents,
    sendCard: sendCardFn,
    sendMessage: async (jid, text) => {
      const ch = findChannel(channels, jid);
      if (!ch) return;
      await ch.sendMessage(jid, text);
    },
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
    void assistantInboxBroadcast.handleEvent(event);
  });
  initAssistantAutoFlow({
    agentRunner: async ({ prompt, purpose, item }) =>
      runAssistantActionAgent({
        prompt,
        purpose,
        item,
      }),
  });
  startProactiveEngine();
  queue.setProcessMessagesFn(processAgentMessages);
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
  if (process.env[HOST_CORE_STARTUP_SMOKE_ENV] === '1') {
    process.stdout.write(`${HOST_CORE_STARTUP_SMOKE_MARKER}\n`, () =>
      process.exit(0),
    );
  } else {
    main().catch((err) => {
      logger.error({ err }, 'Failed to start Icarus');
      process.exit(1);
    });
  }
}

/** @internal - exported for testing */
export async function _runAgentForTest(input: {
  agent: RegisteredAgent;
  prompt?: string;
  chatJid?: string;
  onOutput?: (output: ContainerOutput) => Promise<void>;
  executionContext?: AgentExecutionContext;
  isolatedSession?: boolean;
}): Promise<'success' | 'error'> {
  return runAgent(
    input.agent,
    input.prompt || 'test prompt',
    input.chatJid || 'web:test',
    input.onOutput,
    'test-model',
    'test-run',
    'test-query',
    input.executionContext,
    undefined,
    input.isolatedSession,
  );
}
