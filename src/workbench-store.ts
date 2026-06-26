import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from './config.js';
import {
  createWorkbenchActionItem,
  createWorkbenchArtifact,
  createWorkbenchEvent,
  createWorkbenchSubtask,
  createWorkbenchTask,
  getDelegation,
  getWorkbenchSubtaskByDelegationId,
  getDelegationsByWorkflow,
  getWorkflowStageEvaluation,
  getPendingWorkflowInterruptForState,
  getWorkbenchActionItem,
  getWorkbenchTaskById,
  getWorkbenchSubtaskByStage,
  getWorkbenchTaskByWorkflowId,
  getWorkflow,
  listWorkbenchActionItemsByTask,
  listWorkbenchActionItemsBySource,
  listWorkflowStageEvaluationsByWorkflow,
  listWorkbenchSubtasksByTask,
  resolveWorkbenchActionItemsBySource,
  resolveWorkbenchActionItemsByStage,
  updateWorkbenchActionItem,
  updateWorkbenchSubtask,
  updateWorkbenchTask,
} from './db.js';
import type {
  Delegation,
  Workflow,
  WorkbenchActionItemRecord,
  WorkflowInterruptRecord,
  WorkflowEvalEvidence,
  WorkflowEvalFinding,
} from './types.js';
import type { WorkbenchActionItem, WorkbenchTaskItem } from './workbench.js';
import { resolveWorkflowArtifactDefinitions } from './workflow-artifacts.js';
import { buildHumanInputCard } from './human-input-card.js';
import { emitWorkbenchEvent } from './workbench-events.js';
import {
  getCardConfig,
  getReachableWorkflowStages,
  getWorkflowTypeConfig,
  renderTemplate,
} from './workflow-config.js';
import {
  getWorkflowContextValue,
  WORKFLOW_CONTEXT_KEYS,
  cloneWorkflowContext,
} from './workflow-context.js';

function nowIso(): string {
  return new Date().toISOString();
}

function buildTemplateVars(
  workflow: Workflow,
): Record<string, string | number> {
  return {
    name: workflow.name,
    service: workflow.service,
    main_branch: getWorkflowContextValue(
      workflow,
      WORKFLOW_CONTEXT_KEYS.mainBranch,
    ),
    work_branch:
      getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.workBranch) ||
      'N/A',
    staging_base_branch: getWorkflowContextValue(
      workflow,
      WORKFLOW_CONTEXT_KEYS.stagingBaseBranch,
    ),
    staging_work_branch: getWorkflowContextValue(
      workflow,
      WORKFLOW_CONTEXT_KEYS.stagingWorkBranch,
    ),
    id: workflow.id,
    round: workflow.round,
    deliverable:
      getWorkflowContextValue(workflow, WORKFLOW_CONTEXT_KEYS.deliverable) ||
      'N/A',
    delegation_result: '',
    result_summary: '',
    revision_text: '',
  };
}

function truncate(text: string | null | undefined, max = 400): string {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function parseExtraJson(
  raw: string | null | undefined,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function taskIdForWorkflow(workflow: Workflow): string {
  return `wb-${workflow.id}`;
}

function stageActionItemId(workflowId: string, stageKey: string): string {
  return `wb-action-${workflowId}-${stageKey}`;
}

function subtaskId(taskId: string, stageKey: string, attempt = 1): string {
  const baseId = `wb-subtask-${taskId}-${stageKey}`;
  return attempt <= 1 ? baseId : `${baseId}-${attempt}`;
}

function actionItemId(
  workflowId: string,
  stageKey: string,
  sourceType: string,
  sourceRefId: string,
): string {
  return `wb-action-${workflowId}-${stageKey}-${sourceType}-${sourceRefId}`;
}

function stageEvaluationActionItemId(
  workflowId: string,
  stageKey: string,
): string {
  return `wb-action-${workflowId}-${stageKey}-evaluation`;
}

function getPendingActionSummary(taskId: string): {
  pendingApproval: boolean;
  pendingActionCount: number;
} {
  const pendingActionCount = listWorkbenchActionItemsByTask(taskId).filter(
    (item) => item.status === 'pending',
  ).length;
  return {
    pendingApproval: pendingActionCount > 0,
    pendingActionCount,
  };
}

function emitActionItemUpdate(
  taskId: string,
  workflowId: string,
  payload: Record<string, unknown>,
): void {
  const pendingSummary = getPendingActionSummary(taskId);
  const task = getWorkbenchTaskById(taskId);
  const workflow = getWorkflow(workflowId);
  emitWorkbenchEvent({
    type: 'action_item_updated',
    taskId,
    workflowId,
    payload: {
      ...payload,
      taskTitle: task?.title || workflow?.name || '',
      workflowStageLabel:
        workflow && task
          ? getStatusLabel(workflow.workflow_type, task.current_stage)
          : '',
      pendingApproval: pendingSummary.pendingApproval,
      pendingActionCount: pendingSummary.pendingActionCount,
    },
  });
}

function getStatusLabel(workflowType: string, stageKey: string): string {
  const config = getWorkflowTypeConfig(workflowType);
  return config?.status_labels[stageKey] || stageKey;
}

function isTerminalWorkflowStatus(
  workflowType: string,
  status: string,
): boolean {
  const config = getWorkflowTypeConfig(workflowType);
  return config?.states[status]?.type === 'terminal';
}

function isCompletedWorkflowStatus(
  workflowType: string,
  status: string,
): boolean {
  if (!isTerminalWorkflowStatus(workflowType, status)) return false;
  return /(?:^|_)(passed|completed|done|success)(?:_|$)/.test(status);
}

function getTaskState(
  workflowType: string,
  status: string,
): 'running' | 'success' | 'failed' | 'cancelled' {
  if (!isTerminalWorkflowStatus(workflowType, status)) return 'running';
  if (status === 'cancelled') return 'cancelled';
  if (isCompletedWorkflowStatus(workflowType, status)) return 'success';
  return 'failed';
}

function resolveSubtaskForDelegation(params: {
  taskId: string;
  workflow: Workflow;
  delegationId: string;
  createIfNeeded?: boolean;
}): ReturnType<typeof getWorkbenchSubtaskByStage> {
  const exactMatch = getWorkbenchSubtaskByDelegationId(
    params.taskId,
    params.delegationId,
  );
  if (exactMatch) return exactMatch;
  if (params.workflow.current_delegation_id !== params.delegationId) {
    return undefined;
  }
  const stageSubtask = getWorkbenchSubtaskByStage(
    params.taskId,
    params.workflow.status,
  );
  const canReuseStageSubtask =
    !!stageSubtask &&
    (!stageSubtask.delegation_id ||
      stageSubtask.delegation_id === params.delegationId);
  if (!params.createIfNeeded || canReuseStageSubtask) {
    return stageSubtask;
  }

  const createdSubtaskId = createStageSubtask({
    workflow: params.workflow,
    taskId: params.taskId,
    stageKey: params.workflow.status,
    status: 'current',
    startedAt: params.workflow.updated_at,
    updatedAt: params.workflow.updated_at,
  });
  return createdSubtaskId
    ? getWorkbenchSubtaskByStage(params.taskId, params.workflow.status)
    : stageSubtask;
}

function resolveTransitionTargetSubtask(params: {
  taskId: string;
  workflow: Workflow;
  fromStatus: string;
  toStatus: string;
  delegationId?: string;
}): ReturnType<typeof getWorkbenchSubtaskByStage> {
  const isCurrentDelegation =
    !!params.delegationId &&
    params.workflow.current_delegation_id === params.delegationId;
  if (isCurrentDelegation) {
    const delegationSubtask = getWorkbenchSubtaskByDelegationId(
      params.taskId,
      params.delegationId!,
    );
    if (delegationSubtask?.stage_key === params.toStatus) {
      return delegationSubtask;
    }
  }

  const toSubtask = getWorkbenchSubtaskByStage(params.taskId, params.toStatus);
  const hasDifferentDelegation =
    !!toSubtask?.delegation_id &&
    !!params.delegationId &&
    toSubtask.delegation_id !== params.delegationId;
  const shouldCreateReentrySubtask =
    !!toSubtask &&
    ((params.fromStatus !== 'paused' &&
      toSubtask.stage_key === params.toStatus &&
      toSubtask.status !== 'pending' &&
      toSubtask.status !== 'current') ||
      hasDifferentDelegation);

  if (!shouldCreateReentrySubtask) return toSubtask;

  const createdSubtaskId = createStageSubtask({
    workflow: params.workflow,
    taskId: params.taskId,
    stageKey: params.toStatus,
    status: 'current',
    startedAt: params.workflow.updated_at,
    updatedAt: params.workflow.updated_at,
  });
  return createdSubtaskId
    ? getWorkbenchSubtaskByStage(params.taskId, params.toStatus)
    : toSubtask;
}

function completeSiblingCurrentSubtasks(params: {
  taskId: string;
  workflowId: string;
  stageKey: string;
  keepSubtaskId: string;
  updatedAt: string;
}): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const subtask of listWorkbenchSubtasksByTask(params.taskId)) {
    if (
      subtask.id === params.keepSubtaskId ||
      subtask.workflow_id !== params.workflowId ||
      subtask.stage_key !== params.stageKey ||
      subtask.status !== 'current'
    ) {
      continue;
    }
    updateWorkbenchSubtask(subtask.id, {
      status: 'completed',
      finished_at: subtask.finished_at || params.updatedAt,
      updated_at: params.updatedAt,
    });
    events.push({
      id: subtask.id,
      stageKey: params.stageKey,
      status: 'completed',
    });
  }
  return events;
}

function resolveSubtaskStatusForDelegation(
  delegation: Delegation,
  isCurrentDelegation: boolean,
): 'current' | 'completed' | 'failed' | 'pending' {
  if (isCurrentDelegation && delegation.status === 'pending') {
    return 'current';
  }
  if (delegation.outcome === 'failure' || delegation.status === 'failed') {
    return 'failed';
  }
  if (delegation.status === 'completed') return 'completed';
  return 'pending';
}

function upsertActionItem(params: {
  id: string;
  workflowId: string;
  stageKey: string | null;
  subtaskId: string | null;
  delegationId?: string | null;
  groupFolder?: string | null;
  itemType: string;
  title: string;
  body?: string | null;
  sourceType: string;
  sourceRefId: string;
  replyable: boolean;
  extra?: Record<string, unknown>;
  createdAt: string;
}): void {
  const task = getWorkbenchTaskByWorkflowId(params.workflowId);
  if (!task) return;
  const existing = getWorkbenchActionItem(params.id);
  const actionMode: WorkbenchActionItem['action_mode'] =
    params.extra?.action_mode === 'approve_only' ||
    params.extra?.action_mode === 'approve_or_revise' ||
    params.extra?.action_mode === 'input_required'
      ? params.extra.action_mode
      : undefined;
  const workflow = getWorkflow(params.workflowId);
  const typeConfig = getWorkflowTypeConfig(
    workflow?.workflow_type || task.workflow_type,
  );
  const workflowStatus = workflow?.status || task.status;
  const taskItemForCard: WorkbenchTaskItem = {
    id: task.id,
    title: task.title,
    service: task.service,
    start_from: task.start_from,
    workflow_type: task.workflow_type,
    workflow_status: workflowStatus,
    workflow_status_label:
      typeConfig?.status_labels[workflowStatus] || workflowStatus,
    task_state: task.task_state,
    workflow_stage: task.current_stage,
    workflow_stage_label:
      typeConfig?.status_labels[task.current_stage] || task.current_stage,
    round: workflow?.round || 0,
    source_jid: task.source_jid,
    created_at: task.created_at,
    updated_at: task.updated_at,
    pending_approval: true,
    pending_action_count: 1,
    active_delegation_id: workflow?.current_delegation_id || '',
    context: workflow?.context || {},
  };
  const actionItemPayload: WorkbenchActionItem = {
    id: params.id,
    item_type: params.itemType as
      | 'approval'
      | 'revision_request'
      | 'credential'
      | 'human_input'
      | 'external_blocker'
      | 'interactive',
    source_type: params.sourceType as
      | 'workflow_interrupt'
      | 'request_human_input'
      | 'ask_user_question'
      | 'send_message',
    title: params.title,
    body: params.body ?? '',
    status: (existing?.status && existing.status !== 'resolved'
      ? existing.status
      : 'pending') as
      | 'pending'
      | 'confirmed'
      | 'resolved'
      | 'skipped'
      | 'cancelled'
      | 'expired',
    stage_key: params.stageKey ?? undefined,
    delegation_id: params.delegationId ?? undefined,
    group_folder: params.groupFolder ?? undefined,
    source_ref_id: params.sourceRefId,
    replyable: params.replyable,
    action_mode: actionMode,
    created_at: existing?.created_at || params.createdAt,
    extra: params.extra,
  };
  createWorkbenchActionItem({
    id: params.id,
    task_id: task.id,
    workflow_id: params.workflowId,
    subtask_id: params.subtaskId,
    stage_key: params.stageKey,
    delegation_id: params.delegationId ?? null,
    group_folder: params.groupFolder ?? null,
    item_type: params.itemType,
    status:
      existing?.status && existing.status !== 'resolved'
        ? existing.status
        : 'pending',
    title: params.title,
    body: params.body ?? null,
    source_type: params.sourceType,
    source_ref_id: params.sourceRefId,
    replyable: params.replyable ? 1 : 0,
    created_at: existing?.created_at || params.createdAt,
    updated_at: params.createdAt,
    resolved_at: existing?.resolved_at ?? null,
    extra_json: params.extra ? JSON.stringify(params.extra) : null,
  });
  emitActionItemUpdate(task.id, params.workflowId, {
    id: params.id,
    status: 'pending',
    itemType: params.itemType,
    sourceType: params.sourceType,
    title: params.title,
    body: params.body ?? '',
    sourceRefId: params.sourceRefId,
    groupFolder: params.groupFolder ?? undefined,
    stageKey: params.stageKey ?? undefined,
    delegationId: params.delegationId ?? undefined,
    replyable: params.replyable,
    extra: params.extra,
    card: buildHumanInputCard(actionItemPayload, taskItemForCard),
    createdAt: existing?.created_at || params.createdAt,
    updatedAt: params.createdAt,
  });
}

function parseEvaluationFindings(
  raw: string | null | undefined,
): WorkflowEvalFinding[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WorkflowEvalFinding[]) : [];
  } catch {
    return [];
  }
}

function parseEvaluationEvidence(
  raw: string | null | undefined,
): WorkflowEvalEvidence[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WorkflowEvalEvidence[]) : [];
  } catch {
    return [];
  }
}

function buildEvaluationEventBody(params: {
  summary: string | null;
  findings: WorkflowEvalFinding[];
  evidence: WorkflowEvalEvidence[];
}): string {
  const lines: string[] = [];
  if (params.summary) lines.push(params.summary.trim());
  if (params.findings.length > 0) {
    lines.push(
      ...params.findings
        .slice(0, 3)
        .map((item) => `- [${item.severity}] ${truncate(item.message, 140)}`),
    );
  }
  if (params.evidence.length > 0) {
    lines.push(
      ...params.evidence
        .slice(0, 2)
        .map((item) => `证据: ${truncate(item.summary, 140)}`),
    );
  }
  return truncate(lines.join('\n'), 1000);
}

function ensureArtifacts(workflow: Workflow): void {
  const deliverable = getWorkflowContextValue(
    workflow,
    WORKFLOW_CONTEXT_KEYS.deliverable,
  );
  if (!deliverable || !workflow.service) return;
  const task = getWorkbenchTaskByWorkflowId(workflow.id);
  if (!task) return;

  const baseDir = path.join(
    PROJECT_ROOT,
    'projects',
    workflow.service,
    'iteration',
    deliverable,
  );
  const workflowConfig = getWorkflowTypeConfig(workflow.workflow_type);
  const artifactDefinitions = resolveWorkflowArtifactDefinitions(
    workflowConfig?.artifacts,
    workflow,
  );
  for (const def of artifactDefinitions) {
    const relativePath =
      def.project_path ||
      path.relative(PROJECT_ROOT, path.join(baseDir, def.file));
    const fullPath = path.join(PROJECT_ROOT, relativePath);
    if (!fs.existsSync(fullPath)) continue;
    createWorkbenchArtifact({
      id: `${task.id}-${def.file}`,
      task_id: task.id,
      workflow_id: workflow.id,
      artifact_type: def.artifact_type,
      title: def.title,
      path: relativePath,
      source_role: def.source_role,
      created_at: workflow.updated_at,
    });
    emitWorkbenchEvent({
      type: 'artifact_created',
      taskId: task.id,
      workflowId: workflow.id,
      payload: {
        id: `${task.id}-${def.file}`,
        title: def.title,
        path: relativePath,
        absolutePath: fullPath,
        createdAt: workflow.updated_at,
      },
    });
  }
}

function parseInterruptJsonArray(raw: string | null | undefined): string[] {
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

function ensurePendingInterruptForWorkbench(
  workflow: Workflow,
): WorkflowInterruptRecord | null {
  return (
    getPendingWorkflowInterruptForState(workflow.id, workflow.status) || null
  );
}

function upsertStageActionItem(
  workflow: Workflow,
  interrupt?: WorkflowInterruptRecord | null,
): void {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const task = getWorkbenchTaskByWorkflowId(workflow.id);
  if (!config || !task) return;
  const state = config.states[workflow.status];
  if (!state || state.type !== 'interrupt') return;
  const pendingInterrupt =
    interrupt || ensurePendingInterruptForWorkbench(workflow);
  if (!pendingInterrupt) return;
  const card = state.card
    ? getCardConfig(workflow.workflow_type, state.card)
    : undefined;
  const title = config.status_labels[workflow.status] || workflow.status;
  const vars = buildTemplateVars(workflow);
  upsertActionItem({
    id: stageActionItemId(workflow.id, workflow.status),
    workflowId: workflow.id,
    stageKey: workflow.status,
    subtaskId: getWorkbenchSubtaskByStage(task.id, workflow.status)?.id || null,
    delegationId: workflow.current_delegation_id || null,
    itemType: pendingInterrupt.kind,
    title,
    body: card?.body_template
      ? renderTemplate(card.body_template, vars)
      : pendingInterrupt.body || title,
    sourceType: 'workflow_interrupt',
    sourceRefId: pendingInterrupt.id,
    replyable: false,
    createdAt: pendingInterrupt.created_at,
    extra: {
      interruptId: pendingInterrupt.id,
      workflowId: workflow.id,
      allowedActions: parseInterruptJsonArray(
        pendingInterrupt.allowed_actions_json,
      ),
      payloadSchema: pendingInterrupt.resume_payload_schema_json
        ? JSON.parse(pendingInterrupt.resume_payload_schema_json)
        : {},
      allowedChannels: parseInterruptJsonArray(
        pendingInterrupt.allowed_channels_json,
      ),
      action_kind: 'resume_workflow_interrupt',
      approval_type: workflow.status,
      action_mode:
        workflow.status === 'testing_confirm'
          ? 'input_required'
          : state.allowed_actions?.includes('revise')
            ? 'approve_or_revise'
            : 'approve_only',
    },
  });
}

function resolveCurrentStageActionItems(
  taskId: string,
  resolvedAt: string,
): void {
  const task = getWorkbenchTaskById(taskId);
  if (!task) return;
  const currentStageItems = listWorkbenchActionItemsByTask(taskId).filter(
    (item) =>
      item.stage_key === task.current_stage &&
      (item.status === 'pending' || item.status === 'confirmed'),
  );
  if (currentStageItems.length === 0) return;
  resolveWorkbenchActionItemsByStage(
    task.workflow_id,
    task.current_stage,
    'resolved',
    resolvedAt,
  );
  for (const item of currentStageItems) {
    emitActionItemUpdate(taskId, task.workflow_id, {
      id: item.id,
      status: 'resolved',
      resolvedAt,
    });
  }
}

function resolveStaleStageActionItems(
  taskId: string,
  currentApprovalType: string | null,
  resolvedAt: string,
): void {
  const task = getWorkbenchTaskById(taskId);
  if (!task) return;
  const workflow = getWorkflow(task.workflow_id);
  if (!workflow) return;

  const isCurrentWorkflowApprovalItem = (item: WorkbenchActionItemRecord) =>
    item.source_type === 'workflow_interrupt' &&
    !!currentApprovalType &&
    item.stage_key === currentApprovalType;

  const isCurrentInteractionItem = (item: WorkbenchActionItemRecord) => {
    if (item.source_type === 'workflow_interrupt') return false;
    if (item.stage_key !== task.current_stage) return false;
    if (!item.delegation_id || !workflow.current_delegation_id) return false;
    return item.delegation_id === workflow.current_delegation_id;
  };

  const isStickyCurrentStageItem = (item: WorkbenchActionItemRecord) => {
    if (item.stage_key !== task.current_stage) return false;
    return (
      parseExtraJson(item.extra_json)?.keep_visible_when_current_stage === true
    );
  };

  for (const item of listWorkbenchActionItemsByTask(taskId)) {
    if (item.status !== 'pending') continue;
    if (
      isCurrentWorkflowApprovalItem(item) ||
      isCurrentInteractionItem(item) ||
      isStickyCurrentStageItem(item)
    ) {
      continue;
    }
    updateWorkbenchActionItem(item.id, {
      status: 'resolved',
      updated_at: resolvedAt,
      resolved_at: resolvedAt,
    });
    emitActionItemUpdate(taskId, task.workflow_id, {
      id: item.id,
      status: 'resolved',
      resolvedAt,
    });
  }
}

function nextSubtaskAttempt(taskId: string, stageKey: string): number {
  return (
    listWorkbenchSubtasksByTask(taskId).filter(
      (item) => item.stage_key === stageKey,
    ).length + 1
  );
}

function createStageSubtask(params: {
  workflow: Workflow;
  taskId: string;
  stageKey: string;
  status: 'current' | 'pending';
  startedAt: string | null;
  updatedAt: string;
  attempt?: number;
}): string | null {
  const config = getWorkflowTypeConfig(params.workflow.workflow_type);
  const state = config?.states[params.stageKey];
  if (!config || !state) return null;

  const attempt =
    params.attempt ?? nextSubtaskAttempt(params.taskId, params.stageKey);
  const id = subtaskId(params.taskId, params.stageKey, attempt);
  createWorkbenchSubtask({
    id,
    task_id: params.taskId,
    workflow_id: params.workflow.id,
    delegation_id: null,
    stage_key: params.stageKey,
    title: config.status_labels[params.stageKey] || params.stageKey,
    role: state.role || null,
    group_folder: null,
    status: params.status,
    input_summary: state.task_template
      ? truncate(state.task_template, 240)
      : null,
    output_summary: null,
    started_at: params.startedAt,
    finished_at: null,
    updated_at: params.updatedAt,
  });
  emitWorkbenchEvent({
    type: 'subtask_updated',
    taskId: params.taskId,
    workflowId: params.workflow.id,
    payload: {
      id,
      stageKey: params.stageKey,
      status: params.status,
      attempt,
    },
  });
  return id;
}

function ensureSubtasks(workflow: Workflow): void {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const task = getWorkbenchTaskByWorkflowId(workflow.id);
  if (!config || !task) return;

  const visibleStages = new Set(
    getReachableWorkflowStages(workflow.workflow_type, workflow.status),
  );

  for (const [stageKey, state] of Object.entries(config.states)) {
    if (
      state.type === 'system' ||
      state.type === 'terminal' ||
      !visibleStages.has(stageKey)
    ) {
      continue;
    }
    const existing = getWorkbenchSubtaskByStage(task.id, stageKey);
    if (existing) continue;
    createStageSubtask({
      workflow,
      taskId: task.id,
      stageKey,
      status: stageKey === workflow.status ? 'current' : 'pending',
      startedAt: stageKey === workflow.status ? workflow.created_at : null,
      updatedAt: workflow.updated_at,
      attempt: 1,
    });
  }
}

function resolveBypassedInterruptStages(
  workflow: Workflow,
  fromStatus: string,
  toStatus: string,
): string[] {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return [];

  const fromState = config.states[fromStatus];
  if (!fromState || fromState.type !== 'delegation' || !fromState.on_complete) {
    return [];
  }

  const candidateTargets = new Set<string>();
  if (fromState.on_complete.success?.target === toStatus) {
    candidateTargets.add(fromState.on_complete.failure?.target || '');
  }
  if (fromState.on_complete.failure?.target === toStatus) {
    candidateTargets.add(fromState.on_complete.success?.target || '');
  }

  return Array.from(candidateTargets).filter((stageKey) => {
    if (!stageKey || stageKey === fromStatus || stageKey === toStatus)
      return false;
    const state = config.states[stageKey];
    return (
      state?.type === 'interrupt' &&
      Object.values(state.on_resume || {}).some(
        (transition) => transition.target === toStatus,
      )
    );
  });
}

export function createWorkbenchInteractionItem(input: {
  workflowId: string;
  stageKey: string;
  delegationId?: string | null;
  groupFolder?: string | null;
  sourceType: 'request_human_input' | 'ask_user_question' | 'send_message';
  sourceRefId: string;
  title: string;
  body?: string | null;
  replyable?: boolean;
  createdAt?: string;
  extra?: Record<string, unknown>;
}): void {
  const workflow = getWorkflow(input.workflowId);
  const task = getWorkbenchTaskByWorkflowId(input.workflowId);
  if (!workflow || !task) return;
  const subtask = getWorkbenchSubtaskByStage(task.id, input.stageKey);
  upsertActionItem({
    id: actionItemId(
      input.workflowId,
      input.stageKey,
      input.sourceType,
      input.sourceRefId,
    ),
    workflowId: input.workflowId,
    stageKey: input.stageKey,
    subtaskId: subtask?.id || null,
    delegationId:
      input.delegationId ?? (workflow.current_delegation_id || null),
    groupFolder: input.groupFolder ?? subtask?.group_folder ?? null,
    itemType: 'interactive',
    title: input.title,
    body: input.body ?? null,
    sourceType: input.sourceType,
    sourceRefId: input.sourceRefId,
    replyable: input.replyable !== false,
    createdAt: input.createdAt || workflow.updated_at,
    extra: input.extra,
  });
}

export function updateWorkbenchInteractionItemStatus(input: {
  sourceType: string;
  sourceRefId: string;
  status: 'confirmed' | 'resolved' | 'skipped' | 'cancelled' | 'expired';
}): void {
  const now = nowIso();
  const items = listWorkbenchActionItemsBySource(
    input.sourceType,
    input.sourceRefId,
  );
  resolveWorkbenchActionItemsBySource(
    input.sourceType,
    input.sourceRefId,
    input.status,
    now,
  );
  for (const item of items) {
    emitActionItemUpdate(item.task_id, item.workflow_id, {
      id: item.id,
      status: input.status,
      resolvedAt: now,
    });
  }
}

export function syncWorkbenchInteractionItem(input: {
  sourceType: 'request_human_input' | 'ask_user_question' | 'send_message';
  sourceRefId: string;
  body?: string | null;
  replyable?: boolean;
  extra?: Record<string, unknown>;
}): void {
  const now = nowIso();
  const items = listWorkbenchActionItemsBySource(
    input.sourceType,
    input.sourceRefId,
  );
  for (const item of items) {
    updateWorkbenchActionItem(item.id, {
      body: input.body ?? item.body,
      replyable:
        input.replyable !== undefined
          ? Number(input.replyable)
          : item.replyable,
      updated_at: now,
      extra_json:
        input.extra !== undefined
          ? JSON.stringify(input.extra)
          : item.extra_json,
    });
    emitActionItemUpdate(item.task_id, item.workflow_id, {
      id: item.id,
      status: item.status,
      body: input.body ?? item.body ?? '',
      replyable:
        input.replyable !== undefined ? input.replyable : item.replyable === 1,
      extra: input.extra,
    });
  }
}

export function syncWorkbenchOnWorkflowCreated(workflowId: string): void {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return;
  const taskId = taskIdForWorkflow(workflow);
  if (!getWorkbenchTaskByWorkflowId(workflow.id)) {
    const taskState = getTaskState(workflow.workflow_type, workflow.status);
    createWorkbenchTask({
      id: taskId,
      workflow_id: workflow.id,
      source_jid: workflow.source_jid,
      title: workflow.name,
      service: workflow.service,
      start_from: workflow.start_from,
      workflow_type: workflow.workflow_type,
      status: workflow.status,
      task_state: taskState,
      current_stage: workflow.status,
      summary: null,
      created_at: workflow.created_at,
      updated_at: workflow.updated_at,
      last_event_at: workflow.created_at,
    });
    createWorkbenchEvent({
      id: `${taskId}-created`,
      task_id: taskId,
      subtask_id: null,
      event_type: 'workflow_created',
      title: '任务已创建',
      body: `已创建 ${workflow.workflow_type} 工作流，服务 ${workflow.service}`,
      raw_ref_type: 'workflow',
      raw_ref_id: workflow.id,
      created_at: workflow.created_at,
    });
    emitWorkbenchEvent({
      type: 'task_created',
      taskId,
      workflowId: workflow.id,
      payload: {
        id: taskId,
        title: workflow.name,
        service: workflow.service,
        workflowType: workflow.workflow_type,
        workflowStatus: workflow.status,
        workflowStatusLabel: getStatusLabel(
          workflow.workflow_type,
          workflow.status,
        ),
        taskState,
        workflowStage: workflow.status,
        workflowStageLabel: getStatusLabel(
          workflow.workflow_type,
          workflow.status,
        ),
        context: cloneWorkflowContext(workflow.context),
        pendingApproval: false,
        pendingActionCount: 0,
      },
    });
  }
  ensureSubtasks(workflow);
  ensureArtifacts(workflow);
  upsertStageActionItem(workflow);
}

export function syncWorkbenchOnWorkflowUpdated(
  workflowId: string,
  summary?: string,
  options?: {
    emitRealtime?: boolean;
  },
): void {
  const workflow = getWorkflow(workflowId);
  const task = getWorkbenchTaskByWorkflowId(workflowId);
  if (!workflow || !task) return;
  const emitRealtime = options?.emitRealtime !== false;
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const stateConfig = config?.states[workflow.status];
  const pendingSummary = getPendingActionSummary(task.id);
  const taskState = getTaskState(workflow.workflow_type, workflow.status);

  updateWorkbenchTask(task.id, {
    status: workflow.status,
    task_state: taskState,
    current_stage: workflow.status,
    summary: summary !== undefined ? truncate(summary) : task.summary,
    updated_at: workflow.updated_at,
    last_event_at: workflow.updated_at,
    title: workflow.name,
  });
  if (emitRealtime) {
    emitWorkbenchEvent({
      type: 'task_updated',
      taskId: task.id,
      workflowId,
      payload: {
        workflowStatus: workflow.status,
        workflowStatusLabel: getStatusLabel(
          workflow.workflow_type,
          workflow.status,
        ),
        taskState,
        workflowStage: workflow.status,
        workflowStageLabel: getStatusLabel(
          workflow.workflow_type,
          workflow.status,
        ),
        context: cloneWorkflowContext(workflow.context),
        summary: summary !== undefined ? truncate(summary) : task.summary,
        updatedAt: workflow.updated_at,
        pendingApproval:
          stateConfig?.type === 'interrupt' || pendingSummary.pendingApproval,
        pendingActionCount: pendingSummary.pendingActionCount,
      },
    });
  }

  ensureSubtasks(workflow);

  const current = getWorkbenchSubtaskByStage(task.id, workflow.status);
  if (current) {
    const currentStatus =
      workflow.status === 'paused'
        ? 'paused'
        : stateConfig?.type === 'delegation' && !workflow.current_delegation_id
          ? null
          : 'current';
    if (currentStatus) {
      updateWorkbenchSubtask(current.id, {
        status: currentStatus,
        started_at: current.started_at || workflow.updated_at,
        updated_at: workflow.updated_at,
      });
      if (emitRealtime) {
        emitWorkbenchEvent({
          type: 'subtask_updated',
          taskId: task.id,
          workflowId,
          payload: {
            id: current.id,
            stageKey: workflow.status,
            status: currentStatus,
          },
        });
      }
    }
  }

  resolveStaleStageActionItems(
    task.id,
    stateConfig?.type === 'interrupt' ? workflow.status : null,
    workflow.updated_at,
  );

  ensureArtifacts(workflow);
  upsertStageActionItem(workflow);
}

export function syncWorkbenchOnTransition(
  workflowId: string,
  fromStatus: string,
  toStatus: string,
  delegationId?: string,
): void {
  const workflow = getWorkflow(workflowId);
  const task = getWorkbenchTaskByWorkflowId(workflowId);
  if (!workflow || !task) return;
  const subtaskEvents: Array<Record<string, unknown>> = [];

  const fromSubtask = getWorkbenchSubtaskByStage(task.id, fromStatus);
  if (fromSubtask) {
    const nextStatus =
      toStatus === 'cancelled'
        ? 'cancelled'
        : fromSubtask.status === 'failed'
          ? 'failed'
          : 'completed';
    updateWorkbenchSubtask(fromSubtask.id, {
      // Preserve explicit failure markers so the UI can still surface retry.
      status: nextStatus,
      finished_at: workflow.updated_at,
      updated_at: workflow.updated_at,
    });
    subtaskEvents.push({
      id: fromSubtask.id,
      stageKey: fromStatus,
      status: nextStatus,
    });
  }

  const toSubtask = resolveTransitionTargetSubtask({
    taskId: task.id,
    workflow,
    fromStatus,
    toStatus,
    delegationId,
  });

  if (toSubtask) {
    const nextStatus = workflow.status === 'paused' ? 'paused' : 'current';
    updateWorkbenchSubtask(toSubtask.id, {
      status: nextStatus,
      delegation_id: delegationId ?? toSubtask.delegation_id,
      started_at: toSubtask.started_at || workflow.updated_at,
      finished_at: nextStatus === 'current' ? null : toSubtask.finished_at,
      updated_at: workflow.updated_at,
    });
    subtaskEvents.push({
      id: toSubtask.id,
      stageKey: toStatus,
      status: nextStatus,
      delegationId: delegationId ?? toSubtask.delegation_id,
    });
    if (nextStatus === 'current') {
      subtaskEvents.push(
        ...completeSiblingCurrentSubtasks({
          taskId: task.id,
          workflowId,
          stageKey: toStatus,
          keepSubtaskId: toSubtask.id,
          updatedAt: workflow.updated_at,
        }),
      );
    }
  }

  for (const stageKey of resolveBypassedInterruptStages(
    workflow,
    fromStatus,
    toStatus,
  )) {
    const interruptSubtask = getWorkbenchSubtaskByStage(task.id, stageKey);
    if (!interruptSubtask || interruptSubtask.status !== 'pending') {
      continue;
    }
    updateWorkbenchSubtask(interruptSubtask.id, {
      status: 'completed',
      finished_at: workflow.updated_at,
      updated_at: workflow.updated_at,
    });
    subtaskEvents.push({
      id: interruptSubtask.id,
      stageKey,
      status: 'completed',
    });
  }

  resolveCurrentStageActionItems(task.id, workflow.updated_at);
  const taskState = getTaskState(workflow.workflow_type, workflow.status);
  updateWorkbenchTask(task.id, {
    status: workflow.status,
    task_state: taskState,
    current_stage: toStatus,
    updated_at: workflow.updated_at,
    last_event_at: workflow.updated_at,
  });
  const pendingSummary = getPendingActionSummary(task.id);
  const targetState = getWorkflowTypeConfig(workflow.workflow_type)?.states[
    toStatus
  ];
  emitWorkbenchEvent({
    type: 'task_updated',
    taskId: task.id,
    workflowId,
    payload: {
      workflowStatus: workflow.status,
      workflowStatusLabel: getStatusLabel(
        workflow.workflow_type,
        workflow.status,
      ),
      taskState,
      workflowStage: toStatus,
      workflowStageLabel: getStatusLabel(workflow.workflow_type, toStatus),
      context: cloneWorkflowContext(workflow.context),
      updatedAt: workflow.updated_at,
      pendingApproval:
        targetState?.type === 'interrupt' || pendingSummary.pendingApproval,
      pendingActionCount: pendingSummary.pendingActionCount,
    },
  });
  for (const payload of subtaskEvents) {
    emitWorkbenchEvent({
      type: 'subtask_updated',
      taskId: task.id,
      workflowId,
      payload,
    });
  }
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const fromLabel = config?.status_labels[fromStatus] || fromStatus;
  const toLabel = config?.status_labels[toStatus] || toStatus;
  const transitionTitle = `阶段切换：${fromLabel} -> ${toLabel}`;
  const transitionEventId = [
    'wb-event',
    workflow.id,
    'transition',
    fromStatus,
    toStatus,
    workflow.updated_at,
  ].join('-');
  createWorkbenchEvent({
    id: transitionEventId,
    task_id: task.id,
    subtask_id: toSubtask?.id || null,
    event_type: 'transition',
    title: transitionTitle,
    body: delegationId ? `delegation_id=${delegationId}` : null,
    raw_ref_type: 'workflow',
    raw_ref_id: workflow.id,
    created_at: workflow.updated_at,
  });
  emitWorkbenchEvent({
    type: 'event_created',
    taskId: task.id,
    workflowId,
    payload: {
      id: transitionEventId,
      title: transitionTitle,
      body: delegationId ? `delegation_id=${delegationId}` : null,
      status: toStatus,
      createdAt: workflow.updated_at,
    },
  });
  ensureArtifacts(workflow);
  upsertStageActionItem(workflow);
}

export function createWorkbenchManualSkipEvent(
  workflowId: string,
  stageKey: string,
): void {
  const workflow = getWorkflow(workflowId);
  const task = getWorkbenchTaskByWorkflowId(workflowId);
  if (!workflow || !task) return;

  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const stageLabel = config?.status_labels[stageKey] || stageKey;
  const subtask = getWorkbenchSubtaskByStage(task.id, stageKey);
  const createdAt = nowIso();
  const eventId = [
    'wb-event',
    workflow.id,
    'manual-skip',
    stageKey,
    createdAt,
  ].join('-');

  createWorkbenchEvent({
    id: eventId,
    task_id: task.id,
    subtask_id: subtask?.id || null,
    event_type: 'manual_skip',
    title: `手动跳过阶段：${stageLabel}`,
    body: `按“成功处理”跳过 ${stageLabel}，直接进入下一阶段。`,
    raw_ref_type: 'workflow',
    raw_ref_id: workflow.id,
    created_at: createdAt,
  });
  emitWorkbenchEvent({
    type: 'event_created',
    taskId: task.id,
    workflowId,
    payload: {
      id: eventId,
      title: `手动跳过阶段：${stageLabel}`,
      body: `按“成功处理”跳过 ${stageLabel}，直接进入下一阶段。`,
      status: workflow.status,
      createdAt,
    },
  });
}

export function syncWorkbenchOnDelegationCreated(
  workflowId: string,
  delegationId: string,
): void {
  const workflow = getWorkflow(workflowId);
  const task = getWorkbenchTaskByWorkflowId(workflowId);
  const delegation = getDelegation(delegationId);
  if (!workflow || !task || !delegation) return;

  const subtask = resolveSubtaskForDelegation({
    taskId: task.id,
    workflow,
    delegationId,
    createIfNeeded: true,
  });
  if (subtask) {
    const nextStatus = resolveSubtaskStatusForDelegation(
      delegation,
      workflow.current_delegation_id === delegation.id,
    );
    updateWorkbenchSubtask(subtask.id, {
      delegation_id: delegation.id,
      group_folder: delegation.target_folder,
      status: nextStatus,
      input_summary: truncate(delegation.task, 240),
      started_at: subtask.started_at || delegation.created_at,
      finished_at:
        nextStatus === 'completed' || nextStatus === 'failed'
          ? subtask.finished_at || delegation.updated_at
          : null,
      updated_at: delegation.updated_at,
    });
    emitWorkbenchEvent({
      type: 'subtask_updated',
      taskId: task.id,
      workflowId,
      payload: {
        id: subtask.id,
        delegationId: delegation.id,
        status: nextStatus,
        groupFolder: delegation.target_folder,
      },
    });
    if (nextStatus === 'current') {
      for (const payload of completeSiblingCurrentSubtasks({
        taskId: task.id,
        workflowId,
        stageKey: subtask.stage_key,
        keepSubtaskId: subtask.id,
        updatedAt: delegation.updated_at,
      })) {
        emitWorkbenchEvent({
          type: 'subtask_updated',
          taskId: task.id,
          workflowId,
          payload,
        });
      }
    }
  }

  createWorkbenchEvent({
    id: `wb-event-${delegation.id}-created`,
    task_id: task.id,
    subtask_id: subtask?.id || null,
    event_type: 'delegation_created',
    title: `已委派 ${delegation.target_folder}`,
    body: truncate(delegation.task, 500),
    raw_ref_type: 'delegation',
    raw_ref_id: delegation.id,
    created_at: delegation.created_at,
  });
  emitWorkbenchEvent({
    type: 'event_created',
    taskId: task.id,
    workflowId,
    payload: {
      id: `wb-event-${delegation.id}-created`,
      title: `已委派 ${delegation.target_folder}`,
      body: truncate(delegation.task, 500),
      delegationId: delegation.id,
      createdAt: delegation.created_at,
    },
  });
}

export function syncWorkbenchOnDelegationCompleted(
  workflowId: string,
  delegationId: string,
): void {
  const workflow = getWorkflow(workflowId);
  const task = getWorkbenchTaskByWorkflowId(workflowId);
  const delegation = getDelegation(delegationId);
  if (!workflow || !task || !delegation) return;

  const subtask = resolveSubtaskForDelegation({
    taskId: task.id,
    workflow,
    delegationId,
  });
  if (subtask) {
    updateWorkbenchSubtask(subtask.id, {
      output_summary: truncate(delegation.result, 1000),
      finished_at: delegation.updated_at,
      updated_at: delegation.updated_at,
    });
    emitWorkbenchEvent({
      type: 'subtask_updated',
      taskId: task.id,
      workflowId,
      payload: {
        id: subtask.id,
        delegationId: delegation.id,
        status: subtask.status,
      },
    });
  }

  createWorkbenchEvent({
    id: `wb-event-${delegation.id}-completed`,
    task_id: task.id,
    subtask_id: subtask?.id || null,
    event_type: 'delegation_completed',
    title:
      delegation.outcome === 'failure'
        ? `委派失败 ${delegation.target_folder}`
        : `委派完成 ${delegation.target_folder}`,
    body: truncate(delegation.result, 1000),
    raw_ref_type: 'delegation',
    raw_ref_id: delegation.id,
    created_at: delegation.updated_at,
  });
  emitWorkbenchEvent({
    type: 'event_created',
    taskId: task.id,
    workflowId,
    payload: {
      id: `wb-event-${delegation.id}-completed`,
      title:
        delegation.outcome === 'failure'
          ? `委派失败 ${delegation.target_folder}`
          : `委派完成 ${delegation.target_folder}`,
      body: truncate(delegation.result, 1000),
      delegationId: delegation.id,
      createdAt: delegation.updated_at,
    },
  });

  ensureArtifacts(workflow);
}

export function syncWorkbenchOnStageEvaluated(
  workflowId: string,
  stageKey: string,
  evaluationId: string,
): void {
  const workflow = getWorkflow(workflowId);
  const task = getWorkbenchTaskByWorkflowId(workflowId);
  const evaluation = getWorkflowStageEvaluation(evaluationId);
  if (!workflow || !task || !evaluation) return;

  const findings = parseEvaluationFindings(evaluation.findings_json);
  const evidence = parseEvaluationEvidence(evaluation.evidence_json);
  const stageLabel = getStatusLabel(workflow.workflow_type, stageKey);
  const subtask = getWorkbenchSubtaskByStage(task.id, stageKey);

  if (subtask && evaluation.status !== 'passed') {
    updateWorkbenchSubtask(subtask.id, {
      status: 'failed',
      output_summary: truncate(
        evaluation.summary || subtask.output_summary,
        1000,
      ),
      finished_at: subtask.finished_at || evaluation.updated_at,
      updated_at: evaluation.updated_at,
    });
    emitWorkbenchEvent({
      type: 'subtask_updated',
      taskId: task.id,
      workflowId,
      payload: {
        id: subtask.id,
        stageKey,
        status: 'failed',
      },
    });
  }

  const verdictText =
    evaluation.status === 'passed'
      ? '通过'
      : evaluation.status === 'needs_revision'
        ? '需回修'
        : evaluation.status === 'pending'
          ? '待补充证据'
          : '失败';
  const eventId = `wb-event-${evaluation.id}`;
  const body = buildEvaluationEventBody({
    summary: evaluation.summary,
    findings,
    evidence,
  });

  createWorkbenchEvent({
    id: eventId,
    task_id: task.id,
    subtask_id: subtask?.id || null,
    event_type: 'stage_evaluated',
    title: `阶段评测：${stageLabel} ${verdictText}`,
    body: body || null,
    raw_ref_type: 'workflow_stage_evaluation',
    raw_ref_id: evaluation.id,
    created_at: evaluation.updated_at,
  });
  emitWorkbenchEvent({
    type: 'event_created',
    taskId: task.id,
    workflowId,
    payload: {
      id: eventId,
      title: `阶段评测：${stageLabel} ${verdictText}`,
      body,
      createdAt: evaluation.updated_at,
      status: evaluation.status,
      stageKey,
      score: evaluation.score,
    },
  });
}

export function syncWorkbenchOnStageEvaluationActionNeeded(
  workflowId: string,
  stageKey: string,
  evaluationId: string,
  options?: {
    keepVisibleWhenCurrentStage?: boolean;
  },
): void {
  const workflow = getWorkflow(workflowId);
  const task = getWorkbenchTaskByWorkflowId(workflowId);
  const evaluation = getWorkflowStageEvaluation(evaluationId);
  if (!workflow || !task || !evaluation) return;

  const subtask = getWorkbenchSubtaskByStage(task.id, stageKey);
  const findings = parseEvaluationFindings(evaluation.findings_json);
  const body = buildEvaluationEventBody({
    summary: evaluation.summary,
    findings,
    evidence: parseEvaluationEvidence(evaluation.evidence_json),
  });

  upsertActionItem({
    id: stageEvaluationActionItemId(workflowId, stageKey),
    workflowId,
    stageKey,
    subtaskId: subtask?.id || null,
    delegationId: null,
    groupFolder: subtask?.group_folder || null,
    itemType: 'interactive',
    title: `${getStatusLabel(workflow.workflow_type, stageKey)} 需要处理`,
    body,
    sourceType: 'send_message',
    sourceRefId: evaluation.id,
    replyable: false,
    createdAt: evaluation.updated_at,
    extra: {
      evaluation_id: evaluation.id,
      evaluation_status: evaluation.status,
      evaluation_score: evaluation.score,
      findings_count: findings.length,
      keep_visible_when_current_stage:
        options?.keepVisibleWhenCurrentStage === true,
    },
  });
}

export function syncWorkbenchFromWorkflow(workflowId: string): void {
  syncWorkbenchOnWorkflowCreated(workflowId);
  const workflow = getWorkflow(workflowId);
  const task = getWorkbenchTaskByWorkflowId(workflowId);
  if (!workflow || !task) return;
  const config = getWorkflowTypeConfig(workflow.workflow_type);

  const delegations = getDelegationsByWorkflow(workflowId);
  for (const delegation of delegations) {
    syncWorkbenchOnDelegationCreated(workflowId, delegation.id);
    if (delegation.status !== 'pending') {
      syncWorkbenchOnDelegationCompleted(workflowId, delegation.id);
    }
  }
  for (const evaluation of listWorkflowStageEvaluationsByWorkflow(workflowId)) {
    syncWorkbenchOnStageEvaluated(
      workflowId,
      evaluation.stage_key,
      evaluation.id,
    );
  }
  for (const subtask of listWorkbenchSubtasksByTask(task.id)) {
    if (subtask.stage_key === workflow.status || subtask.status !== 'current') {
      continue;
    }
    updateWorkbenchSubtask(subtask.id, {
      status: 'completed',
      finished_at: subtask.finished_at || workflow.updated_at,
      updated_at: workflow.updated_at,
    });
  }
  if (
    config?.states[workflow.status]?.type === 'delegation' &&
    !workflow.current_delegation_id
  ) {
    for (const subtask of listWorkbenchSubtasksByTask(task.id)) {
      if (
        subtask.stage_key !== workflow.status ||
        subtask.status !== 'current'
      ) {
        continue;
      }
      const delegation = subtask.delegation_id
        ? getDelegation(subtask.delegation_id)
        : undefined;
      const inferredStatus =
        delegation?.outcome === 'failure'
          ? 'failed'
          : delegation?.status === 'completed'
            ? 'completed'
            : null;
      if (!inferredStatus) continue;
      updateWorkbenchSubtask(subtask.id, {
        status: inferredStatus,
        finished_at:
          subtask.finished_at || delegation?.updated_at || workflow.updated_at,
        updated_at: workflow.updated_at,
      });
    }
  }
  syncWorkbenchOnWorkflowUpdated(workflowId);
}
