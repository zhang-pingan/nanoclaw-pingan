/**
 * Workflow Engine for NanoClaw — Configuration-Driven
 *
 * State machine definitions live in container/workflow-definitions/*.json.
 * Card templates live in container/cards/*.json.
 * This engine reads them at init and drives transitions generically.
 *
 * Role resolution (no hardcoded group names):
 *   1. skills.json "workflow_roles" explicit mapping (if present)
 *   2. Infer from skill assignments using each workflow type's roles[].skill_to_role_key
 *   3. If any role is missing for all types → workflow is disabled
 */
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

import { buildInteractiveCard } from './card-builder.js';
import { PROJECT_ROOT } from './config.js';
import {
  closePendingWorkflowInterrupts,
  createDelegation,
  createWorkflowCheckpoint,
  createWorkflowEvent,
  createWorkflowInterrupt,
  createWorkflowInterruptResumeAttempt,
  createWorkflowOutbox,
  createWorkflowStageEvaluation,
  createWorkflow as dbCreateWorkflow,
  getAllActiveWorkflows,
  getAllWorkflows,
  getDelegation,
  getLatestWorkflowCheckpoint,
  getWorkflowEventByIdempotencyKey,
  getPendingWorkflowInterruptForState,
  getWorkflow,
  getWorkflowByDelegation,
  getWorkflowInterrupt,
  getWorkflowInterruptByIdempotencyKey,
  getWorkflowInterruptResumeAttemptByIdempotency,
  listExpiredPendingWorkflowInterrupts,
  listWorkflowInterruptsByWorkflow,
  listRunnableWorkflowOutbox,
  markWorkflowInterruptExpired,
  listPendingWorkflowInterruptsByWorkflow,
  markWorkflowOutboxFailed,
  markWorkflowOutboxProcessing,
  markWorkflowOutboxSucceeded,
  markWorkflowInterruptResumed,
  runWorkflowTransaction,
  storeChatMetadata,
  storeMessageDirect,
  updateWorkflow,
} from './db.js';
import { logger } from './logger.js';
import {
  CardButton,
  CardSection,
  InteractiveCard,
  RegisteredGroup,
  Workflow,
  WorkflowInterruptActorChannel,
  WorkflowInterruptKind,
  WorkflowInterruptRecord,
  WorkflowStageEvalResult,
} from './types.js';
import {
  getCardConfig,
  getWorkflowConfigError,
  getWorkflowConfigs,
  getWorkflowTypeConfig,
  loadWorkflowConfigs,
  renderTemplate,
  StateTransition,
  TemplateVars,
  WorkflowTypeConfig,
} from './workflow-config.js';
import {
  WorkflowCreateForm,
  WorkflowDefinitionTransition,
} from './workflow-definition.js';
import { getDeliverableFileNameForRole } from './workflow-artifacts.js';
import {
  createWorkbenchManualSkipEvent,
  syncWorkbenchOnDelegationCompleted,
  syncWorkbenchOnDelegationCreated,
  syncWorkbenchOnStageEvaluated,
  syncWorkbenchOnStageEvaluationActionNeeded,
  syncWorkbenchOnTransition,
  syncWorkbenchOnWorkflowCreated,
  syncWorkbenchOnWorkflowUpdated,
} from './workbench-store.js';
import {
  buildWorkflowStageEvaluationRecord,
  evaluateWorkflowStage,
} from './workflow-stage-evaluation.js';
import { evaluateWorkflowArtifactContract } from './workflow-artifact-contract.js';
import { getWorkflowEvaluatorConfig } from './workflow-evaluator-registry.js';
import {
  getWorkflowContextValue,
  mergeWorkflowContext,
  WORKFLOW_CONTEXT_KEYS,
  WorkflowContext,
} from './workflow-context.js';

interface DeliverableMetadata {
  fileName: string;
  files: string[];
  main_branch: string;
  work_branch: string;
  staging_base_branch: string;
  staging_work_branch: string;
}

interface ParsedDelegationPayload {
  summary?: string;
  deliverable?: string;
  main_branch?: string;
  work_branch?: string;
  staging_base_branch?: string;
  staging_work_branch?: string;
  access_token?: string;
  test_doc?: string;
  total?: number;
  passed?: number;
  failed?: number;
  blocked?: number;
  bugs?: Array<{
    id: string;
    title?: string;
    severity?: string;
    related_case?: string;
  }>;
}

interface WorkflowCheckpointPayload {
  workflowId: string;
  workflowType: string;
  stateKey: string;
  round: number;
  context: Record<string, unknown>;
  currentDelegationId: string | null;
  pendingInterruptId: string | null;
  attempts: Record<string, number>;
  updatedAt: string;
}

interface ResumeActor {
  channel: WorkflowInterruptActorChannel;
  userId?: string;
  displayName?: string;
}

type JsonSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  minLength?: number;
  maxLength?: number;
  enum?: unknown[];
};

type WorkflowOutboxEffectType =
  | 'send_notification'
  | 'send_feishu_card'
  | 'refresh_feishu_card'
  | 'sync_workbench_action_item'
  | 'sync_assistant_inbox'
  | 'inject_delegation_message'
  | 'index_artifact';

interface DelegationIntent {
  delegationId: string;
  targetFolder: string;
  sourceFolder: string;
  targetJid: string;
  skillName: string;
  taskContent: string;
}

let workflowRuntimeStarted = false;
let workflowWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let workflowOutboxTimer: ReturnType<typeof setInterval> | null = null;
let processingWorkflowOutbox = false;

const WORKFLOW_WATCHDOG_INTERVAL_MS = 15_000;
const WORKFLOW_OUTBOX_INTERVAL_MS = 2_000;

// -------------------------------------------------------
// Role resolution — per trigger channel
// -------------------------------------------------------

/** 从 folder 名提取渠道前缀，如 "feishu_main" → "feishu" */
function getChannelFromFolder(folder: string): string {
  return folder.split('_')[0];
}

/**
 * 根据流程类型和触发群组的 sourceJid 解析所有角色的 folder 映射。
 * 渠道从触发群组的 folder 名前缀提取，然后查找对应渠道的 folder 配置。
 */
function resolveRoles(
  workflowType: string,
  sourceJid: string,
): { roles: Record<string, string> } | { error: string } {
  const config = getWorkflowTypeConfig(workflowType);
  if (!config) return { error: `未知的流程类型: ${workflowType}` };

  const groups = getDeps().registeredGroups();
  const sourceGroup = groups[sourceJid];
  const channel = sourceGroup ? getChannelFromFolder(sourceGroup.folder) : '';

  const roles: Record<string, string> = {};
  const missing: string[] = [];

  for (const [roleName, roleConfig] of Object.entries(config.roles)) {
    const folder = roleConfig.channels[channel];
    if (folder) {
      roles[roleName] = folder;
    } else {
      const available = Object.keys(roleConfig.channels).join(', ');
      missing.push(
        `${roleName}（渠道 "${channel}" 未配置，已有: ${available || '无'}）`,
      );
    }
  }

  if (missing.length > 0) {
    return {
      error:
        `渠道 "${channel}" 缺少角色配置：${missing.join('；')}。` +
        `请在 container/workflow-definitions/<workflow>.json 的对应角色 channels 中添加 "${channel}" 渠道。`,
    };
  }

  return { roles };
}

// -------------------------------------------------------
// Dependencies
// -------------------------------------------------------

export interface WorkflowDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  enqueueMessageCheck: (groupJid: string) => void;
  sendCard?: (
    jid: string,
    card: InteractiveCard,
  ) => Promise<string | undefined>;
}

let deps: WorkflowDeps | null = null;

export function initWorkflow(d: WorkflowDeps): void {
  deps = d;
  const configs = loadWorkflowConfigs();
  if (!configs) return;
  resumeWorkflowRuntime();
}

function getDeps(): WorkflowDeps {
  if (!deps) throw new Error('Workflow not initialized — call initWorkflow()');
  return deps;
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

/** Find the JID for a given group folder name. */
function findJidByFolder(
  folder: string,
  groups: Record<string, RegisteredGroup>,
): string | undefined {
  for (const [jid, g] of Object.entries(groups)) {
    if (g.folder === folder) return jid;
  }
  return undefined;
}

/** Find the main group's JID, optionally scoped to the same channel as sourceJid. */
function findMainJid(
  groups: Record<string, RegisteredGroup>,
  sourceJid?: string,
): string | undefined {
  // If sourceJid is provided, find the main group in the same channel
  if (sourceJid) {
    const sourceGroup = groups[sourceJid];
    if (sourceGroup) {
      const channel = getChannelFromFolder(sourceGroup.folder);
      for (const [jid, g] of Object.entries(groups)) {
        if (g.isMain && getChannelFromFolder(g.folder) === channel) return jid;
      }
    }
  }
  // Fallback: return the first main group found
  for (const [jid, g] of Object.entries(groups)) {
    if (g.isMain) return jid;
  }
  return undefined;
}

/** Get the main group's folder name, optionally scoped to a channel via sourceJid. */
function getMainFolder(sourceJid?: string): string {
  const groups = getDeps().registeredGroups();
  if (sourceJid) {
    const sourceGroup = groups[sourceJid];
    if (sourceGroup) {
      const channel = getChannelFromFolder(sourceGroup.folder);
      const match = Object.values(groups).find(
        (g) => g.isMain && getChannelFromFolder(g.folder) === channel,
      );
      if (match) return match.folder;
    }
  }
  return Object.values(groups).find((g) => g.isMain)?.folder || '';
}

/** Inject a message into a group's chat to trigger the agent. */
function injectDelegation(
  targetJid: string,
  targetGroup: RegisteredGroup,
  delegationId: string,
  workflowId: string,
  skillName: string,
  taskContent: string,
): void {
  const { enqueueMessageCheck } = getDeps();
  const now = Date.now().toString();

  storeChatMetadata(targetJid, now);

  const syntheticContent = `${targetGroup.trigger} [委派任务 | ID:${delegationId} | 来自:流程引擎 | 流程:${workflowId}]\n\n请按照 ${skillName} 技能执行以下任务：\n\n${taskContent}\n\n完成后请调用 complete_delegation 工具报告结果，delegation_id 为 "${delegationId}"。`;
  const syntheticId = `wf-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  storeMessageDirect({
    id: syntheticId,
    chat_jid: targetJid,
    sender: 'system',
    sender_name: '流程引擎委派',
    content: syntheticContent,
    timestamp: now,
    is_from_me: true,
    is_bot_message: false,
    workflow_id: workflowId,
  });

  enqueueMessageCheck(targetJid);
}

/** Send a progress message to the main group (scoped to the same channel as sourceJid when provided). */
function notifyMain(
  message: string,
  sourceJid?: string,
  workflowId?: string,
): void {
  const groups = getDeps().registeredGroups();
  const mainJid = findMainJid(groups, sourceJid);
  if (!mainJid) {
    logger.warn('Workflow: cannot notify main — main group not found');
    return;
  }

  const now = Date.now().toString();
  const msgId = `wf-notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  storeMessageDirect({
    id: msgId,
    chat_jid: mainJid,
    sender: 'system',
    sender_name: '流程引擎',
    content: message,
    timestamp: now,
    is_from_me: true,
    is_bot_message: false,
    workflow_id: workflowId,
  });

  getDeps().enqueueMessageCheck(mainJid);
}

function notifyGroupFolder(
  folder: string,
  senderName: string,
  message: string,
  workflowId?: string,
): void {
  const groups = getDeps().registeredGroups();
  const targetJid = findJidByFolder(folder, groups);
  if (!targetJid) {
    logger.warn({ folder }, 'Cannot notify group folder: target JID not found');
    return;
  }
  const now = Date.now().toString();
  const msgId = `mem-conflict-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  storeChatMetadata(targetJid, now);
  storeMessageDirect({
    id: msgId,
    chat_jid: targetJid,
    sender: 'system',
    sender_name: senderName,
    content: message,
    timestamp: now,
    is_from_me: true,
    is_bot_message: false,
    workflow_id: workflowId,
  });
  getDeps().enqueueMessageCheck(targetJid);
}

/** Create a delegation record and inject it into the target group. */
function delegateTo(
  targetFolder: string,
  sourceFolder: string,
  workflowId: string,
  skillName: string,
  taskContent: string,
): string {
  const groups = getDeps().registeredGroups();
  const targetJid = findJidByFolder(targetFolder, groups);
  if (!targetJid) {
    throw new Error(
      `Workflow: target group folder "${targetFolder}" not found`,
    );
  }
  const targetGroup = groups[targetJid];

  const sourceJid = findJidByFolder(sourceFolder, groups) || '';
  const delegationId = `wf-del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now().toString();

  createDelegation({
    id: delegationId,
    source_jid: sourceJid,
    source_folder: sourceFolder,
    target_jid: targetJid,
    target_folder: targetFolder,
    task: taskContent,
    status: 'pending',
    result: null,
    outcome: null,
    workflow_id: workflowId,
    created_at: now,
    updated_at: now,
  });

  injectDelegation(
    targetJid,
    targetGroup,
    delegationId,
    workflowId,
    skillName,
    taskContent,
  );

  return delegationId;
}

function createDurableDelegationIntent(input: {
  workflowId: string;
  sourceJid: string;
  targetFolder: string;
  sourceFolder: string;
  skillName: string;
  taskContent: string;
  idempotencyKey: string;
}): DelegationIntent {
  const groups = getDeps().registeredGroups();
  const targetJid = findJidByFolder(input.targetFolder, groups);
  if (!targetJid) {
    throw new Error(
      `Workflow: target group folder "${input.targetFolder}" not found`,
    );
  }
  const sourceJid = findJidByFolder(input.sourceFolder, groups) || '';
  const delegationId = `wf-del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now().toString();

  createDelegation({
    id: delegationId,
    source_jid: sourceJid,
    source_folder: input.sourceFolder,
    target_jid: targetJid,
    target_folder: input.targetFolder,
    task: input.taskContent,
    status: 'pending',
    result: null,
    outcome: null,
    workflow_id: input.workflowId,
    created_at: now,
    updated_at: now,
  });

  enqueueWorkflowOutbox({
    workflowId: input.workflowId,
    effectType: 'inject_delegation_message',
    channel: null,
    payload: {
      delegationId,
      targetJid,
      targetFolder: input.targetFolder,
      skillName: input.skillName,
      taskContent: input.taskContent,
    },
    idempotencyKey: `workflow_outbox:inject_delegation:${input.idempotencyKey}`,
  });

  return {
    delegationId,
    targetFolder: input.targetFolder,
    sourceFolder: input.sourceFolder,
    targetJid,
    skillName: input.skillName,
    taskContent: input.taskContent,
  };
}

function enqueueWorkflowOutbox(input: {
  workflowId: string;
  eventId?: string | null;
  effectType: WorkflowOutboxEffectType;
  channel?: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  nextAttemptAt?: string | null;
}): void {
  const now = new Date().toISOString();
  createWorkflowOutbox({
    id: `wf-outbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    workflow_id: input.workflowId,
    event_id: input.eventId || null,
    effect_type: input.effectType,
    channel: input.channel ?? null,
    status: 'pending',
    payload_json: JSON.stringify(input.payload),
    idempotency_key: input.idempotencyKey,
    attempts: 0,
    next_attempt_at: input.nextAttemptAt || null,
    last_error: null,
    created_at: now,
    updated_at: now,
  });
}

function enqueueWorkflowNotification(
  workflow: Workflow,
  message: string,
  keySuffix: string,
): void {
  enqueueWorkflowOutbox({
    workflowId: workflow.id,
    effectType: 'send_notification',
    channel: 'main_group',
    payload: {
      message,
      sourceJid: workflow.source_jid,
    },
    idempotencyKey: `workflow_outbox:notification:${workflow.id}:${keySuffix}`,
  });
}

function enqueueWorkflowWorkbenchSync(
  workflowId: string,
  effect: string,
  payload: Record<string, unknown>,
  keySuffix: string,
): void {
  enqueueWorkflowOutbox({
    workflowId,
    effectType: 'sync_workbench_action_item',
    channel: 'workbench',
    payload: {
      effect,
      ...payload,
    },
    idempotencyKey: `workflow_outbox:workbench:${workflowId}:${keySuffix}`,
  });
}

function enqueueWorkflowCard(
  workflow: Workflow,
  cardKey: string,
  keySuffix: string,
): void {
  enqueueWorkflowOutbox({
    workflowId: workflow.id,
    effectType: 'send_feishu_card',
    channel: 'feishu',
    payload: {
      cardKey,
      sourceJid: workflow.source_jid,
    },
    idempotencyKey: `workflow_outbox:card:${workflow.id}:${cardKey}:${keySuffix}`,
  });
}

function parseOutboxPayload(
  payloadJson: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function compileDefinitionTransitionToStateTransition(
  transition: WorkflowDefinitionTransition | StateTransition,
): StateTransition {
  if (typeof transition.notify === 'string' || 'role' in transition) {
    return transition as StateTransition;
  }
  const definitionTransition = transition as WorkflowDefinitionTransition;
  return {
    target: definitionTransition.target,
    role: definitionTransition.delegate?.role,
    skill: definitionTransition.delegate?.skill,
    task_template: definitionTransition.delegate?.task_template,
    increment_round: definitionTransition.effects?.increment_round,
    notify: definitionTransition.notify?.template,
    card: definitionTransition.card?.ref,
  };
}

function executeWorkflowOutboxRecord(recordId: string): void {
  const now = new Date().toISOString();
  const record = markWorkflowOutboxProcessing({
    id: recordId,
    updatedAt: now,
  });
  if (!record) return;

  try {
    const payload = parseOutboxPayload(record.payload_json);
    if (record.effect_type === 'send_notification') {
      const message = typeof payload.message === 'string' ? payload.message : '';
      if (message) {
        notifyMain(
          message,
          typeof payload.sourceJid === 'string' ? payload.sourceJid : undefined,
          record.workflow_id,
        );
      }
    } else if (record.effect_type === 'send_feishu_card') {
      const workflow = getWorkflow(record.workflow_id);
      const cardKey =
        typeof payload.cardKey === 'string' ? payload.cardKey : '';
      if (workflow && cardKey) sendConfigCard(workflow, cardKey);
    } else if (record.effect_type === 'inject_delegation_message') {
      const workflow = getWorkflow(record.workflow_id);
      const targetJid =
        typeof payload.targetJid === 'string' ? payload.targetJid : '';
      const delegationId =
        typeof payload.delegationId === 'string' ? payload.delegationId : '';
      const skillName =
        typeof payload.skillName === 'string' ? payload.skillName : '';
      const taskContent =
        typeof payload.taskContent === 'string' ? payload.taskContent : '';
      const targetGroup = targetJid
        ? getDeps().registeredGroups()[targetJid]
        : undefined;
      if (workflow && targetJid && targetGroup && delegationId && skillName) {
        injectDelegation(
          targetJid,
          targetGroup,
          delegationId,
          workflow.id,
          skillName,
          taskContent,
        );
      }
    } else if (record.effect_type === 'sync_workbench_action_item') {
      const effect = typeof payload.effect === 'string' ? payload.effect : '';
      if (effect === 'workflow_updated') {
        syncWorkbenchOnWorkflowUpdated(
          record.workflow_id,
          typeof payload.resultSummary === 'string'
            ? payload.resultSummary
            : undefined,
          { emitRealtime: false },
        );
      } else if (effect === 'transition') {
        syncWorkbenchOnTransition(
          record.workflow_id,
          String(payload.fromStatus || ''),
          String(payload.toStatus || ''),
          typeof payload.delegationId === 'string'
            ? payload.delegationId
            : undefined,
        );
      } else if (effect === 'delegation_created') {
        const delegationId =
          typeof payload.delegationId === 'string' ? payload.delegationId : '';
        if (delegationId) {
          syncWorkbenchOnDelegationCreated(record.workflow_id, delegationId);
        }
      }
    }
    markWorkflowOutboxSucceeded({
      id: record.id,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const attempts = record.attempts || 1;
    const deadLetter = attempts >= 5;
    const retryMs = Math.min(60_000, 2 ** attempts * 1_000);
    markWorkflowOutboxFailed({
      id: record.id,
      updatedAt: new Date().toISOString(),
      nextAttemptAt: deadLetter
        ? null
        : new Date(Date.now() + retryMs).toISOString(),
      lastError: err instanceof Error ? err.message : String(err),
      deadLetter,
    });
  }
}

export function processWorkflowOutbox(limit = 50): void {
  if (processingWorkflowOutbox) return;
  processingWorkflowOutbox = true;
  try {
    const due = listRunnableWorkflowOutbox(new Date().toISOString(), limit);
    for (const record of due) {
      executeWorkflowOutboxRecord(record.id);
    }
  } finally {
    processingWorkflowOutbox = false;
  }
}

function validateActiveWorkflowGate(): void {
  const activeWorkflows = getAllActiveWorkflows();
  const invalid: string[] = [];
  for (const workflow of activeWorkflows) {
    const config = getWorkflowTypeConfig(workflow.workflow_type);
    const state = config?.states[workflow.status];
    if (!config) {
      invalid.push(`${workflow.id}: unknown workflow_type ${workflow.workflow_type}`);
      continue;
    }
    if (workflow.status !== 'paused' && !state) {
      invalid.push(`${workflow.id}: unknown state ${workflow.status}`);
    }
    if ((state as { type?: string } | undefined)?.type === 'confirmation') {
      invalid.push(`${workflow.id}: legacy confirmation state ${workflow.status}`);
    }
  }
  if (invalid.length > 0) {
    throw new Error(
      `Active workflow migration gate failed: ${invalid.join('; ')}. Please terminate or migrate these workflows before startup.`,
    );
  }
}

function recoverActiveWorkflow(workflow: Workflow): void {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return;
  if (workflow.status === 'paused') {
    writeWorkflowCheckpoint({ workflow });
    return;
  }

  const state = config.states[workflow.status];
  if (state?.type === 'interrupt') {
    createPendingInterruptForState(workflow);
    enqueueWorkflowWorkbenchSync(
      workflow.id,
      'workflow_updated',
      { resultSummary: null },
      `recovery:${workflow.status}:${workflow.round}`,
    );
  } else if (state?.type === 'terminal') {
    closePendingWorkflowInterrupts(
      workflow.id,
      'cancelled',
      new Date().toISOString(),
    );
    writeWorkflowCheckpoint({ workflow });
  } else {
    writeWorkflowCheckpoint({ workflow });
  }
}

function stateEnteredAt(workflow: Workflow): number {
  const latest = getLatestWorkflowCheckpoint(workflow.id);
  if (latest?.state_key === workflow.status) {
    const checkpointTime = Date.parse(latest.created_at);
    if (Number.isFinite(checkpointTime)) return checkpointTime;
  }
  const updatedAt = Number(workflow.updated_at);
  if (Number.isFinite(updatedAt)) return updatedAt;
  const parsedUpdatedAt = Date.parse(workflow.updated_at);
  if (Number.isFinite(parsedUpdatedAt)) return parsedUpdatedAt;
  const createdAt = Number(workflow.created_at);
  if (Number.isFinite(createdAt)) return createdAt;
  const parsedCreatedAt = Date.parse(workflow.created_at);
  return Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : Date.now();
}

function processTimedOutActiveWorkflow(
  workflow: Workflow,
  nowIso: string,
): void {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const state = config?.states[workflow.status];
  if (!state?.timeout_policy?.duration_ms) return;
  if (state.type === 'interrupt') return;
  const elapsedMs = Date.parse(nowIso) - stateEnteredAt(workflow);
  if (!Number.isFinite(elapsedMs) || elapsedMs < state.timeout_policy.duration_ms) {
    return;
  }

  const attempts = parseCheckpointAttempts(workflow.id);
  const attempt = attempts[workflow.status] || 1;
  const idempotencyKey = `workflow_timeout:${workflow.id}:${workflow.status}:${workflow.round}:${attempt}`;
  if (getWorkflowEventByIdempotencyKey(idempotencyKey)) return;

  writeWorkflowEvent({
    workflowId: workflow.id,
    eventType: 'timeout_fired',
    stateKey: workflow.status,
    payload: {
      timeout_policy: state.timeout_policy,
      attempt,
    },
    idempotencyKey,
    createdAt: nowIso,
  });

  applyTransition(
    workflow,
    compileDefinitionTransitionToStateTransition(state.timeout_policy.on_timeout),
    resolveRolesOrEmpty(workflow),
    {
      workflowUpdates: {
        context: {
          last_state_timeout: {
            state_key: workflow.status,
            fired_at: nowIso,
            attempt,
          },
        },
      },
    },
  );
}

export function resumeWorkflowRuntime(): void {
  validateActiveWorkflowGate();
  for (const workflow of getAllActiveWorkflows()) {
    recoverActiveWorkflow(workflow);
  }
  processWorkflowOutbox();
  if (!workflowRuntimeStarted) {
    workflowWatchdogTimer = setInterval(
      runWorkflowWatchdogOnce,
      WORKFLOW_WATCHDOG_INTERVAL_MS,
    );
    workflowWatchdogTimer.unref?.();
    workflowOutboxTimer = setInterval(
      () => processWorkflowOutbox(),
      WORKFLOW_OUTBOX_INTERVAL_MS,
    );
    workflowOutboxTimer.unref?.();
    workflowRuntimeStarted = true;
  }
}

export function stopWorkflowRuntimeForTest(): void {
  if (workflowWatchdogTimer) clearInterval(workflowWatchdogTimer);
  if (workflowOutboxTimer) clearInterval(workflowOutboxTimer);
  workflowWatchdogTimer = null;
  workflowOutboxTimer = null;
  workflowRuntimeStarted = false;
}

export function runWorkflowWatchdogOnce(nowIso = new Date().toISOString()): void {
  const expiredInterrupts = listExpiredPendingWorkflowInterrupts(nowIso);
  for (const interrupt of expiredInterrupts) {
    try {
      runWorkflowTransaction(() => {
        const latestInterrupt = getWorkflowInterrupt(interrupt.id);
        if (!latestInterrupt || latestInterrupt.status !== 'pending') return;
        const workflow = getWorkflow(latestInterrupt.workflow_id);
        if (!workflow || workflow.status !== latestInterrupt.state_key) return;
        const config = getWorkflowTypeConfig(workflow.workflow_type);
        const state = config?.states[latestInterrupt.state_key];
        if (!state || state.type !== 'interrupt') return;

        const marked = markWorkflowInterruptExpired({
          interruptId: latestInterrupt.id,
          updatedAt: nowIso,
        });
        if (!marked) return;

        writeWorkflowEvent({
          workflowId: workflow.id,
          eventType: 'interrupt_expired',
          stateKey: latestInterrupt.state_key,
          refType: 'workflow_interrupt',
          refId: latestInterrupt.id,
          payload: {
            interrupt_id: latestInterrupt.id,
            expires_at: latestInterrupt.expires_at,
          },
          idempotencyKey: `workflow_interrupt_expired:${latestInterrupt.id}`,
          createdAt: nowIso,
        });

        const definitionTransition =
          state.on_expire || state.timeout_policy?.on_timeout;
        if (definitionTransition) {
          writeWorkflowEvent({
            workflowId: workflow.id,
            eventType: 'timeout_fired',
            stateKey: latestInterrupt.state_key,
            payload: {
              timeout_policy: state.timeout_policy || null,
              attempt: parseCheckpointAttempts(workflow.id)[workflow.status] || 1,
            },
            idempotencyKey: `workflow_timeout:${workflow.id}:${workflow.status}:${workflow.round}:${
              parseCheckpointAttempts(workflow.id)[workflow.status] || 1
            }`,
            createdAt: nowIso,
          });
          applyTransition(
            workflow,
            compileDefinitionTransitionToStateTransition(definitionTransition),
            resolveRolesOrEmpty(workflow),
            {
              workflowUpdates: {
                context: {
                  last_interrupt_expired: {
                    interrupt_id: latestInterrupt.id,
                    state_key: latestInterrupt.state_key,
                    expired_at: nowIso,
                  },
                },
              },
            },
          );
        } else {
          writeWorkflowCheckpoint({
            workflow,
            pendingInterruptId: null,
          });
        }
      });
    } catch (err) {
      logger.error(
        { err, interruptId: interrupt.id },
        'Workflow watchdog failed to process expired interrupt',
      );
    }
  }
  for (const workflow of getAllActiveWorkflows()) {
    try {
      runWorkflowTransaction(() => {
        const latest = getWorkflow(workflow.id);
        if (!latest || isTerminalStatus(latest)) return;
        processTimedOutActiveWorkflow(latest, nowIso);
      });
    } catch (err) {
      logger.error(
        { err, workflowId: workflow.id },
        'Workflow watchdog failed to process active workflow timeout',
      );
    }
  }
  processWorkflowOutbox();
}

function readFrontMatter(content: string): Record<string, unknown> | null {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;
  const frontMatter = content.slice(4, end);
  try {
    const parsed = YAML.parse(frontMatter);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readMetadataFromFile(filePath: string): Partial<DeliverableMetadata> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const metadata = readFrontMatter(content);
  if (!metadata) return {};

  return {
    main_branch:
      typeof metadata.main_branch === 'string'
        ? metadata.main_branch.trim()
        : '',
    work_branch:
      typeof metadata.work_branch === 'string'
        ? metadata.work_branch.trim()
        : '',
    staging_base_branch:
      typeof metadata.staging_base_branch === 'string'
        ? metadata.staging_base_branch.trim()
        : '',
    staging_work_branch:
      typeof metadata.staging_work_branch === 'string'
        ? metadata.staging_work_branch.trim()
        : '',
  };
}

/** Read a specific deliverable directory and return its metadata. */
function readDeliverableDir(
  service: string,
  dirName: string,
): DeliverableMetadata | null {
  const delivDir = path.join(
    PROJECT_ROOT,
    'projects',
    service,
    'iteration',
    dirName,
  );
  if (!fs.existsSync(delivDir)) return null;

  const files = fs.readdirSync(delivDir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) return null;

  const metadata: DeliverableMetadata = {
    fileName: dirName,
    files,
    main_branch: '',
    work_branch: '',
    staging_base_branch: '',
    staging_work_branch: '',
  };

  for (const file of files) {
    const parsed = readMetadataFromFile(path.join(delivDir, file));
    metadata.main_branch ||= parsed.main_branch || '';
    metadata.work_branch ||= parsed.work_branch || '';
    metadata.staging_base_branch ||= parsed.staging_base_branch || '';
    metadata.staging_work_branch ||= parsed.staging_work_branch || '';
  }

  return metadata;
}

function buildDocPath(
  workflow: Pick<Workflow, 'service' | 'context'>,
  fileName: string,
): string {
  const deliverable = getWorkflowContextValue(
    workflow,
    WORKFLOW_CONTEXT_KEYS.deliverable,
  );
  return `/workspace/projects/${workflow.service}/iteration/${deliverable}/${fileName}`;
}

function parseDelegationPayload(
  result: string | null | undefined,
): ParsedDelegationPayload {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as ParsedDelegationPayload;
  } catch {
    return {};
  }
}

/** Get terminal state names from a workflow type config. */
function getTerminalStates(config: WorkflowTypeConfig): string[] {
  return Object.entries(config.states)
    .filter(([, s]) => s.type === 'terminal')
    .map(([name]) => name);
}

/** Get interrupt state names from a workflow type config. */
function getInterruptStates(config: WorkflowTypeConfig): string[] {
  return Object.entries(config.states)
    .filter(([, s]) => s.type === 'interrupt')
    .map(([name]) => name);
}

/** Get the status label for a workflow. */
function getStatusLabel(workflow: Workflow): string {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return workflow.status;
  return config.status_labels[workflow.status] || workflow.status;
}

function formatContextTemplateValue(
  value: unknown,
): string | number | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const items = value
      .filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      )
      .map((item) => `- ${item}`);
    return items.join('\n') || undefined;
  }
  return undefined;
}

function buildContextTemplateVars(context: WorkflowContext): TemplateVars {
  return Object.fromEntries(
    Object.entries(context)
      .map(([key, value]) => [key, formatContextTemplateValue(value)] as const)
      .filter(([, value]) => value !== undefined),
  ) as TemplateVars;
}

/** Build template vars from a workflow + optional delegation result. */
function buildTemplateVars(
  workflow: Workflow,
  extra?: {
    delegationResult?: string;
    resultSummary?: string;
    revisionText?: string;
    testDoc?: string;
  },
): TemplateVars {
  return {
    ...buildContextTemplateVars(workflow.context),
    name: workflow.name,
    workflow_type: workflow.workflow_type,
    service: workflow.service,
    main_branch: getWorkflowContextValue(
      workflow,
      WORKFLOW_CONTEXT_KEYS.mainBranch,
    ),
    work_branch: getWorkflowContextValue(
      workflow,
      WORKFLOW_CONTEXT_KEYS.workBranch,
    ),
    id: workflow.id,
    round: workflow.round,
    deliverable:
      getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.deliverable) ||
      'N/A',
    staging_base_branch: getWorkflowContextValue(
      workflow,
      WORKFLOW_CONTEXT_KEYS.stagingBaseBranch,
    ),
    staging_work_branch: getWorkflowContextValue(
      workflow,
      WORKFLOW_CONTEXT_KEYS.stagingWorkBranch,
    ),
    access_token: getWorkflowContextValue(
      workflow,
      WORKFLOW_CONTEXT_KEYS.accessToken,
    ),
    requirement_description:
      getWorkflowContextValue(
        workflow,
        WORKFLOW_CONTEXT_KEYS.requirementDescription,
      ) || workflow.name,
    requirement_files: Array.isArray(
      workflow.context[WORKFLOW_CONTEXT_KEYS.requirementFiles],
    )
      ? (workflow.context[WORKFLOW_CONTEXT_KEYS.requirementFiles] as unknown[])
          .filter(
            (item): item is string =>
              typeof item === 'string' && item.trim().length > 0,
          )
          .map((item) => `- ${item}`)
          .join('\n') || '无'
      : '无',
    plan_doc: buildDocPath(workflow, getDeliverableFileNameForRole('planner')),
    dev_doc: buildDocPath(workflow, getDeliverableFileNameForRole('dev')),
    test_doc:
      extra?.testDoc ||
      buildDocPath(workflow, getDeliverableFileNameForRole('test')),
    delegation_result: extra?.delegationResult || '',
    result_summary: extra?.resultSummary || '',
    revision_text: extra?.revisionText || '',
  };
}

function finalizeDelegationTaskContent(
  skill: string,
  taskContent: string,
  workflow: Workflow,
  extra?: {
    testDoc?: string;
  },
): string {
  if (skill === 'dev-bugfix') {
    const testDoc =
      extra?.testDoc ||
      buildDocPath(workflow, getDeliverableFileNameForRole('test'));
    const testDocLine = `测试文档：${testDoc}`;
    const hasTestDocLine = taskContent.includes('测试文档：');
    let finalContent = hasTestDocLine
      ? taskContent
      : `${taskContent}\n${testDocLine}`;

    const workBranch = getWorkflowContextValue(
      workflow,
      WORKFLOW_CONTEXT_KEYS.workBranch,
    );
    if (!workBranch) {
      const warning = [
        '[分支缺失警告]',
        '当前 workflow 未记录明确的工作分支。',
        '请先从以下交付文档确认工作分支后再修复：',
        buildDocPath(workflow, getDeliverableFileNameForRole('dev')),
        '本轮修复记录应更新到以下测试文档：',
        testDoc,
        '若仍无法确定，请不要猜测或直接在主干分支修改；请停止修改并反馈失败原因。',
      ].join('\n');
      return finalContent ? `${finalContent}\n\n${warning}` : warning;
    }

    return finalContent;
  }

  const stagingWorkBranch = getWorkflowContextValue(
    workflow,
    WORKFLOW_CONTEXT_KEYS.stagingWorkBranch,
  );
  if (skill !== 'ops-staging-deploy' || !stagingWorkBranch) {
    return taskContent;
  }

  if (taskContent.includes('预发工作分支：')) {
    return taskContent;
  }
  const suffix = `预发工作分支：${stagingWorkBranch}`;
  return taskContent ? `${taskContent}\n${suffix}` : suffix;
}

function appendRetryNote(taskContent: string, retryNote?: string): string {
  const trimmedRetryNote = retryNote?.trim();
  if (!trimmedRetryNote) return taskContent;

  const retrySection = [
    '[重跑补充信息]',
    '以下内容由人工在本次重跑前补充，请优先纳入判断：',
    trimmedRetryNote,
  ].join('\n');

  return taskContent ? `${taskContent}\n\n${retrySection}` : retrySection;
}

function workflowEventId(
  workflowId: string,
  eventType: string,
  refId?: string | null,
): string {
  return `wf-event-${workflowId}-${eventType}-${refId || 'none'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeWorkflowEvent(input: {
  workflowId: string;
  eventType: string;
  stateKey?: string | null;
  refType?: string | null;
  refId?: string | null;
  actor?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  createdAt?: string;
}): string {
  const eventId = workflowEventId(
    input.workflowId,
    input.eventType,
    input.refId,
  );
  createWorkflowEvent({
    id: eventId,
    workflow_id: input.workflowId,
    event_type: input.eventType,
    state_key: input.stateKey ?? null,
    ref_type: input.refType ?? null,
    ref_id: input.refId ?? null,
    actor_json: input.actor ? JSON.stringify(input.actor) : null,
    payload_json: input.payload ? JSON.stringify(input.payload) : null,
    idempotency_key: input.idempotencyKey ?? null,
    created_at: input.createdAt || new Date().toISOString(),
  });
  return eventId;
}

function parseCheckpointAttempts(
  workflowId: string,
): Record<string, number> {
  const latest = getLatestWorkflowCheckpoint(workflowId);
  if (!latest) return {};
  try {
    const parsed = JSON.parse(
      latest.checkpoint_json,
    ) as Partial<WorkflowCheckpointPayload>;
    return parsed.attempts && typeof parsed.attempts === 'object'
      ? parsed.attempts
      : {};
  } catch {
    return {};
  }
}

function writeWorkflowCheckpoint(input: {
  workflow: Workflow;
  stateKey?: string;
  pendingInterruptId?: string | null;
  currentDelegationId?: string | null;
  attempts?: Record<string, number>;
}): void {
  const latest = getLatestWorkflowCheckpoint(input.workflow.id);
  const version = (latest?.checkpoint_version || 0) + 1;
  const now = new Date().toISOString();
  const stateKey = input.stateKey || input.workflow.status;
  const payload: WorkflowCheckpointPayload = {
    workflowId: input.workflow.id,
    workflowType: input.workflow.workflow_type,
    stateKey,
    round: input.workflow.round,
    context: input.workflow.context,
    currentDelegationId:
      (input.currentDelegationId ?? input.workflow.current_delegation_id) ||
      null,
    pendingInterruptId: input.pendingInterruptId ?? null,
    attempts:
      input.attempts || parseCheckpointAttempts(input.workflow.id) || {},
    updatedAt: now,
  };
  createWorkflowCheckpoint({
    id: `wf-checkpoint-${input.workflow.id}-${version}`,
    workflow_id: input.workflow.id,
    state_key: stateKey,
    checkpoint_version: version,
    checkpoint_json: JSON.stringify(payload),
    created_at: now,
  });
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function jsonSchemaFromState(
  state: NonNullable<WorkflowTypeConfig['states'][string]>,
): Record<string, unknown> {
  const schema = state.resume_payload_schema?.schema;
  return schema && typeof schema === 'object' ? schema : { type: 'object' };
}

function validateJsonSchemaSubset(
  schema: JsonSchema | undefined,
  value: unknown,
  pathName = 'payload',
): string[] {
  if (!schema || Object.keys(schema).length === 0) return [];
  const errors: string[] = [];
  const expectedType = schema.type;

  if (expectedType === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [`${pathName} must be an object`];
    }
    const objectValue = value as Record<string, unknown>;
    for (const requiredKey of schema.required || []) {
      if (objectValue[requiredKey] === undefined) {
        errors.push(`${pathName}.${requiredKey} is required`);
      }
    }
    for (const [key, childSchema] of Object.entries(
      schema.properties || {},
    )) {
      if (objectValue[key] === undefined) continue;
      errors.push(
        ...validateJsonSchemaSubset(
          childSchema,
          objectValue[key],
          `${pathName}.${key}`,
        ),
      );
    }
    return errors;
  }

  if (expectedType === 'string') {
    if (typeof value !== 'string') return [`${pathName} must be a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${pathName} must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${pathName} must be at most ${schema.maxLength} characters`);
    }
  } else if (expectedType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${pathName} must be a number`);
    }
  } else if (expectedType === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(`${pathName} must be an integer`);
    }
  } else if (expectedType === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push(`${pathName} must be a boolean`);
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathName} must be one of ${schema.enum.join(', ')}`);
  }
  return errors;
}

function buildInterruptPayloadPatch(
  stateKey: string,
  action: string,
  payload: Record<string, unknown>,
): WorkflowContext {
  const patch: WorkflowContext = {};
  if (typeof payload.revision_text === 'string') {
    patch.revision_text =
      action === 'revise'
        ? `[方案修改意见]\n\n${payload.revision_text}`
        : payload.revision_text;
  }
  if (typeof payload.access_token === 'string') {
    patch[WORKFLOW_CONTEXT_KEYS.accessToken] = payload.access_token.trim();
  }
  if (action === 'skip' && stateKey === 'testing_confirm') {
    patch[WORKFLOW_CONTEXT_KEYS.accessToken] = '';
  }
  patch.last_interrupt_resume = {
    state_key: stateKey,
    action,
    payload,
    resumed_at: new Date().toISOString(),
  };
  return patch;
}

function createPendingInterruptForState(
  workflow: Workflow,
): WorkflowInterruptRecord | null {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const state = config?.states[workflow.status];
  if (!state || state.type !== 'interrupt') return null;

  const existing = getPendingWorkflowInterruptForState(
    workflow.id,
    workflow.status,
  );
  if (existing) {
    writeWorkflowCheckpoint({
      workflow,
      pendingInterruptId: existing.id,
    });
    return existing;
  }

  const now = new Date().toISOString();
  const attempts = parseCheckpointAttempts(workflow.id);
  const attempt = (attempts[workflow.status] || 0) + 1;
  attempts[workflow.status] = attempt;
  const idempotencyKey = `workflow_interrupt:${workflow.id}:${workflow.status}:${workflow.round}:${attempt}`;
  const interruptId = `wi-${workflow.id}-${workflow.status}-${workflow.round}-${attempt}`;
  const allowedChannels = state.allowed_channels || [
    'web',
    'feishu',
    'assistant',
  ];
  const interrupt: WorkflowInterruptRecord = {
    id: interruptId,
    workflow_id: workflow.id,
    state_key: workflow.status,
    kind: (state.kind || 'approval') as WorkflowInterruptKind,
    status: 'pending',
    title:
      state.title || config.status_labels[workflow.status] || workflow.status,
    body: state.body || null,
    resume_payload_schema_json: JSON.stringify(jsonSchemaFromState(state)),
    allowed_actions_json: JSON.stringify(state.allowed_actions || []),
    allowed_channels_json: JSON.stringify(allowedChannels),
    assigned_role: null,
    action_payload_json: null,
    created_by: 'workflow_runtime',
    resumed_by: null,
    resume_action: null,
    resume_payload_json: null,
    resume_error: null,
    idempotency_key: idempotencyKey,
    created_at: now,
    updated_at: now,
    expires_at: state.timeout_policy?.duration_ms
      ? new Date(Date.now() + state.timeout_policy.duration_ms).toISOString()
      : null,
    resumed_at: null,
    cancelled_at: null,
    expired_at: null,
  };
  createWorkflowInterrupt(interrupt);
  const persisted =
    getWorkflowInterruptByStateOrKey(
      workflow.id,
      workflow.status,
      idempotencyKey,
    ) || interrupt;
  writeWorkflowEvent({
    workflowId: workflow.id,
    eventType: 'interrupt_created',
    stateKey: workflow.status,
    refType: 'workflow_interrupt',
    refId: persisted.id,
    payload: {
      interrupt_id: persisted.id,
      kind: persisted.kind,
      allowed_actions: state.allowed_actions || [],
    },
    idempotencyKey,
    createdAt: now,
  });
  writeWorkflowCheckpoint({
    workflow,
    pendingInterruptId: persisted.id,
    attempts,
  });
  return persisted;
}

function getWorkflowInterruptByStateOrKey(
  workflowId: string,
  stateKey: string,
  idempotencyKey: string,
): WorkflowInterruptRecord | undefined {
  return (
    getPendingWorkflowInterruptForState(workflowId, stateKey) ||
    getWorkflowInterruptByIdempotencyKey(idempotencyKey)
  );
}

function ensureWorkflowStateDurableRecords(
  workflow: Workflow,
  reason: 'create' | 'transition' | 'resume' | 'retry' | 'timeout',
  fromStateKey?: string,
): void {
  writeWorkflowEvent({
    workflowId: workflow.id,
    eventType: 'state_entered',
    stateKey: workflow.status,
    payload: {
      from_state_key: fromStateKey || null,
      reason,
      round: workflow.round,
      attempt: 1,
    },
    idempotencyKey: `workflow_state_entered:${workflow.id}:${workflow.status}:${workflow.round}:${reason}`,
  });

  const state = getWorkflowTypeConfig(workflow.workflow_type)?.states[
    workflow.status
  ];
  if (state?.type === 'interrupt') {
    createPendingInterruptForState(workflow);
  } else {
    if (state?.type === 'terminal') {
      const closed = closePendingWorkflowInterrupts(
        workflow.id,
        'cancelled',
        new Date().toISOString(),
      );
      for (const interrupt of closed) {
        writeWorkflowEvent({
          workflowId: workflow.id,
          eventType: 'interrupt_cancelled',
          stateKey: interrupt.state_key,
          refType: 'workflow_interrupt',
          refId: interrupt.id,
          payload: {
            interrupt_id: interrupt.id,
            reason: 'workflow_terminal',
          },
        });
      }
      writeWorkflowEvent({
        workflowId: workflow.id,
        eventType: 'workflow_completed',
        stateKey: workflow.status,
        payload: {
          terminal_state_key: workflow.status,
          result: workflow.status,
        },
      });
    }
    writeWorkflowCheckpoint({ workflow });
  }
}

function actorToJson(actor: ResumeActor): string {
  return JSON.stringify({
    channel: actor.channel,
    userId: actor.userId || '',
    displayName: actor.displayName || '',
  });
}

function createResumeAttempt(input: {
  interrupt: WorkflowInterruptRecord;
  actor: ResumeActor;
  action: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  status: 'accepted' | 'duplicate' | 'conflict' | 'rejected';
  result?: Record<string, unknown>;
  conflictReason?: string | null;
}): void {
  createWorkflowInterruptResumeAttempt({
    id: `wf-resume-attempt-${input.interrupt.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    interrupt_id: input.interrupt.id,
    workflow_id: input.interrupt.workflow_id,
    actor_json: actorToJson(input.actor),
    resume_action: input.action,
    resume_payload_json: JSON.stringify(input.payload || {}),
    idempotency_key: input.idempotencyKey || null,
    status: input.status,
    result_json: input.result ? JSON.stringify(input.result) : null,
    conflict_reason: input.conflictReason || null,
    created_at: new Date().toISOString(),
  });
}

function parseSchema(raw: string | null | undefined): JsonSchema {
  if (!raw) return { type: 'object' };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as JsonSchema)
      : { type: 'object' };
  } catch {
    return { type: 'object' };
  }
}

function isTerminalStatus(workflow: Workflow): boolean {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  return config?.states[workflow.status]?.type === 'terminal';
}

function transitionForEvaluation(
  stateConfig: NonNullable<WorkflowTypeConfig['states'][string]>,
  evaluationStatus: ReturnType<typeof evaluateWorkflowStage>['status'],
): StateTransition | undefined {
  if (stateConfig.evaluator) {
    if (evaluationStatus === 'passed' && stateConfig.evaluator.on_pass) {
      return compileDefinitionTransitionToStateTransition(
        stateConfig.evaluator.on_pass,
      );
    }
    if (
      evaluationStatus === 'needs_revision' &&
      stateConfig.evaluator.on_needs_revision
    ) {
      return compileDefinitionTransitionToStateTransition(
        stateConfig.evaluator.on_needs_revision,
      );
    }
    if (evaluationStatus === 'failed' && stateConfig.evaluator.on_fail) {
      return compileDefinitionTransitionToStateTransition(
        stateConfig.evaluator.on_fail,
      );
    }
    if (evaluationStatus === 'pending' && stateConfig.evaluator.on_pending) {
      return compileDefinitionTransitionToStateTransition(
        stateConfig.evaluator.on_pending,
      );
    }
  }

  if (evaluationStatus === 'passed') {
    return stateConfig.on_complete?.success;
  }
  if (evaluationStatus === 'needs_revision' || evaluationStatus === 'failed') {
    return stateConfig.on_complete?.failure;
  }
  return undefined;
}

function scheduleEvaluatorRetryIfConfigured(input: {
  workflow: Workflow;
  stateConfig: NonNullable<WorkflowTypeConfig['states'][string]>;
  evaluationId: string;
  nowIso?: string;
}): boolean {
  const policy = input.stateConfig.retry_policy;
  if (!policy?.retry_on?.includes('evaluator_pending')) return false;
  const attempts = parseCheckpointAttempts(input.workflow.id);
  const currentAttempt = attempts[input.workflow.status] || 1;
  if (currentAttempt >= policy.max_attempts) return false;
  const nextAttempt = currentAttempt + 1;
  attempts[input.workflow.status] = nextAttempt;
  const now = input.nowIso || new Date().toISOString();
  const delayMs = Math.min(
    policy.max_delay_ms || policy.initial_delay_ms || 0,
    policy.initial_delay_ms || 0,
  );
  const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
  writeWorkflowEvent({
    workflowId: input.workflow.id,
    eventType: 'retry_scheduled',
    stateKey: input.workflow.status,
    refType: 'workflow_stage_evaluation',
    refId: input.evaluationId,
    payload: {
      reason: 'evaluator_pending',
      next_attempt_at: nextAttemptAt,
      attempt: nextAttempt,
    },
    idempotencyKey: `workflow_retry:${input.workflow.id}:${input.workflow.status}:${input.workflow.round}:${nextAttempt}`,
    createdAt: now,
  });
  writeWorkflowCheckpoint({
    workflow: input.workflow,
    currentDelegationId: null,
    attempts,
  });
  return true;
}

function exhaustedRetryTransition(
  stateConfig: NonNullable<WorkflowTypeConfig['states'][string]>,
): StateTransition | undefined {
  return stateConfig.retry_policy?.on_exhausted
    ? compileDefinitionTransitionToStateTransition(
        stateConfig.retry_policy.on_exhausted,
      )
    : undefined;
}

function mergeEvaluationResults(input: {
  stageEvaluation: WorkflowStageEvalResult;
  contractEvaluation: WorkflowStageEvalResult | null;
  evaluatorRef?: string;
}): WorkflowStageEvalResult {
  if (!input.contractEvaluation) return input.stageEvaluation;
  const evaluatorConfig = getWorkflowEvaluatorConfig(input.evaluatorRef);
  const missingStatus =
    evaluatorConfig?.status_mapping?.artifact_missing || 'pending';
  const contractStatus =
    input.contractEvaluation.status === 'pending'
      ? missingStatus
      : input.contractEvaluation.status;
  const severityRank: Record<WorkflowStageEvalResult['status'], number> = {
    passed: 0,
    needs_revision: 1,
    pending: 2,
    failed: 3,
  };
  const status =
    severityRank[contractStatus] > severityRank[input.stageEvaluation.status]
      ? contractStatus
      : input.stageEvaluation.status;
  return {
    status,
    score: Math.min(input.stageEvaluation.score, input.contractEvaluation.score),
    summary:
      status === input.stageEvaluation.status
        ? input.stageEvaluation.summary
        : input.contractEvaluation.summary,
    findings: [
      ...input.contractEvaluation.findings,
      ...input.stageEvaluation.findings,
    ],
    evidence: [
      ...input.contractEvaluation.evidence,
      ...input.stageEvaluation.evidence,
    ],
    evaluatorType: 'hybrid',
  };
}

function resumeCurrentWorkflowInterrupt(
  workflowId: string,
  action: string,
  payload: Record<string, unknown>,
  channel: WorkflowInterruptActorChannel,
): { error?: string } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };
  const interrupt = getPendingWorkflowInterruptForState(
    workflow.id,
    workflow.status,
  );
  if (!interrupt) {
    const state = getWorkflowTypeConfig(workflow.workflow_type)?.states[
      workflow.status
    ];
    if (state?.type === 'interrupt') {
      createPendingInterruptForState(workflow);
      const created = getPendingWorkflowInterruptForState(
        workflow.id,
        workflow.status,
      );
      if (created) {
        return resumeWorkflowInterrupt({
          interruptId: created.id,
          action,
          payload,
          actor: { channel },
        }).ok
          ? {}
          : { error: '恢复人工中断失败' };
      }
    }
    return {
      error: `流程 ${workflowId} 当前状态 ${workflow.status} 没有待恢复的人工中断`,
    };
  }
  const result = resumeWorkflowInterrupt({
    interruptId: interrupt.id,
    action,
    payload,
    actor: { channel },
  });
  return result.ok ? {} : { error: result.error };
}

export function resumeWorkflowInterrupt(input: {
  interruptId: string;
  action: string;
  payload?: Record<string, unknown>;
  actor: ResumeActor;
  idempotencyKey?: string;
}): { ok: true; workflowId: string } | { ok: false; error: string } {
  const payload = input.payload || {};
  let result: { ok: true; workflowId: string } | { ok: false; error: string };
  try {
    result = runWorkflowTransaction(() => {
    if (input.idempotencyKey) {
      const previous = getWorkflowInterruptResumeAttemptByIdempotency(
        input.interruptId,
        input.idempotencyKey,
      );
      if (previous) {
        if (previous.status === 'accepted' || previous.status === 'duplicate') {
          return { ok: true, workflowId: previous.workflow_id } as const;
        }
        return {
          ok: false,
          error: previous.conflict_reason || '重复提交已被拒绝',
        } as const;
      }
    }

    const interrupt = getWorkflowInterrupt(input.interruptId);
    if (!interrupt) {
      return { ok: false, error: `中断 ${input.interruptId} 不存在` } as const;
    }

    const workflow = getWorkflow(interrupt.workflow_id);
    if (!workflow) {
      createResumeAttempt({
        interrupt,
        actor: input.actor,
        action: input.action,
        payload,
        idempotencyKey: input.idempotencyKey,
        status: 'rejected',
        conflictReason: 'workflow_not_found',
      });
      return {
        ok: false,
        error: `流程 ${interrupt.workflow_id} 不存在`,
      } as const;
    }

    if (interrupt.status !== 'pending') {
      const sameAction =
        interrupt.status === 'resumed' &&
        interrupt.resume_action === input.action;
      createResumeAttempt({
        interrupt,
        actor: input.actor,
        action: input.action,
        payload,
        idempotencyKey: input.idempotencyKey,
        status: sameAction ? 'duplicate' : 'conflict',
        result: { workflowId: workflow.id, interruptStatus: interrupt.status },
        conflictReason: sameAction ? null : `interrupt_${interrupt.status}`,
      });
      if (sameAction) return { ok: true, workflowId: workflow.id } as const;
      return {
        ok: false,
        error: `中断已${interrupt.status}，不能再次提交不同操作`,
      } as const;
    }

    if (isTerminalStatus(workflow)) {
      createResumeAttempt({
        interrupt,
        actor: input.actor,
        action: input.action,
        payload,
        idempotencyKey: input.idempotencyKey,
        status: 'rejected',
        conflictReason: 'workflow_terminal',
      });
      return { ok: false, error: `流程已结束 (${workflow.status})` } as const;
    }

    const config = getWorkflowTypeConfig(workflow.workflow_type);
    const state = config?.states[interrupt.state_key];
    if (!config || !state || state.type !== 'interrupt') {
      createResumeAttempt({
        interrupt,
        actor: input.actor,
        action: input.action,
        payload,
        idempotencyKey: input.idempotencyKey,
        status: 'rejected',
        conflictReason: 'state_not_interrupt',
      });
      return {
        ok: false,
        error: `流程状态 ${interrupt.state_key} 不是人工中断`,
      } as const;
    }

    if (workflow.status !== interrupt.state_key) {
      createResumeAttempt({
        interrupt,
        actor: input.actor,
        action: input.action,
        payload,
        idempotencyKey: input.idempotencyKey,
        status: 'conflict',
        conflictReason: `workflow_state_changed:${workflow.status}`,
      });
      return {
        ok: false,
        error: `流程当前状态已变更为 ${workflow.status}`,
      } as const;
    }

    const allowedActions = parseJsonArray(interrupt.allowed_actions_json);
    if (!allowedActions.includes(input.action)) {
      createResumeAttempt({
        interrupt,
        actor: input.actor,
        action: input.action,
        payload,
        idempotencyKey: input.idempotencyKey,
        status: 'rejected',
        conflictReason: 'action_not_allowed',
      });
      return {
        ok: false,
        error: `操作 ${input.action} 不在允许列表: ${allowedActions.join(', ')}`,
      } as const;
    }

    const allowedChannels = parseJsonArray(
      interrupt.allowed_channels_json,
    );
    if (
      input.actor.channel !== 'system' &&
      allowedChannels.length > 0 &&
      !allowedChannels.includes(input.actor.channel)
    ) {
      createResumeAttempt({
        interrupt,
        actor: input.actor,
        action: input.action,
        payload,
        idempotencyKey: input.idempotencyKey,
        status: 'rejected',
        conflictReason: 'channel_not_allowed',
      });
      return {
        ok: false,
        error: `渠道 ${input.actor.channel} 不允许恢复该中断`,
      } as const;
    }

    const schemaErrors = validateJsonSchemaSubset(
      parseSchema(interrupt.resume_payload_schema_json),
      payload,
    );
    if (schemaErrors.length > 0) {
      createResumeAttempt({
        interrupt,
        actor: input.actor,
        action: input.action,
        payload,
        idempotencyKey: input.idempotencyKey,
        status: 'rejected',
        conflictReason: schemaErrors.join('; '),
      });
      return {
        ok: false,
        error: `提交内容不符合 schema: ${schemaErrors.join('; ')}`,
      } as const;
    }

    const transition = state.on_resume?.[input.action];
    if (!transition) {
      createResumeAttempt({
        interrupt,
        actor: input.actor,
        action: input.action,
        payload,
        idempotencyKey: input.idempotencyKey,
        status: 'rejected',
        conflictReason: 'transition_missing',
      });
      return {
        ok: false,
        error: `操作 ${input.action} 没有配置 on_resume transition`,
      } as const;
    }

    const now = new Date().toISOString();
    const actorJson = actorToJson(input.actor);
    const marked = markWorkflowInterruptResumed({
      interruptId: interrupt.id,
      resumedBy: actorJson,
      resumeAction: input.action,
      resumePayloadJson: JSON.stringify(payload),
      updatedAt: now,
    });
    if (!marked) {
      createResumeAttempt({
        interrupt,
        actor: input.actor,
        action: input.action,
        payload,
        idempotencyKey: input.idempotencyKey,
        status: 'conflict',
        conflictReason: 'interrupt_cas_failed',
      });
      return { ok: false, error: '中断已被其他提交处理' } as const;
    }

    createResumeAttempt({
      interrupt,
      actor: input.actor,
      action: input.action,
      payload,
      idempotencyKey: input.idempotencyKey,
      status: 'accepted',
      result: { workflowId: workflow.id, target: transition.target },
    });
    writeWorkflowEvent({
      workflowId: workflow.id,
      eventType: 'interrupt_resumed',
      stateKey: interrupt.state_key,
      refType: 'workflow_interrupt',
      refId: interrupt.id,
      actor: {
        channel: input.actor.channel,
        userId: input.actor.userId || '',
        displayName: input.actor.displayName || '',
      },
      payload: {
        interrupt_id: interrupt.id,
        resume_action: input.action,
        actor: input.actor,
        payload,
      },
      createdAt: now,
    });

    const contextPatch = buildInterruptPayloadPatch(
      interrupt.state_key,
      input.action,
      payload,
    );
    try {
      applyTransition(workflow, transition, resolveRolesOrEmpty(workflow), {
        revisionText:
          typeof contextPatch.revision_text === 'string'
            ? contextPatch.revision_text
            : undefined,
        accessToken:
          typeof contextPatch[WORKFLOW_CONTEXT_KEYS.accessToken] === 'string'
            ? String(contextPatch[WORKFLOW_CONTEXT_KEYS.accessToken])
            : undefined,
        workflowUpdates: { context: contextPatch },
      });
    } catch (err) {
      throw new Error(
        `恢复中断后的状态流转失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const updatedWorkflow = getWorkflow(workflow.id);
    if (updatedWorkflow) {
      writeWorkflowCheckpoint({
        workflow: updatedWorkflow,
        pendingInterruptId:
          getPendingWorkflowInterruptForState(
            updatedWorkflow.id,
            updatedWorkflow.status,
          )?.id || null,
      });
    }
    return { ok: true, workflowId: workflow.id } as const;
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (result.ok) processWorkflowOutbox();
  return result;
}

function resolveRolesOrEmpty(workflow: Workflow): Record<string, string> {
  const rolesResult = resolveRoles(workflow.workflow_type, workflow.source_jid);
  return 'roles' in rolesResult ? rolesResult.roles : {};
}

// -------------------------------------------------------
// Generic transition engine
// -------------------------------------------------------

/**
 * Apply a state transition defined in the config.
 * Handles: increment_round → delegateTo → updateWorkflow → notify → send card
 */
function applyTransition(
  workflow: Workflow,
  transition: StateTransition,
  roles: Record<string, string>,
  extra?: {
    fromStatusOverride?: string;
    delegationResult?: string;
    resultSummary?: string;
    revisionText?: string;
    accessToken?: string;
    testDoc?: string;
    workflowUpdates?: Parameters<typeof updateWorkflow>[1];
  },
): void {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return;

  const fromStatus = extra?.fromStatusOverride || workflow.status;
  const mainFolder = getMainFolder(workflow.source_jid);
  const updates: Parameters<typeof updateWorkflow>[1] = {
    status: transition.target,
  };

  if (workflow.status === 'paused' && workflow.paused_from) {
    updates.paused_from = null;
  }

  if (extra?.accessToken !== undefined) {
    updates.context = {
      [WORKFLOW_CONTEXT_KEYS.accessToken]: extra.accessToken,
    };
  }
  if (extra?.workflowUpdates) {
    updates.context = mergeWorkflowContext(
      updates.context || {},
      extra.workflowUpdates.context,
    );
    Object.assign(updates, extra.workflowUpdates);
  }

  // 1. Increment round if needed
  let round = workflow.round;
  if (transition.increment_round) {
    round = workflow.round + 1;
    updates.round = round;
  }

  // Build template vars with updated values
  const vars = buildTemplateVars(
    {
      ...workflow,
      ...updates,
      context: mergeWorkflowContext(workflow.context, updates.context),
      round,
    },
    extra,
  );

  // 3. Create durable delegation intent if transition specifies a role + skill
  const delegateRole = transition.role;
  const delegateSkill = transition.skill;
  let delegationIntent: DelegationIntent | null = null;

  if (delegateRole && delegateSkill) {
    const targetFolder = roles[delegateRole];
    if (!targetFolder) {
      throw new Error(
        `Workflow: role "${delegateRole}" has no resolved target folder`,
      );
    }
    const taskContent = transition.task_template
      ? renderTemplate(transition.task_template, vars, roles)
      : '';
    const finalTaskContent = finalizeDelegationTaskContent(
      delegateSkill,
      taskContent,
      { ...workflow, ...updates, round },
      extra,
    );

    const delegationKey = `workflow_delegation:${workflow.id}:${transition.target}:${round}:1`;
    delegationIntent = createDurableDelegationIntent({
      workflowId: workflow.id,
      sourceJid: workflow.source_jid,
      targetFolder,
      sourceFolder: mainFolder,
      skillName: delegateSkill,
      taskContent: finalTaskContent,
      idempotencyKey: delegationKey,
    });
    updates.current_delegation_id = delegationIntent.delegationId;
  } else {
    // No delegation — clear current_delegation_id
    updates.current_delegation_id = '';
  }

  // 4. Update workflow state
  updateWorkflow(workflow.id, updates);
  writeWorkflowEvent({
    workflowId: workflow.id,
    eventType: 'transition_applied',
    stateKey: fromStatus,
    payload: {
      source_state_key: fromStatus,
      target_state_key: transition.target,
      transition,
    },
  });
  const isPassiveSelfLoop =
    transition.target === fromStatus && !updates.current_delegation_id;
  if (!isPassiveSelfLoop) {
    enqueueWorkflowWorkbenchSync(
      workflow.id,
      'transition',
      {
        fromStatus,
        toStatus: transition.target,
        delegationId: updates.current_delegation_id,
      },
      `transition:${fromStatus}:${transition.target}:${round}`,
    );
  }
  if (updates.current_delegation_id) {
    enqueueWorkflowWorkbenchSync(
      workflow.id,
      'delegation_created',
      { delegationId: updates.current_delegation_id },
      `delegation_created:${updates.current_delegation_id}`,
    );
    writeWorkflowEvent({
      workflowId: workflow.id,
      eventType: 'delegation_created',
      stateKey: transition.target,
      refType: 'delegation',
      refId: updates.current_delegation_id,
      payload: {
        delegation_id: updates.current_delegation_id,
        idempotency_key: `workflow_delegation:${workflow.id}:${transition.target}:${round}:1`,
        attempt: 1,
        target_folder: delegationIntent?.targetFolder || null,
      },
    });
  }
  enqueueWorkflowWorkbenchSync(
    workflow.id,
    'workflow_updated',
    { resultSummary: extra?.resultSummary || null },
    `workflow_updated:${transition.target}:${round}`,
  );

  const transitionedWorkflow = getWorkflow(workflow.id);
  if (transitionedWorkflow) {
    ensureWorkflowStateDurableRecords(
      transitionedWorkflow,
      extra?.fromStatusOverride ? 'retry' : 'transition',
      fromStatus,
    );
  }

  // 5. Send notification
  if (transition.notify) {
    enqueueWorkflowNotification(
      { ...workflow, ...updates, context: mergeWorkflowContext(workflow.context, updates.context) },
      renderTemplate(transition.notify, vars, roles),
      `transition_notify:${fromStatus}:${transition.target}:${round}`,
    );
  }

  // 6. Send card if specified
  const updatedWorkflow = getWorkflow(workflow.id);
  const targetState = config.states[transition.target];
  const cardKey =
    targetState?.type === 'interrupt' && targetState.card
      ? targetState.card
      : transition.card;
  if (cardKey && updatedWorkflow) {
    enqueueWorkflowCard(
      updatedWorkflow,
      cardKey,
      `transition_card:${fromStatus}:${transition.target}:${round}`,
    );
  }
}

// -------------------------------------------------------
// Public API
// -------------------------------------------------------

export interface CreateWorkflowOpts {
  title: string;
  service: string;
  sourceJid: string;
  startFrom: string;
  workflowType: string;
  context?: WorkflowContext;
  deliverable?: string;
  mainBranch?: string;
  workBranch?: string;
  stagingBaseBranch?: string;
  stagingWorkBranch?: string;
  accessToken?: string;
  requirementDescription?: string;
  requirementFiles?: string[];
  requirementPreset?: string;
}

export function createNewWorkflow(opts: CreateWorkflowOpts): {
  workflowId: string;
  error?: string;
} {
  const workflowType = opts.workflowType;

  // Check if workflow type config exists
  const config = getWorkflowTypeConfig(workflowType);
  if (!config) {
    return {
      workflowId: '',
      error: `未知的流程类型: ${workflowType}`,
    };
  }

  // Check roles
  const rolesResult = resolveRoles(workflowType, opts.sourceJid);
  if ('error' in rolesResult) {
    return { workflowId: '', error: rolesResult.error };
  }
  const roles = rolesResult.roles;

  // Find entry point
  const entryPoint = config.entry_points[opts.startFrom];
  if (!entryPoint) {
    return {
      workflowId: '',
      error: `流程类型 "${workflowType}" 不支持 start_from="${opts.startFrom}"，可选: ${Object.keys(config.entry_points).join(', ')}`,
    };
  }

  const workflowId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now().toString();
  const mainFolder = getMainFolder(opts.sourceJid);

  // If entry point requires deliverable, it must be explicitly specified
  if (entryPoint.requires_deliverable) {
    if (!opts.deliverable) {
      return {
        workflowId,
        error: `入口 "${opts.startFrom}" 需要指定 deliverable 参数，请先在 Workbench 中选择需求目录。`,
      };
    }

    const deliverable = readDeliverableDir(opts.service, opts.deliverable);
    if (!deliverable) {
      return {
        workflowId,
        error: `交付文档目录 "${opts.deliverable}" 不存在 (projects/${opts.service}/iteration/${opts.deliverable}/)`,
      };
    }

    const workflowContext = mergeWorkflowContext(opts.context || {}, {
      [WORKFLOW_CONTEXT_KEYS.mainBranch]:
        opts.mainBranch || deliverable.main_branch,
      [WORKFLOW_CONTEXT_KEYS.workBranch]:
        opts.workBranch || deliverable.work_branch,
      [WORKFLOW_CONTEXT_KEYS.deliverable]: deliverable.fileName,
      [WORKFLOW_CONTEXT_KEYS.stagingBaseBranch]:
        opts.stagingBaseBranch || deliverable.staging_base_branch,
      [WORKFLOW_CONTEXT_KEYS.stagingWorkBranch]:
        opts.stagingWorkBranch || deliverable.staging_work_branch,
      [WORKFLOW_CONTEXT_KEYS.accessToken]: opts.accessToken || '',
      [WORKFLOW_CONTEXT_KEYS.requirementPreset]: opts.requirementPreset || '',
    });

    dbCreateWorkflow({
      id: workflowId,
      name: opts.title,
      service: opts.service,
      start_from: opts.startFrom,
      context: workflowContext,
      status: entryPoint.state,
      current_delegation_id: '',
      round: 0,
      source_jid: opts.sourceJid,
      paused_from: null,
      workflow_type: workflowType,
      created_at: now,
      updated_at: now,
    });
    syncWorkbenchOnWorkflowCreated(workflowId);

    const entryStateConfig = config.states[entryPoint.state];

    const createdWorkflow = getWorkflow(workflowId);
    if (createdWorkflow) {
      ensureWorkflowStateDurableRecords(createdWorkflow, 'create');
    }

    // If entry state is an interrupt state, send the card
    if (entryStateConfig?.type === 'interrupt' && entryStateConfig.card) {
      const createdWorkflow = getWorkflow(workflowId);
      if (createdWorkflow) {
        sendConfigCard(createdWorkflow, entryStateConfig.card);
      }
    }

    // If entry state is a delegation state, delegate immediately
    if (
      entryStateConfig?.type === 'delegation' &&
      entryStateConfig.role &&
      entryStateConfig.skill
    ) {
      const targetFolder = roles[entryStateConfig.role];
      if (!targetFolder) {
        return {
          workflowId,
          error: `角色 ${entryStateConfig.role} 未找到对应的群组`,
        };
      }

      try {
        const createdWorkflow = getWorkflow(workflowId)!;
        const vars = buildTemplateVars(createdWorkflow);
        const taskContent = entryStateConfig.task_template
          ? renderTemplate(entryStateConfig.task_template, vars, roles)
          : '';
        const finalTaskContent = finalizeDelegationTaskContent(
          entryStateConfig.skill,
          taskContent,
          createdWorkflow,
        );

        const delegationId = delegateTo(
          targetFolder,
          mainFolder,
          workflowId,
          entryStateConfig.skill,
          finalTaskContent,
        );
        updateWorkflow(workflowId, { current_delegation_id: delegationId });
        syncWorkbenchOnDelegationCreated(workflowId, delegationId);
        writeWorkflowEvent({
          workflowId,
          eventType: 'delegation_created',
          stateKey: entryPoint.state,
          refType: 'delegation',
          refId: delegationId,
          payload: {
            delegation_id: delegationId,
            idempotency_key: `workflow_delegation:${workflowId}:${entryPoint.state}:0:1`,
            attempt: 1,
          },
        });
        const delegatedWorkflow = getWorkflow(workflowId);
        if (delegatedWorkflow) {
          writeWorkflowCheckpoint({
            workflow: delegatedWorkflow,
            currentDelegationId: delegationId,
          });
        }
      } catch (err) {
        logger.error({ err, workflowId }, 'Failed to delegate initial task');
        return {
          workflowId,
          error: `委派初始任务失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      notifyMain(
        `[流程启动] 需求「${opts.title}」${config.name}已创建 (${workflowId})，已委派 ${roles[entryStateConfig.role]} 开始执行。`,
        opts.sourceJid,
        workflowId,
      );
    }

    return { workflowId };
  }

  // 正常入口：创建任务对应的流程实例，并委派到初始状态对应角色
  const entryStateConfig = config.states[entryPoint.state];
  const workflowContext = mergeWorkflowContext(opts.context || {}, {
    [WORKFLOW_CONTEXT_KEYS.mainBranch]: opts.mainBranch || '',
    [WORKFLOW_CONTEXT_KEYS.workBranch]: opts.workBranch || '',
    [WORKFLOW_CONTEXT_KEYS.deliverable]: '',
    [WORKFLOW_CONTEXT_KEYS.stagingBaseBranch]: opts.stagingBaseBranch || '',
    [WORKFLOW_CONTEXT_KEYS.stagingWorkBranch]: opts.stagingWorkBranch || '',
    [WORKFLOW_CONTEXT_KEYS.accessToken]: opts.accessToken || '',
    [WORKFLOW_CONTEXT_KEYS.requirementDescription]:
      opts.requirementDescription || '',
    [WORKFLOW_CONTEXT_KEYS.requirementFiles]: Array.isArray(
      opts.requirementFiles,
    )
      ? opts.requirementFiles.filter(
          (item) => typeof item === 'string' && item.trim().length > 0,
        )
      : [],
    [WORKFLOW_CONTEXT_KEYS.requirementPreset]: opts.requirementPreset || '',
  });

  dbCreateWorkflow({
    id: workflowId,
    name: opts.title,
    service: opts.service,
    start_from: opts.startFrom,
    context: workflowContext,
    status: entryPoint.state,
    current_delegation_id: '',
    round: 0,
    source_jid: opts.sourceJid,
    paused_from: null,
    workflow_type: workflowType,
    created_at: now,
    updated_at: now,
  });
  syncWorkbenchOnWorkflowCreated(workflowId);

  const createdWorkflow = getWorkflow(workflowId);
  if (createdWorkflow) {
    ensureWorkflowStateDurableRecords(createdWorkflow, 'create');
  }

  // If entry state is a delegation state, delegate immediately
  if (
    entryStateConfig?.type === 'delegation' &&
    entryStateConfig.role &&
    entryStateConfig.skill
  ) {
    const targetFolder = roles[entryStateConfig.role];
    if (!targetFolder) {
      return {
        workflowId,
        error: `角色 ${entryStateConfig.role} 未找到对应的群组`,
      };
    }

    try {
      const createdWorkflow = getWorkflow(workflowId)!;
      const vars = buildTemplateVars(createdWorkflow);
      const taskContent = entryStateConfig.task_template
        ? renderTemplate(entryStateConfig.task_template, vars, roles)
        : '';
      const finalTaskContent = finalizeDelegationTaskContent(
        entryStateConfig.skill,
        taskContent,
        createdWorkflow,
      );

      const delegationId = delegateTo(
        targetFolder,
        mainFolder,
        workflowId,
        entryStateConfig.skill,
        finalTaskContent,
      );
      updateWorkflow(workflowId, { current_delegation_id: delegationId });
      syncWorkbenchOnDelegationCreated(workflowId, delegationId);
      writeWorkflowEvent({
        workflowId,
        eventType: 'delegation_created',
        stateKey: entryPoint.state,
        refType: 'delegation',
        refId: delegationId,
        payload: {
          delegation_id: delegationId,
          idempotency_key: `workflow_delegation:${workflowId}:${entryPoint.state}:0:1`,
          attempt: 1,
        },
      });
      const delegatedWorkflow = getWorkflow(workflowId);
      if (delegatedWorkflow) {
        writeWorkflowCheckpoint({
          workflow: delegatedWorkflow,
          currentDelegationId: delegationId,
        });
      }
    } catch (err) {
      logger.error({ err, workflowId }, 'Failed to delegate initial task');
      return {
        workflowId,
        error: `委派初始任务失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    notifyMain(
      `[流程启动] 需求「${opts.title}」${config.name}已创建 (${workflowId})，已委派 ${roles[entryStateConfig.role]} 开始执行。`,
      opts.sourceJid,
      workflowId,
    );
  }

  return { workflowId };
}

export function skipWorkflow(workflowId: string): { error?: string } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };

  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return { error: `未知的流程类型: ${workflow.workflow_type}` };

  const state = config.states[workflow.status];
  if (state?.type === 'interrupt') {
    return resumeCurrentWorkflowInterrupt(
      workflowId,
      state.allowed_actions?.includes('skip') ? 'skip' : 'approve',
      { skipped: true },
      'system',
    );
  }

  return skipWorkflowStage(workflowId, workflow.status);
}

export function skipWorkflowStage(
  workflowId: string,
  stageKey: string,
): { error?: string } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };

  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return { error: `未知的流程类型: ${workflow.workflow_type}` };

  const terminalStates = getTerminalStates(config);
  const stateConfig = config.states[stageKey];
  if (!stateConfig) {
    return {
      error: `流程 ${workflowId} 不存在阶段 ${stageKey}`,
    };
  }

  if (
    stageKey !== workflow.status &&
    workflow.status !== 'paused' &&
    !terminalStates.includes(workflow.status)
  ) {
    return {
      error: `流程 ${workflowId} 当前状态 ${workflow.status} 不支持跳过阶段 ${stageKey}`,
    };
  }

  let transition: StateTransition | undefined;
  if (stateConfig.type === 'interrupt') {
    transition = stateConfig.on_resume?.skip || stateConfig.on_resume?.approve;
  } else if (stateConfig.type === 'delegation') {
    transition = stateConfig.on_complete?.success;
  }

  if (!transition) {
    return {
      error: `流程 ${workflowId} 当前节点 ${stageKey} 不支持跳过操作`,
    };
  }

  const rolesResult = resolveRoles(workflow.workflow_type, workflow.source_jid);
  if ('error' in rolesResult) return { error: rolesResult.error };

  createWorkbenchManualSkipEvent(workflowId, stageKey);
  applyTransition(workflow, transition, rolesResult.roles, {
    fromStatusOverride: stageKey,
  });
  return {};
}

export function returnWorkflowToInterruptStage(
  workflowId: string,
  stageKey: string,
): { error?: string } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };
  if (workflow.status === 'paused') {
    return { error: `流程 ${workflowId} 当前已暂停，请先恢复后再回到确认节点` };
  }

  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return { error: `未知的流程类型: ${workflow.workflow_type}` };

  const stateConfig = config.states[stageKey];
  if (!stateConfig) {
    return { error: `阶段 ${stageKey} 不存在` };
  }
  if (stateConfig.type !== 'interrupt') {
    return { error: `阶段 ${stageKey} 不是人工中断节点` };
  }
  if (workflow.status === stageKey) {
    return { error: `流程 ${workflowId} 当前已在阶段 ${stageKey}` };
  }

  const fromStatus = workflow.status;
  updateWorkflow(workflowId, {
    status: stageKey,
    current_delegation_id: '',
    paused_from: null,
  });
  syncWorkbenchOnTransition(workflowId, fromStatus, stageKey);
  syncWorkbenchOnWorkflowUpdated(
    workflowId,
    `已回到阶段 ${config.status_labels[stageKey] || stageKey}`,
    { emitRealtime: false },
  );

  const updatedWorkflow = getWorkflow(workflowId);
  if (!updatedWorkflow) return {};
  ensureWorkflowStateDurableRecords(updatedWorkflow, 'transition', fromStatus);

  notifyMain(
    `[流程回退] 需求「${updatedWorkflow.name}」(${workflowId}) 已回到阶段 ${config.status_labels[stageKey] || stageKey}，请重新确认。`,
    updatedWorkflow.source_jid,
    workflowId,
  );
  if (stateConfig.card) {
    sendConfigCard(updatedWorkflow, stateConfig.card);
  }
  return {};
}

export function retryWorkflowStage(
  workflowId: string,
  stageKey: string,
  extra?: {
    retryNote?: string;
  },
): { error?: string } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };
  if (workflow.status === 'paused') {
    return { error: `流程 ${workflowId} 当前已暂停，请先恢复后再重跑` };
  }

  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return { error: `未知的流程类型: ${workflow.workflow_type}` };

  const stateConfig = config.states[stageKey];
  if (!stateConfig) {
    return { error: `阶段 ${stageKey} 不存在` };
  }
  if (
    stateConfig.type !== 'delegation' ||
    !stateConfig.role ||
    !stateConfig.skill
  ) {
    return { error: `阶段 ${stageKey} 不支持重跑` };
  }

  const rolesResult = resolveRoles(workflow.workflow_type, workflow.source_jid);
  if ('error' in rolesResult) return { error: rolesResult.error };
  const roles = rolesResult.roles;

  const targetFolder = roles[stateConfig.role];
  if (!targetFolder) {
    return { error: `角色 ${stateConfig.role} 未找到对应群组` };
  }

  try {
    const vars = buildTemplateVars(workflow);
    const taskContent = stateConfig.task_template
      ? renderTemplate(stateConfig.task_template, vars, roles)
      : '';
    const finalTaskContent = finalizeDelegationTaskContent(
      stateConfig.skill,
      taskContent,
      workflow,
    );
    const retriedTaskContent = appendRetryNote(
      finalTaskContent,
      extra?.retryNote,
    );
    const delegationId = delegateTo(
      targetFolder,
      getMainFolder(workflow.source_jid),
      workflowId,
      stateConfig.skill,
      retriedTaskContent,
    );

    const fromStatus = workflow.status;
    updateWorkflow(workflowId, {
      status: stageKey,
      current_delegation_id: delegationId,
      paused_from: null,
    });
    syncWorkbenchOnDelegationCreated(workflowId, delegationId);
    syncWorkbenchOnTransition(workflowId, fromStatus, stageKey, delegationId);
    syncWorkbenchOnWorkflowUpdated(
      workflowId,
      `已重跑阶段 ${config.status_labels[stageKey] || stageKey}`,
      { emitRealtime: false },
    );
    notifyMain(
      `[流程重跑] 需求「${workflow.name}」(${workflowId}) 已重新执行阶段 ${config.status_labels[stageKey] || stageKey}，已委派 ${targetFolder}。`,
      workflow.source_jid,
      workflowId,
    );
    return {};
  } catch (err) {
    return {
      error: `重跑阶段失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Called when a delegation completes. Checks if it belongs to a workflow
 * and advances the state machine accordingly.
 */
export function onDelegationComplete(delegationId: string): void {
  const workflow = getWorkflowByDelegation(delegationId);
  if (!workflow) return; // Not a workflow delegation

  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return;

  const rolesResult = resolveRoles(workflow.workflow_type, workflow.source_jid);
  if ('error' in rolesResult) return;
  const roles = rolesResult.roles;

  const delegation = getDelegation(delegationId);
  if (!delegation) return;
  syncWorkbenchOnDelegationCompleted(workflow.id, delegationId);
  writeWorkflowEvent({
    workflowId: workflow.id,
    eventType: 'delegation_completed',
    stateKey: workflow.status,
    refType: 'delegation',
    refId: delegationId,
    payload: {
      delegation_id: delegationId,
      artifact_refs: [],
      trace_id: null,
      attempt: 1,
    },
  });

  // If workflow is paused, delegation result is stored but state machine does not advance
  if (workflow.status === 'paused') {
    logger.info(
      { workflowId: workflow.id, delegationId },
      'Workflow is paused, delegation result stored but not advancing',
    );
    return;
  }

  logger.info(
    {
      workflowId: workflow.id,
      delegationId,
      currentStatus: workflow.status,
      result: delegation.result?.slice(0, 100),
    },
    'Workflow delegation completed',
  );

  // Look up current state config
  const stateConfig = config.states[workflow.status];
  if (
    !stateConfig ||
    stateConfig.type !== 'delegation' ||
    !stateConfig.on_complete
  ) {
    logger.warn(
      { workflowId: workflow.id, status: workflow.status },
      'Unexpected workflow status on delegation complete — no on_complete config',
    );
    return;
  }

  // Parse result summary and persisted workflow fields
  let resultSummary = delegation.result || '';
  let testDoc = '';
  const payload = parseDelegationPayload(delegation.result);
  const workflowUpdates: Parameters<typeof updateWorkflow>[1] = {};
  const contextUpdates: WorkflowContext = {};
  if (payload.summary) {
    resultSummary = payload.summary;
  } else if (payload.total !== undefined) {
    resultSummary = `总用例 ${payload.total}，通过 ${payload.passed}，失败 ${payload.failed}`;
    if (payload.bugs?.length) {
      resultSummary +=
        '\n' + payload.bugs.map((b) => `- ${b.id}: ${b.title}`).join('\n');
    }
  }
  if (payload.deliverable) {
    contextUpdates[WORKFLOW_CONTEXT_KEYS.deliverable] = payload.deliverable;
  }
  if (payload.main_branch) {
    contextUpdates[WORKFLOW_CONTEXT_KEYS.mainBranch] = payload.main_branch;
  }
  if (payload.work_branch) {
    contextUpdates[WORKFLOW_CONTEXT_KEYS.workBranch] = payload.work_branch;
  }
  if (payload.staging_base_branch) {
    contextUpdates[WORKFLOW_CONTEXT_KEYS.stagingBaseBranch] =
      payload.staging_base_branch;
  }
  if (payload.staging_work_branch) {
    contextUpdates[WORKFLOW_CONTEXT_KEYS.stagingWorkBranch] =
      payload.staging_work_branch;
  }
  if (payload.access_token) {
    contextUpdates[WORKFLOW_CONTEXT_KEYS.accessToken] = payload.access_token;
  }
  if (Object.keys(contextUpdates).length > 0) {
    workflowUpdates.context = contextUpdates;
  }
  if (typeof payload.test_doc === 'string' && payload.test_doc.trim()) {
    testDoc = payload.test_doc.trim();
  }

  const evaluationWorkflow: Workflow = {
    ...workflow,
    context: mergeWorkflowContext(workflow.context, contextUpdates),
  };
  const stageEvaluation = evaluateWorkflowStage({
    workflow: evaluationWorkflow,
    stageKey: workflow.status,
    delegation,
  });
  const contractEvaluation = evaluateWorkflowArtifactContract({
    workflow: evaluationWorkflow,
    contractRef:
      stateConfig.artifact_contract?.ref ||
      getWorkflowEvaluatorConfig(stateConfig.evaluator?.ref)?.deterministic
        ?.artifact_contract,
    payload: payload as unknown as Record<string, unknown>,
  });
  const evaluation = mergeEvaluationResults({
    stageEvaluation,
    contractEvaluation,
    evaluatorRef: stateConfig.evaluator?.ref,
  });
  const evaluationRecord = buildWorkflowStageEvaluationRecord({
    workflow: evaluationWorkflow,
    stageKey: workflow.status,
    delegation,
    result: evaluation,
  });
  createWorkflowStageEvaluation(evaluationRecord);
  workflowUpdates.context = mergeWorkflowContext(workflowUpdates.context || {}, {
    latest_evaluator_result: {
      state_key: workflow.status,
      evaluation_id: evaluationRecord.id,
      evaluator_ref: stateConfig.evaluator?.ref || evaluationRecord.evaluator_type,
      artifact_contract_ref: stateConfig.artifact_contract?.ref || null,
      status: evaluation.status,
      score: evaluation.score,
      summary: evaluation.summary,
      findings: evaluation.findings,
      evidence: evaluation.evidence,
      evaluated_at: evaluationRecord.updated_at,
    },
    ...(stateConfig.rollback_hint
      ? {
          latest_rollback_hint: {
            ref: stateConfig.rollback_hint.ref,
            state_key: workflow.status,
            evaluation_id: evaluationRecord.id,
          },
        }
      : {}),
  });
  writeWorkflowEvent({
    workflowId: workflow.id,
    eventType: 'artifact_evaluated',
    stateKey: workflow.status,
    refType: 'workflow_stage_evaluation',
    refId: evaluationRecord.id,
    payload: {
      artifact_contract_ref: stateConfig.artifact_contract?.ref || null,
      evaluator_ref: stateConfig.evaluator?.ref || evaluationRecord.evaluator_type,
      result: evaluation.status,
      findings: evaluation.findings,
      evidence: evaluation.evidence,
    },
  });
  syncWorkbenchOnStageEvaluated(
    workflow.id,
    workflow.status,
    evaluationRecord.id,
  );

  logger.info(
    {
      workflowId: workflow.id,
      delegationId,
      stageKey: workflow.status,
      evaluationStatus: evaluation.status,
      evaluationScore: evaluation.score,
    },
    'Workflow stage evaluated',
  );

  if (evaluation.summary) {
    resultSummary = evaluation.summary;
  }

  const evaluatorTransition = transitionForEvaluation(
    stateConfig,
    evaluation.status,
  );
  const retryExhaustedTransition =
    evaluation.status === 'pending'
      ? exhaustedRetryTransition(stateConfig)
      : undefined;

  if (
    evaluation.status === 'pending' &&
    !evaluatorTransition &&
    !retryExhaustedTransition
  ) {
    updateWorkflow(workflow.id, {
      current_delegation_id: '',
      ...(workflowUpdates.context ? { context: workflowUpdates.context } : {}),
    });
    const pendingWorkflow = getWorkflow(workflow.id);
    if (pendingWorkflow) {
      writeWorkflowCheckpoint({
        workflow: pendingWorkflow,
        currentDelegationId: null,
      });
    }
    syncWorkbenchOnWorkflowUpdated(workflow.id, evaluation.summary);
    syncWorkbenchOnStageEvaluationActionNeeded(
      workflow.id,
      workflow.status,
      evaluationRecord.id,
      { keepVisibleWhenCurrentStage: true },
    );
    scheduleEvaluatorRetryIfConfigured({
      workflow: pendingWorkflow || workflow,
      stateConfig,
      evaluationId: evaluationRecord.id,
    });
    notifyMain(
      `[阶段评测] 需求「${workflow.name}」(${workflow.id}) 在阶段 ${config.status_labels[workflow.status] || workflow.status} 缺少充分证据，已停止自动流转。\n\n${evaluation.summary}\n\n请补充交付物或结果后重跑当前阶段。`,
      workflow.source_jid,
      workflow.id,
    );
    return;
  }

  const transition = evaluatorTransition || retryExhaustedTransition;
  if (!transition) {
    logger.warn(
      {
        workflowId: workflow.id,
        status: workflow.status,
        evaluationStatus: evaluation.status,
      },
      'No transition defined for evaluated outcome',
    );
    return;
  }

  const targetState = config.states[transition.target];
  const shouldCreateEvaluationActionItem =
    transition.target === workflow.status || targetState?.type === 'terminal';

  applyTransition(workflow, transition, roles, {
    delegationResult: delegation.result || '',
    resultSummary,
    testDoc,
    workflowUpdates,
  });

  if (shouldCreateEvaluationActionItem) {
    syncWorkbenchOnStageEvaluationActionNeeded(
      workflow.id,
      targetState?.type === 'terminal' ? transition.target : workflow.status,
      evaluationRecord.id,
      {
        keepVisibleWhenCurrentStage: transition.target === workflow.status,
      },
    );
  }
}

// -------------------------------------------------------
// Card helpers — config-driven
// -------------------------------------------------------

function buildConfigCard(
  workflow: Workflow,
  cardKey: string,
): InteractiveCard | null {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return null;

  const cardConfig = getCardConfig(workflow.workflow_type, cardKey);
  if (!cardConfig) return null;

  const vars = buildTemplateVars(workflow);
  const rolesResult = resolveRoles(workflow.workflow_type, workflow.source_jid);
  const roleFolders = 'roles' in rolesResult ? rolesResult.roles : {};
  const interrupt =
    config.states[workflow.status]?.type === 'interrupt'
      ? getPendingWorkflowInterruptForState(workflow.id, workflow.status) ||
        createPendingInterruptForState(workflow)
      : null;
  const payloadSchema = interrupt
    ? parseSchema(interrupt.resume_payload_schema_json)
    : undefined;

  return buildInteractiveCard(cardConfig, {
    workflowId: workflow.id,
    interruptId: interrupt?.id,
    allowedActions: interrupt
      ? parseJsonArray(interrupt.allowed_actions_json)
      : undefined,
    payloadSchema,
    vars,
    roleFolders,
  });
}

/** Send a card defined in config to the main group (scoped to workflow's source channel). */
function sendConfigCard(workflow: Workflow, cardKey: string): void {
  const { sendCard } = getDeps();
  const groups = getDeps().registeredGroups();
  const mainJid = findMainJid(groups, workflow.source_jid);
  if (!mainJid) {
    logger.warn('Workflow: cannot send card — main group not found');
    return;
  }

  if (sendCard) {
    const card = buildConfigCard(workflow, cardKey);
    if (card) {
      sendCard(mainJid, card).catch((err) => {
        logger.error(
          { err, workflowId: workflow.id, cardKey },
          'Failed to send workflow card, falling back to text',
        );
        // Fallback: send text notification
        const card = buildConfigCard(workflow, cardKey);
        if (card) {
          notifyMain(
            `[流程进展] ${card.header.title}\n\n${card.body || ''}`.trim(),
            workflow.source_jid,
            workflow.id,
          );
        }
      });
    }
  } else {
    // Fallback: no card support
    const card = buildConfigCard(workflow, cardKey);
    if (card) {
      notifyMain(
        `${`[流程进展] ${card.header.title}\n\n${card.body || ''}`.trim()}\n\n请确认是否继续。`,
        workflow.source_jid,
        workflow.id,
      );
    }
  }
}

function buildWorkflowListCard(workflows: Workflow[]): InteractiveCard {
  const sections: CardSection[] = [];

  for (const w of workflows) {
    const config = getWorkflowTypeConfig(w.workflow_type);
    const labels = config?.status_labels || {};
    const terminalStates = config ? getTerminalStates(config) : [];

    const statusLabel =
      w.status === 'paused'
        ? `⏸ 已中断（原状态：${labels[w.paused_from || ''] || w.paused_from || '未知'}）`
        : labels[w.status] || w.status;
    const workBranch = getWorkflowContextValue(
      w,
      WORKFLOW_CONTEXT_KEYS.workBranch,
    );
    const stagingWorkBranch = getWorkflowContextValue(
      w,
      WORKFLOW_CONTEXT_KEYS.stagingWorkBranch,
    );

    const body = `**${w.id}** ${w.name} (${w.service})\n状态：${statusLabel}${w.round > 0 ? ` | Round ${w.round}` : ''}${workBranch ? `\n工作分支：${workBranch}` : ''}${stagingWorkBranch ? `\n预发工作分支：${stagingWorkBranch}` : ''}`;

    const buttons: CardButton[] = [];
    const interruptStates = config ? getInterruptStates(config) : [];

    if (interruptStates.includes(w.status)) {
      const interrupt = getPendingWorkflowInterruptForState(w.id, w.status);
      if (w.status === 'testing_confirm') {
        buttons.push(
          {
            id: 'skip',
            label: '⏭ 跳过鉴权直接测试',
            value: {
              workflow_id: w.id,
              interrupt_id: interrupt?.id || '',
              action: 'workflow_interrupt_resume',
              resume_action: 'skip',
            },
          },
          {
            id: 'pause',
            label: '⏸ 中断',
            value: { workflow_id: w.id, action: 'pause_workflow' },
          },
          {
            id: 'cancel',
            label: '❌ 取消',
            type: 'danger',
            value: { workflow_id: w.id, action: 'cancel_workflow' },
          },
        );
      } else {
        buttons.push(
          {
            id: 'approve',
            label: '✅ 确认部署',
            type: 'primary',
            value: {
              workflow_id: w.id,
              interrupt_id: interrupt?.id || '',
              action: 'workflow_interrupt_resume',
              resume_action: 'approve',
            },
          },
          {
            id: 'pause',
            label: '⏸ 中断',
            value: { workflow_id: w.id, action: 'pause_workflow' },
          },
          {
            id: 'cancel',
            label: '❌ 取消',
            type: 'danger',
            value: { workflow_id: w.id, action: 'cancel_workflow' },
          },
        );
      }
    } else if (w.status === 'paused') {
      buttons.push(
        {
          id: 'resume',
          label: '▶ 继续',
          type: 'primary',
          value: { workflow_id: w.id, action: 'resume' },
        },
        {
          id: 'cancel',
          label: '❌ 取消',
          type: 'danger',
          value: { workflow_id: w.id, action: 'cancel_workflow' },
        },
      );
    } else if (!terminalStates.includes(w.status)) {
      buttons.push(
        {
          id: 'pause',
          label: '⏸ 中断',
          value: { workflow_id: w.id, action: 'pause_workflow' },
        },
        {
          id: 'cancel',
          label: '❌ 取消',
          type: 'danger',
          value: { workflow_id: w.id, action: 'cancel_workflow' },
        },
      );
    }

    sections.push({ body, buttons: buttons.length > 0 ? buttons : undefined });
  }

  return {
    header: { title: '📊 流程列表', color: 'blue' },
    sections,
  };
}

// -------------------------------------------------------
// Cancel / Pause / Resume
// -------------------------------------------------------

export function cancelWorkflow(workflowId: string): { error?: string } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };

  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const terminalStates = config
    ? getTerminalStates(config)
    : ['passed', 'ops_failed', 'cancelled'];

  if (terminalStates.includes(workflow.status)) {
    return { error: `流程已结束 (${workflow.status})` };
  }
  updateWorkflow(workflowId, {
    status: 'cancelled',
    current_delegation_id: '',
  });
  const closed = closePendingWorkflowInterrupts(
    workflowId,
    'cancelled',
    new Date().toISOString(),
  );
  for (const interrupt of closed) {
    writeWorkflowEvent({
      workflowId,
      eventType: 'interrupt_cancelled',
      stateKey: interrupt.state_key,
      refType: 'workflow_interrupt',
      refId: interrupt.id,
      payload: {
        interrupt_id: interrupt.id,
        reason: 'workflow_cancelled',
      },
    });
  }
  const updatedWorkflow = getWorkflow(workflowId);
  if (updatedWorkflow) {
    ensureWorkflowStateDurableRecords(
      updatedWorkflow,
      'transition',
      workflow.status,
    );
  }
  syncWorkbenchOnTransition(workflowId, workflow.status, 'cancelled');
  syncWorkbenchOnWorkflowUpdated(workflowId, '任务已取消', {
    emitRealtime: false,
  });
  notifyMain(
    `[流程取消] 需求「${workflow.name}」(${workflowId}) 已取消。`,
    workflow.source_jid,
    workflowId,
  );
  return {};
}

export function pauseWorkflow(workflowId: string): { error?: string } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };

  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const terminalStates = config
    ? getTerminalStates(config)
    : ['passed', 'ops_failed', 'cancelled'];

  if (
    terminalStates.includes(workflow.status) ||
    workflow.status === 'paused'
  ) {
    return { error: `流程当前状态 ${workflow.status}，无法中断` };
  }
  updateWorkflow(workflowId, {
    status: 'paused',
    paused_from: workflow.status,
  });
  syncWorkbenchOnTransition(workflowId, workflow.status, 'paused');
  syncWorkbenchOnWorkflowUpdated(workflowId, '任务已暂停', {
    emitRealtime: false,
  });
  notifyMain(
    `[流程中断] 需求「${workflow.name}」(${workflowId}) 已中断，可随时恢复。`,
    workflow.source_jid,
    workflowId,
  );
  return {};
}

export function resumeWorkflow(workflowId: string): { error?: string } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return { error: `流程 ${workflowId} 不存在` };
  if (workflow.status !== 'paused' || !workflow.paused_from) {
    return { error: `流程当前状态 ${workflow.status}，不是中断状态` };
  }

  // Check if delegation completed while paused
  if (workflow.current_delegation_id) {
    const delegation = getDelegation(workflow.current_delegation_id);
    if (delegation?.status === 'completed') {
      // Agent completed work while paused — restore state then advance
      updateWorkflow(workflowId, {
        status: workflow.paused_from,
        paused_from: null,
      });
      syncWorkbenchOnTransition(
        workflowId,
        workflow.status,
        workflow.paused_from,
      );
      onDelegationComplete(workflow.current_delegation_id);
      notifyMain(
        `[流程恢复] 需求「${workflow.name}」(${workflowId}) 已恢复，中断期间任务已完成，自动推进。`,
        workflow.source_jid,
        workflowId,
      );
      return {};
    }
    if (delegation?.status === 'pending') {
      // Agent still running — restore state, wait for natural completion
      updateWorkflow(workflowId, {
        status: workflow.paused_from,
        paused_from: null,
      });
      syncWorkbenchOnTransition(
        workflowId,
        workflow.status,
        workflow.paused_from,
      );
      syncWorkbenchOnWorkflowUpdated(workflowId, '任务已恢复，委派仍在执行', {
        emitRealtime: false,
      });
      notifyMain(
        `[流程恢复] 需求「${workflow.name}」(${workflowId}) 已恢复，任务仍在执行中。`,
        workflow.source_jid,
        workflowId,
      );
      return {};
    }
  }

  // No active delegation (e.g. paused_from is an interrupt state) — restore state
  updateWorkflow(workflowId, {
    status: workflow.paused_from,
    paused_from: null,
  });
  syncWorkbenchOnTransition(workflowId, workflow.status, workflow.paused_from);
  syncWorkbenchOnWorkflowUpdated(workflowId, '任务已恢复', {
    emitRealtime: false,
  });
  notifyMain(
    `[流程恢复] 需求「${workflow.name}」(${workflowId}) 已恢复。`,
    workflow.source_jid,
    workflowId,
  );

  // If resuming to an interrupt state, resend its card
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (config) {
    const resumedStateConfig = config.states[workflow.paused_from];
    if (
      resumedStateConfig?.type === 'interrupt' &&
      resumedStateConfig.card
    ) {
      const updatedWorkflow = getWorkflow(workflowId);
      if (updatedWorkflow) {
        ensureWorkflowStateDurableRecords(updatedWorkflow, 'resume', 'paused');
        sendConfigCard(updatedWorkflow, resumedStateConfig.card);
      }
    }
  }
  return {};
}

// -------------------------------------------------------
// Card action handler
// -------------------------------------------------------

export function handleCardAction(action: {
  action: string;
  user_id: string;
  message_id: string;
  group_folder?: string;
  workflow_id?: string;
  form_value?: Record<string, string>;
}): void {
  logger.info({ action }, 'Handling card action');

  // Resolve source_jid from the workflow for channel-aware notifications
  const wfSourceJid = action.workflow_id
    ? getWorkflow(action.workflow_id)?.source_jid
    : undefined;

  /** Display label for notifications. */
  const getLabel = (): string => {
    if (action.workflow_id) {
      const wf = getWorkflow(action.workflow_id);
      if (wf) return `需求「${wf.name}」(${wf.id})`;
    }
    return action.workflow_id || '未知';
  };

  const buildIdempotencyKey = (interruptId: string, resumeAction: string) =>
    [
      'card',
      action.message_id || '',
      action.user_id || '',
      interruptId,
      resumeAction,
    ].join(':');

  if (action.action === 'workflow_interrupt_resume') {
    const resolvedInterruptId =
      action.form_value?.interrupt_id ||
      (action as { interrupt_id?: string }).interrupt_id ||
      '';
    const resumeAction =
      action.form_value?.resume_action ||
      (action as { resume_action?: string }).resume_action ||
      '';
    if (!resolvedInterruptId || !resumeAction) {
      notifyMain('[操作失败] 缺少中断 ID 或恢复动作', wfSourceJid);
      return;
    }
    const payload = Object.fromEntries(
      Object.entries(action.form_value || {}).filter(
        ([key]) =>
          ![
            'action',
            'workflow_id',
            'interrupt_id',
            'resume_action',
            'resume_payload_schema',
          ].includes(key),
      ),
    );
    const result = resumeWorkflowInterrupt({
      interruptId: resolvedInterruptId,
      action: resumeAction,
      payload,
      actor: {
        channel: 'feishu',
        userId: action.user_id,
      },
      idempotencyKey: buildIdempotencyKey(
        resolvedInterruptId,
        resumeAction,
      ),
    });
    if (!result.ok) {
      notifyMain(
        `[操作失败] 恢复流程中断失败: ${result.error}`,
        wfSourceJid,
        action.workflow_id,
      );
    }
    return;
  }

  switch (action.action) {
    case 'pause':
    case 'pause_workflow': {
      if (!action.workflow_id) {
        notifyMain('[操作失败] 缺少流程 ID', wfSourceJid);
        break;
      }
      const result = pauseWorkflow(action.workflow_id);
      if (result.error)
        notifyMain(
          `[操作失败] 中断流程失败: ${result.error}`,
          wfSourceJid,
          action.workflow_id,
        );
      break;
    }
    case 'resume': {
      if (!action.workflow_id) {
        notifyMain('[操作失败] 缺少流程 ID', wfSourceJid);
        break;
      }
      const result = resumeWorkflow(action.workflow_id);
      if (result.error)
        notifyMain(
          `[操作失败] 恢复流程失败: ${result.error}`,
          wfSourceJid,
          action.workflow_id,
        );
      break;
    }
    case 'cancel':
    case 'cancel_workflow': {
      if (!action.workflow_id) {
        notifyMain('[操作失败] 缺少流程 ID', wfSourceJid);
        break;
      }
      const result = cancelWorkflow(action.workflow_id);
      if (result.error)
        notifyMain(
          `[操作失败] 取消流程失败: ${result.error}`,
          wfSourceJid,
          action.workflow_id,
        );
      break;
    }
    case 'memory_conflict_keep': {
      const folder = action.group_folder;
      const keepId = action.form_value?.keep_id;
      const deprecateId = action.form_value?.deprecate_id;
      if (!folder || !keepId || !deprecateId) {
        notifyMain('[操作失败] 记忆冲突处理缺少必要参数。', wfSourceJid);
        break;
      }
      notifyGroupFolder(
        folder,
        '记忆冲突指令',
        [
          '[记忆冲突处理] 用户已选择保留方案。',
          `请调用 memory_resolve_conflict(mode="keep", keep_id="${keepId}", deprecate_id="${deprecateId}")`,
          '完成后请反馈处理结果。',
        ].join('\n'),
      );
      break;
    }
    case 'memory_conflict_merge': {
      const folder = action.group_folder;
      const mergedContent = action.form_value?.merged_content?.trim();
      const mergeA = action.form_value?.merge_id_a;
      const mergeB = action.form_value?.merge_id_b;
      if (!folder || !mergeA || !mergeB) {
        notifyMain('[操作失败] 合并冲突缺少必要参数。', wfSourceJid);
        break;
      }
      if (!mergedContent) {
        notifyGroupFolder(folder, '记忆整理', '请填写合并内容后再提交。');
        break;
      }
      notifyGroupFolder(
        folder,
        '记忆冲突指令',
        [
          '[记忆冲突处理] 用户已选择合并方案。',
          `请调用 memory_resolve_conflict(mode="merge", merge_ids=["${mergeA}","${mergeB}"], merged_content="${mergedContent.replace(/"/g, '\\"')}")`,
          '完成后请反馈处理结果。',
        ].join('\n'),
      );
      break;
    }
    case 'memory_conflict_skip': {
      const folder = action.group_folder;
      if (!folder) {
        notifyMain('[操作失败] 缺少 group_folder。', wfSourceJid);
        break;
      }
      notifyGroupFolder(folder, '记忆整理', '已跳过该冲突，稍后可继续处理。');
      break;
    }
    default:
      logger.warn({ action: action.action }, 'Unknown card action');
  }
}

/** Check if workflow engine is enabled. */
export function isWorkflowEnabled(): boolean {
  return getWorkflowConfigs() !== null;
}

/** Get the reason workflow is disabled (for diagnostics). */
export function getWorkflowDisabledReason(): string | null {
  return getWorkflowConfigError();
}

/** Get status labels for a workflow type. */
export function getStatusLabelsForType(
  workflowType: string,
): Record<string, string> {
  const config = getWorkflowTypeConfig(workflowType);
  return config?.status_labels || {};
}

/** Return summary of all available workflow types for UI/task creation. */
export function getAvailableWorkflowTypes(): Array<{
  type: string;
  name: string;
  entry_points: string[];
  entry_points_detail: Record<
    string,
    {
      requires_deliverable: boolean;
      deliverable_role?: string;
      required_deliverable_file?: string;
    }
  >;
  role_channels: Record<string, Record<string, string>>;
  create_form?: WorkflowCreateForm;
}> {
  const configs = getWorkflowConfigs();
  if (!configs) return [];

  return Object.entries(configs).map(([typeName, config]) => ({
    type: typeName,
    name: config.name,
    entry_points: Object.keys(config.entry_points),
    entry_points_detail: Object.fromEntries(
      Object.entries(config.entry_points).map(([name, ep]) => [
        name,
        {
          requires_deliverable: ep.requires_deliverable || false,
          deliverable_role: ep.deliverable_role,
          required_deliverable_file: ep.requires_deliverable
            ? getDeliverableFileNameForRole(ep.deliverable_role)
            : undefined,
        },
      ]),
    ),
    role_channels: Object.fromEntries(
      Object.entries(config.roles).map(([role, rc]) => [role, rc.channels]),
    ),
    create_form: config.create_form,
  }));
}
