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
  getDelegationsByWorkflow,
  getWorkbenchActionItem,
  getWorkbenchTaskById,
  getWorkbenchSubtaskByStage,
  getWorkbenchTaskByWorkflowId,
  getWorkflow,
  listWorkbenchActionItemsByTask,
  listWorkbenchActionItemsBySource,
  listWorkbenchSubtasksByTask,
  resolveWorkbenchActionItemsBySource,
  resolveWorkbenchActionItemsByStage,
  updateWorkbenchActionItem,
  updateWorkbenchSubtask,
  updateWorkbenchTask,
} from './db.js';
import type { Delegation, Workflow } from './types.js';
import { emitWorkbenchEvent } from './workbench-events.js';
import {
  getReachableWorkflowStages,
  getWorkflowTypeConfig,
  renderTemplate,
} from './workflow-config.js';

function nowIso(): string {
  return new Date().toISOString();
}

function buildTemplateVars(
  workflow: Workflow,
): Record<string, string | number> {
  return {
    name: workflow.name,
    service: workflow.service,
    work_branch: workflow.work_branch || 'N/A',
    staging_base_branch: workflow.staging_base_branch || '',
    staging_work_branch: workflow.staging_work_branch || '',
    id: workflow.id,
    round: workflow.round,
    deliverable: workflow.deliverable || 'N/A',
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

function taskIdForWorkflow(workflow: Workflow): string {
  return `wb-${workflow.id}`;
}

function stageActionItemId(workflowId: string, stageKey: string): string {
  return `wb-action-${workflowId}-${stageKey}`;
}

function subtaskId(taskId: string, stageKey: string): string {
  return `wb-subtask-${taskId}-${stageKey}`;
}

function actionItemId(
  workflowId: string,
  stageKey: string,
  sourceType: string,
  sourceRefId: string,
): string {
  return `wb-action-${workflowId}-${stageKey}-${sourceType}-${sourceRefId}`;
}

function emitActionItemUpdate(
  taskId: string,
  workflowId: string,
  payload: Record<string, unknown>,
): void {
  emitWorkbenchEvent({
    type: 'action_item_updated',
    taskId,
    workflowId,
    payload,
  });
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
    createdAt: existing?.created_at || params.createdAt,
    updatedAt: params.createdAt,
  });
}

function ensureArtifacts(workflow: Workflow): void {
  if (!workflow.deliverable || !workflow.service) return;
  const task = getWorkbenchTaskByWorkflowId(workflow.id);
  if (!task) return;

  const baseDir = path.join(
    PROJECT_ROOT,
    'projects',
    workflow.service,
    'iteration',
    workflow.deliverable,
  );
  const defs = [
    { type: 'plan_doc', title: '方案文档', file: 'plan.md', role: 'planner' },
    { type: 'dev_doc', title: '开发文档', file: 'dev.md', role: 'dev' },
    { type: 'test_doc', title: '测试文档', file: 'test.md', role: 'test' },
    { type: 'readme', title: '说明文档', file: 'README.md', role: 'system' },
  ];

  for (const def of defs) {
    const fullPath = path.join(baseDir, def.file);
    if (!fs.existsSync(fullPath)) continue;
    createWorkbenchArtifact({
      id: `${task.id}-${def.file}`,
      task_id: task.id,
      workflow_id: workflow.id,
      artifact_type: def.type,
      title: def.title,
      path: path.relative(PROJECT_ROOT, fullPath),
      source_role: def.role,
      created_at: workflow.updated_at,
    });
    emitWorkbenchEvent({
      type: 'artifact_created',
      taskId: task.id,
      workflowId: workflow.id,
      payload: {
        id: `${task.id}-${def.file}`,
        title: def.title,
        path: path.relative(PROJECT_ROOT, fullPath),
        createdAt: workflow.updated_at,
      },
    });
  }
}

function upsertStageActionItem(workflow: Workflow): void {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const task = getWorkbenchTaskByWorkflowId(workflow.id);
  if (!config || !task) return;
  const state = config.states[workflow.status];
  if (!state || state.type !== 'confirmation') return;
  const card = state.card ? config.cards[state.card] : undefined;
  const title = config.status_labels[workflow.status] || workflow.status;
  const vars = buildTemplateVars(workflow);
  upsertActionItem({
    id: stageActionItemId(workflow.id, workflow.status),
    workflowId: workflow.id,
    stageKey: workflow.status,
    subtaskId: getWorkbenchSubtaskByStage(task.id, workflow.status)?.id || null,
    delegationId: workflow.current_delegation_id || null,
    itemType: 'approval',
    title,
    body: card ? renderTemplate(card.body_template, vars) : title,
    sourceType: 'workflow',
    sourceRefId: workflow.status,
    replyable: false,
    createdAt: workflow.updated_at,
    extra: {
      approval_type: workflow.status,
      action_mode:
        workflow.status === 'testing_confirm'
          ? 'input_required'
          : state.on_revise
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
  resolveWorkbenchActionItemsByStage(
    task.workflow_id,
    task.current_stage,
    'resolved',
    resolvedAt,
  );
}

function resolveStaleStageActionItems(
  taskId: string,
  currentApprovalType: string | null,
  resolvedAt: string,
): void {
  const task = getWorkbenchTaskById(taskId);
  if (!task) return;
  for (const item of listWorkbenchActionItemsByTask(taskId)) {
    if (item.status !== 'pending') continue;
    if (
      item.source_type === 'workflow' &&
      item.source_ref_id === currentApprovalType
    )
      continue;
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
    createWorkbenchSubtask({
      id: subtaskId(task.id, stageKey),
      task_id: task.id,
      workflow_id: workflow.id,
      delegation_id: null,
      stage_key: stageKey,
      title: config.status_labels[stageKey] || stageKey,
      role: state.role || null,
      group_folder: null,
      status: stageKey === workflow.status ? 'current' : 'pending',
      input_summary: state.task_template
        ? truncate(state.task_template, 240)
        : null,
      output_summary: null,
      started_at: stageKey === workflow.status ? workflow.created_at : null,
      finished_at: null,
      updated_at: workflow.updated_at,
    });
    emitWorkbenchEvent({
      type: 'subtask_updated',
      taskId: task.id,
      workflowId: workflow.id,
      payload: {
        id: subtaskId(task.id, stageKey),
        stageKey,
        status: stageKey === workflow.status ? 'current' : 'pending',
      },
    });
  }
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

export function syncWorkbenchOnWorkflowCreated(workflowId: string): void {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return;
  const taskId = taskIdForWorkflow(workflow);
  if (!getWorkbenchTaskByWorkflowId(workflow.id)) {
    createWorkbenchTask({
      id: taskId,
      workflow_id: workflow.id,
      source_jid: workflow.source_jid,
      title: workflow.name,
      service: workflow.service,
      start_from: workflow.start_from,
      workflow_type: workflow.workflow_type,
      status: workflow.status,
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
        status: workflow.status,
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
): void {
  const workflow = getWorkflow(workflowId);
  const task = getWorkbenchTaskByWorkflowId(workflowId);
  if (!workflow || !task) return;
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const stateConfig = config?.states[workflow.status];

  updateWorkbenchTask(task.id, {
    status: workflow.status,
    current_stage: workflow.status,
    summary: summary !== undefined ? truncate(summary) : task.summary,
    updated_at: workflow.updated_at,
    last_event_at: workflow.updated_at,
    title: workflow.name,
  });
  emitWorkbenchEvent({
    type: 'task_updated',
    taskId: task.id,
    workflowId,
    payload: {
      status: workflow.status,
      currentStage: workflow.status,
      summary: summary !== undefined ? truncate(summary) : task.summary,
      updatedAt: workflow.updated_at,
    },
  });

  ensureSubtasks(workflow);

  const current = getWorkbenchSubtaskByStage(task.id, workflow.status);
  if (current) {
    updateWorkbenchSubtask(current.id, {
      status: workflow.status === 'paused' ? 'paused' : 'current',
      started_at: current.started_at || workflow.updated_at,
      updated_at: workflow.updated_at,
    });
    emitWorkbenchEvent({
      type: 'subtask_updated',
      taskId: task.id,
      workflowId,
      payload: {
        id: current.id,
        stageKey: workflow.status,
        status: workflow.status === 'paused' ? 'paused' : 'current',
      },
    });
  }

  resolveStaleStageActionItems(
    task.id,
    stateConfig?.type === 'confirmation' ? workflow.status : null,
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
    emitWorkbenchEvent({
      type: 'subtask_updated',
      taskId: task.id,
      workflowId,
      payload: {
        id: fromSubtask.id,
        stageKey: fromStatus,
        status: nextStatus,
      },
    });
  }

  const toSubtask = getWorkbenchSubtaskByStage(task.id, toStatus);
  if (toSubtask) {
    const nextStatus = workflow.status === 'paused' ? 'paused' : 'current';
    updateWorkbenchSubtask(toSubtask.id, {
      status: nextStatus,
      delegation_id: delegationId ?? toSubtask.delegation_id,
      started_at: toSubtask.started_at || workflow.updated_at,
      updated_at: workflow.updated_at,
    });
    emitWorkbenchEvent({
      type: 'subtask_updated',
      taskId: task.id,
      workflowId,
      payload: {
        id: toSubtask.id,
        stageKey: toStatus,
        status: nextStatus,
        delegationId: delegationId ?? toSubtask.delegation_id,
      },
    });
  }

  resolveCurrentStageActionItems(task.id, workflow.updated_at);
  updateWorkbenchTask(task.id, {
    status: workflow.status,
    current_stage: toStatus,
    updated_at: workflow.updated_at,
    last_event_at: workflow.updated_at,
  });
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

  const subtask = getWorkbenchSubtaskByStage(task.id, workflow.status);
  if (subtask) {
    updateWorkbenchSubtask(subtask.id, {
      delegation_id: delegation.id,
      group_folder: delegation.target_folder,
      status: 'current',
      input_summary: truncate(delegation.task, 240),
      started_at: subtask.started_at || delegation.created_at,
      updated_at: delegation.updated_at,
    });
    emitWorkbenchEvent({
      type: 'subtask_updated',
      taskId: task.id,
      workflowId,
      payload: {
        id: subtask.id,
        delegationId: delegation.id,
        status: 'current',
        groupFolder: delegation.target_folder,
      },
    });
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

  const subtask = getWorkbenchSubtaskByStage(task.id, workflow.status);
  if (subtask) {
    updateWorkbenchSubtask(subtask.id, {
      output_summary: truncate(delegation.result),
      finished_at: delegation.updated_at,
      updated_at: delegation.updated_at,
      status: delegation.outcome === 'failure' ? 'failed' : subtask.status,
    });
    emitWorkbenchEvent({
      type: 'subtask_updated',
      taskId: task.id,
      workflowId,
      payload: {
        id: subtask.id,
        delegationId: delegation.id,
        status: delegation.outcome === 'failure' ? 'failed' : subtask.status,
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
    body: truncate(delegation.result, 700),
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
      body: truncate(delegation.result, 700),
      delegationId: delegation.id,
      createdAt: delegation.updated_at,
    },
  });

  ensureArtifacts(workflow);
}

export function syncWorkbenchFromWorkflow(workflowId: string): void {
  syncWorkbenchOnWorkflowCreated(workflowId);
  const workflow = getWorkflow(workflowId);
  const task = getWorkbenchTaskByWorkflowId(workflowId);
  if (!workflow || !task) return;

  const delegations = getDelegationsByWorkflow(workflowId);
  for (const delegation of delegations) {
    syncWorkbenchOnDelegationCreated(workflowId, delegation.id);
    if (delegation.status !== 'pending') {
      syncWorkbenchOnDelegationCompleted(workflowId, delegation.id);
    }
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
  syncWorkbenchOnWorkflowUpdated(workflowId);
}
