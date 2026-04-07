import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from './config.js';
import {
  createWorkbenchComment,
  createWorkbenchContextAsset,
  getDelegationsByWorkflow,
  getWorkflow,
  getAllWorkflows,
  getWorkbenchTaskById,
  getWorkbenchTaskByWorkflowId,
  listWorkbenchApprovalsByTask,
  listWorkbenchArtifactsByTask,
  listWorkbenchCommentsByTask,
  listWorkbenchContextAssetsByTask,
  listWorkbenchEventsByTask,
  listWorkbenchSubtasksByTask,
  listWorkbenchTasks as listWorkbenchTaskRecords,
  updateWorkbenchSubtask,
} from './db.js';
import type {
  Delegation,
  WorkbenchApprovalRecord,
  WorkbenchArtifactRecord,
  WorkbenchCommentRecord,
  WorkbenchContextAssetRecord,
  WorkbenchEventRecord,
  WorkbenchSubtaskRecord,
  WorkbenchTaskRecord,
  Workflow,
} from './types.js';
import {
  approveWorkflow,
  cancelWorkflow,
  createNewWorkflow,
  getAvailableWorkflowTypes,
  getStatusLabelsForType,
  pauseWorkflow,
  resumeWorkflow,
  retryWorkflowStage,
  reviseWorkflow,
  skipWorkflow,
} from './workflow.js';
import {
  getReachableWorkflowStages,
  getWorkflowTypeConfig,
  renderTemplate,
} from './workflow-config.js';
import { syncWorkbenchFromWorkflow } from './workbench-store.js';
import { emitWorkbenchEvent } from './workbench-events.js';

export interface WorkbenchTaskItem {
  id: string;
  title: string;
  service: string;
  start_from: string;
  workflow_type: string;
  status: string;
  status_label: string;
  current_stage: string;
  current_stage_label: string;
  branch: string;
  deliverable: string;
  round: number;
  source_jid: string;
  created_at: string;
  updated_at: string;
  pending_approval: boolean;
  active_delegation_id: string;
}

export interface WorkbenchTimelineEvent {
  id: string;
  type: 'lifecycle' | 'delegation' | 'approval' | 'artifact';
  title: string;
  body: string;
  created_at: string;
  status?: string;
}

export interface WorkbenchSubtask {
  id: string;
  title: string;
  stage_key: string;
  stage_label: string;
  status: 'completed' | 'current' | 'pending' | 'failed';
  role?: string;
  skill?: string;
  target_folder?: string;
  delegation_id?: string;
  result?: string;
  created_at?: string;
  updated_at?: string;
}

export interface WorkbenchArtifact {
  id: string;
  title: string;
  artifact_type: string;
  path: string;
  exists: boolean;
}

export interface WorkbenchApproval {
  id: string;
  approval_type: string;
  title: string;
  body: string;
  status: 'pending';
  action_mode: 'approve_only' | 'approve_or_revise';
}

export interface WorkbenchTaskDetail {
  task: WorkbenchTaskItem;
  subtasks: WorkbenchSubtask[];
  timeline: WorkbenchTimelineEvent[];
  artifacts: WorkbenchArtifact[];
  approvals: WorkbenchApproval[];
  comments: Array<{ id: string; author: string; content: string; created_at: string }>;
  assets: Array<{
    id: string;
    title: string;
    asset_type: string;
    path: string | null;
    url: string | null;
    note: string | null;
    created_at: string;
  }>;
}

function toTaskItem(workflow: Workflow): WorkbenchTaskItem {
  const persisted = getWorkbenchTaskByWorkflowId(workflow.id);
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const stateConfig = config?.states[workflow.status];
  const statusLabels = getStatusLabelsForType(workflow.workflow_type);

  return {
    id: persisted?.id || workflow.id,
    title: persisted?.title || workflow.name,
    service: persisted?.service || workflow.service,
    start_from: persisted?.start_from || workflow.start_from,
    workflow_type: persisted?.workflow_type || workflow.workflow_type,
    status: persisted?.status || workflow.status,
    status_label: statusLabels[workflow.status] || workflow.status,
    current_stage: persisted?.current_stage || workflow.status,
    current_stage_label:
      statusLabels[persisted?.current_stage || workflow.status] ||
      persisted?.current_stage ||
      workflow.status,
    branch: workflow.branch,
    deliverable: workflow.deliverable,
    round: workflow.round,
    source_jid: persisted?.source_jid || workflow.source_jid,
    created_at: persisted?.created_at || workflow.created_at,
    updated_at: persisted?.updated_at || workflow.updated_at,
    pending_approval: stateConfig?.type === 'confirmation',
    active_delegation_id: workflow.current_delegation_id || '',
  };
}

function mapPersistedSubtask(item: WorkbenchSubtaskRecord): WorkbenchSubtask {
  return {
    id: item.id,
    title: item.title,
    stage_key: item.stage_key,
    stage_label: item.title,
    status:
      item.status === 'completed'
        ? 'completed'
        : item.status === 'current'
          ? 'current'
          : item.status === 'failed'
            ? 'failed'
          : 'pending',
    role: item.role || undefined,
    target_folder: item.group_folder || undefined,
    delegation_id: item.delegation_id || undefined,
    result: item.output_summary || undefined,
    created_at: item.started_at || undefined,
    updated_at: item.updated_at,
  };
}

function mapPersistedEvent(item: WorkbenchEventRecord): WorkbenchTimelineEvent {
  return {
    id: item.id,
    type:
      item.event_type === 'workflow_created'
        ? 'lifecycle'
        : item.event_type.includes('approval')
          ? 'approval'
          : item.event_type.includes('artifact')
            ? 'artifact'
            : 'delegation',
    title: item.title,
    body: item.body || '',
    created_at: item.created_at,
    status: item.event_type,
  };
}

function mapPersistedArtifact(item: WorkbenchArtifactRecord): WorkbenchArtifact {
  const fullPath = path.join(PROJECT_ROOT, item.path);
  return {
    id: item.id,
    title: item.title,
    artifact_type: item.artifact_type,
    path: item.path,
    exists: fs.existsSync(fullPath),
  };
}

function mapPersistedApproval(item: WorkbenchApprovalRecord): WorkbenchApproval {
  return {
    id: item.id,
    approval_type: item.approval_type,
    title: item.title,
    body: item.body || '',
    status: 'pending',
    action_mode: item.approval_type.includes('confirm') ? 'approve_or_revise' : 'approve_only',
  };
}

function mapPersistedComment(item: WorkbenchCommentRecord) {
  return {
    id: item.id,
    author: item.author,
    content: item.content,
    created_at: item.created_at,
  };
}

function mapPersistedAsset(item: WorkbenchContextAssetRecord) {
  return {
    id: item.id,
    title: item.title,
    asset_type: item.asset_type,
    path: item.path,
    url: item.url,
    note: item.note,
    created_at: item.created_at,
  };
}

function getVisibleStageKeys(workflow: Workflow): string[] {
  const task = getWorkbenchTaskByWorkflowId(workflow.id);
  const persistedStageKeys = task
    ? listWorkbenchSubtasksByTask(task.id).map((item) => item.stage_key)
    : [];

  if (persistedStageKeys.length > 0) {
    return persistedStageKeys;
  }

  const visibleStageKeys = getReachableWorkflowStages(
    workflow.workflow_type,
    workflow.status,
  );
  return visibleStageKeys.length > 0 ? visibleStageKeys : [workflow.status];
}

function getStageDefinitions(workflow: Workflow): WorkbenchSubtask[] {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  if (!config) return [];

  const visibleStageKeys = new Set(getVisibleStageKeys(workflow));

  return Object.entries(config.states)
    .filter(
      ([key, state]) =>
        state.type !== 'system' &&
        state.type !== 'terminal' &&
        visibleStageKeys.has(key),
    )
    .map(([key, state]) => ({
      id: `stage-${key}`,
      title: state.role || key,
      stage_key: key,
      stage_label: config.status_labels[key] || key,
      status: 'pending' as const,
      role: state.role,
      skill: state.skill,
    }));
}

function summarizeResult(result: string | null): string {
  if (!result) return '';
  const normalized = result.replace(/\s+/g, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function buildSubtasks(workflow: Workflow, delegations: Delegation[]): WorkbenchSubtask[] {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const stages = getStageDefinitions(workflow);
  if (!config || stages.length === 0) return [];

  const currentKey = workflow.status;
  const delegationStates = Object.entries(config.states)
    .filter(([, state]) => state.type === 'delegation')
    .map(([key]) => key);

  return stages.map((stage) => {
    const delegationIndex = delegationStates.indexOf(stage.stage_key);
    const linkedDelegation = delegationIndex >= 0 ? delegations[delegationIndex] : undefined;

    let status: WorkbenchSubtask['status'] = 'pending';
    if (stage.stage_key === currentKey) status = 'current';
    else if (linkedDelegation?.outcome === 'failure') status = 'failed';
    else if (linkedDelegation?.status === 'completed') status = 'completed';

    return {
      ...stage,
      title: stage.stage_label,
      status,
      target_folder: linkedDelegation?.target_folder,
      delegation_id: linkedDelegation?.id,
      result: summarizeResult(linkedDelegation?.result || null),
      created_at: linkedDelegation?.created_at,
      updated_at: linkedDelegation?.updated_at,
    };
  });
}

function buildArtifacts(workflow: Workflow): WorkbenchArtifact[] {
  if (!workflow.service || !workflow.deliverable) return [];

  const baseDir = path.join(
    PROJECT_ROOT,
    'projects',
    workflow.service,
    'iteration',
    workflow.deliverable,
  );

  const candidates = [
    { artifact_type: 'plan_doc', title: '方案文档', file: 'plan.md' },
    { artifact_type: 'dev_doc', title: '开发文档', file: 'dev.md' },
    { artifact_type: 'test_doc', title: '测试文档', file: 'test.md' },
    { artifact_type: 'readme', title: '说明文档', file: 'README.md' },
  ];

  return candidates.map((candidate) => {
    const fullPath = path.join(baseDir, candidate.file);
    return {
      id: `${workflow.id}-${candidate.file}`,
      title: candidate.title,
      artifact_type: candidate.artifact_type,
      path: path.relative(PROJECT_ROOT, fullPath),
      exists: fs.existsSync(fullPath),
    };
  });
}

function buildApprovals(workflow: Workflow): WorkbenchApproval[] {
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const stateConfig = config?.states[workflow.status];
  if (!config || !stateConfig || stateConfig.type !== 'confirmation') return [];

  const card = stateConfig.card ? config.cards[stateConfig.card] : undefined;
  const vars = {
    name: workflow.name,
    service: workflow.service,
    branch: workflow.branch || 'N/A',
    id: workflow.id,
    round: workflow.round,
    deliverable: workflow.deliverable || 'N/A',
    delegation_result: '',
    result_summary: '',
    revision_text: '',
  };
  const body = card
    ? renderTemplate(card.body_template, vars)
    : `${config.status_labels[workflow.status] || workflow.status} 等待处理`;

  return [
    {
      id: `${workflow.id}-approval-${workflow.status}`,
      approval_type: workflow.status,
      title: config.status_labels[workflow.status] || workflow.status,
      body,
      status: 'pending',
      action_mode: stateConfig.on_revise ? 'approve_or_revise' : 'approve_only',
    },
  ];
}

function buildTimeline(workflow: Workflow, delegations: Delegation[]): WorkbenchTimelineEvent[] {
  const timeline: WorkbenchTimelineEvent[] = [
    {
      id: `${workflow.id}-created`,
      type: 'lifecycle',
      title: '任务已创建',
      body: `已创建 ${workflow.workflow_type} 工作流，服务 ${workflow.service}`,
      created_at: workflow.created_at,
      status: workflow.status,
    },
  ];

  for (const delegation of delegations) {
    timeline.push({
      id: `${delegation.id}-created`,
      type: 'delegation',
      title: `已委派 ${delegation.target_folder}`,
      body: delegation.task,
      created_at: delegation.created_at,
      status: delegation.status,
    });

    if (delegation.status !== 'pending') {
      timeline.push({
        id: `${delegation.id}-completed`,
        type: 'delegation',
        title:
          delegation.outcome === 'failure'
            ? `委派失败 ${delegation.target_folder}`
            : `委派完成 ${delegation.target_folder}`,
        body: summarizeResult(delegation.result),
        created_at: delegation.updated_at,
        status: delegation.outcome || delegation.status,
      });
    }
  }

  for (const artifact of buildArtifacts(workflow).filter((item) => item.exists)) {
    timeline.push({
      id: `${artifact.id}-artifact`,
      type: 'artifact',
      title: `产出已生成：${artifact.title}`,
      body: artifact.path,
      created_at: workflow.updated_at,
      status: 'ready',
    });
  }

  for (const approval of buildApprovals(workflow)) {
    timeline.push({
      id: `${approval.id}-approval`,
      type: 'approval',
      title: `等待审批：${approval.title}`,
      body: approval.body,
      created_at: workflow.updated_at,
      status: approval.status,
    });
  }

  return timeline.sort((a, b) => {
    const aTs = new Date(a.created_at).getTime();
    const bTs = new Date(b.created_at).getTime();
    return bTs - aTs;
  });
}

export function listWorkbenchTasks(): WorkbenchTaskItem[] {
  const persisted = listWorkbenchTaskRecords();
  if (persisted.length > 0) {
    return persisted.map((item: WorkbenchTaskRecord) => {
      const workflow = getWorkflow(item.workflow_id);
      if (workflow) return toTaskItem(workflow);
      return {
        id: item.id,
        title: item.title,
        service: item.service,
        start_from: item.start_from,
        workflow_type: item.workflow_type,
        status: item.status,
        status_label: item.status,
        current_stage: item.current_stage,
        current_stage_label: item.current_stage,
        branch: '',
        deliverable: '',
        round: 0,
        source_jid: item.source_jid,
        created_at: item.created_at,
        updated_at: item.updated_at,
        pending_approval: false,
        active_delegation_id: '',
      };
    });
  }
  return getAllWorkflows().map((workflow) => {
    syncWorkbenchFromWorkflow(workflow.id);
    return toTaskItem(workflow);
  });
}

function resolveWorkbenchWorkflowId(taskId: string): string | null {
  if (!taskId) return null;

  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId) return null;

  const persistedById = getWorkbenchTaskById(normalizedTaskId);
  if (persistedById) return persistedById.workflow_id;

  const normalizedWorkflowId = normalizedTaskId.replace(/^wb-/, '');
  if (getWorkflow(normalizedWorkflowId)) return normalizedWorkflowId;

  const persistedByWorkflowId = getWorkbenchTaskByWorkflowId(normalizedWorkflowId);
  if (persistedByWorkflowId) return persistedByWorkflowId.workflow_id;

  return null;
}

function getWorkbenchTaskRecord(taskId: string): WorkbenchTaskRecord | null {
  const workflowId = resolveWorkbenchWorkflowId(taskId);
  if (!workflowId) return null;
  syncWorkbenchFromWorkflow(workflowId);
  return getWorkbenchTaskByWorkflowId(workflowId) || null;
}

export function getWorkbenchTaskDetail(taskId: string): WorkbenchTaskDetail | null {
  const workflowId = resolveWorkbenchWorkflowId(taskId);
  if (!workflowId) return null;

  const workflow = getWorkflow(workflowId);
  if (!workflow) return null;
  const config = getWorkflowTypeConfig(workflow.workflow_type);
  const stateConfig = config?.states[workflow.status];
  const shouldShowApprovals = stateConfig?.type === 'confirmation';

  const task = getWorkbenchTaskRecord(taskId);
  if (task) {
    const visibleStageKeys = new Set(getVisibleStageKeys(workflow));
    return {
      task: toTaskItem(workflow),
      subtasks: listWorkbenchSubtasksByTask(task.id)
        .filter((item) => visibleStageKeys.has(item.stage_key))
        .map(mapPersistedSubtask),
      timeline: listWorkbenchEventsByTask(task.id).map(mapPersistedEvent),
      artifacts: listWorkbenchArtifactsByTask(task.id).map(mapPersistedArtifact),
      approvals: shouldShowApprovals
        ? listWorkbenchApprovalsByTask(task.id)
            .filter(
              (item) =>
                item.status === 'pending' &&
                item.approval_type === workflow.status,
            )
            .map(mapPersistedApproval)
        : [],
      comments: listWorkbenchCommentsByTask(task.id).map(mapPersistedComment),
      assets: listWorkbenchContextAssetsByTask(task.id).map(mapPersistedAsset),
    };
  }
  const delegations = getDelegationsByWorkflow(workflow.id);

  return {
    task: toTaskItem(workflow),
    subtasks: buildSubtasks(workflow, delegations),
    timeline: buildTimeline(workflow, delegations),
    artifacts: buildArtifacts(workflow),
    approvals: buildApprovals(workflow),
    comments: [],
    assets: [],
  };
}

export function createWorkbenchTask(input: {
  name: string;
  service: string;
  sourceJid: string;
  startFrom: string;
  workflowType: string;
  deliverable?: string;
  deployBranch?: string;
}): { workflowId: string; error?: string } {
  return createNewWorkflow({
    name: input.name,
    service: input.service,
    sourceJid: input.sourceJid,
    startFrom: input.startFrom,
    workflowType: input.workflowType,
    deliverable: input.deliverable,
    deployBranch: input.deployBranch,
  });
}

export function runWorkbenchTaskAction(input: {
  taskId: string;
  action: 'approve' | 'revise' | 'pause' | 'resume' | 'cancel' | 'skip';
  revisionText?: string;
}): { error?: string } {
  const workflowId = resolveWorkbenchWorkflowId(input.taskId);
  if (!workflowId) return { error: 'Task not found' };

  switch (input.action) {
    case 'approve':
      return approveWorkflow(workflowId);
    case 'revise':
      return reviseWorkflow(workflowId, input.revisionText?.trim() || '请按最新意见修正');
    case 'pause':
      return pauseWorkflow(workflowId);
    case 'resume':
      return resumeWorkflow(workflowId);
    case 'cancel':
      return cancelWorkflow(workflowId);
    case 'skip':
      return skipWorkflow(workflowId);
    default:
      return { error: `Unsupported action: ${input.action}` };
  }
}

export function getWorkbenchCreateOptions(): {
  workflow_types: ReturnType<typeof getAvailableWorkflowTypes>;
} {
  return {
    workflow_types: getAvailableWorkflowTypes(),
  };
}

export function addWorkbenchComment(input: {
  taskId: string;
  author: string;
  content: string;
}): { error?: string } {
  const detail = getWorkbenchTaskDetail(input.taskId);
  if (!detail) return { error: 'Task not found' };

  const workflowId = resolveWorkbenchWorkflowId(input.taskId);
  if (!workflowId) return { error: 'Task not found' };

  const now = new Date().toISOString();
  const id = `wb-comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createWorkbenchComment({
    id,
    task_id: detail.task.id,
    workflow_id: workflowId,
    author: input.author,
    content: input.content.trim(),
    created_at: now,
  });
  emitWorkbenchEvent({
    type: 'comment_created',
    taskId: detail.task.id,
    workflowId,
    payload: { id, author: input.author, content: input.content.trim(), createdAt: now },
  });
  return {};
}

export function addWorkbenchAsset(input: {
  taskId: string;
  title: string;
  assetType: string;
  path?: string;
  url?: string;
  note?: string;
}): { error?: string } {
  const detail = getWorkbenchTaskDetail(input.taskId);
  if (!detail) return { error: 'Task not found' };

  const workflowId = resolveWorkbenchWorkflowId(input.taskId);
  if (!workflowId) return { error: 'Task not found' };

  const now = new Date().toISOString();
  const id = `wb-asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createWorkbenchContextAsset({
    id,
    task_id: detail.task.id,
    workflow_id: workflowId,
    asset_type: input.assetType,
    title: input.title,
    path: input.path || null,
    url: input.url || null,
    note: input.note || null,
    created_at: now,
  });
  emitWorkbenchEvent({
    type: 'asset_created',
    taskId: detail.task.id,
    workflowId,
    payload: {
      id,
      title: input.title,
      assetType: input.assetType,
      path: input.path || null,
      url: input.url || null,
      note: input.note || null,
      createdAt: now,
    },
  });
  return {};
}

export function retryWorkbenchSubtask(input: {
  taskId: string;
  subtaskId: string;
}): { error?: string } {
  const detail = getWorkbenchTaskDetail(input.taskId);
  if (!detail) return { error: 'Task not found' };

  const task = getWorkbenchTaskRecord(input.taskId);
  if (!task) return { error: 'Task not found' };

  const subtask = listWorkbenchSubtasksByTask(task.id).find((item) => item.id === input.subtaskId);
  if (!subtask) return { error: 'Subtask not found' };
  if (subtask.status !== 'failed') return { error: 'Only failed subtasks can be retried' };

  const workflowId = resolveWorkbenchWorkflowId(input.taskId);
  if (!workflowId) return { error: 'Task not found' };

  const result = retryWorkflowStage(workflowId, subtask.stage_key);
  if (result.error) return result;
  updateWorkbenchSubtask(subtask.id, {
    status: 'pending',
    output_summary: null,
    finished_at: null,
    updated_at: new Date().toISOString(),
  });
  emitWorkbenchEvent({
    type: 'subtask_updated',
    taskId: detail.task.id,
    workflowId,
    payload: { id: subtask.id, status: 'pending', retried: true },
  });
  return {};
}
