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
import { buildCardActionPayload } from './card-action-payload.js';
import { PROJECT_ROOT, WEB_UPLOADS_DIR } from './config.js';
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
  getDelegationsByWorkflow,
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
import { getWorkflowActionHandler } from './workflow-actions/index.js';
import {
  Delegation,
  CardButton,
  CardActionResult,
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
  StateConfig,
  StateTransition,
  TemplateVars,
  WorkflowTypeConfig,
} from './workflow-config.js';
import {
  WorkflowCreateForm,
  WorkflowDefinitionSystemRunStep,
  WorkflowDefinitionTransition,
  WorkflowManualRequirementCreateConfig,
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
import {
  evaluateWorkflowArtifactContract,
  getWorkflowArtifactContract,
} from './workflow-artifact-contract.js';
import { getWorkflowEvaluatorConfig } from './workflow-evaluator-registry.js';
import {
  buildWorkflowHandoffEnvelope,
  getDelegationArtifactContractRef,
  normalizeWorkflowHandoffEnvelope,
  parseDelegationHandoffResult,
  WorkflowHandoffEnvelope,
} from './workflow-handoff.js';
import {
  buildQueuedWorkflowLlmJudgeRecord,
  runWorkflowLlmJudgeSidecar,
  shouldRunWorkflowLlmJudgeNow,
} from './workflow-llm-judge.js';
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

const TEST_CASE_FILE_BASENAME = 'test-cases';
const WORKFLOW_CONTEXT_STAGE_RESULTS_KEY = 'stage_results';
const WORKFLOW_CONTEXT_LATEST_DELEGATION_RESULT_KEY =
  'latest_delegation_result';

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
  minimum?: number;
  maximum?: number;
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
  handoffEnvelope: WorkflowHandoffEnvelope;
}

interface SystemRunResult {
  status: 'success' | 'failure' | 'pending';
  output: Record<string, unknown>;
  contextPatch: WorkflowContext;
  summary?: string;
  error?: string;
}

type WorkflowActionStepScope = 'system' | 'before_delegate' | 'after_complete';

interface WorkflowTransitionExtra {
  fromStatusOverride?: string;
  delegationResult?: string;
  resultSummary?: string;
  revisionText?: string;
  accessToken?: string;
  testDoc?: string;
  workflowUpdates?: Parameters<typeof updateWorkflow>[1];
  fallbackToTargetDelegate?: boolean;
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

function describeSchemaForPrompt(schema: unknown): string {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return 'any';
  }
  const typed = schema as {
    type?: unknown;
    minLength?: unknown;
    maxLength?: unknown;
    enum?: unknown;
  };
  const parts: string[] = [];
  if (typeof typed.type === 'string') parts.push(typed.type);
  if (typeof typed.minLength === 'number') {
    parts.push(`minLength=${typed.minLength}`);
  }
  if (typeof typed.maxLength === 'number') {
    parts.push(`maxLength=${typed.maxLength}`);
  }
  if (Array.isArray(typed.enum) && typed.enum.length > 0) {
    parts.push(`enum=${typed.enum.map((item) => String(item)).join('|')}`);
  }
  return parts.join(', ') || 'any';
}

function buildArtifactContractPrompt(contractRef?: string): string {
  if (!contractRef) return '';
  const contract = getWorkflowArtifactContract(contractRef);
  if (!contract) {
    return [
      'artifact_contract:',
      `- id: ${contractRef}`,
      '- details: 未找到契约定义，请按 success_criteria 交付。',
    ].join('\n');
  }

  const lines = ['artifact_contract:', `- id: ${contract.id}`];
  if (contract.description)
    lines.push(`- description: ${contract.description}`);

  lines.push('- result_required:');
  for (const field of ['verdict', 'summary', 'findings', 'evidence']) {
    const type =
      field === 'verdict'
        ? 'passed | failed | needs_revision | pending'
        : field === 'summary'
          ? 'string'
          : 'array';
    lines.push(`  - ${field}: ${type}`);
  }
  const payloadRequired = Array.from(
    new Set(
      (contract.payload?.required || []).filter(
        (field): field is string => typeof field === 'string' && !!field,
      ),
    ),
  );
  for (const field of payloadRequired) {
    const schema = contract.payload?.properties?.[field];
    lines.push(`  - ${field}: ${describeSchemaForPrompt(schema)}`);
  }

  const files = contract.files || [];
  if (files.length > 0) {
    lines.push('- files:');
    for (const file of files) {
      const requirement =
        file.required || file.must_exist ? 'required' : 'optional';
      lines.push(`  - path: ${file.path}`);
      lines.push(`    required: ${requirement}`);
      if (file.frontmatter_required?.length) {
        lines.push(
          `    frontmatter_required: ${file.frontmatter_required.join(', ')}`,
        );
      }
      if (file.max_bytes) lines.push(`    max_bytes: ${file.max_bytes}`);
    }
  }

  return lines.join('\n');
}

/** Inject a message into a group's chat to trigger the agent. */
function injectDelegation(
  targetJid: string,
  targetGroup: RegisteredGroup,
  delegationId: string,
  workflowId: string,
  skillName: string,
  taskContent: string,
  handoffEnvelope?: WorkflowHandoffEnvelope,
): void {
  const { enqueueMessageCheck } = getDeps();
  const now = Date.now().toString();

  storeChatMetadata(targetJid, now);

  const artifactContractText = buildArtifactContractPrompt(
    handoffEnvelope?.contract.artifact_contract_ref,
  );
  const contractText = handoffEnvelope
    ? [
        '[Typed Handoff]',
        `skill: ${handoffEnvelope.skill}`,
        `success_criteria:\n${handoffEnvelope.contract.success_criteria.map((item) => `- ${item}`).join('\n')}`,
        artifactContractText,
        '',
        'complete_delegation.result 必须返回 JSON object，包含 result_required 中列出的字段，并满足文件产物要求。',
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const syntheticContent = `${targetGroup.trigger} [委派任务 | ID:${delegationId} | 来自:流程引擎 | 流程:${workflowId}]\n\n请按照 ${skillName} 技能执行以下任务：\n\n${contractText ? `${contractText}\n\n` : ''}${taskContent}\n\n完成后请调用 complete_delegation 工具报告结果，delegation_id 为 "${delegationId}"。`;
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
  stageKey: string;
  role: string;
  skillName: string;
  taskContent: string;
  handoff?: StateTransition['handoff'];
  artifactContractRef?: string;
  workflowForHandoff?: Workflow;
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
  const workflow = input.workflowForHandoff || getWorkflow(input.workflowId);
  if (!workflow) {
    throw new Error(`Workflow: workflow "${input.workflowId}" not found`);
  }
  const handoffEnvelope = normalizeWorkflowHandoffEnvelope(
    buildWorkflowHandoffEnvelope({
      workflow,
      stageKey: input.stageKey,
      role: input.role,
      skill: input.skillName,
      taskContent: input.taskContent,
      handoff: input.handoff,
      artifactContractRef: input.artifactContractRef,
    }),
  );

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
    handoff_role: handoffEnvelope.role,
    handoff_skill: handoffEnvelope.skill,
    handoff_contract_json: JSON.stringify(handoffEnvelope.contract),
    handoff_input_json: JSON.stringify(handoffEnvelope.input),
    handoff_result_json: null,
    handoff_validation_status: null,
    handoff_validation_errors_json: null,
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
      handoffEnvelope,
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
    handoffEnvelope,
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

function enqueueWorkflowCreatedSync(workflowId: string): void {
  enqueueWorkflowWorkbenchSync(
    workflowId,
    'workflow_created',
    {},
    'workflow_created',
  );
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

function parseOutboxPayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getNestedValue(
  value: unknown,
  pathParts: string[],
): unknown | undefined {
  let current = value;
  for (const part of pathParts) {
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function resolveSystemTemplateExpression(
  expression: string,
  vars: TemplateVars,
  roles: Record<string, string>,
  steps: Record<string, unknown>,
): unknown {
  if (expression.startsWith('role_folder:')) {
    return roles[expression.slice('role_folder:'.length)] || '';
  }
  if (expression.startsWith('steps.')) {
    return getNestedValue(steps, expression.slice('steps.'.length).split('.'));
  }
  if (expression.startsWith('context.')) {
    return getNestedValue(
      vars.context,
      expression.slice('context.'.length).split('.'),
    );
  }
  if (expression.includes('.')) {
    return getNestedValue(vars, expression.split('.'));
  }
  return vars[expression];
}

function stringifySystemTemplateValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function renderSystemParamValue(
  value: unknown,
  vars: TemplateVars,
  roles: Record<string, string>,
  steps: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{([^{}]+)\}\}$/);
    if (exact) {
      const resolved = resolveSystemTemplateExpression(
        exact[1].trim(),
        vars,
        roles,
        steps,
      );
      return resolved === undefined ? '' : resolved;
    }
    return value.replace(/\{\{([^{}]+)\}\}/g, (_match, expression: string) =>
      stringifySystemTemplateValue(
        resolveSystemTemplateExpression(expression.trim(), vars, roles, steps),
      ),
    );
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      renderSystemParamValue(item, vars, roles, steps),
    );
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, childValue]) => [
        key,
        renderSystemParamValue(childValue, vars, roles, steps),
      ]),
    );
  }

  return value;
}

function renderSystemStepParams(
  params: Record<string, unknown> | undefined,
  workflow: Workflow,
  roles: Record<string, string>,
  steps: Record<string, unknown>,
): Record<string, unknown> {
  const vars = buildTemplateVars(workflow);
  const rendered = renderSystemParamValue(params || {}, vars, roles, steps);
  return isPlainObject(rendered) ? rendered : {};
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
    handoff: definitionTransition.delegate?.handoff,
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
      const message =
        typeof payload.message === 'string' ? payload.message : '';
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
    } else if (record.effect_type === 'refresh_feishu_card') {
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
      const handoffEnvelope =
        payload.handoffEnvelope &&
        typeof payload.handoffEnvelope === 'object' &&
        !Array.isArray(payload.handoffEnvelope)
          ? (payload.handoffEnvelope as unknown as WorkflowHandoffEnvelope)
          : undefined;
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
          handoffEnvelope,
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
      } else if (effect === 'workflow_created') {
        syncWorkbenchOnWorkflowCreated(record.workflow_id);
      } else if (effect === 'delegation_completed') {
        const delegationId =
          typeof payload.delegationId === 'string' ? payload.delegationId : '';
        if (delegationId) {
          syncWorkbenchOnDelegationCompleted(record.workflow_id, delegationId);
        }
      } else if (effect === 'stage_evaluated') {
        const stageKey =
          typeof payload.stageKey === 'string' ? payload.stageKey : '';
        const evaluationId =
          typeof payload.evaluationId === 'string' ? payload.evaluationId : '';
        if (stageKey && evaluationId) {
          syncWorkbenchOnStageEvaluated(
            record.workflow_id,
            stageKey,
            evaluationId,
          );
        }
      } else if (effect === 'stage_evaluation_action_needed') {
        const stageKey =
          typeof payload.stageKey === 'string' ? payload.stageKey : '';
        const evaluationId =
          typeof payload.evaluationId === 'string' ? payload.evaluationId : '';
        if (stageKey && evaluationId) {
          syncWorkbenchOnStageEvaluationActionNeeded(
            record.workflow_id,
            stageKey,
            evaluationId,
            {
              keepVisibleWhenCurrentStage:
                payload.keepVisibleWhenCurrentStage === true,
            },
          );
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
      invalid.push(
        `${workflow.id}: unknown workflow_type ${workflow.workflow_type}`,
      );
      continue;
    }
    if (workflow.status !== 'paused' && !state) {
      invalid.push(`${workflow.id}: unknown state ${workflow.status}`);
    }
    if ((state as { type?: string } | undefined)?.type === 'confirmation') {
      invalid.push(
        `${workflow.id}: legacy confirmation state ${workflow.status}`,
      );
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
  } else if (state?.type === 'system') {
    const attempts = parseCheckpointAttempts(workflow.id);
    const attempt = attempts[workflow.status] || 1;
    const idempotencyKey = `workflow_system:${workflow.id}:${workflow.status}:${workflow.round}:${attempt}`;
    if (!getWorkflowEventByIdempotencyKey(idempotencyKey)) {
      runSystemState(workflow, 'transition');
    } else {
      writeWorkflowCheckpoint({ workflow });
    }
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
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs < state.timeout_policy.duration_ms
  ) {
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
    compileDefinitionTransitionToStateTransition(
      state.timeout_policy.on_timeout,
    ),
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
    runWorkflowTransaction(() => {
      const latest = getWorkflow(workflow.id);
      if (latest && !isTerminalStatus(latest)) recoverActiveWorkflow(latest);
    });
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

export function runWorkflowWatchdogOnce(
  nowIso = new Date().toISOString(),
): void {
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
              attempt:
                parseCheckpointAttempts(workflow.id)[workflow.status] || 1,
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
        processDueEvaluatorRetry(latest, nowIso);
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

function isPathInsideDir(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(
    path.resolve(baseDir),
    path.resolve(targetPath),
  );
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function mapProjectHostPathToAgentPath(filePath: string): string {
  const relative = path.relative(
    path.join(PROJECT_ROOT, 'projects'),
    path.resolve(filePath),
  );
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return filePath;
  }
  return `/workspace/projects/${relative.split(path.sep).join('/')}`;
}

function sanitizeProjectMarkdownFilename(
  filePath: string,
  index: number,
): string {
  const ext = path.extname(filePath).toLowerCase() || '.md';
  const safeExt = /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '.md';
  return `${TEST_CASE_FILE_BASENAME}${index === 0 ? '' : `-${index + 1}`}${safeExt}`;
}

function uniquePathInDir(dir: string, filename: string): string {
  const parsed = path.parse(filename);
  let candidate = path.join(dir, filename);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

function normalizeTestCaseFilePaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is string =>
            typeof item === 'string' && item.trim().length > 0,
        )
        .map((item) => item.trim())
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((item) => item.trim().length > 0)));
}

function listDeliverableTestCaseFiles(
  service: string,
  deliverable: string,
): string[] {
  const deliverableDir = path.join(
    PROJECT_ROOT,
    'projects',
    service,
    'iteration',
    deliverable,
  );
  if (!fs.existsSync(deliverableDir)) return [];
  return fs
    .readdirSync(deliverableDir)
    .filter(
      (fileName) =>
        fileName === `${TEST_CASE_FILE_BASENAME}.md` ||
        /^test-cases-\d+\.md$/i.test(fileName),
    )
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((fileName) =>
      mapProjectHostPathToAgentPath(path.join(deliverableDir, fileName)),
    );
}

function materializeTestCaseFilesForDeliverable(
  workflow: Workflow,
  context: WorkflowContext,
): WorkflowContext {
  const deliverable =
    typeof context[WORKFLOW_CONTEXT_KEYS.deliverable] === 'string'
      ? String(context[WORKFLOW_CONTEXT_KEYS.deliverable]).trim()
      : getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.deliverable);
  if (!deliverable) return {};

  const originalFiles = normalizeTestCaseFilePaths(
    context[WORKFLOW_CONTEXT_KEYS.testCaseFiles] ??
      workflow.context[WORKFLOW_CONTEXT_KEYS.testCaseFiles],
  );
  const currentFiles = uniqueStrings([
    ...originalFiles,
    ...listDeliverableTestCaseFiles(workflow.service, deliverable),
  ]);
  if (currentFiles.length === 0) return {};

  const deliverableDir = path.join(
    PROJECT_ROOT,
    'projects',
    workflow.service,
    'iteration',
    deliverable,
  );
  if (!fs.existsSync(deliverableDir)) return {};

  const materializedFiles = uniqueStrings(
    currentFiles.map((filePath, index) => {
      if (filePath.startsWith('/workspace/projects/')) return filePath;

      const resolvedPath = path.resolve(filePath);
      if (isPathInsideDir(deliverableDir, resolvedPath)) {
        return mapProjectHostPathToAgentPath(resolvedPath);
      }

      if (!isPathInsideDir(WEB_UPLOADS_DIR, resolvedPath)) return filePath;
      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return filePath;
      }

      const destination = uniquePathInDir(
        deliverableDir,
        sanitizeProjectMarkdownFilename(resolvedPath, index),
      );
      fs.copyFileSync(resolvedPath, destination);
      return mapProjectHostPathToAgentPath(destination);
    }),
  );

  const changed =
    materializedFiles.length !== originalFiles.length ||
    materializedFiles.some((item, index) => item !== originalFiles[index]);

  return changed
    ? { [WORKFLOW_CONTEXT_KEYS.testCaseFiles]: materializedFiles }
    : {};
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

function getWorkflowDeliverableFileName(
  workflowType: string,
  role?: string,
): string {
  const config = getWorkflowTypeConfig(workflowType);
  return getDeliverableFileNameForRole(role, config?.roles);
}

function getWorkflowEntryPointDeliverableFileName(
  config: WorkflowTypeConfig,
  role?: string,
): string {
  return getDeliverableFileNameForRole(role, config.roles);
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

function getDelegationPayload(
  delegation: Delegation | null | undefined,
): ParsedDelegationPayload {
  const handoffPayload = parseDelegationHandoffResult(delegation);
  if (handoffPayload)
    return handoffPayload as unknown as ParsedDelegationPayload;
  return parseDelegationPayload(delegation?.result);
}

function buildDelegationResultContextPatch(
  workflow: Workflow,
  delegation: Delegation,
  payload: unknown,
): WorkflowContext {
  if (!isPlainObject(payload) || Object.keys(payload).length === 0) return {};

  const existingStageResults = isPlainObject(
    workflow.context[WORKFLOW_CONTEXT_STAGE_RESULTS_KEY],
  )
    ? (workflow.context[WORKFLOW_CONTEXT_STAGE_RESULTS_KEY] as Record<
        string,
        unknown
      >)
    : {};
  const payloadRecord = { ...payload };

  return {
    [WORKFLOW_CONTEXT_STAGE_RESULTS_KEY]: {
      ...existingStageResults,
      [workflow.status]: payloadRecord,
    },
    [WORKFLOW_CONTEXT_LATEST_DELEGATION_RESULT_KEY]: {
      state_key: workflow.status,
      delegation_id: delegation.id,
      payload: payloadRecord,
    },
  };
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
    ...workflow.context,
    context: workflow.context,
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
    test_case_files: Array.isArray(
      workflow.context[WORKFLOW_CONTEXT_KEYS.testCaseFiles],
    )
      ? (workflow.context[WORKFLOW_CONTEXT_KEYS.testCaseFiles] as unknown[])
          .filter(
            (item): item is string =>
              typeof item === 'string' && item.trim().length > 0,
          )
          .map((item) => `- ${item}`)
          .join('\n') || '无'
      : '无',
    plan_doc: buildDocPath(
      workflow,
      getWorkflowDeliverableFileName(workflow.workflow_type, 'planner'),
    ),
    dev_doc: buildDocPath(
      workflow,
      getWorkflowDeliverableFileName(workflow.workflow_type, 'dev'),
    ),
    test_doc:
      extra?.testDoc ||
      buildDocPath(
        workflow,
        getWorkflowDeliverableFileName(workflow.workflow_type, 'test'),
      ),
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
      buildDocPath(
        workflow,
        getWorkflowDeliverableFileName(workflow.workflow_type, 'test'),
      );
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
        buildDocPath(
          workflow,
          getWorkflowDeliverableFileName(workflow.workflow_type, 'dev'),
        ),
        '本轮修复记录应更新到以下测试文档：',
        testDoc,
        '若仍无法确定，请不要猜测或直接在主干分支修改；请停止修改并反馈失败原因。',
      ].join('\n');
      return finalContent ? `${finalContent}\n\n${warning}` : warning;
    }

    return finalContent;
  }

  return taskContent;
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

function parseCheckpointAttempts(workflowId: string): Record<string, number> {
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

function parseChannelArray(
  raw: string | null | undefined,
): WorkflowInterruptActorChannel[] {
  return parseJsonArray(raw).filter(
    (item): item is WorkflowInterruptActorChannel =>
      item === 'web' ||
      item === 'feishu' ||
      item === 'assistant' ||
      item === 'system',
  );
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
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
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
      errors.push(
        `${pathName} must be at least ${schema.minLength} characters`,
      );
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${pathName} must be at most ${schema.maxLength} characters`);
    }
  } else if (expectedType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${pathName} must be a number`);
    } else {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${pathName} must be at least ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${pathName} must be at most ${schema.maximum}`);
      }
    }
  } else if (expectedType === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(`${pathName} must be an integer`);
    } else {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${pathName} must be at least ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${pathName} must be at most ${schema.maximum}`);
      }
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

function normalizeJsonSchemaPayload(
  schema: JsonSchema | undefined,
  value: unknown,
): unknown {
  if (!schema || value === undefined || value === null) return value;

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return value;
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = { ...input };
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (input[key] !== undefined) {
        output[key] = normalizeJsonSchemaPayload(childSchema, input[key]);
      }
    }
    return output;
  }

  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;

  if (schema.type === 'number') {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (schema.type === 'integer') {
    if (!/^[-+]?\d+$/.test(text)) return value;
    const parsed = Number.parseInt(text, 10);
    return Number.isSafeInteger(parsed) ? parsed : value;
  }
  if (schema.type === 'boolean') {
    if (/^(true|1|yes|on)$/i.test(text)) return true;
    if (/^(false|0|no|off)$/i.test(text)) return false;
  }
  return value;
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
  } else if (state?.type === 'system') {
    runSystemState(workflow, reason, fromStateKey);
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

function runSystemState(
  workflow: Workflow,
  reason: 'create' | 'transition' | 'resume' | 'retry' | 'timeout',
  fromStateKey?: string,
): void {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const state = config?.states[workflow.status];
  if (!state || state.type !== 'system') return;
  const attempts = parseCheckpointAttempts(workflow.id);
  const attempt = attempts[workflow.status] || 1;
  const idempotencyKey = `workflow_system:${workflow.id}:${workflow.status}:${workflow.round}:${attempt}`;
  if (getWorkflowEventByIdempotencyKey(idempotencyKey)) return;

  const now = new Date().toISOString();
  writeWorkflowEvent({
    workflowId: workflow.id,
    eventType: 'system_executed',
    stateKey: workflow.status,
    payload: {
      reason,
      from_state_key: fromStateKey || null,
      attempt,
    },
    idempotencyKey,
    createdAt: now,
  });
  let workflowForTransition = workflow;
  let systemResult: SystemRunResult = {
    status: 'success',
    output: {},
    contextPatch: {},
  };
  if (state.run?.steps?.length) {
    systemResult = runWorkflowActionSteps({
      workflow,
      steps: state.run.steps,
      attempt,
      scope: 'system',
    });
    writeWorkflowEvent({
      workflowId: workflow.id,
      eventType: 'system_completed',
      stateKey: workflow.status,
      payload: {
        status: systemResult.status,
        summary: systemResult.summary || null,
        error: systemResult.error || null,
        output: systemResult.output,
      },
      idempotencyKey: `workflow_system_completed:${workflow.id}:${workflow.status}:${workflow.round}:${attempt}`,
      createdAt: new Date().toISOString(),
    });
    if (Object.keys(systemResult.contextPatch).length > 0) {
      updateWorkflow(workflow.id, {
        context: systemResult.contextPatch,
      });
      workflowForTransition = getWorkflow(workflow.id) || {
        ...workflow,
        context: mergeWorkflowContext(
          workflow.context,
          systemResult.contextPatch,
        ),
      };
    }
  }

  writeWorkflowCheckpoint({
    workflow: workflowForTransition,
    attempts,
  });

  if (systemResult.status === 'pending') {
    updateWorkflow(workflow.id, { current_delegation_id: '' });
    enqueueWorkflowWorkbenchSync(
      workflow.id,
      'workflow_updated',
      { resultSummary: systemResult.summary || '系统节点等待外部结果' },
      `system_pending:${workflow.status}:${workflow.round}:${attempt}`,
    );
    return;
  }

  const transition =
    systemResult.status === 'success'
      ? state.on_complete?.success
      : state.on_complete?.failure;
  if (!transition) return;
  applyTransition(
    workflowForTransition,
    transition,
    resolveRolesOrEmpty(workflow),
    {
      fallbackToTargetDelegate: true,
      workflowUpdates: {
        context: {
          last_system_state: {
            state_key: workflow.status,
            executed_at: now,
            attempt,
            status: systemResult.status,
            summary: systemResult.summary || '',
            error: systemResult.error || '',
          },
        },
      },
    },
  );
}

function workflowActionStepEventType(
  scope: WorkflowActionStepScope,
  phase: 'started' | 'completed' | 'failed' | 'pending',
): string {
  if (scope === 'system') {
    if (phase === 'started') return 'system_step_started';
    if (phase === 'completed') return 'system_step_completed';
    if (phase === 'pending') return 'system_step_pending';
    return 'system_step_failed';
  }
  if (phase === 'started') return 'workflow_hook_step_started';
  if (phase === 'completed') return 'workflow_hook_step_completed';
  if (phase === 'pending') return 'workflow_hook_step_pending';
  return 'workflow_hook_step_failed';
}

function workflowActionStepIdempotencyKey(input: {
  workflow: Workflow;
  scope: WorkflowActionStepScope;
  attempt: number;
  index: number;
  phase?: 'started';
  invocationKey?: string;
}): string {
  const prefix =
    input.scope === 'system'
      ? input.phase === 'started'
        ? 'workflow_system_step_started'
        : 'workflow_system_step'
      : input.phase === 'started'
        ? 'workflow_hook_step_started'
        : 'workflow_hook_step';
  if (input.invocationKey) {
    return `${prefix}:${input.workflow.id}:${input.workflow.status}:${input.workflow.round}:${input.scope}:${input.invocationKey}:${input.attempt}:${input.index + 1}`;
  }
  return `${prefix}:${input.workflow.id}:${input.workflow.status}:${input.workflow.round}:${input.scope}:${input.attempt}:${input.index + 1}`;
}

function runWorkflowActionSteps(input: {
  workflow: Workflow;
  steps: WorkflowDefinitionSystemRunStep[];
  attempt: number;
  scope: WorkflowActionStepScope;
  invocationKey?: string;
  refType?: string;
  refId?: string;
}): SystemRunResult {
  const roles = resolveRolesOrEmpty(input.workflow);
  const stepOutputs: Record<string, unknown> = {};
  let context = cloneWorkflowContextForSystem(input.workflow.context);
  let contextPatch: WorkflowContext = {};
  const output: Record<string, unknown> = {};
  const summaries: string[] = [];

  for (const [index, step] of input.steps.entries()) {
    const stepId = step.id || `step_${index + 1}`;
    const handler = getWorkflowActionHandler(step.uses);
    const params = renderSystemStepParams(
      step.with,
      { ...input.workflow, context },
      roles,
      stepOutputs,
    );

    if (!handler) {
      const error = `Workflow action handler "${step.uses}" is not registered`;
      writeWorkflowEvent({
        workflowId: input.workflow.id,
        eventType: workflowActionStepEventType(input.scope, 'failed'),
        stateKey: input.workflow.status,
        refType: input.refType,
        refId: input.refId,
        payload: {
          scope: input.scope,
          invocation_key: input.invocationKey || null,
          step_id: stepId,
          uses: step.uses,
          error,
        },
        idempotencyKey: workflowActionStepIdempotencyKey({
          workflow: input.workflow,
          scope: input.scope,
          attempt: input.attempt,
          index,
          invocationKey: input.invocationKey,
        }),
      });
      return {
        status: 'failure',
        output: {
          ...output,
          [stepId]: { status: 'failure', error },
        },
        contextPatch,
        error,
      };
    }

    writeWorkflowEvent({
      workflowId: input.workflow.id,
      eventType: workflowActionStepEventType(input.scope, 'started'),
      stateKey: input.workflow.status,
      refType: input.refType,
      refId: input.refId,
      payload: {
        scope: input.scope,
        invocation_key: input.invocationKey || null,
        step_id: stepId,
        uses: step.uses,
      },
      idempotencyKey: workflowActionStepIdempotencyKey({
        workflow: input.workflow,
        scope: input.scope,
        attempt: input.attempt,
        index,
        phase: 'started',
        invocationKey: input.invocationKey,
      }),
    });

    let result: ReturnType<typeof handler.run>;
    try {
      result = handler.run({
        workflow: { ...input.workflow, context },
        stateKey: input.workflow.status,
        params,
        context,
        steps: stepOutputs,
      });
    } catch (err) {
      result = {
        status: 'failure',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const stepOutput = result.output || {};
    stepOutputs[stepId] = stepOutput;
    output[stepId] = {
      status: result.status,
      output: stepOutput,
      summary: result.summary || '',
      error: result.error || '',
    };
    if (result.summary) summaries.push(result.summary);
    if (result.contextPatch) {
      contextPatch = mergeWorkflowContext(contextPatch, result.contextPatch);
      context = mergeWorkflowContext(context, result.contextPatch);
    }

    writeWorkflowEvent({
      workflowId: input.workflow.id,
      eventType:
        result.status === 'success'
          ? workflowActionStepEventType(input.scope, 'completed')
          : result.status === 'pending'
            ? workflowActionStepEventType(input.scope, 'pending')
            : workflowActionStepEventType(input.scope, 'failed'),
      stateKey: input.workflow.status,
      refType: input.refType,
      refId: input.refId,
      payload: {
        scope: input.scope,
        invocation_key: input.invocationKey || null,
        step_id: stepId,
        uses: step.uses,
        status: result.status,
        output: stepOutput,
        summary: result.summary || null,
        error: result.error || null,
      },
      idempotencyKey: workflowActionStepIdempotencyKey({
        workflow: input.workflow,
        scope: input.scope,
        attempt: input.attempt,
        index,
        invocationKey: input.invocationKey,
      }),
    });

    if (result.status !== 'success') {
      return {
        status: result.status,
        output,
        contextPatch,
        summary: result.summary,
        error: result.error,
      };
    }
  }

  return {
    status: 'success',
    output,
    contextPatch,
    summary: summaries.join('\n'),
  };
}

function cloneWorkflowContextForSystem(
  context: WorkflowContext,
): WorkflowContext {
  return mergeWorkflowContext({}, context);
}

function runDelegationHook(input: {
  workflow: Workflow;
  stateKey: string;
  stateConfig: StateConfig;
  hook: Extract<WorkflowActionStepScope, 'before_delegate' | 'after_complete'>;
  attempt: number;
  invocationKey?: string;
  refType?: string;
  refId?: string;
}): SystemRunResult {
  const run = input.stateConfig[input.hook];
  const steps = run?.steps || [];
  if (steps.length === 0) {
    return {
      status: 'success',
      output: {},
      contextPatch: {},
    };
  }

  const workflowForHook: Workflow = {
    ...input.workflow,
    status: input.stateKey as Workflow['status'],
  };
  writeWorkflowEvent({
    workflowId: workflowForHook.id,
    eventType: 'workflow_hook_started',
    stateKey: input.stateKey,
    refType: input.refType,
    refId: input.refId,
    payload: {
      hook: input.hook,
      attempt: input.attempt,
      invocation_key: input.invocationKey || null,
      step_count: steps.length,
    },
    idempotencyKey: input.invocationKey
      ? `workflow_hook_started:${workflowForHook.id}:${input.stateKey}:${workflowForHook.round}:${input.hook}:${input.invocationKey}:${input.attempt}`
      : `workflow_hook_started:${workflowForHook.id}:${input.stateKey}:${workflowForHook.round}:${input.hook}:${input.attempt}`,
  });

  const result = runWorkflowActionSteps({
    workflow: workflowForHook,
    steps,
    attempt: input.attempt,
    scope: input.hook,
    invocationKey: input.invocationKey,
    refType: input.refType,
    refId: input.refId,
  });
  writeWorkflowEvent({
    workflowId: workflowForHook.id,
    eventType:
      result.status === 'success'
        ? 'workflow_hook_completed'
        : result.status === 'pending'
          ? 'workflow_hook_pending'
          : 'workflow_hook_failed',
    stateKey: input.stateKey,
    refType: input.refType,
    refId: input.refId,
    payload: {
      hook: input.hook,
      attempt: input.attempt,
      invocation_key: input.invocationKey || null,
      status: result.status,
      summary: result.summary || null,
      error: result.error || null,
      output: result.output,
    },
    idempotencyKey: input.invocationKey
      ? `workflow_hook:${workflowForHook.id}:${input.stateKey}:${workflowForHook.round}:${input.hook}:${input.invocationKey}:${input.attempt}`
      : `workflow_hook:${workflowForHook.id}:${input.stateKey}:${workflowForHook.round}:${input.hook}:${input.attempt}`,
  });
  return result;
}

function buildHookFailureMessage(
  hook: 'before_delegate' | 'after_complete',
  stateKey: string,
  result: SystemRunResult,
): string {
  const reason = result.error || result.summary || result.status;
  return `Workflow ${hook} hook failed for state "${stateKey}": ${reason}`;
}

function stopWorkflowOnHookBlock(input: {
  workflow: Workflow;
  stateKey: string;
  hook: 'before_delegate' | 'after_complete';
  result: SystemRunResult;
  contextPatch?: WorkflowContext;
  workflowUpdates?: Parameters<typeof updateWorkflow>[1];
  syncKeySuffix?: string;
  writeCheckpoint?: boolean;
}): Workflow {
  const updates: Parameters<typeof updateWorkflow>[1] = {
    ...(input.workflowUpdates || {}),
    current_delegation_id: '',
  };
  const contextPatch = mergeWorkflowContext(
    (updates.context as WorkflowContext | undefined) || {},
    input.contextPatch,
  );
  if (Object.keys(contextPatch).length > 0) {
    updates.context = contextPatch;
  }

  updateWorkflow(input.workflow.id, updates);
  const updated =
    getWorkflow(input.workflow.id) ||
    ({
      ...input.workflow,
      ...updates,
      context: mergeWorkflowContext(
        input.workflow.context,
        updates.context as WorkflowContext | undefined,
      ),
    } as Workflow);

  if (input.writeCheckpoint !== false) {
    writeWorkflowCheckpoint({
      workflow: updated,
      currentDelegationId: null,
    });
  }
  enqueueWorkflowWorkbenchSync(
    updated.id,
    'workflow_updated',
    {
      resultSummary: buildHookFailureMessage(
        input.hook,
        input.stateKey,
        input.result,
      ),
    },
    `workflow_hook_blocked:${input.stateKey}:${input.hook}:${
      input.syncKeySuffix || updated.round
    }`,
  );
  return updated;
}

function createDelegationForState(input: {
  workflow: Workflow;
  stateKey: string;
  stateConfig: StateConfig;
  roles: Record<string, string>;
  sourceFolder: string;
  role: string;
  skill: string;
  taskTemplate?: string;
  handoff?: StateTransition['handoff'];
  artifactContractRef?: string;
  idempotencyKey: string;
  attempt: number;
  extra?: WorkflowTransitionExtra;
  retryNote?: string;
}):
  | {
      status: 'created';
      intent: DelegationIntent;
      contextPatch: WorkflowContext;
      workflow: Workflow;
    }
  | {
      status: 'blocked';
      hook: 'before_delegate';
      result: SystemRunResult;
      contextPatch: WorkflowContext;
      workflow: Workflow;
    } {
  const targetFolder = input.roles[input.role];
  if (!targetFolder) {
    throw new Error(
      `Workflow: role "${input.role}" has no resolved target folder`,
    );
  }

  const beforeHook = runDelegationHook({
    workflow: input.workflow,
    stateKey: input.stateKey,
    stateConfig: input.stateConfig,
    hook: 'before_delegate',
    attempt: input.attempt,
  });
  if (beforeHook.status !== 'success') {
    return {
      status: 'blocked',
      hook: 'before_delegate',
      result: beforeHook,
      contextPatch: beforeHook.contextPatch,
      workflow: {
        ...input.workflow,
        status: input.stateKey as Workflow['status'],
        context: mergeWorkflowContext(
          input.workflow.context,
          beforeHook.contextPatch,
        ),
      },
    };
  }

  const workflowForDelegate: Workflow = {
    ...input.workflow,
    status: input.stateKey as Workflow['status'],
    context: mergeWorkflowContext(
      input.workflow.context,
      beforeHook.contextPatch,
    ),
  };
  const vars = buildTemplateVars(workflowForDelegate, input.extra);
  const taskContent = input.taskTemplate
    ? renderTemplate(input.taskTemplate, vars, input.roles)
    : '';
  const finalTaskContent = appendRetryNote(
    finalizeDelegationTaskContent(
      input.skill,
      taskContent,
      workflowForDelegate,
      input.extra,
    ),
    input.retryNote,
  );
  const intent = createDurableDelegationIntent({
    workflowId: input.workflow.id,
    sourceJid: input.workflow.source_jid,
    targetFolder,
    sourceFolder: input.sourceFolder,
    stageKey: input.stateKey,
    role: input.role,
    skillName: input.skill,
    taskContent: finalTaskContent,
    handoff: input.handoff,
    artifactContractRef: input.artifactContractRef,
    workflowForHandoff: workflowForDelegate,
    idempotencyKey: input.idempotencyKey,
  });

  return {
    status: 'created',
    intent,
    contextPatch: beforeHook.contextPatch,
    workflow: workflowForDelegate,
  };
}

function actorToJson(actor: ResumeActor): string {
  return JSON.stringify({
    channel: actor.channel,
    userId: actor.userId || '',
    displayName: actor.displayName || '',
  });
}

function canonicalJson(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key])}`)
    .join(',')}}`;
}

function sameResumeActor(
  recordedActorJson: string | null,
  actor: ResumeActor,
): boolean {
  if (!recordedActorJson) return false;
  try {
    const recorded = JSON.parse(recordedActorJson) as Record<string, unknown>;
    return (
      recorded.channel === actor.channel &&
      String(recorded.userId || '') === (actor.userId || '') &&
      String(recorded.displayName || '') === (actor.displayName || '')
    );
  } catch {
    return false;
  }
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

function calculateRetryDelayMs(
  policy: NonNullable<WorkflowTypeConfig['states'][string]['retry_policy']>,
  nextAttempt: number,
): number {
  const initial = policy.initial_delay_ms ?? 0;
  const max = policy.max_delay_ms ?? initial;
  if (initial <= 0) return 0;
  let delay = initial;
  if (policy.backoff === 'linear') {
    delay = initial * Math.max(1, nextAttempt - 1);
  } else if (policy.backoff === 'exponential') {
    delay = initial * 2 ** Math.max(0, nextAttempt - 2);
  }
  return max > 0 ? Math.min(delay, max) : delay;
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
  const delayMs = calculateRetryDelayMs(policy, nextAttempt);
  const baseTime = Date.parse(now);
  const nextAttemptAt = new Date(
    (Number.isFinite(baseTime) ? baseTime : Date.now()) + delayMs,
  ).toISOString();
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

function getLatestEvaluatorResult(
  workflow: Workflow,
): Record<string, unknown> | null {
  const value = workflow.context.latest_evaluator_result;
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function hasEvaluatorRetryCapacity(
  workflow: Workflow,
  stateConfig: NonNullable<WorkflowTypeConfig['states'][string]>,
): boolean {
  const policy = stateConfig.retry_policy;
  if (!policy?.retry_on?.includes('evaluator_pending')) return false;
  const attempts = parseCheckpointAttempts(workflow.id);
  const currentAttempt = attempts[workflow.status] || 1;
  return currentAttempt < policy.max_attempts;
}

function processDueEvaluatorRetry(workflow: Workflow, nowIso: string): void {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const state = config?.states[workflow.status];
  if (!state || state.type !== 'delegation') return;
  if (!state.retry_policy?.retry_on?.includes('evaluator_pending')) return;

  const latestEvaluator = getLatestEvaluatorResult(workflow);
  if (latestEvaluator?.status !== 'pending') return;

  const attempts = parseCheckpointAttempts(workflow.id);
  const attempt = attempts[workflow.status] || 1;
  if (attempt > state.retry_policy.max_attempts) {
    const transition = exhaustedRetryTransition(state);
    if (transition) {
      applyTransition(workflow, transition, resolveRolesOrEmpty(workflow), {
        workflowUpdates: {
          context: {
            last_retry_exhausted: {
              state_key: workflow.status,
              attempt,
              exhausted_at: nowIso,
            },
          },
        },
      });
    }
    return;
  }

  const retryEvent = getWorkflowEventByIdempotencyKey(
    `workflow_retry:${workflow.id}:${workflow.status}:${workflow.round}:${attempt}`,
  );
  if (!retryEvent) return;
  const payload = parseOutboxPayload(retryEvent.payload_json || '{}');
  const nextAttemptAt =
    typeof payload.next_attempt_at === 'string' ? payload.next_attempt_at : '';
  if (!nextAttemptAt || nextAttemptAt > nowIso) return;
  if (
    getWorkflowEventByIdempotencyKey(
      `workflow_retry_executed:${workflow.id}:${workflow.status}:${workflow.round}:${attempt}`,
    )
  ) {
    return;
  }

  if (!state.role || !state.skill) return;
  const roles = resolveRolesOrEmpty(workflow);
  const idempotencyKey = `workflow_delegation:${workflow.id}:${workflow.status}:${workflow.round}:${attempt}`;
  const prepared = createDelegationForState({
    workflow,
    stateKey: workflow.status,
    stateConfig: state,
    roles,
    sourceFolder: getMainFolder(workflow.source_jid),
    role: state.role,
    skill: state.skill,
    taskTemplate: state.task_template,
    handoff: state.handoff,
    artifactContractRef: state.artifact_contract?.ref,
    attempt,
    idempotencyKey,
    retryNote: `Evaluator pending retry attempt ${attempt}. Previous evaluation: ${String(
      latestEvaluator.summary || '',
    )}`,
  });
  if (prepared.status === 'blocked') {
    stopWorkflowOnHookBlock({
      workflow: prepared.workflow,
      stateKey: workflow.status,
      hook: prepared.hook,
      result: prepared.result,
      contextPatch: prepared.contextPatch,
      syncKeySuffix: `${workflow.round}:${attempt}`,
    });
    writeWorkflowEvent({
      workflowId: workflow.id,
      eventType: 'retry_scheduled',
      stateKey: workflow.status,
      payload: {
        reason: 'evaluator_pending_retry_blocked',
        blocked_by_hook: prepared.hook,
        attempt,
      },
      idempotencyKey: `workflow_retry_executed:${workflow.id}:${workflow.status}:${workflow.round}:${attempt}`,
      createdAt: nowIso,
    });
    return;
  }
  const delegationId = prepared.intent.delegationId;
  updateWorkflow(workflow.id, {
    current_delegation_id: delegationId,
    ...(Object.keys(prepared.contextPatch).length > 0
      ? { context: prepared.contextPatch }
      : {}),
  });
  const updated = getWorkflow(workflow.id) || workflow;
  writeWorkflowEvent({
    workflowId: workflow.id,
    eventType: 'retry_scheduled',
    stateKey: workflow.status,
    refType: 'delegation',
    refId: delegationId,
    payload: {
      reason: 'evaluator_pending_retry_executed',
      attempt,
      delegation_id: delegationId,
    },
    idempotencyKey: `workflow_retry_executed:${workflow.id}:${workflow.status}:${workflow.round}:${attempt}`,
    createdAt: nowIso,
  });
  writeWorkflowEvent({
    workflowId: workflow.id,
    eventType: 'delegation_created',
    stateKey: workflow.status,
    refType: 'delegation',
    refId: delegationId,
    payload: {
      delegation_id: delegationId,
      idempotency_key: idempotencyKey,
      attempt,
      target_folder: prepared.intent.targetFolder,
    },
    createdAt: nowIso,
  });
  writeWorkflowCheckpoint({
    workflow: updated,
    currentDelegationId: delegationId,
    attempts,
  });
  enqueueWorkflowWorkbenchSync(
    workflow.id,
    'delegation_created',
    { delegationId },
    `retry_due_delegation_created:${delegationId}`,
  );
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
    score: Math.min(
      input.stageEvaluation.score,
      input.contractEvaluation.score,
    ),
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

function recordLlmJudgeSidecar(input: {
  workflow: Workflow;
  stageKey: string;
  delegation?: Delegation | null;
  primaryEvaluationId: string;
  deterministicEvaluation: WorkflowStageEvalResult;
  evaluatorConfig?: ReturnType<typeof getWorkflowEvaluatorConfig>;
}): ReturnType<typeof buildQueuedWorkflowLlmJudgeRecord> {
  const sidecarRecord = buildQueuedWorkflowLlmJudgeRecord(input);
  if (!sidecarRecord) return null;

  createWorkflowStageEvaluation(sidecarRecord);
  writeWorkflowEvent({
    workflowId: input.workflow.id,
    eventType: 'llm_judge_sidecar_recorded',
    stateKey: input.stageKey,
    refType: 'workflow_stage_evaluation',
    refId: sidecarRecord.id,
    payload: {
      sidecar_for: input.primaryEvaluationId,
      evaluator_ref: input.evaluatorConfig?.id || null,
      result: sidecarRecord.status,
    },
  });

  if (shouldRunWorkflowLlmJudgeNow()) {
    void runWorkflowLlmJudgeSidecar(input)
      .then((completedRecord) => {
        if (!completedRecord) return;
        createWorkflowStageEvaluation(completedRecord);
        writeWorkflowEvent({
          workflowId: input.workflow.id,
          eventType: 'llm_judge_sidecar_completed',
          stateKey: input.stageKey,
          refType: 'workflow_stage_evaluation',
          refId: completedRecord.id,
          payload: {
            sidecar_for: input.primaryEvaluationId,
            evaluator_ref: input.evaluatorConfig?.id || null,
            result: completedRecord.status,
          },
        });
      })
      .catch((err) => {
        logger.error(
          {
            err,
            workflowId: input.workflow.id,
            stageKey: input.stageKey,
            primaryEvaluationId: input.primaryEvaluationId,
          },
          'Workflow LLM judge sidecar failed',
        );
      });
  }

  return sidecarRecord;
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
          if (
            previous.status === 'accepted' ||
            previous.status === 'duplicate'
          ) {
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
        return {
          ok: false,
          error: `中断 ${input.interruptId} 不存在`,
        } as const;
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
        const samePayload =
          canonicalJson(
            parseOutboxPayload(interrupt.resume_payload_json || '{}'),
          ) === canonicalJson(payload);
        const sameActor = sameResumeActor(interrupt.resumed_by, input.actor);
        const sameAction =
          interrupt.status === 'resumed' &&
          interrupt.resume_action === input.action &&
          samePayload &&
          sameActor;
        createResumeAttempt({
          interrupt,
          actor: input.actor,
          action: input.action,
          payload,
          idempotencyKey: input.idempotencyKey,
          status: sameAction ? 'duplicate' : 'conflict',
          result: {
            workflowId: workflow.id,
            interruptStatus: interrupt.status,
          },
          conflictReason: sameAction
            ? null
            : !sameActor && interrupt.status === 'resumed'
              ? 'resume_actor_conflict'
              : !samePayload && interrupt.status === 'resumed'
                ? 'resume_payload_conflict'
                : `interrupt_${interrupt.status}`,
        });
        if (sameAction) return { ok: true, workflowId: workflow.id } as const;
        return {
          ok: false,
          error: `中断已${interrupt.status}，不能再次提交不同操作或内容`,
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

      const allowedChannels = parseJsonArray(interrupt.allowed_channels_json);
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

      const schema = parseSchema(interrupt.resume_payload_schema_json);
      const normalizedPayload = normalizeJsonSchemaPayload(
        schema,
        payload,
      ) as Record<string, unknown>;
      const schemaErrors = validateJsonSchemaSubset(schema, normalizedPayload);
      if (schemaErrors.length > 0) {
        createResumeAttempt({
          interrupt,
          actor: input.actor,
          action: input.action,
          payload: normalizedPayload,
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
          payload: normalizedPayload,
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
        resumePayloadJson: JSON.stringify(normalizedPayload),
        updatedAt: now,
      });
      if (!marked) {
        createResumeAttempt({
          interrupt,
          actor: input.actor,
          action: input.action,
          payload: normalizedPayload,
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
        payload: normalizedPayload,
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
          payload: normalizedPayload,
        },
        createdAt: now,
      });

      const contextPatch = buildInterruptPayloadPatch(
        interrupt.state_key,
        input.action,
        normalizedPayload,
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
  extra?: WorkflowTransitionExtra,
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

  const targetStateConfig = config.states[transition.target];
  const useTargetDelegate =
    extra?.fallbackToTargetDelegate === true &&
    !transition.role &&
    !transition.skill &&
    targetStateConfig?.type === 'delegation';

  // 3. Create durable delegation intent from the transition, or from the
  // target state when explicitly allowed.
  const delegateRole = useTargetDelegate
    ? targetStateConfig?.role
    : transition.role;
  const delegateSkill = useTargetDelegate
    ? targetStateConfig?.skill
    : transition.skill;
  const delegateTaskTemplate = useTargetDelegate
    ? targetStateConfig?.task_template
    : transition.task_template;
  const delegateHandoff = useTargetDelegate
    ? targetStateConfig?.handoff
    : transition.handoff;
  let delegationIntent: DelegationIntent | null = null;

  if (delegateRole && delegateSkill) {
    const delegationKey = `workflow_delegation:${workflow.id}:${transition.target}:${round}:1`;
    const workflowForDelegate: Workflow = {
      ...workflow,
      ...updates,
      status: transition.target as Workflow['status'],
      context: mergeWorkflowContext(workflow.context, updates.context),
      round,
    };
    const prepared = createDelegationForState({
      workflow: workflowForDelegate,
      stateKey: transition.target,
      stateConfig:
        targetStateConfig?.type === 'delegation'
          ? targetStateConfig
          : {
              type: 'delegation',
              role: delegateRole,
              skill: delegateSkill,
            },
      roles,
      sourceFolder: mainFolder,
      role: delegateRole,
      skill: delegateSkill,
      taskTemplate: delegateTaskTemplate,
      handoff: delegateHandoff,
      artifactContractRef: targetStateConfig?.artifact_contract?.ref,
      idempotencyKey: delegationKey,
      attempt: 1,
      extra,
    });
    if (prepared.status === 'blocked') {
      const blockedUpdates = mergeWorkflowContext(
        updates.context || {},
        prepared.contextPatch,
      );
      const blockedWorkflow = stopWorkflowOnHookBlock({
        workflow: workflowForDelegate,
        stateKey: transition.target,
        hook: prepared.hook,
        result: prepared.result,
        workflowUpdates: {
          ...updates,
          context: blockedUpdates,
        },
        syncKeySuffix: `${round}:transition`,
      });
      writeWorkflowEvent({
        workflowId: workflow.id,
        eventType: 'transition_applied',
        stateKey: fromStatus,
        payload: {
          source_state_key: fromStatus,
          target_state_key: transition.target,
          transition,
          blocked_by_hook: prepared.hook,
        },
      });
      enqueueWorkflowWorkbenchSync(
        workflow.id,
        'transition',
        { fromStatus, toStatus: transition.target, delegationId: '' },
        `transition:${fromStatus}:${transition.target}:${round}`,
      );
      ensureWorkflowStateDurableRecords(
        blockedWorkflow,
        'transition',
        fromStatus,
      );
      return;
    }
    delegationIntent = prepared.intent;
    updates.context = mergeWorkflowContext(
      updates.context || {},
      prepared.contextPatch,
    );
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
    const vars = buildTemplateVars(
      {
        ...workflow,
        ...updates,
        context: mergeWorkflowContext(workflow.context, updates.context),
        round,
      },
      extra,
    );
    enqueueWorkflowNotification(
      {
        ...workflow,
        ...updates,
        context: mergeWorkflowContext(workflow.context, updates.context),
      },
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
  testCaseFiles?: string[];
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
    const requiredDeliverableFile = getWorkflowEntryPointDeliverableFileName(
      config,
      entryPoint.deliverable_role,
    );
    if (!deliverable.files.includes(requiredDeliverableFile)) {
      return {
        workflowId,
        error: `入口 "${opts.startFrom}" 需要交付物 ${requiredDeliverableFile}，但目录 projects/${opts.service}/iteration/${opts.deliverable}/ 中未找到。`,
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
      [WORKFLOW_CONTEXT_KEYS.testCaseFiles]: Array.isArray(opts.testCaseFiles)
        ? opts.testCaseFiles.filter(
            (item) => typeof item === 'string' && item.trim().length > 0,
          )
        : normalizeTestCaseFilePaths(
            opts.context?.[WORKFLOW_CONTEXT_KEYS.testCaseFiles],
          ),
      [WORKFLOW_CONTEXT_KEYS.requirementPreset]: opts.requirementPreset || '',
    });
    Object.assign(
      workflowContext,
      materializeTestCaseFilesForDeliverable(
        {
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
        },
        workflowContext,
      ),
    );

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
    const entryStateConfig = config.states[entryPoint.state];

    const createdWorkflow = getWorkflow(workflowId);
    if (createdWorkflow) {
      ensureWorkflowStateDurableRecords(createdWorkflow, 'create');
    }
    enqueueWorkflowCreatedSync(workflowId);

    // If entry state is an interrupt state, send the card
    if (entryStateConfig?.type === 'interrupt' && entryStateConfig.card) {
      const createdWorkflow = getWorkflow(workflowId);
      if (createdWorkflow) {
        enqueueWorkflowCard(
          createdWorkflow,
          entryStateConfig.card,
          `entry_card:${entryPoint.state}:0`,
        );
      }
    }

    if (entryStateConfig?.type === 'system') {
      const createdWorkflow = getWorkflow(workflowId);
      if (createdWorkflow) {
        runSystemState(createdWorkflow, 'create');
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
        const prepared = createDelegationForState({
          workflow: createdWorkflow,
          stateKey: entryPoint.state,
          stateConfig: entryStateConfig,
          roles,
          sourceFolder: mainFolder,
          role: entryStateConfig.role,
          skill: entryStateConfig.skill,
          taskTemplate: entryStateConfig.task_template,
          handoff: entryStateConfig.handoff,
          artifactContractRef: entryStateConfig.artifact_contract?.ref,
          attempt: 1,
          idempotencyKey: `workflow_delegation:${workflowId}:${entryPoint.state}:0:1`,
        });
        if (prepared.status === 'blocked') {
          stopWorkflowOnHookBlock({
            workflow: prepared.workflow,
            stateKey: entryPoint.state,
            hook: prepared.hook,
            result: prepared.result,
            contextPatch: prepared.contextPatch,
            syncKeySuffix: '0:create',
          });
          throw new Error(
            buildHookFailureMessage(
              prepared.hook,
              entryPoint.state,
              prepared.result,
            ),
          );
        }
        const delegationId = prepared.intent.delegationId;
        updateWorkflow(workflowId, {
          current_delegation_id: delegationId,
          ...(Object.keys(prepared.contextPatch).length > 0
            ? { context: prepared.contextPatch }
            : {}),
        });
        enqueueWorkflowWorkbenchSync(
          workflowId,
          'delegation_created',
          { delegationId },
          `delegation_created:${delegationId}`,
        );
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

      enqueueWorkflowNotification(
        {
          id: workflowId,
          name: opts.title,
          service: opts.service,
          start_from: opts.startFrom,
          context: {},
          status: entryPoint.state,
          current_delegation_id: '',
          round: 0,
          source_jid: opts.sourceJid,
          paused_from: null,
          workflow_type: workflowType,
          created_at: now,
          updated_at: now,
        },
        `[流程启动] 需求「${opts.title}」${config.name}已创建 (${workflowId})，已委派 ${roles[entryStateConfig.role]} 开始执行。`,
        `workflow_started:${entryPoint.state}`,
      );
    }

    processWorkflowOutbox();
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
    [WORKFLOW_CONTEXT_KEYS.testCaseFiles]: Array.isArray(opts.testCaseFiles)
      ? opts.testCaseFiles.filter(
          (item) => typeof item === 'string' && item.trim().length > 0,
        )
      : normalizeTestCaseFilePaths(
          opts.context?.[WORKFLOW_CONTEXT_KEYS.testCaseFiles],
        ),
    [WORKFLOW_CONTEXT_KEYS.requirementPreset]: opts.requirementPreset || '',
  });
  Object.assign(
    workflowContext,
    materializeTestCaseFilesForDeliverable(
      {
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
      },
      workflowContext,
    ),
  );

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
  const createdWorkflow = getWorkflow(workflowId);
  if (createdWorkflow) {
    ensureWorkflowStateDurableRecords(createdWorkflow, 'create');
  }
  enqueueWorkflowCreatedSync(workflowId);

  if (entryStateConfig?.type === 'system' && createdWorkflow) {
    runSystemState(createdWorkflow, 'create');
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
      const prepared = createDelegationForState({
        workflow: createdWorkflow,
        stateKey: entryPoint.state,
        stateConfig: entryStateConfig,
        roles,
        sourceFolder: mainFolder,
        role: entryStateConfig.role,
        skill: entryStateConfig.skill,
        taskTemplate: entryStateConfig.task_template,
        handoff: entryStateConfig.handoff,
        artifactContractRef: entryStateConfig.artifact_contract?.ref,
        attempt: 1,
        idempotencyKey: `workflow_delegation:${workflowId}:${entryPoint.state}:0:1`,
      });
      if (prepared.status === 'blocked') {
        stopWorkflowOnHookBlock({
          workflow: prepared.workflow,
          stateKey: entryPoint.state,
          hook: prepared.hook,
          result: prepared.result,
          contextPatch: prepared.contextPatch,
          syncKeySuffix: '0:create',
        });
        throw new Error(
          buildHookFailureMessage(
            prepared.hook,
            entryPoint.state,
            prepared.result,
          ),
        );
      }
      const delegationId = prepared.intent.delegationId;
      updateWorkflow(workflowId, {
        current_delegation_id: delegationId,
        ...(Object.keys(prepared.contextPatch).length > 0
          ? { context: prepared.contextPatch }
          : {}),
      });
      enqueueWorkflowWorkbenchSync(
        workflowId,
        'delegation_created',
        { delegationId },
        `delegation_created:${delegationId}`,
      );
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

    enqueueWorkflowNotification(
      {
        id: workflowId,
        name: opts.title,
        service: opts.service,
        start_from: opts.startFrom,
        context: {},
        status: entryPoint.state,
        current_delegation_id: '',
        round: 0,
        source_jid: opts.sourceJid,
        paused_from: null,
        workflow_type: workflowType,
        created_at: now,
        updated_at: now,
      },
      `[流程启动] 需求「${opts.title}」${config.name}已创建 (${workflowId})，已委派 ${roles[entryStateConfig.role]} 开始执行。`,
      `workflow_started:${entryPoint.state}`,
    );
  }

  processWorkflowOutbox();
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
    fallbackToTargetDelegate: stateConfig.type === 'delegation',
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
  enqueueWorkflowWorkbenchSync(
    workflowId,
    'transition',
    { fromStatus, toStatus: stageKey, delegationId: '' },
    `return_to_stage:${fromStatus}:${stageKey}:${workflow.round}`,
  );
  enqueueWorkflowWorkbenchSync(
    workflowId,
    'workflow_updated',
    {
      resultSummary: `已回到阶段 ${config.status_labels[stageKey] || stageKey}`,
    },
    `return_to_stage_updated:${stageKey}:${workflow.round}`,
  );

  const updatedWorkflow = getWorkflow(workflowId);
  if (!updatedWorkflow) return {};
  ensureWorkflowStateDurableRecords(updatedWorkflow, 'transition', fromStatus);

  enqueueWorkflowNotification(
    updatedWorkflow,
    `[流程回退] 需求「${updatedWorkflow.name}」(${workflowId}) 已回到阶段 ${config.status_labels[stageKey] || stageKey}，请重新确认。`,
    `return_to_stage_notify:${stageKey}:${updatedWorkflow.round}`,
  );
  if (stateConfig.card) {
    enqueueWorkflowCard(
      updatedWorkflow,
      stateConfig.card,
      `return_to_stage_card:${stageKey}:${updatedWorkflow.round}`,
    );
  }
  processWorkflowOutbox();
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
    const retryAttempt =
      listWorkflowInterruptsByWorkflow(workflowId).length +
      getDelegationsByWorkflow(workflowId).length +
      1;
    const prepared = createDelegationForState({
      workflow: { ...workflow, status: stageKey as Workflow['status'] },
      stateKey: stageKey,
      stateConfig,
      roles,
      sourceFolder: getMainFolder(workflow.source_jid),
      role: stateConfig.role,
      skill: stateConfig.skill,
      taskTemplate: stateConfig.task_template,
      handoff: stateConfig.handoff,
      artifactContractRef: stateConfig.artifact_contract?.ref,
      attempt: retryAttempt,
      idempotencyKey: `workflow_delegation:${workflowId}:${stageKey}:${workflow.round}:${retryAttempt}`,
      retryNote: extra?.retryNote,
    });
    if (prepared.status === 'blocked') {
      stopWorkflowOnHookBlock({
        workflow: prepared.workflow,
        stateKey: stageKey,
        hook: prepared.hook,
        result: prepared.result,
        workflowUpdates: {
          status: stageKey,
          paused_from: null,
          context: prepared.contextPatch,
        },
        syncKeySuffix: `${workflow.round}:${retryAttempt}`,
      });
      return {};
    }
    const delegationId = prepared.intent.delegationId;

    const fromStatus = workflow.status;
    updateWorkflow(workflowId, {
      status: stageKey,
      current_delegation_id: delegationId,
      paused_from: null,
      ...(Object.keys(prepared.contextPatch).length > 0
        ? { context: prepared.contextPatch }
        : {}),
    });
    enqueueWorkflowWorkbenchSync(
      workflowId,
      'delegation_created',
      { delegationId },
      `retry_delegation_created:${delegationId}`,
    );
    enqueueWorkflowWorkbenchSync(
      workflowId,
      'transition',
      { fromStatus, toStatus: stageKey, delegationId },
      `retry_transition:${fromStatus}:${stageKey}:${workflow.round}:${retryAttempt}`,
    );
    enqueueWorkflowWorkbenchSync(
      workflowId,
      'workflow_updated',
      {
        resultSummary: `已重跑阶段 ${config.status_labels[stageKey] || stageKey}`,
      },
      `retry_workflow_updated:${stageKey}:${workflow.round}:${retryAttempt}`,
    );
    writeWorkflowEvent({
      workflowId,
      eventType: 'delegation_created',
      stateKey: stageKey,
      refType: 'delegation',
      refId: delegationId,
      payload: {
        delegation_id: delegationId,
        idempotency_key: `workflow_delegation:${workflowId}:${stageKey}:${workflow.round}:${retryAttempt}`,
        attempt: retryAttempt,
        target_folder: prepared.intent.targetFolder,
      },
    });
    enqueueWorkflowNotification(
      workflow,
      `[流程重跑] 需求「${workflow.name}」(${workflowId}) 已重新执行阶段 ${config.status_labels[stageKey] || stageKey}，已委派 ${targetFolder}。`,
      `retry_notify:${stageKey}:${workflow.round}:${retryAttempt}`,
    );
    processWorkflowOutbox();
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
  enqueueWorkflowWorkbenchSync(
    workflow.id,
    'delegation_completed',
    { delegationId },
    `delegation_completed:${delegationId}`,
  );
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
  const payload = getDelegationPayload(delegation);
  const workflowUpdates: Parameters<typeof updateWorkflow>[1] = {};
  const contextUpdates: WorkflowContext = {};
  Object.assign(
    contextUpdates,
    buildDelegationResultContextPatch(workflow, delegation, payload),
  );
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
  Object.assign(
    contextUpdates,
    materializeTestCaseFilesForDeliverable(workflow, contextUpdates),
  );
  if (Object.keys(contextUpdates).length > 0) {
    workflowUpdates.context = contextUpdates;
  }
  if (typeof payload.test_doc === 'string' && payload.test_doc.trim()) {
    testDoc = payload.test_doc.trim();
  }

  let evaluationWorkflow: Workflow = {
    ...workflow,
    context: mergeWorkflowContext(workflow.context, contextUpdates),
  };
  const afterHook = runDelegationHook({
    workflow: evaluationWorkflow,
    stateKey: workflow.status,
    stateConfig,
    hook: 'after_complete',
    attempt: 1,
    invocationKey: `delegation:${delegation.id}`,
    refType: 'delegation',
    refId: delegation.id,
  });
  if (Object.keys(afterHook.contextPatch).length > 0) {
    Object.assign(contextUpdates, afterHook.contextPatch);
    workflowUpdates.context = mergeWorkflowContext(
      workflowUpdates.context || {},
      afterHook.contextPatch,
    );
    evaluationWorkflow = {
      ...evaluationWorkflow,
      context: mergeWorkflowContext(
        evaluationWorkflow.context,
        afterHook.contextPatch,
      ),
    };
  }
  if (afterHook.status !== 'success') {
    stopWorkflowOnHookBlock({
      workflow,
      stateKey: workflow.status,
      hook: 'after_complete',
      result: afterHook,
      contextPatch: workflowUpdates.context,
    });
    return;
  }

  const stageEvaluation = evaluateWorkflowStage({
    workflow: evaluationWorkflow,
    stageKey: workflow.status,
    delegation,
  });
  const evaluatorConfig = getWorkflowEvaluatorConfig(
    stateConfig.evaluator?.ref,
  );
  const artifactContractRef = getDelegationArtifactContractRef(delegation);
  const contractEvaluation = evaluateWorkflowArtifactContract({
    workflow: evaluationWorkflow,
    contractRef: artifactContractRef,
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
  const llmJudgeSidecarRecord = recordLlmJudgeSidecar({
    workflow: evaluationWorkflow,
    stageKey: workflow.status,
    delegation,
    primaryEvaluationId: evaluationRecord.id,
    deterministicEvaluation: evaluation,
    evaluatorConfig,
  });
  workflowUpdates.context = mergeWorkflowContext(
    workflowUpdates.context || {},
    {
      latest_evaluator_result: {
        state_key: workflow.status,
        evaluation_id: evaluationRecord.id,
        evaluator_ref:
          stateConfig.evaluator?.ref || evaluationRecord.evaluator_type,
        artifact_contract_ref: artifactContractRef || null,
        status: evaluation.status,
        score: evaluation.score,
        summary: evaluation.summary,
        findings: evaluation.findings,
        evidence: evaluation.evidence,
        evaluated_at: evaluationRecord.updated_at,
      },
      ...(llmJudgeSidecarRecord
        ? {
            latest_llm_judge_result: {
              state_key: workflow.status,
              evaluation_id: llmJudgeSidecarRecord.id,
              evaluator_ref: evaluatorConfig?.id || null,
              status: llmJudgeSidecarRecord.status,
              score: llmJudgeSidecarRecord.score,
              summary: llmJudgeSidecarRecord.summary,
              evaluated_at: llmJudgeSidecarRecord.updated_at,
              sidecar_for: evaluationRecord.id,
            },
          }
        : {}),
      ...(stateConfig.rollback_hint
        ? {
            latest_rollback_hint: {
              ref: stateConfig.rollback_hint.ref,
              state_key: workflow.status,
              evaluation_id: evaluationRecord.id,
            },
          }
        : {}),
    },
  );
  writeWorkflowEvent({
    workflowId: workflow.id,
    eventType: 'artifact_evaluated',
    stateKey: workflow.status,
    refType: 'workflow_stage_evaluation',
    refId: evaluationRecord.id,
    payload: {
      artifact_contract_ref: artifactContractRef || null,
      evaluator_ref:
        stateConfig.evaluator?.ref || evaluationRecord.evaluator_type,
      result: evaluation.status,
      findings: evaluation.findings,
      evidence: evaluation.evidence,
    },
  });
  enqueueWorkflowWorkbenchSync(
    workflow.id,
    'stage_evaluated',
    { stageKey: workflow.status, evaluationId: evaluationRecord.id },
    `stage_evaluated:${workflow.status}:${evaluationRecord.id}`,
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
    evaluation.status === 'pending' &&
    !hasEvaluatorRetryCapacity(workflow, stateConfig)
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
    enqueueWorkflowWorkbenchSync(
      workflow.id,
      'workflow_updated',
      { resultSummary: evaluation.summary },
      `evaluation_pending_updated:${workflow.status}:${evaluationRecord.id}`,
    );
    enqueueWorkflowWorkbenchSync(
      workflow.id,
      'stage_evaluation_action_needed',
      {
        stageKey: workflow.status,
        evaluationId: evaluationRecord.id,
        keepVisibleWhenCurrentStage: true,
      },
      `evaluation_action_needed:${workflow.status}:${evaluationRecord.id}`,
    );
    scheduleEvaluatorRetryIfConfigured({
      workflow: pendingWorkflow || workflow,
      stateConfig,
      evaluationId: evaluationRecord.id,
    });
    enqueueWorkflowNotification(
      workflow,
      `[阶段评测] 需求「${workflow.name}」(${workflow.id}) 在阶段 ${config.status_labels[workflow.status] || workflow.status} 缺少充分证据，已停止自动流转。\n\n${evaluation.summary}\n\n请补充交付物或结果后重跑当前阶段。`,
      `evaluation_pending_notify:${workflow.status}:${evaluationRecord.id}`,
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
    fallbackToTargetDelegate:
      evaluation.status === 'passed' && !stateConfig.evaluator?.on_pass,
  });

  if (shouldCreateEvaluationActionItem) {
    enqueueWorkflowWorkbenchSync(
      workflow.id,
      'stage_evaluation_action_needed',
      {
        stageKey:
          targetState?.type === 'terminal'
            ? transition.target
            : workflow.status,
        evaluationId: evaluationRecord.id,
        keepVisibleWhenCurrentStage: transition.target === workflow.status,
      },
      `evaluation_action_needed:${transition.target}:${evaluationRecord.id}`,
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

  const card = buildInteractiveCard(cardConfig, {
    workflowId: workflow.id,
    interruptId: interrupt?.id,
    allowedActions: interrupt
      ? parseJsonArray(interrupt.allowed_actions_json)
      : undefined,
    payloadSchema,
    vars,
    roleFolders,
  });
  if (interrupt) {
    card.allowed_channels = parseChannelArray(interrupt.allowed_channels_json);
  }
  return card;
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
    const body = `**${w.id}** ${w.name} (${w.service})\n状态：${statusLabel}${w.round > 0 ? ` | Round ${w.round}` : ''}${workBranch ? `\n工作分支：${workBranch}` : ''}`;

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
  enqueueWorkflowWorkbenchSync(
    workflowId,
    'transition',
    { fromStatus: workflow.status, toStatus: 'cancelled', delegationId: '' },
    `cancel_transition:${workflow.status}:${workflow.round}`,
  );
  enqueueWorkflowWorkbenchSync(
    workflowId,
    'workflow_updated',
    { resultSummary: '任务已取消' },
    `cancel_updated:${workflow.round}`,
  );
  enqueueWorkflowNotification(
    workflow,
    `[流程取消] 需求「${workflow.name}」(${workflowId}) 已取消。`,
    `cancel_notify:${workflow.round}`,
  );
  processWorkflowOutbox();
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
  enqueueWorkflowWorkbenchSync(
    workflowId,
    'transition',
    {
      fromStatus: workflow.status,
      toStatus: 'paused',
      delegationId: workflow.current_delegation_id,
    },
    `pause_transition:${workflow.status}:${workflow.round}`,
  );
  enqueueWorkflowWorkbenchSync(
    workflowId,
    'workflow_updated',
    { resultSummary: '任务已暂停' },
    `pause_updated:${workflow.round}`,
  );
  enqueueWorkflowNotification(
    workflow,
    `[流程中断] 需求「${workflow.name}」(${workflowId}) 已中断，可随时恢复。`,
    `pause_notify:${workflow.round}`,
  );
  processWorkflowOutbox();
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
      enqueueWorkflowWorkbenchSync(
        workflowId,
        'transition',
        {
          fromStatus: workflow.status,
          toStatus: workflow.paused_from,
          delegationId: workflow.current_delegation_id,
        },
        `resume_completed_transition:${workflow.paused_from}:${workflow.round}`,
      );
      onDelegationComplete(workflow.current_delegation_id);
      enqueueWorkflowNotification(
        workflow,
        `[流程恢复] 需求「${workflow.name}」(${workflowId}) 已恢复，中断期间任务已完成，自动推进。`,
        `resume_completed_notify:${workflow.round}`,
      );
      processWorkflowOutbox();
      return {};
    }
    if (delegation?.status === 'pending') {
      // Agent still running — restore state, wait for natural completion
      updateWorkflow(workflowId, {
        status: workflow.paused_from,
        paused_from: null,
      });
      enqueueWorkflowWorkbenchSync(
        workflowId,
        'transition',
        {
          fromStatus: workflow.status,
          toStatus: workflow.paused_from,
          delegationId: workflow.current_delegation_id,
        },
        `resume_pending_transition:${workflow.paused_from}:${workflow.round}`,
      );
      enqueueWorkflowWorkbenchSync(
        workflowId,
        'workflow_updated',
        { resultSummary: '任务已恢复，委派仍在执行' },
        `resume_pending_updated:${workflow.round}`,
      );
      enqueueWorkflowNotification(
        workflow,
        `[流程恢复] 需求「${workflow.name}」(${workflowId}) 已恢复，任务仍在执行中。`,
        `resume_pending_notify:${workflow.round}`,
      );
      processWorkflowOutbox();
      return {};
    }
  }

  // No active delegation (e.g. paused_from is an interrupt state) — restore state
  updateWorkflow(workflowId, {
    status: workflow.paused_from,
    paused_from: null,
  });
  enqueueWorkflowWorkbenchSync(
    workflowId,
    'transition',
    {
      fromStatus: workflow.status,
      toStatus: workflow.paused_from,
      delegationId: workflow.current_delegation_id,
    },
    `resume_transition:${workflow.paused_from}:${workflow.round}`,
  );
  enqueueWorkflowWorkbenchSync(
    workflowId,
    'workflow_updated',
    { resultSummary: '任务已恢复' },
    `resume_updated:${workflow.round}`,
  );
  enqueueWorkflowNotification(
    workflow,
    `[流程恢复] 需求「${workflow.name}」(${workflowId}) 已恢复。`,
    `resume_notify:${workflow.round}`,
  );

  // If resuming to an interrupt state, resend its card
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (config) {
    const resumedStateConfig = config.states[workflow.paused_from];
    if (resumedStateConfig?.type === 'interrupt' && resumedStateConfig.card) {
      const updatedWorkflow = getWorkflow(workflowId);
      if (updatedWorkflow) {
        ensureWorkflowStateDurableRecords(updatedWorkflow, 'resume', 'paused');
        enqueueWorkflowCard(
          updatedWorkflow,
          resumedStateConfig.card,
          `resume_card:${workflow.paused_from}:${updatedWorkflow.round}`,
        );
      }
    }
  }
  processWorkflowOutbox();
  return {};
}

// -------------------------------------------------------
// Card action handler
// -------------------------------------------------------

export function handleCardAction(action: {
  action: string;
  user_id: string;
  message_id: string;
  actor_channel?: WorkflowInterruptActorChannel;
  group_folder?: string;
  workflow_id?: string;
  form_value?: Record<string, string>;
}): CardActionResult {
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
      return {
        ok: false,
        toast: { type: 'error', content: '缺少中断 ID 或恢复动作' },
      };
    }
    const payload = buildCardActionPayload(action.form_value, [
      'action',
      'workflow_id',
      'interrupt_id',
      'resume_action',
      'resume_payload_schema',
      'payload',
    ]);
    const result = resumeWorkflowInterrupt({
      interruptId: resolvedInterruptId,
      action: resumeAction,
      payload,
      actor: {
        channel: action.actor_channel || 'feishu',
        userId: action.user_id,
      },
      idempotencyKey: buildIdempotencyKey(resolvedInterruptId, resumeAction),
    });
    if (!result.ok) {
      notifyMain(
        `[操作失败] 恢复流程中断失败: ${result.error}`,
        wfSourceJid,
        action.workflow_id,
      );
      return {
        ok: false,
        toast: {
          type: 'error',
          content: `恢复流程中断失败: ${result.error}`,
        },
      };
    }
    return {
      ok: true,
      toast: { type: 'success', content: '已提交操作，正在推进后续流程。' },
    };
  }

  switch (action.action) {
    case 'pause':
    case 'pause_workflow': {
      if (!action.workflow_id) {
        notifyMain('[操作失败] 缺少流程 ID', wfSourceJid);
        return {
          ok: false,
          toast: { type: 'error', content: '缺少流程 ID' },
        };
      }
      const result = pauseWorkflow(action.workflow_id);
      if (result.error) {
        notifyMain(
          `[操作失败] 中断流程失败: ${result.error}`,
          wfSourceJid,
          action.workflow_id,
        );
        return {
          ok: false,
          toast: { type: 'error', content: `中断流程失败: ${result.error}` },
        };
      }
      return {
        ok: true,
        toast: { type: 'success', content: '已提交中断流程操作。' },
      };
    }
    case 'resume': {
      if (!action.workflow_id) {
        notifyMain('[操作失败] 缺少流程 ID', wfSourceJid);
        return {
          ok: false,
          toast: { type: 'error', content: '缺少流程 ID' },
        };
      }
      const result = resumeWorkflow(action.workflow_id);
      if (result.error) {
        notifyMain(
          `[操作失败] 恢复流程失败: ${result.error}`,
          wfSourceJid,
          action.workflow_id,
        );
        return {
          ok: false,
          toast: { type: 'error', content: `恢复流程失败: ${result.error}` },
        };
      }
      return {
        ok: true,
        toast: { type: 'success', content: '已提交恢复流程操作。' },
      };
    }
    case 'cancel':
    case 'cancel_workflow': {
      if (!action.workflow_id) {
        notifyMain('[操作失败] 缺少流程 ID', wfSourceJid);
        return {
          ok: false,
          toast: { type: 'error', content: '缺少流程 ID' },
        };
      }
      const result = cancelWorkflow(action.workflow_id);
      if (result.error) {
        notifyMain(
          `[操作失败] 取消流程失败: ${result.error}`,
          wfSourceJid,
          action.workflow_id,
        );
        return {
          ok: false,
          toast: { type: 'error', content: `取消流程失败: ${result.error}` },
        };
      }
      return {
        ok: true,
        toast: { type: 'success', content: '已提交取消流程操作。' },
      };
    }
    case 'memory_conflict_keep': {
      const folder = action.group_folder;
      const keepId = action.form_value?.keep_id;
      const deprecateId = action.form_value?.deprecate_id;
      if (!folder || !keepId || !deprecateId) {
        notifyMain('[操作失败] 记忆冲突处理缺少必要参数。', wfSourceJid);
        return {
          ok: false,
          toast: { type: 'error', content: '记忆冲突处理缺少必要参数。' },
        };
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
      return {
        ok: true,
        toast: { type: 'success', content: '已提交保留方案。' },
      };
    }
    case 'memory_conflict_merge': {
      const folder = action.group_folder;
      const mergedContent = action.form_value?.merged_content?.trim();
      const mergeA = action.form_value?.merge_id_a;
      const mergeB = action.form_value?.merge_id_b;
      if (!folder || !mergeA || !mergeB) {
        notifyMain('[操作失败] 合并冲突缺少必要参数。', wfSourceJid);
        return {
          ok: false,
          toast: { type: 'error', content: '合并冲突缺少必要参数。' },
        };
      }
      if (!mergedContent) {
        notifyGroupFolder(folder, '记忆整理', '请填写合并内容后再提交。');
        return {
          ok: false,
          toast: { type: 'error', content: '请填写合并内容后再提交。' },
        };
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
      return {
        ok: true,
        toast: { type: 'success', content: '已提交合并方案。' },
      };
    }
    case 'memory_conflict_skip': {
      const folder = action.group_folder;
      if (!folder) {
        notifyMain('[操作失败] 缺少 group_folder。', wfSourceJid);
        return {
          ok: false,
          toast: { type: 'error', content: '缺少 group_folder。' },
        };
      }
      notifyGroupFolder(folder, '记忆整理', '已跳过该冲突，稍后可继续处理。');
      return {
        ok: true,
        toast: { type: 'success', content: '已跳过该冲突。' },
      };
    }
    default:
      logger.warn({ action: action.action }, 'Unknown card action');
      return {
        ok: false,
        toast: { type: 'error', content: `未知卡片操作: ${action.action}` },
      };
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
      manual_requirement_create?: WorkflowManualRequirementCreateConfig;
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
            ? getWorkflowEntryPointDeliverableFileName(
                config,
                ep.deliverable_role,
              )
            : undefined,
          manual_requirement_create: ep.manual_requirement_create,
        },
      ]),
    ),
    role_channels: Object.fromEntries(
      Object.entries(config.roles).map(([role, rc]) => [role, rc.channels]),
    ),
    create_form: config.create_form,
  }));
}
